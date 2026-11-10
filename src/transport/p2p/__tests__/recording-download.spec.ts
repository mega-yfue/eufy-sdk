import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStringPairCommandPayload, decryptP2PData } from "../codec.js";
import {
  MAX_TRANSFER_BYTES,
  RECORDING_DATA_TYPE,
  RECORDING_STATIONS,
  decodeRecording,
  homeBase2RecordingPath,
  homeBase3RecordingPath,
  receiveRecording,
} from "../recording-download.js";
import type { P2PSession } from "../p2p-session.js";
import {
  IDR,
  adts,
  adtsHeader,
  audioFrame,
  camera,
  clearAudioFrame,
  clearVideoFrame,
  keyframe,
  plainFrame,
  slice,
} from "./recording-fixtures.js";

const HB2 = RECORDING_STATIONS.get("T8010")!;
const HB3 = RECORDING_STATIONS.get("T8030")!;

/** An H.265 IDR access unit: VPS, SPS and PPS ahead of an IDR_W_RADL slice. */
const HEVC_IDR = Buffer.from("00000001400101000000014201010000000144010000000126010000", "hex");
/** An H.265 TRAIL_R slice numbered `n`. */
const hevcSlice = (n: number) => Buffer.concat([Buffer.from("000000010201", "hex"), Buffer.alloc(40, n)]);

describe("recording download", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds the HomeBase 2 path from the channel and a recording name", () => {
    expect(homeBase2RecordingPath(2, "20260101120000")).toBe("/media/mmcblk0p1/Camera02/20260101120000.dat");
    expect(homeBase2RecordingPath(0, "h265_20260101120000")).toBe("/media/mmcblk0p1/Camera00/h265_20260101120000.dat");
    expect(homeBase2RecordingPath(0, "../../etc/passwd")).toBeUndefined();
    expect(homeBase2RecordingPath(0, "2026010112000")).toBeUndefined();
    expect(homeBase2RecordingPath(100, "20260101120000")).toBeUndefined();
  });

  it("builds the HomeBase 3 path from the channel and a recording name", () => {
    expect(homeBase3RecordingPath(2, "20260101120000")).toBe(
      "/zx/emmcdata/Camera02/202601/20260101120000/20260101120000.zxvideo",
    );
    expect(homeBase3RecordingPath(0, "20261231235959")).toBe(
      "/zx/emmcdata/Camera00/202612/20261231235959/20261231235959.zxvideo",
    );
    expect(homeBase3RecordingPath(12, "20260201000000")).toBe(
      "/zx/emmcdata/Camera12/202602/20260201000000/20260201000000.zxvideo",
    );
    for (const recording of [
      "h265_20260101120000",
      "20260101120000.zxvideo",
      "/zx/emmcdata/Camera02/202601/20260101120000/20260101120000.zxvideo",
      "../../etc/passwd",
      "2026010112000",
      "202601011200000",
    ]) {
      expect(homeBase3RecordingPath(2, recording)).toBeUndefined();
    }
    expect(homeBase3RecordingPath(100, "20260101120000")).toBeUndefined();
  });

  it("frames the request as five zero bytes and two 128-byte strings, level-1 encrypted", () => {
    const key = Buffer.alloc(16, 3);
    const body = buildStringPairCommandPayload("/media/x.dat", "0".repeat(40), 1, key);
    const data = body.subarray(10);

    expect(body.readUInt16LE(0)).toBe(data.length);
    expect([...body.subarray(6, 8)]).toEqual([1, 1]);
    const plain = decryptP2PData(data, key);
    expect(plain.subarray(0, 5)).toEqual(Buffer.alloc(5));
    expect(plain.subarray(5, 17).toString()).toBe("/media/x.dat");
    expect(plain.subarray(133, 173).toString()).toBe("0".repeat(40));
    expect(data.length).toBe(272);
  });

  it("decodes keyframes, plaintext frames and the audio sealed under the keyframe's media key", () => {
    const { eccHex, publicKey } = camera();
    const first = randomBytes(32);
    const second = randomBytes(32);
    const aac = [180, 190, 170].map((n, i) => Buffer.concat([adtsHeader(n), Buffer.alloc(n, i + 1)]));
    const frames = [
      keyframe(first, publicKey, IDR, 0, 1_000),
      audioFrame(first, aac[0]!),
      plainFrame(slice(1), 1, 1_067),
      plainFrame(slice(2), 2, 1_133),
      keyframe(second, publicKey, IDR, 3, 1_200),
      audioFrame(second, aac[1]!),
      plainFrame(slice(4), 4, 1_267),
      audioFrame(second, aac[2]!),
    ];

    const out = decodeRecording(frames, HB2, eccHex);

    expect(out.video).toEqual(Buffer.concat([IDR, slice(1), slice(2), IDR, slice(4)]));
    expect(out).toMatchObject({ codec: "h264", frames: 5, missingFrames: 0, durationMs: 267 });
    expect(out.fps).toBeCloseTo(4 / 0.267, 1);
    expect(out.audio).toEqual(Buffer.concat(aac));
  });

  it("decodes a recording stored in the clear, keyframes and audio included, without a key", () => {
    const frames = [
      clearVideoFrame(IDR, true, 0, 1_000),
      clearAudioFrame(adts(180, 1)),
      clearVideoFrame(slice(1), false, 1, 1_067),
      clearVideoFrame(slice(2), false, 2, 1_133),
      clearAudioFrame(adts(170, 3), 7),
      clearVideoFrame(IDR, true, 3, 1_200),
      clearAudioFrame(adts(190, 2)),
    ];

    const out = decodeRecording(frames, HB3);

    expect(out.video).toEqual(Buffer.concat([IDR, slice(1), slice(2), IDR]));
    expect(out).toMatchObject({ codec: "h264", frames: 4, missingFrames: 0, durationMs: 200, fps: 15 });
    expect(out.audio).toEqual(Buffer.concat([adts(180, 1), adts(190, 2)]));
  });

  it("decodes an H.265 recording stored in the clear", () => {
    const out = decodeRecording(
      [clearVideoFrame(HEVC_IDR, true, 0, 0), clearVideoFrame(hevcSlice(1), false, 1, 67)],
      HB3,
    );

    expect(out.video).toEqual(Buffer.concat([HEVC_IDR, hevcSlice(1)]));
    expect(out).toMatchObject({ codec: "h265", frames: 2, missingFrames: 0, durationMs: 67 });
  });

  it("names the codec from a keyframe, not from a P-frame whose header byte reads as an H.265 VPS", () => {
    const delta = Buffer.from([0, 0, 0, 1, 0x41, 0x9a, 0x02]);

    expect(decodeRecording([clearVideoFrame(delta, false, 0, 0)], HB3).codec).toBeUndefined();
    expect(decodeRecording([clearVideoFrame(delta, false, 0, 0), clearVideoFrame(IDR, true, 1, 67)], HB3).codec).toBe(
      "h264",
    );
  });

  it("joins a HomeBase 3 keyframe split at 400000 bytes", () => {
    const head = Buffer.concat([IDR, Buffer.alloc(400_000 - IDR.length, 0x11)]);
    const tail = Buffer.alloc(62_076, 0x22);

    const out = decodeRecording(
      [clearVideoFrame(head, true, 0, 0), clearVideoFrame(tail, true, 0, 0), clearVideoFrame(slice(1), false, 1, 67)],
      HB3,
    );

    expect(out.video).toEqual(Buffer.concat([head, tail, slice(1)]));
    expect(out).toMatchObject({ frames: 2, missingFrames: 0, durationMs: 67 });
  });

  it("drops a sealed keyframe from a station that stores in the clear", () => {
    const { publicKey } = camera();
    const key = randomBytes(32);

    expect(
      decodeRecording([keyframe(key, publicKey, IDR, 0, 0), clearVideoFrame(slice(1), false, 1, 67)], HB3).video,
    ).toEqual(slice(1));
    expect(() => decodeRecording([keyframe(key, publicKey, IDR, 0, 0)], HB3)).toThrow(
      expect.objectContaining({ reason: "undecodable" }),
    );
  });

  it("counts the frames the camera numbered but that never arrived", () => {
    const { eccHex, publicKey } = camera();
    const key = randomBytes(32);
    const out = decodeRecording(
      [keyframe(key, publicKey, IDR, 10, 0), plainFrame(slice(1), 11, 67), plainFrame(slice(2), 14, 267)],
      HB2,
      eccHex,
    );

    expect(out).toMatchObject({ frames: 3, missingFrames: 2 });
  });

  it("joins split pictures and omits a continuation whose opening frame was lost", () => {
    const { eccHex, publicKey } = camera();
    const key = randomBytes(32);
    const head = Buffer.concat([slice(1), Buffer.alloc(64_000 - slice(1).length, 0x11)]);
    const tail = Buffer.alloc(19, 0x22);
    const frames = [
      keyframe(key, publicKey, IDR, 0, 0),
      plainFrame(head, 1, 67),
      plainFrame(tail, 1, 67),
      plainFrame(Buffer.alloc(20, 0x33), 2, 134),
      plainFrame(slice(3), 3, 201),
    ];

    const out = decodeRecording(frames, HB2, eccHex);

    expect(out.video).toEqual(Buffer.concat([IDR, head, tail, slice(3)]));
    expect(out).toMatchObject({ frames: 3, missingFrames: 1 });
  });

  it("omits a split picture when its final chunk never arrived", () => {
    const { eccHex, publicKey } = camera();
    const key = randomBytes(32);
    const head = Buffer.concat([slice(1), Buffer.alloc(64_000 - slice(1).length, 0x11)]);
    const out = decodeRecording(
      [keyframe(key, publicKey, IDR, 0, 0), plainFrame(head, 1, 67), plainFrame(slice(2), 2, 134)],
      HB2,
      eccHex,
    );

    expect(out.video).toEqual(Buffer.concat([IDR, slice(2)]));
    expect(out).toMatchObject({ frames: 2, missingFrames: 1 });
  });

  it("drops a keyframe sealed for another camera, and the audio that depends on it", () => {
    const { eccHex } = camera();
    const other = camera();
    const key = randomBytes(32);
    const out = decodeRecording(
      [keyframe(key, other.publicKey, IDR, 0, 0), audioFrame(key, Buffer.alloc(100, 1)), plainFrame(slice(1), 1, 67)],
      HB2,
      eccHex,
    );

    expect(out.video).toEqual(slice(1));
    expect(out.codec).toBeUndefined();
    expect(out.audio).toBeUndefined();
  });

  it("counts first/interior orphans and a full terminal group once", () => {
    const { eccHex, publicKey } = camera();
    const key = randomBytes(32);
    const stamp = 0xffffffff - 100;
    const full = Buffer.concat([IDR, Buffer.alloc(64_000 - IDR.length, 1)]);
    const terminal = keyframe(key, publicKey, full, 4, stamp + 268);
    const out = decodeRecording(
      [
        keyframe(key, publicKey, Buffer.alloc(64_000, 0x33), 0, stamp),
        keyframe(key, publicKey, Buffer.alloc(9_000, 0x44), 0, stamp),
        keyframe(key, publicKey, IDR, 1, stamp + 67),
        keyframe(key, publicKey, Buffer.alloc(64_000, 0x33), 2, stamp + 134),
        keyframe(key, publicKey, Buffer.alloc(64_000, 0x44), 2, stamp + 134),
        keyframe(key, publicKey, Buffer.alloc(9_000, 0x55), 2, stamp + 134),
        keyframe(key, publicKey, IDR, 3, stamp + 201),
        terminal,
      ],
      HB2,
      eccHex,
    );

    expect(out.video).toEqual(Buffer.concat([IDR, IDR]));
    expect(out).toMatchObject({ frames: 2, missingFrames: 3, durationMs: 134 });
  });

  it("answers undecodable when no video frame decodes", () => {
    const { eccHex } = camera();
    const other = camera();

    expect(() => decodeRecording([keyframe(randomBytes(32), other.publicKey, IDR, 0, 0)], HB2, eccHex)).toThrow(
      expect.objectContaining({ reason: "undecodable" }),
    );
  });

  describe("transfer", () => {
    /** A session double that answers the download request with `reply`, and records what was sent. */
    function station(reply: (session: EventEmitter) => void) {
      const session = new EventEmitter() as EventEmitter & { sent: unknown[]; sendStringPairCommand: unknown };
      session.sent = [];
      session.sendStringPairCommand = (...args: unknown[]) => {
        session.sent.push(args);
        queueMicrotask(() => reply(session));
      };
      return session;
    }
    const frame = (commandId: number, opts: { dataType?: number; channel?: number; raw?: Buffer } = {}) => ({
      commandId,
      dataType: opts.dataType ?? RECORDING_DATA_TYPE,
      channel: opts.channel ?? 0,
      signCode: 0,
      raw: opts.raw ?? Buffer.alloc(30, commandId & 0xff),
    });
    const request = { path: "/p", accountId: "", channel: 0, finishChannel: 0 };

    it("sends the request on the camera channel and keeps only that channel's recording frames", async () => {
      const session = station((s) => {
        s.emit("data", frame(1300, { channel: 1 }));
        s.emit("data", frame(1300, { channel: 1, dataType: 1 }));
        s.emit("data", frame(1300, { channel: 2 }));
        s.emit("data", frame(1301, { channel: 1 }));
        s.emit("data", frame(1301, { channel: 1, dataType: 1 }));
        s.emit("data", frame(1304, { channel: 2 }));
        s.emit("data", frame(1300, { channel: 1 }));
        s.emit("data", frame(1304, { channel: 1, dataType: 2 }));
      });

      const transfer = receiveRecording(session as unknown as P2PSession, {
        path: "/media/mmcblk0p1/Camera01/20260101120000.dat",
        accountId: "0".repeat(40),
        channel: 1,
        finishChannel: 0,
      });
      const frames = await transfer.frames;
      await transfer.drained;

      expect(session.sent).toEqual([[1024, "/media/mmcblk0p1/Camera01/20260101120000.dat", "0".repeat(40), 1]]);
      expect(frames.map((f) => f.commandId)).toEqual([1300, 1301, 1300]);
      expect(session.listenerCount("data")).toBe(0);
    });

    it("ends on the finish frame tagged with channel 0, for a camera on channel 1", async () => {
      vi.useFakeTimers();
      const session = station((s) => {
        s.emit("data", frame(1300, { channel: 1 }));
        s.emit("data", frame(1301, { channel: 1 }));
        s.emit("data", frame(1304, { channel: 0, dataType: 2 }));
      });

      const transfer = receiveRecording(session as unknown as P2PSession, { ...request, channel: 1 });
      const outcome = transfer.frames.then(
        (frames) => frames.map((f) => f.commandId),
        (error: { reason?: string }) => error.reason,
      );
      await vi.advanceTimersByTimeAsync(16_000);

      expect(await outcome).toEqual([1300, 1301]);
      expect(session.listenerCount("data")).toBe(0);
    });

    it("ends on the finish frame tagged with the station channel when the station tags it there", async () => {
      vi.useFakeTimers();
      const session = station((s) => {
        s.emit("data", frame(1300, { channel: 1 }));
        s.emit("data", frame(1301, { channel: 1 }));
        s.emit("data", frame(1304, { channel: 255, dataType: 2 }));
      });

      const transfer = receiveRecording(session as unknown as P2PSession, {
        ...request,
        channel: 1,
        finishChannel: 255,
      });
      const outcome = transfer.frames.then(
        (frames) => frames.map((f) => f.commandId),
        (error: { reason?: string }) => error.reason,
      );
      await vi.advanceTimersByTimeAsync(100);

      expect(await outcome).toEqual([1300, 1301]);
      expect(session.listenerCount("data")).toBe(0);
    });

    it("answers no-data when the station sends nothing", async () => {
      vi.useFakeTimers();
      const session = station(() => undefined);
      const transfer = receiveRecording(session as unknown as P2PSession, request);
      const settled = expect(transfer.frames).rejects.toMatchObject({ reason: "no-data" });
      await vi.advanceTimersByTimeAsync(21_000);
      await settled;
    });

    it("answers no-data at once when the station replies that it holds no such recording, and stops listening", async () => {
      vi.useFakeTimers();
      const reply = (data: Buffer) => ({ commandId: 1024, dataType: 0, channel: 0, signCode: 0, raw: data, data });
      const missing = Buffer.alloc(132);
      missing.writeInt32LE(-111);
      const session = station((s) => {
        s.emit("data", reply(Buffer.alloc(2)));
        s.emit("data", reply(missing));
      });

      const transfer = receiveRecording(session as unknown as P2PSession, { ...request, missingCode: -111 });
      const settled = expect(transfer.frames).rejects.toMatchObject({
        reason: "no-data",
        message: "the station holds no recording at /p",
      });
      await vi.advanceTimersByTimeAsync(0);
      await settled;
      await transfer.drained;
      expect(session.listenerCount("data")).toBe(0);
    });

    it("ignores a no-such-recording reply on another channel or after the recording's frames began", async () => {
      vi.useFakeTimers();
      const reply = (channel: number) => {
        const data = Buffer.alloc(132);
        data.writeInt32LE(-111);
        return { commandId: 1024, dataType: 0, channel, signCode: 0, raw: data, data };
      };
      const session = station((s) => {
        s.emit("data", reply(1));
        s.emit("data", frame(1300));
        s.emit("data", reply(0));
        s.emit("data", frame(1301));
        s.emit("data", frame(1304, { dataType: 2 }));
      });

      const transfer = receiveRecording(session as unknown as P2PSession, { ...request, missingCode: -111 });
      await vi.advanceTimersByTimeAsync(0);

      expect((await transfer.frames).map((f) => f.commandId)).toEqual([1300, 1301]);
    });

    it("answers incomplete at the byte ceiling, and keeps listening until the station finishes", async () => {
      const half = Buffer.alloc(MAX_TRANSFER_BYTES / 2);
      let rest: (() => void) | undefined;
      const session = station((s) => {
        for (let i = 0; i < 3; i++) s.emit("data", frame(1300, { raw: half }));
        rest = () => s.emit("data", frame(1304, { dataType: 2 }));
      });

      const transfer = receiveRecording(session as unknown as P2PSession, request);
      const settled = expect(transfer.frames).rejects.toMatchObject({ reason: "incomplete" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(session.listenerCount("data")).toBe(1);
      rest!();
      await settled;
      expect(session.listenerCount("data")).toBe(0);
    });

    it("answers incomplete when the finish frame never arrives and the station goes quiet", async () => {
      vi.useFakeTimers();
      const session = station((s) => s.emit("data", frame(1300)));
      const transfer = receiveRecording(session as unknown as P2PSession, request);
      const settled = expect(transfer.frames).rejects.toMatchObject({ reason: "incomplete" });
      await vi.advanceTimersByTimeAsync(16_000);
      await settled;
      expect(session.listenerCount("data")).toBe(0);
    });

    it("answers incomplete past the time bound, once the station stops sending", async () => {
      vi.useFakeTimers();
      const session = station((s) => s.emit("data", frame(1300)));
      const transfer = receiveRecording(session as unknown as P2PSession, { ...request, timeoutMs: 5_000 });
      const settled = expect(transfer.frames).rejects.toMatchObject({ reason: "incomplete" });
      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(1_000);
        session.emit("data", frame(1300));
      }
      expect(session.listenerCount("data")).toBe(1);
      session.emit("data", frame(1304, { dataType: 2 }));
      await settled;
    });

    it("rejects at once on abort, and drains once the station finishes", async () => {
      const session = station((s) => s.emit("data", frame(1300)));
      const controller = new AbortController();
      const transfer = receiveRecording(session as unknown as P2PSession, { ...request, signal: controller.signal });
      let drained = false;
      void transfer.drained.then(() => (drained = true));
      await new Promise((resolve) => setImmediate(resolve));
      const reason = new Error("stop");
      controller.abort(reason);

      await expect(transfer.frames).rejects.toBe(reason);
      session.emit("data", frame(1300));
      await new Promise((resolve) => setImmediate(resolve));
      expect(drained).toBe(false);
      expect(session.listenerCount("data")).toBe(1);
      session.emit("data", frame(1304, { dataType: 2 }));
      await transfer.drained;
      expect(session.listenerCount("data")).toBe(0);
    });

    it("sends nothing when already aborted", async () => {
      const session = station(() => undefined);
      const reason = new Error("stop");
      const transfer = receiveRecording(session as unknown as P2PSession, {
        ...request,
        signal: AbortSignal.abort(reason),
      });

      await expect(transfer.frames).rejects.toBe(reason);
      await transfer.drained;
      expect(session.sent).toEqual([]);
      expect(session.listenerCount("data")).toBe(0);
    });
  });
});
