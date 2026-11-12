import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { SessionExpiredError } from "../../transport/http/mega-client.js";

/**
 * The read-through freshness refresh as an INBOUND PATH.
 *
 * `getDevice` wires a policy that fires a background cloud re-read when a property is read while stale,
 * and hands the triggering read the stale value. That refresh is, for a host that reads often, the path
 * most fresh cloud values actually arrive on — it fires roughly every `cacheTtlMs`, where the poll fires
 * every ten minutes. So a change it lands is a change the poll will never see afterwards, because live
 * state has already caught up and the poll's own diff is edge-triggered on live state.
 *
 * Leaving it silent therefore does not defer the announcement, it LOSES it: the host is left holding the
 * previous value with nothing telling it to look again, which is the complaint the announcement exists to
 * answer. So this path announces too. Its timing says only when a caller happened to read, which is
 * exactly what the announcement's own docs state about latency — but the VALUE is news either way, and no
 * spurious event is possible, because the announcement is edge-triggered.
 *
 * It also has to apply what the device volunteered over realtime, not only the cloud record's params.
 * The two are kept apart in the registry, so applying the cloud half alone reverts live state for any id
 * a report made fresher — and once the path announces, it would announce that revert.
 */
function withFreshnessPolicy() {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", cacheTtlMs: 1000 });
  const record: { params: Record<number, string>; dpParams?: Record<number, string> } & Record<string, unknown> = {
    model: "T8900",
    category: "eufy_security",
    params: { 1550: "0", 1141: "-70" },
    paramUpdatedAt: {},
  };
  const registry = (eufy as any).registry;
  vi.spyOn(registry, "record").mockImplementation(async () => record);
  vi.spyOn(eufy as any, "commandContext").mockResolvedValue({ channel: 0, codec: "sensor", paramIds: new Set([1550]) });
  vi.spyOn(eufy as any, "commandSinkFor").mockReturnValue({ dispatch: async () => undefined });
  vi.spyOn(eufy as any, "mediaProviderFor").mockReturnValue(undefined);
  vi.spyOn(eufy as any, "awaitFirstRealtimeState").mockResolvedValue(undefined);
  vi.spyOn(registry, "applyRealtimeParams").mockImplementation(() => {});
  const seen: any[] = [];
  eufy.on("propertyChanged", (e) => seen.push(e));
  return { eufy, record, seen };
}

/**
 * The same client, but with the registry's own report map live — `record` still serves a hand-written
 * cloud half, and answers with whatever {@link DeviceRegistry.applyRealtimeParams} has actually
 * accumulated beside it. That join is the thing under test here, so neither half of it can be faked.
 */
function withLiveReportMap() {
  const built = withFreshnessPolicy();
  const registry = (built.eufy as any).registry;
  vi.mocked(registry.applyRealtimeParams).mockRestore();
  vi.spyOn(registry, "record").mockImplementation(async () => ({
    ...built.record,
    dpParams: registry.dpParams.get("T8000P0000000000"),
  }));
  return built;
}

/** Age every stored value past the staleness window without waiting for it. */
const makeStale = (dev: unknown) => {
  for (const v of (dev as { state: Map<string, { ts: number }> }).state.values()) v.ts -= 10_000;
};

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("the read-through freshness refresh announces what it lands", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("announces a value the background re-read brought in", async () => {
    const { eufy, record, seen } = withFreshnessPolicy();
    const dev = await eufy.getDevice("T8000P0000000000");
    expect(dev.getProperty("contact")?.value).toBe(false);

    record.params = { ...record.params, 1550: "1" };
    makeStale(dev);
    dev.getProperty("contact"); // a stale read fires the refresh and is handed the stale value
    await settle();

    expect(seen).toEqual([{ deviceSn: "T8000P0000000000", property: "contact", value: true }]);
    expect(dev.getProperty("contact")?.value).toBe(true);
  });

  it("says nothing when the re-read brought in the same values", async () => {
    const { eufy, seen } = withFreshnessPolicy();
    const dev = await eufy.getDevice("T8000P0000000000");

    makeStale(dev);
    dev.getProperty("contact");
    await settle();

    expect(seen).toEqual([]);
  });

  /**
   * The registry keeps a device's realtime report apart from the cloud record's params, so the cloud half
   * still carries the pre-report value. Applying it alone would revert live state and announce the revert.
   */
  it("does not revert or announce a revert of what a realtime report landed", async () => {
    const { eufy, record, seen } = withFreshnessPolicy();
    const dev = await eufy.getDevice("T8000P0000000000");
    (eufy as any).applyRealtimeState("T8000P0000000000", { 1550: "1" });
    expect(seen).toEqual([{ deviceSn: "T8000P0000000000", property: "contact", value: true }]);
    record.dpParams = { 1550: "1" }; // the registry answers with the report beside the stale cloud half

    makeStale(dev);
    dev.getProperty("contact");
    await settle();

    expect(dev.getProperty("contact")?.value).toBe(true);
    expect(seen).toHaveLength(1); // the realtime announcement, and no revert after it
  });

  /**
   * The mirror ordering: the CLOUD is the fresher half, for an id the report map also holds.
   *
   * A report's value stands in for the cloud's lag on that id, so it takes precedence while the cloud
   * has said nothing new. A poll diff on the same id is the cloud saying something new — it observed
   * that param transition — which ends the lag the report was covering. So the poll retires the report
   * for the ids it moved, and the refresh's join has nothing stale left to overlay.
   *
   * Without that, the report outranks the cloud forever: the poll lands `1` in live state and announces
   * it, then the next stale read joins `1` under a report still holding `0`, reverts live state, and
   * announces the revert — the exact failure the join was written to prevent, one ordering over.
   */
  it("does not revert or announce a revert of what the poll landed, once the cloud moved that id", async () => {
    const { eufy, record, seen } = withLiveReportMap();
    const dev = await eufy.getDevice("T8000P0000000000");
    (eufy as any).applyRealtimeState("T8000P0000000000", { 1550: "0" });
    expect(dev.getProperty("contact")?.value).toBe(false);

    record.params = { ...record.params, 1550: "1" };
    (eufy as any).applyPolledParams([
      { deviceSn: "T8000P0000000000", paramType: 1550, from: "0", to: "1", params: record.params },
    ]);
    expect(seen).toEqual([{ deviceSn: "T8000P0000000000", property: "contact", value: true }]);

    makeStale(dev);
    dev.getProperty("contact");
    await settle();

    expect(dev.getProperty("contact")?.value).toBe(true);
    expect(seen).toHaveLength(1); // the poll's announcement, and no revert after it
  });
});

describe("a failed read-through refresh", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reports a dead session as sessionExpired instead of rejecting a promise nobody holds", async () => {
    const { eufy } = withFreshnessPolicy();
    const dev = await eufy.getDevice("T8000P0000000000");
    const expired = new SessionExpiredError("/app/devicemanage/get_device_param_list failed (401/401): token error");
    vi.spyOn((eufy as any).registry, "record").mockRejectedValue(expired);
    const reported: unknown[] = [];
    eufy.on("sessionExpired", (e) => reported.push(e));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      makeStale(dev);
      expect(dev.getProperty("contact")?.value).toBe(false);
      await settle();
      await settle();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(reported).toEqual([expired]);
    expect(unhandled).toEqual([]);
    expect(dev.getProperty("contact")?.value).toBe(false);
  });
});
