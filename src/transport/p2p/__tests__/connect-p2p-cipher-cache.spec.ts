import { describe, it, expect, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import type { P2PRouterDeps } from "../command-router.js";
import type { P2PSessionConfig } from "../p2p-session.js";
import { traceCollector } from "./session-fixtures.js";

/**
 * `P2PCommandRouter.ensureStation`'s `resolveCipherKeys` closure (the level-2 key negotiator handed to
 * `P2PSession`) — verifies a failed `get_ciphers()` call does NOT get cached, so a later invocation
 * (a later signCode-2/8 frame on the same long-lived session) retries instead of permanently returning
 * the poisoned `undefined`. Mirrors `detect_local_ip.spec.ts`'s "does NOT poison the cache" pattern for
 * a different cache with the same failure-mode bug.
 *
 * `P2PSession` is mocked to a bare `EventEmitter` (no real socket/connect) purely to capture the
 * config passed to its constructor — the callback under test is the router's own code, not anything
 * session-internal.
 */
let capturedConfig: P2PSessionConfig | undefined;
const resolveCipherKeys = (cipherId: number) => capturedConfig!.resolveCipherKeys!(cipherId);

vi.mock("../p2p-session.js", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  class FakeP2PSession extends EventEmitter {
    isConnected = true;
    hasLevel2Key = false;
    constructor(opts: P2PSessionConfig) {
      super();
      capturedConfig = opts;
    }
    connect = vi.fn(async () => {});
  }
  return { ...(await importOriginal<typeof import("../p2p-session.js")>()), P2PSession: FakeP2PSession };
});

const { P2PCommandRouter } = await import("../command-router.js");
const { P2PSession } = await vi.importActual<typeof import("../p2p-session.js")>("../p2p-session.js");

const DEVICE: EufyDevice = {
  sn: "T8531K0000000000",
  model: "T8531",
  category: "eufy_security",
  deviceClass: "camera",
  api: "mega",
  realtime: "p2p",
  p2pDid: "XXXXXXX-000000-XXXXX",
  raw: { member: { admin_user_id: "0".repeat(40) } },
};

function makeDeps(
  getCiphers: ReturnType<typeof vi.fn>,
  logger?: P2PRouterDeps["logger"],
  onError: P2PRouterDeps["onError"] = () => {},
): P2PRouterDeps {
  return {
    ...(logger ? { logger } : {}),
    mega: {
      auth: { userId: "u1", authToken: "t" },
      getDskKeys: vi.fn().mockResolvedValue({}),
      getCiphers,
    } as unknown as P2PRouterDeps["mega"],
    listDevices: () => [DEVICE],
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError,
    onLevel2Ready: () => {},
    onFrame: () => {},
  };
}

describe("P2PCommandRouter.ensureStation — resolveCipherKeys cache", () => {
  it("does NOT cache a failed get_ciphers() call — the next resolve retries and can succeed", async () => {
    const getCiphers = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce([{ cipher_id: 97, ecc_private_key: "deadbeef" }]);
    const router = new P2PCommandRouter(makeDeps(getCiphers));

    await router.ensureStation(DEVICE.sn);
    expect(capturedConfig?.resolveCipherKeys).toBeDefined();

    const first = await resolveCipherKeys(97);
    expect(first).toBeUndefined(); // transient failure

    const second = await resolveCipherKeys(97);
    expect(second?.ecc).toBe("deadbeef"); // retried, not short-circuited on a poisoned cache entry

    expect(getCiphers).toHaveBeenCalledTimes(2);
  });

  it("DOES cache a successful get_ciphers() call — a later resolve does not re-fetch", async () => {
    const getCiphers = vi.fn().mockResolvedValue([{ cipher_id: 97, ecc_private_key: "cafebabe" }]);
    const router = new P2PCommandRouter(makeDeps(getCiphers));

    await router.ensureStation(DEVICE.sn);
    expect((await resolveCipherKeys(97))?.ecc).toBe("cafebabe");
    expect((await resolveCipherKeys(97))?.ecc).toBe("cafebabe");
    expect(getCiphers).toHaveBeenCalledTimes(1); // second resolve served from cache
  });

  /**
   * An answer that names a different cipher is used anyway, and derives to nothing — so without a record of
   * the substitution the outcome reads as a station fault rather than as a lookup answering off-target.
   */
  it("states cipher material used in place of the cipher the station asked for", async () => {
    const { logger, traces } = traceCollector();
    const getCiphers = vi.fn().mockResolvedValue([{ cipher_id: 12, ecc_private_key: "cafebabe" }]);
    const router = new P2PCommandRouter(makeDeps(getCiphers, logger));

    await router.ensureStation(DEVICE.sn);
    expect((await resolveCipherKeys(97))?.ecc).toBe("cafebabe");

    expect(traces).toMatchObject([{ phase: "cipher-fallback", cipherId: 97, answeredCipherId: 12 }]);
  });

  /**
   * A negotiation asks the cloud once for both keys of a cipher: a `get_ciphers` call that throws is one
   * failed lookup, reported once, and a cipher answered with an empty ECC key carries its RSA private key in
   * that same lookup.
   */
  it("resolves both keys of a cipher in one lookup, and fetches and reports a failed one once", async () => {
    const getCiphers = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce([{ cipher_id: 10, ecc_private_key: "", private_key: "cnNhLWtleQ==" }]);
    const onError = vi.fn();
    const router = new P2PCommandRouter(makeDeps(getCiphers, undefined, onError));
    await router.ensureStation(DEVICE.sn);
    const session = new P2PSession(capturedConfig!);
    const gatewayInfo = Buffer.alloc(64);
    gatewayInfo.writeUInt16LE(10, 0);

    (session as unknown as { negotiateLevel2Key(payload: Buffer): void }).negotiateLevel2Key(gatewayInfo);

    expect(await session.awaitLevel2Key(1_000)).toBe(false);
    expect(getCiphers).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(await resolveCipherKeys(10)).toEqual({ ecc: "", rsa: "cnNhLWtleQ==" });
    expect(getCiphers).toHaveBeenCalledTimes(2);
  });

  /** Material for the cipher that was asked for is the ordinary answer and states nothing. */
  it("says nothing where the answer names the cipher that was asked for", async () => {
    const { logger, traces } = traceCollector();
    const getCiphers = vi.fn().mockResolvedValue([{ cipher_id: 97, ecc_private_key: "cafebabe" }]);
    const router = new P2PCommandRouter(makeDeps(getCiphers, logger));

    await router.ensureStation(DEVICE.sn);
    expect((await resolveCipherKeys(97))?.ecc).toBe("cafebabe");

    expect(traces).toEqual([]);
  });
});
