import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NvrLiveStream, nvrAudio, nvrVideo } from "../nvr-live.js";
import { buildPortalHeader, PortalLinkType } from "../portal-packet.js";
import type { RtcSession } from "../session.js";
import { NvrMediaRouter, type NvrMediaRoute } from "../nvr-media.js";

/** Synthetic complete access units: the media header preserves a 64-bit clock and real frame geometry. */
function video(type = 1, stamp = 1_800_000_000_000n) {
  const bytes = Buffer.from(type === 1 ? "000000012601af0e" : "00000001658884", "hex");
  const body = Buffer.alloc(22 + bytes.length);
  body.writeUInt32LE(bytes.length);
  body[4] = 1;
  body[5] = type;
  body.writeUInt16LE(3840, 10);
  body.writeUInt16LE(2160, 12);
  body.writeBigUInt64LE(stamp, 14);
  bytes.copy(body, 22);
  return Buffer.concat([buildPortalHeader(1300, body.length, 101, 1), body]);
}
function audio(type = 2) {
  const body = Buffer.alloc(20);
  body.writeUInt32LE(4);
  body[5] = type;
  body.writeBigUInt64LE(1_800_000_000_032n, 8);
  body.fill(0xd5, 16);
  return Buffer.concat([buildPortalHeader(1301, body.length, 101, 1), body]);
}
class Session extends EventEmitter {
  isConnected = false;
  connect = vi.fn(async () => {
    this.isConnected = true;
    this.emit("connected");
  });
  sendCommand = vi.fn((_packet: Buffer) => true);
  sendRaw = vi.fn((_packet: Buffer) => true);
  close = vi.fn(() => {
    this.isConnected = false;
    this.emit("close");
  });
}
const route: NvrMediaRoute = {
  stationSn: "T8000P0000000000",
  cameraSn: "T8000P0000000001",
  channel: 3,
  attached: true,
  signalingMode: "call",
  iceTransportPolicy: "all",
  defaultSensor: 1,
  sensors: [0, 1],
};
const routers: NvrMediaRouter[] = [];
afterEach(() => {
  routers.splice(0).forEach((r) => r.close());
  vi.useRealTimers();
});
function router() {
  const sessions: Session[] = [];
  const media = new NvrMediaRouter({
    identity: () => ({ authToken: "synthetic", userId: "synthetic", gtoken: "synthetic" }),
    shard: () => "eu-pr",
    createSession: () => {
      const s = new Session();
      sessions.push(s);
      return s as unknown as RtcSession;
    },
  });
  routers.push(media);
  return { media, sessions };
}

describe("NVR media wire", () => {
  it.each([0, 1])("preserves codec %s, geometry, keyframe and the full media clock", (type) => {
    expect(nvrVideo(video(type))).toMatchObject({
      codec: type ? "h265" : "h264",
      width: 3840,
      height: 2160,
      keyframe: true,
      timestampMs: 1_800_000_000_000,
    });
  });
  it("drops truncated frames and unknown codecs rather than publishing damaged pictures", () => {
    expect(nvrVideo(video().subarray(0, -1))).toBeUndefined();
    expect(nvrVideo(video(9))).toBeUndefined();
    expect(nvrVideo(video(1, 2n ** 63n))).toBeUndefined();
    const wrong = video();
    wrong.writeUInt32LE(9999, 16);
    expect(nvrVideo(wrong)).toBeUndefined();
  });
  it("preserves audio and refuses an unsupported audio codec without inventing a decoder config", () => {
    expect(nvrAudio(audio())).toMatchObject({
      codec: "g711a",
      timestampMs: 1_800_000_000_032,
      data: Buffer.alloc(4, 0xd5),
    });
    expect(nvrAudio(audio(0))?.codec).toBe("aac-lc");
    expect(nvrAudio(audio(7))).toBeUndefined();
    expect(nvrAudio(audio().subarray(0, -1))).toBeUndefined();
  });
});

describe("independent NVR media lifetime", () => {
  it("shares one sensor while keeping its sibling sensor and another camera independent", async () => {
    vi.useFakeTimers();
    const { media, sessions } = router();
    const primary = media.mediaProviderFor(route);
    const a = await primary.live();
    const shared = await primary.live();
    const fixed = await primary.live({ sensor: 0 });
    const other = await media
      .mediaProviderFor({ ...route, cameraSn: "T8000P0000000002", channel: 4, defaultSensor: 0, sensors: [0] })
      .live();
    expect(sessions).toHaveLength(3);
    const requests = sessions.map((s) => JSON.parse(s.sendCommand.mock.calls[0]![0].subarray(16).toString()));
    expect(requests.map((r) => r.cmd)).toEqual([1003, 1003, 1003]);
    expect(requests.map((r) => r.payload.chn_list[0])).toEqual([
      { index: 0, chn: 3, sensor: 1 },
      { index: 0, chn: 3, sensor: 0 },
      { index: 0, chn: 4, sensor: 0 },
    ]);
    expect(requests.map((r) => r.payload.audio_chn)).toEqual([3, 3, 4]);
    const aFrames = vi.fn();
    const fixedFrames = vi.fn();
    const sound = vi.fn();
    a.on("video", aFrames);
    fixed.on("video", fixedFrames);
    a.on("audio", sound);
    sessions[0]!.emit("mediaData", video());
    sessions[0]!.emit("mediaData", audio());
    expect(aFrames).toHaveBeenCalledOnce();
    expect(fixedFrames).not.toHaveBeenCalled();
    expect(sound).toHaveBeenCalledOnce();
    a.stop();
    shared.stop();
    await vi.advanceTimersByTimeAsync(8001);
    expect(sessions[0]!.close).toHaveBeenCalledOnce();
    expect(sessions[1]!.close).not.toHaveBeenCalled();
    expect(sessions[2]!.close).not.toHaveBeenCalled();
    fixed.stop();
    other.stop();
  });
  it("rejects an E40's absent second sensor and an already-aborted call before opening a session", async () => {
    const { media, sessions } = router();
    const single = media.mediaProviderFor({ ...route, defaultSensor: 0, sensors: [0] });
    await expect(single.live({ sensor: 1 })).rejects.toThrow("unsupported sensor");
    await expect(single.live({ signal: AbortSignal.abort() })).rejects.toThrow();
    expect(sessions).toHaveLength(0);
  });
  it("propagates a rejected start, closes that session and permits a fresh attempt", async () => {
    const { media, sessions } = router();
    const camera = media.mediaProviderFor(route);
    const first = await camera.live();
    const error = vi.fn();
    first.on("error", error);
    const payload = Buffer.alloc(4);
    payload.writeInt32LE(-2);
    sessions[0]!.emit(
      "commandData",
      Buffer.concat([buildPortalHeader(1350, 4, 255, 2, 1), payload]),
      PortalLinkType.COMMAND,
    );
    expect(error).toHaveBeenCalledOnce();
    expect(sessions[0]!.close).toHaveBeenCalledOnce();
    const retry = await camera.live();
    expect(sessions).toHaveLength(2);
    retry.stop();
  });
  it("ends a stalled video pull even while audio still arrives", async () => {
    vi.useFakeTimers();
    const { media, sessions } = router();
    const consumer = await media.mediaProviderFor(route).live();
    const error = vi.fn();
    consumer.on("error", error);
    sessions[0]!.emit("mediaData", video());
    await vi.advanceTimersByTimeAsync(14_000);
    sessions[0]!.emit("mediaData", audio());
    await vi.advanceTimersByTimeAsync(1001);
    expect(error).toHaveBeenCalledOnce();
    expect(sessions[0]!.close).toHaveBeenCalledOnce();
  });
  it("does not connect after disposal before the asynchronous start", async () => {
    const s = new Session();
    const stream = new NvrLiveStream({
      channel: 3,
      sensor: 0,
      session: {
        authToken: "synthetic",
        gtoken: "synthetic",
        stationSn: route.stationSn,
        adminUserId: "synthetic",
        shard: "eu-pr",
        country: "DE",
      },
      createSession: () => s as unknown as RtcSession,
    });
    stream.start();
    stream.stop();
    await Promise.resolve();
    expect(s.connect).not.toHaveBeenCalled();
    expect(s.close).toHaveBeenCalledOnce();
  });
});
