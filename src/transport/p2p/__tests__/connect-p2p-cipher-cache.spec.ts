import { describe, it, expect, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import type { P2PRouterDeps } from "../command-router.js";
import type { P2PSessionConfig } from "../p2p-session.js";
import { traceCollector } from "./session-fixtures.js";

/**
 * `P2PCommandRouter.ensureStation`'s `resolveCipherKey` closure (the level-2 key negotiator handed to
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
const resolveCipherKey = (cipherId: number, version = 8) => capturedConfig!.resolveCipherKey!(cipherId, version);

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

describe("P2PCommandRouter.ensureStation — resolveCipherKey cache", () => {
  /** `ConnectKeyFactory` asks again once when its first pass leaves no key, and caches only a key. */
  it("asks a lookup that yields no key once more, and does NOT cache the miss", async () => {
    const getCiphers = vi
      .fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce([{ cipher_id: 97 }])
      .mockResolvedValueOnce([{ cipher_id: 97, ecc_private_key: "deadbeef" }]);
    const onError = vi.fn();
    const router = new P2PCommandRouter(makeDeps(getCiphers, undefined, onError));

    await router.ensureStation(DEVICE.sn);
    expect(await resolveCipherKey(97)).toBeUndefined();
    expect(getCiphers).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(await resolveCipherKey(97)).toBe("deadbeef");
    expect(getCiphers).toHaveBeenCalledTimes(3);
  });

  it("DOES cache a successful get_ciphers() call — a later resolve does not re-fetch", async () => {
    const getCiphers = vi.fn().mockResolvedValue([{ cipher_id: 97, ecc_private_key: "cafebabe" }]);
    const router = new P2PCommandRouter(makeDeps(getCiphers));

    await router.ensureStation(DEVICE.sn);
    expect(await resolveCipherKey(97)).toBe("cafebabe");
    expect(await resolveCipherKey(97)).toBe("cafebabe");
    expect(getCiphers).toHaveBeenCalledTimes(1); // second resolve served from cache
  });

  /**
   * The app's two lookups: a version-8 gateway info asks with `station_sn` and keeps `ecc_private_key`, any other
   * version asks with `sn` and keeps `private_key`, each from the first entry whatever cipher it names.
   */
  it("asks by the gateway info's version and keeps that version's key from the first entry", async () => {
    const getCiphers = vi.fn().mockResolvedValue([
      { cipher_id: 12, ecc_private_key: "ecc-a", private_key: "rsa-a" },
      { cipher_id: 97, ecc_private_key: "cafebabe" },
    ]);
    const router = new P2PCommandRouter(makeDeps(getCiphers));
    await router.ensureStation(DEVICE.sn);

    expect(await resolveCipherKey(97, 1)).toBe("rsa-a");
    expect(getCiphers).toHaveBeenLastCalledWith([97], "0".repeat(40), DEVICE.sn, "sn");
    expect(await resolveCipherKey(98, 8)).toBe("ecc-a");
    expect(getCiphers).toHaveBeenLastCalledWith([98], "0".repeat(40), DEVICE.sn, "station_sn");
  });

  /** Material for the cipher that was asked for is the ordinary answer and states nothing. */
  it("says nothing where the answer names the cipher that was asked for", async () => {
    const { logger, traces } = traceCollector();
    const getCiphers = vi.fn().mockResolvedValue([{ cipher_id: 97, ecc_private_key: "cafebabe" }]);
    const router = new P2PCommandRouter(makeDeps(getCiphers, logger));

    await router.ensureStation(DEVICE.sn);
    expect(await resolveCipherKey(97)).toBe("cafebabe");

    expect(traces).toEqual([]);
  });
});
