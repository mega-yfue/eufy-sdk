import { createDecipheriv, createECDH } from "node:crypto";
import { eciesUnwrap } from "../codec.js";
import {
  KEYED_PAYLOAD_CMD,
  buildKeyBlob,
  buildKeyedActuatePayload,
  keyedPayloadReportCode,
  sealInnerPayload,
  serialIv,
  spellAesKey,
} from "../keyed-payload.js";

// Synthetic device key pair: the "device" side of the ECDH, so a spec can open what the blob seals.
const device = createECDH("prime256v1");
device.setPrivateKey(Buffer.alloc(32, 7));
const devicePublicKeyHex = device.getPublicKey("hex").slice(2); // drop the 04 prefix, as the cloud publishes it
const devicePrivateKeyHex = Buffer.alloc(32, 7).toString("hex");

const identity = {
  engage: true,
  adminUserId: "0000000000000000000000000000000000000000",
  username: "someone+tag",
  shortUserId: "0003",
  deviceSn: "T8520Q2000000000",
};
const rnd = {
  aesKey: Buffer.alloc(16, 0xab),
  nonce: Buffer.alloc(16, 0xcd),
  ephemeralPrivateKey: Buffer.alloc(32, 9),
  seqNum: 42,
};

/**
 * The key blob for the injected key, nonce and ephemeral key above, byte for byte: the layout the device
 * accepted, pinned so a change to any segment fails here rather than only against hardware.
 */
const PINNED_KEY_BLOB =
  "027135fa4fd93a09dce98bbf681b4bfcf50e7c0d6354e62afb0bff2a3429617865" +
  "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" +
  "171b78f9c97d15756396cfaeaf6aca536f00577c89a0cf2fec7108fc64fe3a95fe0416c2ff5a614e3ad8502486fb9070" +
  "6ee5016645737ca41f1ee7baf17e7b6fc8b999dcd915c355b2b63075d0a585c1";

/** Open a sealed inner payload the way the device does, under the per-command key it was told. */
function openPayload(payloadB64: string, aesKeyHex: string, deviceSn: string): Record<string, unknown> {
  const opener = createDecipheriv("aes-128-cbc", Buffer.from(aesKeyHex, "hex"), serialIv(deviceSn));
  return JSON.parse(
    Buffer.concat([opener.update(Buffer.from(payloadB64, "base64")), opener.final()]).toString("utf8"),
  ) as Record<string, unknown>;
}

describe("keyed-payload envelope", () => {
  it("spells the per-command key as 32 uppercase hex chars and pads the serial into a 16-byte IV", () => {
    expect(spellAesKey(rnd.aesKey)).toBe("AB".repeat(16));
    expect(serialIv("T8520Q2000000000")).toEqual(Buffer.from("T8520Q2000000000", "utf8"));
    expect(serialIv("SHORT")).toEqual(Buffer.concat([Buffer.from("SHORT"), Buffer.alloc(11)]));
    expect(serialIv("T8520Q2000000000EXTRA")).toHaveLength(16);
  });

  it("seals the key into the pinned blob: compressed pub ‖ nonce ‖ sealed key ‖ hmac, 129 bytes", () => {
    const aesKeyHex = spellAesKey(rnd.aesKey);
    const blob = buildKeyBlob(aesKeyHex, devicePublicKeyHex, rnd);
    expect(blob).toBe(PINNED_KEY_BLOB);
    expect(Buffer.from(blob, "hex")).toHaveLength(129);
    expect(Buffer.from(blob, "hex").subarray(33, 49)).toEqual(rnd.nonce);
    // The device side opens it with its private key, tag verified and padding stripped.
    const opened = eciesUnwrap(Buffer.from(blob, "hex"), devicePrivateKeyHex, { verifyHmac: true, pkcs7: true });
    expect(opened?.toString("utf8")).toBe(aesKeyHex);
  });

  it("seals the inner JSON under the per-command key with the serial IV, base64 out", () => {
    const aesKeyHex = spellAesKey(rnd.aesKey);
    const b64 = sealInnerPayload('{"a":1}', aesKeyHex, identity.deviceSn);
    expect(openPayload(b64, aesKeyHex, identity.deviceSn)).toEqual({ a: 1 });
  });

  it("builds the two sealed fields: the pinned key blob and the inner JSON under its key", () => {
    const { key, payload } = buildKeyedActuatePayload(identity, devicePublicKeyHex, "Someone", rnd);
    expect(key).toBe(PINNED_KEY_BLOB);
    expect(openPayload(payload, spellAesKey(rnd.aesKey), identity.deviceSn)).toEqual({
      shortUserId: "0003",
      slOperation: 1,
      userId: identity.adminUserId,
      userName: "Someone",
      seq_num: 42,
    });
    const released = buildKeyedActuatePayload({ ...identity, engage: false }, devicePublicKeyHex, "Someone", rnd);
    expect(openPayload(released.payload, spellAesKey(rnd.aesKey), identity.deviceSn).slOperation).toBe(0);
  });

  it("uses a fresh key, nonce and ephemeral pair per envelope when only the sequence is injected", () => {
    const a = buildKeyedActuatePayload(identity, devicePublicKeyHex, "x", { seqNum: 1 });
    const b = buildKeyedActuatePayload(identity, devicePublicKeyHex, "x", { seqNum: 1 });
    expect(a.key).not.toBe(b.key);
    expect(a.payload).not.toBe(b.payload);
  });

  it("reads the result out of the device's state report, and nothing out of any other document", () => {
    expect(keyedPayloadReportCode({ cmd: KEYED_PAYLOAD_CMD.STATE_REPORT, payload: { code: 0, slState: "4" } })).toBe(0);
    expect(keyedPayloadReportCode({ cmd: KEYED_PAYLOAD_CMD.STATE_REPORT, payload: { code: -151 } })).toBe(-151);
    expect(keyedPayloadReportCode({ cmd: 1940, payload: { code: 0 } })).toBeUndefined();
    expect(keyedPayloadReportCode({ cmd: KEYED_PAYLOAD_CMD.STATE_REPORT, payload: { code: "0" } })).toBeUndefined();
    expect(keyedPayloadReportCode({ cmd: KEYED_PAYLOAD_CMD.STATE_REPORT })).toBeUndefined();
    expect(keyedPayloadReportCode(undefined)).toBeUndefined();
  });
});
