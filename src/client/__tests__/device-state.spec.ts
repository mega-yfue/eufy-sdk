import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import type { DeviceState } from "../types.js";
import { DeviceRegistry } from "../device-registry.js";
import { classifyDevice, type EufyDevice } from "../../core/types.js";

/**
 * The liveness seam: `deviceState(sn)` + the `deviceState` event.
 *
 * The SDK reports when a device last reported and never an `online` verdict — the staleness threshold
 * is the caller's, because a mains camera and a battery sensor have very different healthy silences.
 * P2P session state is deliberately absent from this shape; these specs pin that, plus the rule that a
 * device which merely re-reported (no param value change) still surfaces as alive.
 */
function makeClient(devices: Array<Partial<EufyDevice> & { sn: string }>, sessions: Record<string, boolean> = {}) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x" });
  const list = devices.map((d) => ({ realtime: "p2p", ...d }) as EufyDevice);
  vi.spyOn((eufy as any).registry, "list").mockReturnValue(list);
  vi.spyOn((eufy as any).p2p, "getSessions").mockReturnValue(
    new Map(Object.entries(sessions).map(([sn, connected]) => [sn, { isConnected: connected } as any])),
  );
  vi.spyOn((eufy as any).p2p, "stationKeyOf").mockImplementation((sn: unknown) => {
    const d = list.find((x) => x.sn === sn);
    return d?.stationSn ?? (sn as string);
  });
  return eufy;
}

describe("deviceState — the liveness facts", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reports last-seen and the station, and no online verdict", () => {
    const eufy = makeClient([{ sn: "CAM", stationSn: "HB", lastSeenMs: 1_700_000_000_000 }], { HB: true });

    const s = eufy.deviceState("CAM");

    expect(s).toEqual({ sn: "CAM", stationSn: "HB", lastSeenMs: 1_700_000_000_000 });
    expect("online" in s).toBe(false);
  });

  /**
   * Sessions are opened on demand and closed when idle, so a device at rest has none — a per-device
   * session flag here would read as "unreachable" across a healthy fleet. Session visibility belongs
   * to getP2pSessions() / p2pConnect / p2pClose, station-scoped like the session itself.
   */
  it("carries no P2P session state — a closed session is the healthy resting state, not a signal", () => {
    const eufy = makeClient([{ sn: "CAM", stationSn: "HB", lastSeenMs: 1 }], { HB: false });

    const keys = Object.keys(eufy.deviceState("CAM"));

    expect(keys).not.toContain("p2pConnected");
    expect(keys).not.toContain("sessionPolicy");
    expect(keys.sort()).toEqual(["lastSeenMs", "sn", "stationSn"]);
  });

  it("reports an appliance the same way — lastSeenMs is the portable liveness signal", () => {
    const vacuum = classifyDevice({ category: "eufy_home", device_model: "T2080", device_type: 100 });
    expect(vacuum.realtime).toBe("smqtt");

    const eufy = makeClient([{ sn: "VAC", lastSeenMs: 42, ...vacuum } as any]);

    expect(eufy.deviceState("VAC")).toEqual({ sn: "VAC", stationSn: "VAC", lastSeenMs: 42 });
  });

  it("reports an unknown serial without inventing liveness for it", () => {
    const eufy = makeClient([{ sn: "CAM", stationSn: "HB", lastSeenMs: 1 }], { HB: true });

    expect(eufy.deviceState("GHOST")).toEqual({ sn: "GHOST", stationSn: "GHOST", lastSeenMs: undefined });
  });
});

/**
 * Driven end-to-end through a real {@link DeviceRegistry} over a fake cloud, so the `update_time`
 * seconds→ms derivation is exercised rather than hand-fed. A stubbed diff would keep these green even
 * if the registry stopped deriving `lastSeenMs` at all.
 */
function withCloud(rounds: Array<Array<{ sn: string; updateTime?: number }>>) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x" });
  let round = -1;
  const mega = {
    post: async (_s: string, path: string) => {
      if (path.endsWith("get_house_list")) {
        round++;
        return { house_infos: [] };
      }
      return {
        devices: (rounds[Math.min(round, rounds.length - 1)] ?? []).map((d) => ({
          device_sn: d.sn,
          device_model: "T8410",
          category: "eufy_security",
          device_type: 30,
          p2p_did: "DID-XYZ",
          params: [{ param_type: 1101, param_value: "88", update_time: d.updateTime }],
        })),
      };
    },
    getDeviceParamList: async () => ({}),
  };
  (eufy as any).registry = new DeviceRegistry({ mega: mega as never, onError: () => {} });
  const seen: DeviceState[] = [];
  eufy.on("deviceState", (s) => seen.push(s));
  return { eufy, seen };
}

describe("deviceState event", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fires when a poll shows the device reported in, even with no param value change", async () => {
    const { eufy, seen } = withCloud([[{ sn: "SENSOR", updateTime: 1_000 }], [{ sn: "SENSOR", updateTime: 9_000 }]]);
    await (eufy as any).pollOnce();

    await (eufy as any).pollOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sn: "SENSOR", lastSeenMs: 9_000_000 }); // wire seconds → ms
  });

  it("fires on the next poll after the station answered its own P2P session, with the answer's time", async () => {
    const { eufy, seen } = withCloud([[{ sn: "STATION", updateTime: 1_000 }]]);
    await (eufy as any).pollOnce();
    (eufy as any).p2p.deps.onPeerAnswer("STATION", 9_000_000);

    await (eufy as any).pollOnce();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ sn: "STATION", lastSeenMs: 9_000_000 });
    expect(eufy.deviceState("STATION").lastSeenMs).toBe(9_000_000);
  });

  it("does not fire when last-seen didn't advance", async () => {
    const { eufy, seen } = withCloud([[{ sn: "SENSOR", updateTime: 9_000 }]]);
    await (eufy as any).pollOnce();

    await (eufy as any).pollOnce();

    expect(seen).toEqual([]);
  });

  it("does not fire for a device seen for the first time (that's discovery, not a transition)", async () => {
    const { eufy, seen } = withCloud([[], [{ sn: "NEW", updateTime: 5_000 }]]);
    await (eufy as any).pollOnce();

    await (eufy as any).pollOnce();

    expect(seen).toEqual([]);
  });

  /**
   * A param the record delivered without an `update_time` must contribute no timestamp — a fake `0`
   * would read as "last seen in 1970" and a device that never stamps anything would look permanently
   * stale rather than simply unmeasured.
   */
  it("stays silent for a device the cloud never stamps", async () => {
    const { eufy, seen } = withCloud([[{ sn: "QUIET" }], [{ sn: "QUIET" }]]);
    await (eufy as any).pollOnce();

    await (eufy as any).pollOnce();

    expect(seen).toEqual([]);
    expect(eufy.deviceState("QUIET").lastSeenMs).toBeUndefined();
  });
});
