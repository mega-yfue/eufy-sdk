import { createECDH, randomBytes } from "node:crypto";
import { LiveStream } from "../live-stream.js";
import type { P2PSession } from "../p2p-session.js";
import { STATION_CHUNK_BYTES } from "../video.js";
import { sealBody, wrapEnvelope } from "./ecies-fixtures.js";
import { FakeP2PSession, p2pVideoFrame, START_CODE } from "./live-source-fixtures.js";

function camera() {
  const ec = createECDH("prime256v1");
  ec.generateKeys();
  const scalar = ec.getPrivateKey();
  return { privateKey: Buffer.concat([Buffer.alloc(32 - scalar.length), scalar]), publicKey: ec.getPublicKey() };
}

/** Real ECIES envelope + authenticated GCM body, with no account or captured media. */
function encryptedFrame(publicKey: Buffer, mediaKey: Buffer, plain: Buffer, full = false) {
  const header = Buffer.alloc(22);
  header.writeUInt32LE(full ? STATION_CHUNK_BYTES : plain.length, 0);
  header[4] = 1;
  header.writeUInt16LE(1920, 10);
  header.writeUInt16LE(1080, 12);
  const { tag, nonce, ct } = sealBody(mediaKey, plain);
  return {
    commandId: 1300,
    channel: 0,
    signCode: 1,
    data: Buffer.concat([header, wrapEnvelope(mediaKey, publicKey), tag, nonce, ct]),
  };
}

function stream(eccPrivateKey?: Buffer) {
  const session = new FakeP2PSession();
  const legacy = vi.spyOn(session, "decodeVideoFrame");
  const live = new LiveStream(session as unknown as P2PSession, { eccPrivateKey, keepAliveMs: 0 });
  const video = vi.fn();
  live.on("video", video);
  live.start();
  return { session, legacy, live, video };
}

describe("authenticated ECC decoder dispatch", () => {
  it("emits the authenticated frame before a truthy legacy decryption can mask it", () => {
    const cam = camera(),
      s = stream(cam.privateKey);
    s.legacy.mockReturnValue(Buffer.alloc(128, 0x7f));
    const plain = Buffer.concat([START_CODE, Buffer.from([0x65, 1, 2, 3])]);
    const frame = encryptedFrame(cam.publicKey, randomBytes(32), plain);
    expect(frame.data.length - plain.length).toBe(179);
    try {
      s.session.push(frame);
      expect(s.video).toHaveBeenCalledOnce();
      expect(s.video.mock.calls[0][0].data).toEqual(plain);
      expect(s.legacy).not.toHaveBeenCalled();
    } finally {
      s.live.stop();
    }
  });

  it("authenticates continuations before assembling a split access unit", () => {
    const cam = camera(),
      s = stream(cam.privateKey),
      mediaKey = randomBytes(32);
    s.legacy.mockReturnValue(Buffer.alloc(128, 0x7f));
    const first = Buffer.concat([START_CODE, Buffer.alloc(STATION_CHUNK_BYTES - 4, 0x65)]);
    const tail = Buffer.from([1, 2, 3]);
    try {
      s.session.push(encryptedFrame(cam.publicKey, mediaKey, first, true));
      expect(s.video).not.toHaveBeenCalled();
      s.session.push(encryptedFrame(cam.publicKey, mediaKey, tail));
      expect(s.video).toHaveBeenCalledOnce();
      expect(s.video.mock.calls[0][0].data).toEqual(Buffer.concat([first, tail]));
      expect(s.legacy).not.toHaveBeenCalled();
    } finally {
      s.live.stop();
    }
  });

  it("preserves legacy session decoding when ECC authentication fails", () => {
    const s = stream(camera().privateKey);
    const fallback = Buffer.concat([START_CODE, Buffer.from([0x65, 7])]);
    s.legacy.mockReturnValue(fallback);
    try {
      s.session.push(encryptedFrame(camera().publicKey, randomBytes(32), Buffer.from("wrong key")));
      expect(s.video.mock.calls[0][0].data).toEqual(fallback);
      expect(s.legacy).toHaveBeenCalledOnce();
    } finally {
      s.live.stop();
    }
  });

  it.each([true, false])("preserves plaintext fallback with ECC configured=%s", (configured) => {
    const s = stream(configured ? camera().privateKey : undefined);
    s.legacy.mockReturnValue(undefined);
    const frame = p2pVideoFrame({ keyframe: true, nal: Buffer.from([0x65, 8]) });
    try {
      s.session.push(frame);
      expect(s.video.mock.calls[0][0].data).toEqual(frame.data!.subarray(22));
      expect(s.legacy).toHaveBeenCalledOnce();
    } finally {
      s.live.stop();
    }
  });
});
