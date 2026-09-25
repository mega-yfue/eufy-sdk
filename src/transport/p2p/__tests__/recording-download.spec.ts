import { EventEmitter } from "node:events";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingDownloadError } from "../../../core/contracts.js";
import { parseAdtsHeader, isSupportedAdts } from "../adts.js";
import { buildStringPairCommandPayload, decryptP2PData } from "../codec.js";
import { decodeRecording, homeBase2RecordingPath, receiveRecording } from "../recording-download.js";
import type { P2PSession } from "../p2p-session.js";
import { IDR, audioFrame, camera, keyframe, plainFrame, slice } from "./recording-fixtures.js";

describe("recording download", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds the HomeBase 2 path from the channel and the pushed recording name", () => {
    expect(homeBase2RecordingPath(2, "20260101120000")).toBe("/media/mmcblk0p1/Camera02/20260101120000.dat");
    expect(homeBase2RecordingPath(0, "../../etc/passwd")).toBeUndefined();
    expect(homeBase2RecordingPath(0, "2026010112000")).toBeUndefined();
    expect(homeBase2RecordingPath(100, "20260101120000")).toBeUndefined();
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
    const aac = [Buffer.alloc(180, 1), Buffer.alloc(190, 2), Buffer.alloc(170, 3)];
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

    const out = decodeRecording(frames, eccHex);

    expect(out.video).toEqual(Buffer.concat([IDR, slice(1), slice(2), IDR, slice(4)]));
    expect(out).toMatchObject({ frames: 5, missingFrames: 0, durationMs: 267 });
    expect(out.fps).toBeCloseTo(4 / 0.267, 1);
    let offset = 0;
    for (const payload of aac) {
      const header = parseAdtsHeader(out.audio!, offset)!;
      expect(isSupportedAdts(header)).toBe(true);
      expect(out.audio!.subarray(offset + header.headerLength, offset + header.frameLength)).toEqual(payload);
      offset += header.frameLength;
    }
    expect(offset).toBe(out.audio!.length);
  });

  it("counts the frames the camera numbered but that never arrived", () => {
    const { eccHex, publicKey } = camera();
    const key = randomBytes(32);
    const out = decodeRecording(
      [keyframe(key, publicKey, IDR, 10, 0), plainFrame(slice(1), 11, 67), plainFrame(slice(2), 14, 267)],
      eccHex,
    );

    expect(out).toMatchObject({ frames: 3, missingFrames: 2 });
  });

  it("drops a keyframe sealed for another camera, and the audio that depends on it", () => {
    const { eccHex } = camera();
    const other = camera();
    const key = randomBytes(32);
    const out = decodeRecording(
      [keyframe(key, other.publicKey, IDR, 0, 0), audioFrame(key, Buffer.alloc(100, 1)), plainFrame(slice(1), 1, 67)],
      eccHex,
    );

    expect(out.video).toEqual(slice(1));
    expect(out.audio).toBeUndefined();
  });

  it("answers undecodable when no video frame decodes", () => {
    const { eccHex } = camera();
    const other = camera();

    expect(() => decodeRecording([keyframe(randomBytes(32), other.publicKey, IDR, 0, 0)], eccHex)).toThrow(
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
    const media = (commandId: number, dataType: number, raw = Buffer.alloc(30)) => ({
      commandId,
      dataType,
      signCode: 0,
      raw,
    });

    it("sends the request on the camera channel and collects frames until the finish frame", async () => {
      const session = station((s) => {
        s.emit("data", media(1300, 3));
        s.emit("data", media(1301, 3));
        s.emit("data", media(1300, 1));
        s.emit("data", media(1304, 3));
      });

      const transfer = await receiveRecording(session as unknown as P2PSession, {
        path: "/media/mmcblk0p1/Camera01/20260101120000.dat",
        accountId: "0".repeat(40),
        channel: 1,
      });

      expect(session.sent).toEqual([[1024, "/media/mmcblk0p1/Camera01/20260101120000.dat", "0".repeat(40), 1]]);
      expect(transfer.finished).toBe(true);
      expect(transfer.frames.map((f) => f.commandId)).toEqual([1300, 1301]);
      expect(session.listenerCount("data")).toBe(0);
    });

    it("answers no-data when the station sends nothing", async () => {
      vi.useFakeTimers();
      const session = station(() => undefined);
      const transfer = receiveRecording(session as unknown as P2PSession, { path: "/p", accountId: "", channel: 0 });
      const settled = expect(transfer).rejects.toThrow(RecordingDownloadError);
      await vi.advanceTimersByTimeAsync(21_000);
      await settled;
      await expect(transfer).rejects.toMatchObject({ reason: "no-data" });
    });

    it("answers refused on a negative command result before any frame", async () => {
      const session = station((s) => s.emit("commandResult", { code: -104, channel: 0 }));

      await expect(
        receiveRecording(session as unknown as P2PSession, { path: "/p", accountId: "", channel: 0 }),
      ).rejects.toMatchObject({ reason: "refused" });
    });

    it("ends a transfer whose finish frame never arrives once the station goes quiet", async () => {
      vi.useFakeTimers();
      const session = station((s) => s.emit("data", media(1300, 3)));
      const transfer = receiveRecording(session as unknown as P2PSession, { path: "/p", accountId: "", channel: 0 });
      await vi.advanceTimersByTimeAsync(16_000);

      await expect(transfer).resolves.toMatchObject({ finished: false, frames: [expect.anything()] });
    });
  });
});
