import { createECDH, randomBytes } from "node:crypto";
import { VideoFrameDecoder, parseVideoFrameHeader } from "../video.js";
import { sealBody, wrapEnvelope } from "./ecies-fixtures.js";

/**
 * P2P video-frame decoder (`CMD_VIDEO_FRAME` 1300).
 *
 * We do NOT have the real camera key (it is E2E vault-locked), so these tests exercise the CODE,
 * not a real frame: a synthetic "camera" P-256 keypair stands in for the get_ciphers ECC key, a
 * random 32-byte media key is ECIES-wrapped into the 129-byte envelope exactly as the station does,
 * and the H.264 body is GCM-sealed. Everything is deterministic and uses no account material.
 */
/** Assemble a full CMD_VIDEO_FRAME payload (post-XZYH). `envelope` undefined => P/B-frame. */
function assembleFrame(opts: {
  keyframe: boolean;
  envelope?: Buffer;
  nonce: Buffer;
  tag: Buffer;
  ct: Buffer;
  width?: number;
  height?: number;
}): Buffer {
  const header = Buffer.alloc(0x16);
  header.writeUInt32LE(opts.ct.length, 0x00);
  header.writeUInt8(opts.keyframe ? 0x01 : 0x00, 0x04);
  header.writeInt16LE(opts.width ?? 2304, 0x0a);
  header.writeInt16LE(opts.height ?? 1296, 0x0c);
  header.writeUInt32LE(0x12345678, 0x0e);
  const envelope = opts.keyframe ? (opts.envelope as Buffer) : Buffer.alloc(0);
  // For keyframes the envelope occupies [0x16:0x97]; for P/B-frames there is no envelope, so the
  // GCM tag/nonce/body slide up to start at 0x16. To keep fixed offsets, P/B-frames pad [0x16:0x97]
  // with zeros (the station leaves the envelope region absent, but the decoder only reads it on
  // keyframes — so the byte content there is irrelevant for P/B-frames).
  const envRegion = opts.keyframe ? envelope : Buffer.alloc(0x97 - 0x16);
  return Buffer.concat([header, envRegion, opts.tag, opts.nonce, opts.ct]);
}

describe("VideoFrameDecoder", () => {
  function newCamera(): { decoder: VideoFrameDecoder; camPub: Buffer } {
    const cam = createECDH("prime256v1");
    cam.generateKeys();
    const priv = cam.getPrivateKey();
    const priv32 = priv.length === 32 ? priv : Buffer.concat([Buffer.alloc(32 - priv.length), priv]);
    return { decoder: new VideoFrameDecoder(priv32), camPub: cam.getPublicKey() };
  }

  test("round-trip: keyframe recovers the plaintext, then a P-frame reuses the key", () => {
    const { decoder, camPub } = newCamera();
    const mediaKey = randomBytes(32);

    const kfPlain = Buffer.from("\x00\x00\x00\x01keyframe-NAL-payload");
    const kfBody = sealBody(mediaKey, kfPlain);
    const keyframe = assembleFrame({
      keyframe: true,
      envelope: wrapEnvelope(mediaKey, camPub),
      ...kfBody,
    });
    const kfOut = decoder.decodeFrame(keyframe);
    expect(kfOut?.keyframe).toBe(true);
    expect(kfOut?.h264.equals(kfPlain)).toBe(true);
    expect(kfOut?.width).toBe(2304);
    expect(kfOut?.height).toBe(1296);
    expect(decoder.currentMediaKey?.equals(mediaKey)).toBe(true);

    const pPlain = Buffer.from("\x00\x00\x00\x01p-frame-payload");
    const pBody = sealBody(mediaKey, pPlain); // same key, new nonce/tag
    const pframe = assembleFrame({ keyframe: false, ...pBody });
    const pOut = decoder.decodeFrame(pframe);
    expect(pOut?.keyframe).toBe(false);
    expect(pOut?.h264.equals(pPlain)).toBe(true);
  });

  test("a frame whose plaintext spans several update() blocks still decodes whole", () => {
    // The decrypt returns `update()`'s buffer directly and only concatenates when `final()` has bytes
    // to add — the allocation the video path pays per frame, and AES-GCM's contract says `final()` is
    // empty. This covers the fallback that contract does not guarantee: a body long enough that the
    // cipher could split it, which must come back identical either way.
    const { decoder, camPub } = newCamera();
    const mediaKey = randomBytes(32);
    const plain = Buffer.concat([Buffer.from("\x00\x00\x00\x01"), randomBytes(300_000)]);
    const out = decoder.decodeFrame(
      assembleFrame({ keyframe: true, envelope: wrapEnvelope(mediaKey, camPub), ...sealBody(mediaKey, plain) }),
    );
    expect(out?.h264.equals(plain)).toBe(true);
  });

  test("keyframe-key-reuse: one keyframe then several P-frames decode with the cached key", () => {
    const { decoder, camPub } = newCamera();
    const mediaKey = randomBytes(32);
    const kfBody = sealBody(mediaKey, Buffer.from("idr"));
    expect(
      decoder.decodeFrame(assembleFrame({ keyframe: true, envelope: wrapEnvelope(mediaKey, camPub), ...kfBody })),
    ).toBeDefined();

    for (let i = 0; i < 5; i++) {
      const plain = Buffer.from(`p-frame-${i}`);
      const body = sealBody(mediaKey, plain);
      const out = decoder.decodeFrame(assembleFrame({ keyframe: false, ...body }));
      expect(out?.h264.equals(plain)).toBe(true);
    }
  });

  test("a P/B-frame before any keyframe returns undefined (no cached key)", () => {
    const { decoder } = newCamera();
    const body = sealBody(randomBytes(32), Buffer.from("orphan"));
    expect(decoder.decodeFrame(assembleFrame({ keyframe: false, ...body }))).toBeUndefined();
  });

  test("wrong camera key fails closed (HMAC mismatch -> undefined, no throw)", () => {
    const { camPub } = newCamera();
    const wrongDecoder = newCamera().decoder; // unrelated key
    const mediaKey = randomBytes(32);
    const body = sealBody(mediaKey, Buffer.from("x"));
    const frame = assembleFrame({ keyframe: true, envelope: wrapEnvelope(mediaKey, camPub), ...body });
    expect(wrongDecoder.decodeFrame(frame)).toBeUndefined();
  });

  test("tampered envelope HMAC fails closed", () => {
    const { decoder, camPub } = newCamera();
    const mediaKey = randomBytes(32);
    const body = sealBody(mediaKey, Buffer.from("x"));
    const envelope = wrapEnvelope(mediaKey, camPub);
    envelope[128] ^= 0xff; // flip a byte in the 32-byte HMAC tag
    const frame = assembleFrame({ keyframe: true, envelope, ...body });
    expect(decoder.decodeFrame(frame)).toBeUndefined();
  });

  test("tampered GCM body fails closed (auth tag mismatch)", () => {
    const { decoder, camPub } = newCamera();
    const mediaKey = randomBytes(32);
    const body = sealBody(mediaKey, Buffer.from("00000000000000000000", "hex"));
    const frame = assembleFrame({ keyframe: true, envelope: wrapEnvelope(mediaKey, camPub), ...body });
    frame[frame.length - 1] ^= 0x01; // corrupt last ciphertext byte
    expect(decoder.decodeFrame(frame)).toBeUndefined();
  });

  test("constructor rejects a non-32-byte key", () => {
    expect(() => new VideoFrameDecoder(Buffer.alloc(16))).toThrow();
  });

  test("parseVideoFrameHeader returns undefined on a too-short buffer", () => {
    expect(parseVideoFrameHeader(Buffer.alloc(8))).toBeUndefined();
  });
});

describe("parseVideoFrameHeader on a real captured keyframe header", () => {
  // The 22-byte CMD_VIDEO_FRAME header (+ the envelope's compressed-point prefix at 0x16) from a
  // real captured 2304x1296 keyframe, reconstructed byte-for-byte and inlined as base64. This is
  // header METADATA ONLY — no video payload is reproduced or committed — so the check is fully
  // deterministic and runs everywhere (it replaces a fixture that used to live at /tmp and self-skip).
  // Pins the field OFFSETS against known real-device values, so an offset regression fails loudly.
  const HEADER_B64 = "I7MDAAEAAAAAAAAJEAUAAAAAAAAAAAI=";

  it("reads the documented field offsets from the captured header", () => {
    const buf = Buffer.from(HEADER_B64, "base64");
    const h = parseVideoFrameHeader(buf);
    expect(h).toBeDefined();
    // The header declares the payload THIS frame carries; this one carried a whole 242979-byte unit.
    expect(h?.payloadLength).toBe(0x3b323);
    expect(h?.keyframe).toBe(true);
    expect(h?.width).toBe(2304);
    expect(h?.height).toBe(1296);
    // a valid compressed P-256 point begins with 0x02 or 0x03 at the envelope offset 0x16
    expect([0x02, 0x03]).toContain(buf[0x16]);
  });
});
