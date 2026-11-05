import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import type { EufyDevice } from "../../core/types.js";

/**
 * A wired station's session is the persistent one realtime start opened. When it closes on its own, or its
 * warm-up fails, the client reopens it: at once, then after 5 s, doubling up to five minutes, until it
 * connects or realtime stops.
 *
 * The registry is seeded so the station key and power tier resolve through the real code; only the session
 * open is stubbed, and the router's close and connect callbacks are driven directly.
 */
const STATION_SN = "T8000P0000000000";

function fleet(): EufyDevice[] {
  const common = { category: "eufy_security", api: "mega", realtime: "p2p", p2pDid: "XXXXXXX-000000-XXXXX" };
  return [
    { ...common, sn: STATION_SN, model: "T8023", deviceClass: "homebase", stationSn: STATION_SN },
  ] as unknown as EufyDevice[];
}

function makeClient() {
  const eufy = new EufyMega({ email: "t@example.com", password: "x" });
  const devices = fleet();
  vi.spyOn((eufy as any).registry, "list").mockReturnValue(devices);
  vi.spyOn((eufy as any).registry, "p2pDevices").mockReturnValue(devices);
  vi.spyOn(eufy as any, "startRealtimeGeneration").mockResolvedValue(undefined);
  (eufy as any).ensureRealtimeGeneration();
  const open = vi.spyOn((eufy as any).p2p, "ensureStation").mockResolvedValue(undefined);
  const deps = (eufy as any).p2p.deps as { onClose: (sn: string) => void; onConnect: (sn: string) => void };
  return { eufy, open, deps };
}

describe("wired station reopen", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("reopens a wired station's session at once when it closes", async () => {
    const { open, deps } = makeClient();

    deps.onClose(STATION_SN);
    await vi.advanceTimersByTimeAsync(0);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(STATION_SN, expect.any(AbortSignal));
  });

  it("retries a failed reopen after 5 s, then 10 s", async () => {
    const { open, deps } = makeClient();
    open.mockRejectedValue(new Error("P2P connect timeout"));

    deps.onClose(STATION_SN);
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(open).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("caps the pause between reopens at five minutes", async () => {
    const { open, deps } = makeClient();
    open.mockRejectedValue(new Error("P2P connect timeout"));

    deps.onClose(STATION_SN);
    await vi.advanceTimersByTimeAsync(0);
    for (const pause of [5_000, 10_000, 20_000, 40_000, 80_000, 160_000]) await vi.advanceTimersByTimeAsync(pause);
    expect(open).toHaveBeenCalledTimes(7);

    await vi.advanceTimersByTimeAsync(299_999);
    expect(open).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(8);
  });

  it("keeps one reopen pending per station when it closes again while one waits", async () => {
    const { open, deps } = makeClient();
    open.mockRejectedValue(new Error("P2P connect timeout"));

    deps.onClose(STATION_SN);
    await vi.advanceTimersByTimeAsync(0);
    deps.onClose(STATION_SN);
    deps.onClose(STATION_SN);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(open).toHaveBeenCalledTimes(2);
  });

  it("drops the pending reopen and its backoff once the session connects", async () => {
    const { open, deps } = makeClient();
    open.mockRejectedValue(new Error("P2P connect timeout"));
    deps.onClose(STATION_SN);
    await vi.advanceTimersByTimeAsync(0);

    deps.onConnect(STATION_SN);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(open).toHaveBeenCalledTimes(1);

    deps.onClose(STATION_SN);
    await vi.advanceTimersByTimeAsync(0);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("does not reopen a battery station, whose session closes to let it sleep", async () => {
    const { eufy, open, deps } = makeClient();
    vi.spyOn(eufy as any, "stationPower").mockReturnValue("battery");

    deps.onClose(STATION_SN);
    await vi.advanceTimersByTimeAsync(600_000);

    expect(open).not.toHaveBeenCalled();
  });

  it("stops reopening once realtime is disconnected", async () => {
    const { eufy, open, deps } = makeClient();
    vi.spyOn(eufy as any, "teardownRealtime");
    open.mockRejectedValue(new Error("P2P connect timeout"));
    deps.onClose(STATION_SN);
    await vi.advanceTimersByTimeAsync(0);

    await eufy.disconnect();
    deps.onClose(STATION_SN);
    await vi.advanceTimersByTimeAsync(600_000);

    expect(open).toHaveBeenCalledTimes(1);
  });

  it("reopens a wired station whose warm-up failed", async () => {
    const { eufy, open } = makeClient();
    open.mockRejectedValueOnce(new Error("P2P connect timeout")).mockResolvedValue(undefined);

    await (eufy as any).warmWiredP2P();
    await vi.advanceTimersByTimeAsync(0);

    expect(open).toHaveBeenCalledTimes(2);
  });
});
