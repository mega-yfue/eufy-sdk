import { createCipheriv, createECDH, createHmac } from "node:crypto";
import { P2PSession } from "../p2p-session.js";
import { deriveLevel2KeyFromGatewayInfo, gatewayInfoCipherId } from "../codec.js";

/**
 * Level-2 (gateway) P2P frame decryption — signCode 2 vs 8.
 *
 * Both use the SAME AES-256-GCM key + AAD "eufy security"; they differ ONLY by a 4-byte
 * cleartext sub-header present on signCode 8 (so ct@32) and absent on signCode 2 (ct@28).
 * Fixtures are synthetic (fixed key/nonce/plaintext) — no account data, fully deterministic.
 */
const KEY = Buffer.alloc(32, 7); // any 32-byte session key
const NONCE = Buffer.from("0123456789ab", "utf8"); // 12-byte GCM nonce
const AAD = Buffer.from("eufy security");

/** GCM-seal `plaintext` and frame it the way the station sends a given signCode. */
function sealLevel2(plaintext: Buffer, signCode: number): Buffer {
  const c = createCipheriv("aes-256-gcm", KEY, NONCE);
  c.setAAD(AAD);
  const ct = Buffer.concat([c.update(plaintext), c.final()]);
  const tag = c.getAuthTag();
  const subHeader = signCode === 8 ? Buffer.from([0x05, 0x03, 0x02, 0x01]) : Buffer.alloc(0);
  return Buffer.concat([tag, NONCE, subHeader, ct]); // tag(16) ‖ nonce(12) ‖ [subhdr] ‖ ct
}

function newSession(): P2PSession {
  return new P2PSession({ stationSn: "T8000X0000000000", p2pDid: "T8000-000000-00000" });
}

describe("P2PSession level-2 (signCode 2/8) GCM decrypt", () => {
  test("signCode 2 (media/db/notify content): ct at offset 28, no sub-header", () => {
    const pt = Buffer.from(JSON.stringify({ cmd: 6445, payload: { result: 5 } }));
    const session = newSession();
    session.setLevel2Key(KEY);
    const out = (session as unknown as { decryptLevel2(p: Buffer, s: number): Buffer | undefined }).decryptLevel2(
      sealLevel2(pt, 2),
      2,
    );
    expect(out?.toString()).toBe(pt.toString());
  });

  test("signCode 8 (app commands): ct at offset 32, after the 4-byte sub-header", () => {
    const pt = Buffer.from(JSON.stringify({ account_id: "x", cmd: 1306, mChannel: 255 }));
    const session = newSession();
    session.setLevel2Key(KEY);
    const out = (session as unknown as { decryptLevel2(p: Buffer, s: number): Buffer | undefined }).decryptLevel2(
      sealLevel2(pt, 8),
      8,
    );
    expect(out?.toString()).toBe(pt.toString());
  });

  test("a tiny signCode-2 frame (4-byte result code) round-trips", () => {
    const pt = Buffer.from([0, 0, 0, 0]); // 32-byte frame: tag(16)+nonce(12)+ct(4)
    const session = newSession();
    session.setLevel2Key(KEY);
    const frame = sealLevel2(pt, 2);
    expect(frame.length).toBe(32);
    const out = (session as unknown as { decryptLevel2(p: Buffer, s: number): Buffer | undefined }).decryptLevel2(
      frame,
      2,
    );
    expect(out?.equals(pt)).toBe(true);
  });

  test("wrong key / tampered tag fails closed (returns undefined, no throw)", () => {
    const session = newSession();
    session.setLevel2Key(Buffer.alloc(32, 9)); // different key
    const frame = sealLevel2(Buffer.from("secret"), 2);
    const out = (session as unknown as { decryptLevel2(p: Buffer, s: number): Buffer | undefined }).decryptLevel2(
      frame,
      2,
    );
    expect(out).toBeUndefined();
  });

  test("the signCode-8 sub-header carries into the next byte after [ff, 03, 02, 01]", () => {
    const session = newSession();
    session.setLevel2Key(KEY);
    const encrypt = (session as unknown as { encryptLevel2(p: Buffer): Buffer }).encryptLevel2.bind(session);
    const headers = Array.from({ length: 257 }, () => encrypt(Buffer.from("{}")).subarray(28, 32));
    expect(headers[0]).toEqual(Buffer.from([0x00, 0x03, 0x02, 0x01]));
    expect(headers[255]).toEqual(Buffer.from([0xff, 0x03, 0x02, 0x01]));
    expect(headers[256]).toEqual(Buffer.from([0x00, 0x04, 0x02, 0x01]));
  });

  test("setLevel2Key rejects non-32-byte keys", () => {
    expect(() => newSession().setLevel2Key(Buffer.alloc(16))).toThrow();
  });
});

/**
 * Level-2 session-key negotiation from a CMD_GATEWAYINFO ECIES envelope. The fixture is
 * fully synthetic — generated keypairs, no real account material — but exercises the exact
 * derivation (ECDH P-256 → eufyKDF → AES-128-CBC) that recovers the live key.
 */
function eufyKdf(shared: Buffer): Buffer {
  const hmac = (k: Buffer, d: Buffer): Buffer => createHmac("sha256", k).update(d).digest();
  const label = Buffer.from("ECIES");
  let out: Buffer = Buffer.alloc(0);
  let t: Buffer = label;
  for (let i = 0; i < 2; i++) {
    t = hmac(shared, t);
    out = Buffer.concat([out, hmac(shared, Buffer.concat([t, label]))]);
  }
  return out;
}

describe("deriveLevel2KeyFromGatewayInfo (ECIES)", () => {
  test("recovers the session key from a synthetic GATEWAYINFO envelope", () => {
    const sessionKey = Buffer.alloc(32, 0x5a);
    // device "cipher" keypair — stands in for the get_ciphers ecc_private_key
    const device = createECDH("prime256v1");
    device.generateKeys();
    const devicePrivHex = device.getPrivateKey().toString("hex").padStart(64, "0");
    // ephemeral sender keypair; envelope ships its COMPRESSED public key
    const eph = createECDH("prime256v1");
    eph.generateKeys();
    const ephPubCompressed = eph.getPublicKey(undefined, "compressed");
    const shared = eph.computeSecret(device.getPublicKey()); // symmetric with device side
    const aesKey = eufyKdf(shared).subarray(0, 16);
    const iv = Buffer.alloc(16, 0x11);
    const c = createCipheriv("aes-128-cbc", aesKey, iv);
    c.setAutoPadding(false);
    const ct = Buffer.concat([c.update(Buffer.concat([sessionKey, Buffer.alloc(16, 0x10)])), c.final()]); // 48B
    const envelope = Buffer.concat([ephPubCompressed, iv, ct]); // pub(33)+iv(16)+ct(48)
    const gwPayload = Buffer.concat([Buffer.from([97, 0, 0, 0]), envelope]); // cipher_id 97 LE ‖ 0000 ‖ env

    expect(gatewayInfoCipherId(gwPayload)).toBe(97);
    const derived = deriveLevel2KeyFromGatewayInfo(gwPayload, devicePrivHex);
    expect(derived?.equals(sessionKey)).toBe(true);
  });

  test("returns undefined on a too-short payload", () => {
    expect(deriveLevel2KeyFromGatewayInfo(Buffer.alloc(10), "00".repeat(32))).toBeUndefined();
  });
});

/**
 * sendControlLevel2 envelope construction — verifies the optional `mValue3` plumbing (added for the
 * power-source write, where the app uses mValue3:0 rather than the command id). Spies on the private
 * encryptLevel2 to read the exact JSON envelope before it's sealed. Synthetic key/session, no network.
 */
describe("P2PSession.sendControlLevel2 envelope (mValue3)", () => {
  function captureEnvelope(session: P2PSession, call: () => void): Record<string, unknown> {
    (session as unknown as { connectAddress: unknown }).connectAddress = { address: "127.0.0.1", port: 32100 };
    (session as unknown as { send: (...a: unknown[]) => void }).send = () => {};
    let seen: Record<string, unknown> = {};
    const s = session as unknown as { encryptLevel2(b: Buffer): Buffer | undefined };
    const orig = s.encryptLevel2.bind(session);
    s.encryptLevel2 = (b: Buffer) => {
      seen = JSON.parse(b.toString());
      return orig(b);
    };
    call();
    return seen;
  }

  test("mValue3 is 0 unless given, as the app's envelope", () => {
    const session = newSession();
    session.setLevel2Key(KEY);
    const env = captureEnvelope(session, () => session.sendControlLevel2(1293, 6, "acct", { x: 1 }));
    expect(env).toMatchObject({ account_id: "acct", cmd: 1293, mChannel: 6, mValue3: 0, payload: { x: 1 } });
  });
});

describe("P2PSession stream keepalive", () => {
  test("sends 1139 header-only on the station channel 0xff, whatever camera channel it holds", () => {
    const session = newSession();
    session.setLevel2Key(KEY);
    const s = session as unknown as {
      connectAddress: unknown;
      send: (to: unknown, type: unknown, data: Buffer) => void;
      liveStartedChannels: Map<number, string>;
    };
    s.connectAddress = { address: "127.0.0.1", port: 32100 };
    const sent: Buffer[] = [];
    s.send = (_to, _type, data) => sent.push(data);
    s.liveStartedChannels.set(3, "l2");
    session.startLiveMedia(3, "acct");
    const frame = sent.at(-1)!;
    const head = frame.indexOf("XZYH");
    expect(frame.readUInt16LE(head + 4)).toBe(1139);
    expect(frame[head + 12]).toBe(0xff);
  });
});
