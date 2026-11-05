import { encode as encodeJpeg } from "jpeg-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../core/types.js";
import { LiveSnapshotUnavailableError } from "../../core/contracts.js";
import { EufyMega } from "../eufy-mega.js";
import * as snapshots from "../../transport/p2p/media.js";
import { buildPortalHeader } from "../../transport/rtc/portal-packet.js";
import { RtcSession } from "../../transport/rtc/session.js";

const HUB = "T8000P0000000000";
const CAMERA = "T8000P0000000001";

/** Synthetic cloud records retain the category, product name and parent channel used in production. */
function fixture(model: string, name: string) {
  const client = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
  });
  const internals = client as any;
  internals.registry.devices = [
    {
      sn: HUB,
      model: "T8N00",
      name: "Synthetic NVR S4",
      category: "eufy_security",
      deviceClass: "station",
      api: "mega",
      realtime: "p2p",
      raw: { member: { admin_user_id: "synthetic-admin" } },
    },
    {
      sn: CAMERA,
      model,
      name,
      category: "eufy_security",
      deviceClass: "camera",
      api: "mega",
      realtime: "p2p",
      stationSn: HUB,
      channel: 3,
      params: {},
      raw: { parent_sn: HUB, device_channel: 3 },
    },
  ] as EufyDevice[];
  vi.spyOn(internals.mega, "getDeviceParamList").mockResolvedValue({ params: [] });
  vi.spyOn(internals.mega, "rtcIdentity").mockReturnValue({
    authToken: "synthetic",
    userId: "synthetic",
    gtoken: "synthetic",
  });
  const p2p = vi.spyOn(internals.p2p, "mediaProviderFor");
  return { client, internals, p2p };
}

afterEach(() => vi.restoreAllMocks());

describe("public NVR camera media binding", () => {
  it.each(["unknown-model", "missing-channel", "different-station"])(
    "does not admit %s to NVR media",
    async (scenario) => {
      const { client, internals } = fixture("T8P00", "Synthetic PoE Cam E40");
      const records = internals.registry.devices as EufyDevice[];
      if (scenario === "unknown-model") records[1]!.model = "T0000";
      if (scenario === "missing-channel") records[1]!.raw = { parent_sn: HUB };
      if (scenario === "different-station") records[0]!.model = "T8010";
      const provider = vi.spyOn(internals.rtc, "nvrMediaProviderFor");
      await client.getDevice(CAMERA);
      expect(provider).not.toHaveBeenCalled();
      internals.rtc.close();
    },
  );
  it("preserves cancellation and login failures from the public snapshot caller", async () => {
    const { client, internals } = fixture("T8P00", "Synthetic PoE Cam E40");
    const device = await client.getDevice(CAMERA);
    const reason = new Error("synthetic cancellation");
    await expect(device.camera?.()?.snapshotLive?.({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    vi.mocked(internals.mega.rtcIdentity).mockReturnValue(undefined);
    await expect(device.camera?.()?.snapshotLive?.()).rejects.toThrow("not logged in");
    await expect(device.camera?.()?.snapshotLive?.()).rejects.not.toBeInstanceOf(LiveSnapshotUnavailableError);
    internals.rtc.close();
  });
  it.each([
    ["T8E00", 0],
    ["T8P00", 0],
    ["T8P10", 0],
    ["T8162", 0],
    ["T8410", 0],
    ["T8214", 0],
  ] as const)("starts %s through its public camera capability with sensor %s", async (model, sensor) => {
    vi.spyOn(RtcSession.prototype, "connect").mockImplementation(async function (this: RtcSession) {
      this.emit("connected");
    });
    const sent = vi.spyOn(RtcSession.prototype, "sendCommand").mockReturnValue(true);
    const { client, internals, p2p } = fixture(model, `Synthetic ${model} behind an NVR`);
    try {
      const device = await client.getDevice(CAMERA);
      const stream = await device.camera?.()?.live?.();
      expect(stream).toBeDefined();
      expect(sent).toHaveBeenCalledOnce();
      const packet = sent.mock.calls[0]![0];
      expect(JSON.parse(packet.subarray(16).toString())).toMatchObject({
        cmd: 1003,
        payload: { chn_list: [{ index: 0, chn: 3, sensor }], audio_chn: 3 },
      });
      expect(p2p).not.toHaveBeenCalled();
      stream?.stop();
    } finally {
      internals.rtc.close();
    }
  });

  it.each([
    ["T8E00", "Synthetic PoE Bullet PTZ Cam S4"],
    ["T8P00", "Synthetic PoE Cam E40"],
    ["T8P10", "Synthetic PoE Cam E41"],
    ["T8162", "Synthetic eufyCam paired to an NVR"],
    ["T8410", "Synthetic camera paired to an NVR"],
    ["T8214", "Synthetic Video Doorbell paired to an NVR"],
  ])("binds %s media without falling through to the unreachable P2P provider", async (model, name) => {
    const { client, p2p } = fixture(model, name);
    const device = await client.getDevice(CAMERA);
    expect(device.camera?.()?.live).toBeTypeOf("function");
    expect(device.camera?.()?.openReadable).toBeTypeOf("function");
    expect(p2p).not.toHaveBeenCalled();
  });
});

/** Complete synthetic HEVC portal frame, retaining the header layout used by the camera route. */
function viewFrame(lastByte: number): Buffer {
  const data = Buffer.from([0, 0, 0, 1, 0x26, 1, 0xaf, lastByte]);
  const body = Buffer.alloc(22 + data.length);
  body.writeUInt32LE(data.length);
  body[5] = 1;
  body.writeUInt16LE(1280, 10);
  body.writeUInt16LE(720, 12);
  data.copy(body, 22);
  return Buffer.concat([buildPortalHeader(1300, body.length, 101, 1), body]);
}

describe("public non-NVR optical view boundary", () => {
  it.each([
    ["T8223", "Synthetic Video Doorbell C31"],
    ["T8425", "Synthetic Floodlight Cam E340"],
  ])("keeps %s view discovery absent and refuses secondary pulls in the model", async (model, name) => {
    const { client, internals, p2p } = fixture(model, name);
    internals.registry.devices = [
      {
        sn: CAMERA,
        model,
        name,
        category: "eufy_security",
        deviceClass: "camera",
        api: "mega",
        realtime: "p2p",
        stationSn: CAMERA,
        params: {},
        raw: { parent_sn: CAMERA, member: { admin_user_id: "synthetic-admin" } },
      },
    ] as EufyDevice[];
    const provider = { live: vi.fn(), openReadable: vi.fn(), snapshotLive: vi.fn(), record: vi.fn() };
    p2p.mockReturnValue(provider);
    const connected = vi.spyOn(RtcSession.prototype, "connect");
    try {
      const camera = (await client.getDevice(CAMERA)).camera!()!;
      expect(camera.views).toBeUndefined();
      for (const method of ["live", "openReadable", "snapshotLive"] as const) {
        await expect(camera[method]!({ view: 1 })).rejects.toThrow("camera: unsupported optical view 1");
      }
      expect(connected).not.toHaveBeenCalled();
      expect(provider.live).not.toHaveBeenCalled();
      expect(provider.openReadable).not.toHaveBeenCalled();
      expect(provider.snapshotLive).not.toHaveBeenCalled();
    } finally {
      internals.rtc.close();
    }
  });
});

describe("public NVR optical view selection", () => {
  it.each([
    ["T8E00", "Synthetic PoE Bullet PTZ Cam S4", [0, 1]],
    ["T8P00", "Synthetic PoE Cam E40", [0]],
    ["T8P10", "Synthetic PoE Cam E41", [0]],
    ["T8162", "Synthetic eufyCam paired to an NVR", [0]],
    ["T8214", "Synthetic Video Doorbell paired to an NVR", [0]],
  ] as const)("reports the supported views for %s", async (model, name, views) => {
    const { client, internals } = fixture(model, name);
    try {
      const camera = (await client.getDevice(CAMERA)).camera!()!;
      expect(camera.views?.()).toEqual(views);
    } finally {
      internals.rtc.close();
    }
  });

  it("isolates optical views while sharing repeated consumers and video readables of the same view", async () => {
    vi.useFakeTimers();
    const sessions: RtcSession[] = [];
    vi.spyOn(RtcSession.prototype, "connect").mockImplementation(async function (this: RtcSession) {
      sessions.push(this);
      this.emit("connected");
    });
    const sent = vi.spyOn(RtcSession.prototype, "sendCommand").mockReturnValue(true);
    const closed = vi.spyOn(RtcSession.prototype, "close");
    const { client, internals } = fixture("T8E00", "Synthetic PoE Bullet PTZ Cam S4");
    let readable: import("node:stream").Readable | undefined;
    try {
      const camera = (await client.getDevice(CAMERA)).camera!()!;
      const primary = await camera.live!();
      const repeated = await camera.live!({ view: 0 });
      const secondary = await camera.live!({ view: 1 });
      readable = await camera.openReadable!({ view: 1, objectMode: true });
      expect(sessions).toHaveLength(2);
      const starts = sent.mock.calls.filter(([packet]) => JSON.parse(packet.subarray(16).toString()).cmd === 1003);
      expect(starts.map(([packet]) => JSON.parse(packet.subarray(16).toString()).payload.chn_list[0].sensor)).toEqual([
        0, 1,
      ]);
      const primaryFrames = vi.fn(),
        secondaryFrames = vi.fn(),
        readableFrames = vi.fn();
      primary.on("video", primaryFrames);
      secondary.on("video", secondaryFrames);
      readable.on("data", readableFrames);
      const fixed = viewFrame(1),
        movable = viewFrame(2);
      sessions[0]!.emit("mediaData", fixed);
      sessions[1]!.emit("mediaData", movable);
      await new Promise<void>((resolve) => process.nextTick(resolve));
      expect(primaryFrames.mock.calls.map(([frame]) => frame.data)).toEqual([fixed.subarray(38)]);
      expect(secondaryFrames.mock.calls.map(([frame]) => frame.data)).toEqual([movable.subarray(38)]);
      expect(readableFrames.mock.calls.map(([frame]) => frame.data)).toEqual([movable.subarray(38)]);
      primary.stop();
      await vi.advanceTimersByTimeAsync(8001);
      expect(closed.mock.contexts).not.toContain(sessions[0]);
      repeated.stop();
      await vi.advanceTimersByTimeAsync(8001);
      expect(closed.mock.contexts).toContain(sessions[0]);
      expect(closed.mock.contexts).not.toContain(sessions[1]);
      sessions[1]!.emit("mediaData", movable);
      expect(secondaryFrames).toHaveBeenCalledTimes(2);
      secondary.stop();
    } finally {
      readable?.destroy();
      internals.rtc.close();
      vi.useRealTimers();
    }
  });

  it.each(["live", "openReadable"] as const)("refuses a second E40 view before %s opens a session", async (method) => {
    const connected = vi.spyOn(RtcSession.prototype, "connect").mockImplementation(async function (this: RtcSession) {
      this.emit("connected");
    });
    vi.spyOn(RtcSession.prototype, "sendCommand").mockReturnValue(true);
    const { client, internals } = fixture("T8P00", "Synthetic PoE Cam E40");
    try {
      const camera = (await client.getDevice(CAMERA)).camera!()!;
      await expect(camera[method]!({ view: 1 })).rejects.toThrow(RangeError);
      expect(connected).not.toHaveBeenCalled();
    } finally {
      internals.rtc.close();
    }
  });

  it("selects the requested optical view for a fresh snapshot", async () => {
    vi.spyOn(RtcSession.prototype, "connect").mockImplementation(async function (this: RtcSession) {
      this.emit("connected");
    });
    const sent = vi.spyOn(RtcSession.prototype, "sendCommand").mockReturnValue(true);
    vi.spyOn(snapshots, "captureSnapshotFromShared").mockImplementation(async (source) => {
      const consumer = source.attach();
      consumer.stop();
      return { jpeg: Buffer.from("synthetic"), width: 1, height: 1 };
    });
    const { client, internals } = fixture("T8E00", "Synthetic PoE Bullet PTZ Cam S4");
    try {
      const camera = (await client.getDevice(CAMERA)).camera!()!;
      await camera.snapshotLive!({ view: 1 });
      expect(JSON.parse(sent.mock.calls[0]![0].subarray(16).toString()).payload.chn_list[0].sensor).toBe(1);
    } finally {
      internals.rtc.close();
    }
  });

  it("does not substitute a primary-view stored thumbnail when another view's snapshot fails", async () => {
    const failure = new LiveSnapshotUnavailableError("no-keyframe", "synthetic acquisition failure");
    vi.spyOn(snapshots, "captureSnapshotFromShared").mockRejectedValue(failure);
    const { client, internals } = fixture("T8E00", "Synthetic PoE Bullet PTZ Cam S4");
    const stored = vi
      .fn()
      .mockResolvedValue(encodeJpeg({ data: Buffer.from([0, 0, 0, 255]), width: 1, height: 1 }, 50).data);
    vi.spyOn(internals.mega, "loggedIn", "get").mockReturnValue(true);
    internals.storedImages = { snapshotStored: stored };
    try {
      const camera = (await client.getDevice(CAMERA)).camera!()!;
      await expect(camera.snapshotLive!({ view: 1 })).rejects.toBe(failure);
      expect(stored).not.toHaveBeenCalled();
    } finally {
      internals.rtc.close();
    }
  });
});
