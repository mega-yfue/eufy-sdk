import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { P2PRouterDeps } from "../command-router.js";
import {
  IDR,
  adts,
  camera,
  clearAudioFrame,
  clearVideoFrame,
  keyframe,
  plainFrame,
  slice,
} from "./recording-fixtures.js";
import { ACCOUNT_ID, DEVICE_SN, STATION_SN, connectedSession, routerWithSession } from "./session-fixtures.js";

const RECORDING = "20260101120000";
const CIPHER_ID = 7;
/** A recording name the fake HomeBase 3 holds no recording under when told so. */
const MISSING = "20260101130000";

/**
 * A router over a fake HomeBase 2 session that answers a download request with one recording, a keyframe at
 * 5 ms then a plain frame and the finish frame at 25 ms, and a cipher lookup that knows only
 * {@link CIPHER_ID}. The finish frame is tagged with the camera's channel unless `opts.finishChannel` names
 * another. `transfers.peak` counts requests the station was serving at once.
 */
function homeBase2(deps: Partial<P2PRouterDeps> = {}, opts: { finish?: boolean; finishChannel?: number } = {}) {
  const cam = camera();
  const key = randomBytes(32);
  const session = connectedSession();
  const sent: unknown[][] = [];
  const transfers = { active: 0, peak: 0 };
  const media = (frame: { commandId: number; signCode: number; raw: Buffer }, channel: number) =>
    session.emit("data", { ...frame, dataType: 3, channel });
  Object.assign(session, {
    sendStringPairCommand: vi.fn((...args: unknown[]) => {
      sent.push(args);
      transfers.peak = Math.max(transfers.peak, ++transfers.active);
      const channel = args[3] as number;
      setTimeout(() => media(keyframe(key, cam.publicKey, IDR, 0, 0), channel), 5);
      setTimeout(() => {
        media(plainFrame(slice(1), 1, 67), channel);
        transfers.active--;
        if (opts.finish === false) return;
        session.emit("data", {
          commandId: 1304,
          dataType: 2,
          signCode: 0,
          raw: Buffer.alloc(0),
          channel: opts.finishChannel ?? channel,
        });
      }, 25);
    }),
  });
  const getCiphers = vi.fn(async (ids: number[]) =>
    ids[0] === CIPHER_ID ? [{ cipher_id: CIPHER_ID, ecc_private_key: cam.eccHex }] : [],
  );
  const router = routerWithSession(session, { deps: { mega: { getCiphers } as never, ...deps } });
  return { media: router.mediaProviderFor(DEVICE_SN), session, sent, getCiphers, transfers };
}

/**
 * A router over a fake HomeBase 3 session that answers a download request with result code 0 at 1 ms, then one
 * recording in the clear, a keyframe and an audio frame at 5 ms then a plain frame at 25 ms, followed by the
 * finish frame tagged with channel 255. A request for `opts.missing` is answered only with result code -111.
 */
function homeBase3(opts: { missing?: string } = {}) {
  const session = connectedSession();
  const sent: unknown[][] = [];
  const media = (frame: { commandId: number; signCode: number; raw: Buffer }, channel: number) =>
    session.emit("data", { ...frame, dataType: 3, channel });
  Object.assign(session, {
    sendStringPairCommand: vi.fn((...args: unknown[]) => {
      sent.push(args);
      const channel = args[3] as number;
      const missing = opts.missing !== undefined && String(args[1]).includes(opts.missing);
      const reply = Buffer.alloc(132);
      reply.writeInt32LE(missing ? -111 : 0);
      setTimeout(
        () => session.emit("data", { commandId: 1024, dataType: 0, signCode: 0, raw: reply, data: reply, channel }),
        1,
      );
      if (missing) return;
      setTimeout(() => {
        media(clearVideoFrame(IDR, true, 0, 0), channel);
        media(clearAudioFrame(adts(180, 1)), channel);
      }, 5);
      setTimeout(() => {
        media(clearVideoFrame(slice(1), false, 1, 67), channel);
        session.emit("data", { commandId: 1304, dataType: 2, signCode: 0, raw: Buffer.alloc(0), channel: 255 });
      }, 25);
    }),
  });
  const getCiphers = vi.fn(async () => []);
  const router = routerWithSession(session, { deps: { mega: { getCiphers } as never, ...attachedTo("T8030") } });
  return { media: router.mediaProviderFor(DEVICE_SN), sent, getCiphers };
}

/** The fixture's camera, attached to a station of `model`. */
function attachedTo(model: string): Partial<P2PRouterDeps> {
  return {
    listDevices: () =>
      [
        {
          sn: DEVICE_SN,
          stationSn: STATION_SN,
          channel: 1,
          raw: { parent_sn: STATION_SN, device_channel: 1, member: { admin_user_id: ACCOUNT_ID } },
        },
        { sn: STATION_SN, stationSn: STATION_SN, model, raw: {} },
      ] as never,
  };
}

describe("recording download through the router", () => {
  it("requests the camera's recording on its channel, as the station admin, and decodes it", async () => {
    const { media, sent, getCiphers } = homeBase2();

    const out = await media.downloadRecording!({ recording: RECORDING, cipherId: CIPHER_ID });

    expect(sent).toEqual([[1024, `/media/mmcblk0p1/Camera01/${RECORDING}.dat`, ACCOUNT_ID, 1]]);
    expect(getCiphers).toHaveBeenCalledWith([CIPHER_ID], ACCOUNT_ID, STATION_SN);
    expect(out.video).toEqual(Buffer.concat([IDR, slice(1)]));
    expect(out.frames).toBe(2);
  });

  it("runs one download at a time per station", async () => {
    const { media, sent, transfers } = homeBase2();

    await Promise.all([
      media.downloadRecording!({ recording: RECORDING, cipherId: CIPHER_ID }),
      media.downloadRecording!({ recording: "20260101120100", cipherId: CIPHER_ID }),
    ]);

    expect(sent).toHaveLength(2);
    expect(transfers.peak).toBe(1);
  });

  it("offers a download on a camera attached to a HomeBase 2 or 3, and on no other", () => {
    expect(homeBase2().media.downloadRecording).toBeTypeOf("function");
    expect(homeBase2(attachedTo("T8030")).media.downloadRecording).toBeTypeOf("function");
    expect(homeBase2(attachedTo("T8002")).media.downloadRecording).toBeUndefined();
    expect(
      homeBase2({
        listDevices: () => [{ sn: DEVICE_SN, stationSn: DEVICE_SN, model: "T8114", raw: {} }] as never,
      }).media.downloadRecording,
    ).toBeUndefined();
  });

  it("rejects an aborted download while it waits its turn, and the next one still waits for the first", async () => {
    const { media, sent, transfers } = homeBase2();
    const controller = new AbortController();

    const first = media.downloadRecording!({ recording: RECORDING, cipherId: CIPHER_ID });
    const queued = media.downloadRecording!({
      recording: "20260101120100",
      cipherId: CIPHER_ID,
      signal: controller.signal,
    });
    const next = media.downloadRecording!({ recording: "20260101120200", cipherId: CIPHER_ID });
    const reason = new Error("stop");
    controller.abort(reason);

    await expect(queued).rejects.toBe(reason);
    await Promise.all([first, next]);
    expect(sent.map((args) => args[1])).toEqual([
      `/media/mmcblk0p1/Camera01/${RECORDING}.dat`,
      "/media/mmcblk0p1/Camera01/20260101120200.dat",
    ]);
    expect(transfers.peak).toBe(1);
  });

  it("keeps the station's turn when a queued download is aborted before the next one is asked for", async () => {
    const { media, sent, transfers } = homeBase2();
    const controller = new AbortController();

    const first = media.downloadRecording!({ recording: RECORDING, cipherId: CIPHER_ID });
    const queued = media.downloadRecording!({
      recording: "20260101120100",
      cipherId: CIPHER_ID,
      signal: controller.signal,
    });
    const reason = new Error("stop");
    controller.abort(reason);
    await expect(queued).rejects.toBe(reason);
    const next = media.downloadRecording!({ recording: "20260101120200", cipherId: CIPHER_ID });

    await Promise.all([first, next]);
    expect(sent).toHaveLength(2);
    expect(transfers.peak).toBe(1);
  });

  it("rejects an abort mid-transfer at once, and the next download waits for the station to finish", async () => {
    const { media, session, sent, transfers } = homeBase2();
    const controller = new AbortController();
    const reason = new Error("stop");
    session.once("data", () => controller.abort(reason));

    const first = media.downloadRecording!({ recording: RECORDING, cipherId: CIPHER_ID, signal: controller.signal });
    await expect(first).rejects.toBe(reason);
    expect(transfers.active).toBe(1);
    const next = await media.downloadRecording!({ recording: "20260101120100", cipherId: CIPHER_ID });

    expect(next.video).toEqual(Buffer.concat([IDR, slice(1)]));
    expect(sent).toHaveLength(2);
    expect(transfers.peak).toBe(1);
  });

  it("rejects incomplete when the station stops without its finish frame", async () => {
    vi.useFakeTimers();
    try {
      const { media } = homeBase2({}, { finish: false });

      const download = media.downloadRecording!({ recording: RECORDING, cipherId: CIPHER_ID });
      const settled = expect(download).rejects.toMatchObject({ reason: "incomplete" });
      await vi.advanceTimersByTimeAsync(16_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("ends a HomeBase 2 download on a finish frame tagged with channel 0", async () => {
    vi.useFakeTimers();
    try {
      const { media } = homeBase2({}, { finishChannel: 0 });

      const download = media.downloadRecording!({ recording: RECORDING, cipherId: CIPHER_ID });
      await vi.advanceTimersByTimeAsync(100);

      await expect(download).resolves.toMatchObject({ frames: 2, missingFrames: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a recording name the station could not hold", async () => {
    const { media, sent } = homeBase2();

    await expect(media.downloadRecording!({ recording: "../x", cipherId: CIPHER_ID })).rejects.toMatchObject({
      reason: "invalid-recording",
    });
    expect(sent).toHaveLength(0);
  });

  it("refuses when the recording's cipher cannot be obtained", async () => {
    const { media, sent } = homeBase2();

    await expect(media.downloadRecording!({ recording: RECORDING, cipherId: CIPHER_ID + 1 })).rejects.toMatchObject({
      reason: "key-unavailable",
    });
    expect(sent).toHaveLength(0);
  });

  it("requests a HomeBase 3 recording by the path it builds, reads no cipher, and decodes it in the clear", async () => {
    vi.useFakeTimers();
    try {
      const { media, sent, getCiphers } = homeBase3();

      const download = media.downloadRecording!({ recording: RECORDING, cipherId: 0 });
      await vi.advanceTimersByTimeAsync(100);
      const out = await download;

      expect(sent).toEqual([[1024, `/zx/emmcdata/Camera01/202601/${RECORDING}/${RECORDING}.zxvideo`, ACCOUNT_ID, 1]]);
      expect(getCiphers).not.toHaveBeenCalled();
      expect(out.video).toEqual(Buffer.concat([IDR, slice(1)]));
      expect(out.audio).toEqual(adts(180, 1));
      expect(out).toMatchObject({ frames: 2, missingFrames: 0, durationMs: 67 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a recording a HomeBase 3 does not hold at once, and the next download takes its turn", async () => {
    vi.useFakeTimers();
    try {
      const { media, sent } = homeBase3({ missing: MISSING });

      const outcomes = Promise.allSettled([
        media.downloadRecording!({ recording: MISSING, cipherId: 0 }),
        media.downloadRecording!({ recording: RECORDING, cipherId: 0 }),
      ]);
      await vi.advanceTimersByTimeAsync(100);
      const [missing, held] = await Promise.race([outcomes, Promise.resolve([])]);

      expect(missing).toMatchObject({ status: "rejected", reason: { reason: "no-data" } });
      expect(held).toMatchObject({ status: "fulfilled", value: { frames: 2 } });
      expect(sent.map((args) => args[1])).toEqual([
        `/zx/emmcdata/Camera01/202601/${MISSING}/${MISSING}.zxvideo`,
        `/zx/emmcdata/Camera01/202601/${RECORDING}/${RECORDING}.zxvideo`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads no cipher on a HomeBase 3 whatever cipher id the caller passes", async () => {
    const { media, getCiphers } = homeBase3();

    const out = await media.downloadRecording!({ recording: RECORDING, cipherId: CIPHER_ID });

    expect(out).toMatchObject({ frames: 2 });
    expect(getCiphers).not.toHaveBeenCalled();
  });

  it("refuses a HomeBase 3 recording name that is not a bare start stamp", async () => {
    const { media, sent } = homeBase3();

    for (const recording of [
      `h265_${RECORDING}`,
      `${RECORDING}.zxvideo`,
      `/zx/emmcdata/Camera01/202601/${RECORDING}/${RECORDING}.zxvideo`,
    ]) {
      await expect(media.downloadRecording!({ recording, cipherId: 0 })).rejects.toMatchObject({
        reason: "invalid-recording",
      });
    }
    expect(sent).toHaveLength(0);
  });
});
