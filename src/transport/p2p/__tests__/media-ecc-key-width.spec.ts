import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { VideoFrameDecoder } from "../video.js";

/**
 * The session's P-256 scalar is 32 bytes even when its leading byte is zero. `ECDH.getPrivateKey()` drops
 * leading zero bytes, so about one generated scalar in 256 would otherwise come back 31 bytes long, and
 * {@link VideoFrameDecoder} rejects it.
 */
const LEADING_ZERO_SCALAR = Buffer.from("00" + "11".repeat(31), "hex");

vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return {
    ...real,
    createECDH: (curve: string) => {
      const ecdh = real.createECDH(curve);
      ecdh.generateKeys = (() => {
        ecdh.setPrivateKey(LEADING_ZERO_SCALAR);
        return ecdh.getPublicKey();
      }) as typeof ecdh.generateKeys;
      return ecdh;
    },
  };
});

describe("the session's P-256 media key", () => {
  it("keeps a scalar's leading zero byte, so a decoder takes it", () => {
    const session = new P2PSession({
      stationSn: "T8030P0000000000",
      p2pDid: "XXXXXXX-000000-XXXXX",
      noBroadcast: true,
    });
    const key = session.mediaEccPrivateKey!;
    expect(key).toEqual(LEADING_ZERO_SCALAR);
    expect(() => new VideoFrameDecoder(key)).not.toThrow();
  });
});
