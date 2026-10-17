import { createECDH } from "node:crypto";
import { eciesUnwrap, eciesWrap } from "../codec.js";

/** The peer whose public key an envelope is sealed for, and whose private key opens it. */
const peer = createECDH("prime256v1");
peer.setPrivateKey(Buffer.alloc(32, 7));
const open = (envelope: Buffer) => eciesUnwrap(envelope, peer.getPrivateKey("hex"), { verifyHmac: true, pkcs7: true });

describe("eciesWrap", () => {
  it("seals what eciesUnwrap opens: tag verified, PKCS#7 stripped", () => {
    const plaintext = Buffer.from("A".repeat(32));
    const envelope = eciesWrap(plaintext, peer.getPublicKey());
    expect(envelope).toHaveLength(33 + 16 + 48 + 32);
    expect(open(envelope)).toEqual(plaintext);
  });

  it("lays the envelope out as ephemeral pub ‖ iv ‖ ct ‖ tag, with the injected inputs in place", () => {
    const ephemeral = createECDH("prime256v1");
    ephemeral.setPrivateKey(Buffer.alloc(32, 9));
    const iv = Buffer.alloc(16, 0xcd);
    const envelope = eciesWrap(Buffer.from("B".repeat(32)), peer.getPublicKey(), {
      ephemeralPrivateKey: Buffer.alloc(32, 9),
      iv,
    });
    expect(envelope.subarray(0, 33)).toEqual(ephemeral.getPublicKey(null, "compressed"));
    expect(envelope.subarray(33, 49)).toEqual(iv);
    // Deterministic under injected inputs, fresh otherwise.
    expect(
      eciesWrap(Buffer.from("B".repeat(32)), peer.getPublicKey(), { ephemeralPrivateKey: Buffer.alloc(32, 9), iv }),
    ).toEqual(envelope);
    expect(eciesWrap(Buffer.from("B".repeat(32)), peer.getPublicKey())).not.toEqual(envelope);
  });

  it("produces a tag that fails closed on the opening side when a byte is disturbed", () => {
    const envelope = eciesWrap(Buffer.from("C".repeat(32)), peer.getPublicKey());
    const tampered = Buffer.from(envelope);
    tampered[60] ^= 0x01;
    expect(open(tampered)).toBeUndefined();
  });
});
