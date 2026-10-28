import { describe, it, expect, vi, beforeEach } from "vitest";
import { commandObservation, observeCommand } from "../../core/contracts.js";
import { EufyMega } from "../eufy-mega.js";
import type { EufyDevice } from "../../core/types.js";

/**
 * A guard-mode write recycles the P2P session of a device that is its own station. A wired station's
 * session is the persistent one realtime start opened, so the recycle reopens it while realtime runs,
 * including when the close itself rejects.
 *
 * Driven through the command sink with the registry seeded, so the station key and power tier resolve
 * through the real code; only the session open and close are stubbed.
 */
const GUARD_MODE_PARAM = 1224;

const SOLO_WIRED_SN = "T8000P0000000003";

function fleet(): EufyDevice[] {
  const common = { category: "eufy_security", api: "mega", realtime: "p2p", p2pDid: "XXXXXXX-000000-XXXXX" };
  return [
    { ...common, sn: SOLO_WIRED_SN, model: "T8399", deviceClass: "camera", stationSn: SOLO_WIRED_SN },
  ] as unknown as EufyDevice[];
}

function makeClient() {
  const eufy = new EufyMega({ email: "t@example.com", password: "x" });
  const devices = fleet();
  vi.spyOn((eufy as any).registry, "list").mockReturnValue(devices);
  vi.spyOn((eufy as any).registry, "p2pDevices").mockReturnValue(devices);
  vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue(devices);
  vi.spyOn(eufy as any, "startRealtimeGeneration").mockResolvedValue(undefined);
  (eufy as any).ensureRealtimeGeneration();
  const reset = vi.spyOn((eufy as any).p2p, "resetStandaloneSession").mockResolvedValue(undefined);
  const open = vi.spyOn((eufy as any).p2p, "ensureStation").mockResolvedValue(undefined);
  return { eufy, reset, open };
}

/** Write guard mode `expected` to `sn` and let the device converge on it, as the arming member does. */
async function writeGuardMode(eufy: EufyMega, sn: string, expected: number): Promise<void> {
  let mode = 1;
  let cloudMode = "1";
  const device = {
    getProperty: () => ({ value: mode }),
    applyParams: (params: Record<number, string>) => {
      mode = Number(params[GUARD_MODE_PARAM]);
    },
  };
  (eufy as any).liveDevices.set(sn, new WeakRef(device));
  vi.spyOn((eufy as any).registry, "require").mockImplementation(() => ({
    params: { [GUARD_MODE_PARAM]: cloudMode },
  }));
  vi.spyOn(eufy as any, "routeCommand").mockImplementation(async (...args: unknown[]) => {
    cloudMode = String(commandObservation(args[1] as never)!.expected);
  });
  const command = observeCommand(
    { kind: "set-param", param: GUARD_MODE_PARAM, value: expected, form: "auto", channel: 0 },
    {
      event: "armingModeChanged",
      expected,
      param: GUARD_MODE_PARAM,
      property: "armingMode",
      resetStandaloneSession: true,
      timeoutMs: 20_000,
    },
  );
  await (eufy as any).commandSinkFor(sn).dispatch(command);
}

describe("standalone session recycle", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reopens a wired station's session after a guard-mode write recycles it", async () => {
    const { eufy, reset, open } = makeClient();

    await writeGuardMode(eufy, SOLO_WIRED_SN, 63);

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(SOLO_WIRED_SN, expect.any(AbortSignal)));
    expect(reset).toHaveBeenCalledWith(SOLO_WIRED_SN);
    expect(reset.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]);
  });

  it("reopens a wired station's session when the recycle's close rejects, and still reports the rejection", async () => {
    const { eufy, reset, open } = makeClient();
    const failure = new Error("close failed");
    reset.mockRejectedValue(failure);
    const unacknowledged = vi.spyOn(eufy as any, "reportUnacknowledged").mockImplementation(() => undefined);

    await writeGuardMode(eufy, SOLO_WIRED_SN, 63);

    await vi.waitFor(() => expect(open).toHaveBeenCalledWith(SOLO_WIRED_SN, expect.any(AbortSignal)));
    await vi.waitFor(() => expect(unacknowledged).toHaveBeenCalledWith(failure));
  });
});

/**
 * A station ends its own session when it reboots or updates firmware. The router reports that close
 * through its `onClose` dependency, which is driven directly here.
 */
describe("wired station closed by the station", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    return () => vi.useRealTimers();
  });

  const stationClosed = (eufy: EufyMega) => (eufy as any).p2p.deps.onClose(SOLO_WIRED_SN);

  it("reopens it with a backoff, and a close during the loop does not start a second one", async () => {
    const { eufy, open } = makeClient();
    eufy.on("error", () => {});
    open.mockRejectedValueOnce(new Error("connect timeout")).mockResolvedValue(undefined);

    stationClosed(eufy);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(1);

    stationClosed(eufy);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("stops reopening once the client disconnects", async () => {
    const { eufy, open } = makeClient();
    stationClosed(eufy);
    await eufy.disconnect();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(open).not.toHaveBeenCalled();
  });
});
