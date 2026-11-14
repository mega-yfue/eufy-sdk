import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";

/**
 * A valueless event's re-read as an INBOUND PATH.
 *
 * `armingModeChanged` names no mode, so before it is emitted the client re-reads the param the event
 * declares and lands it on the live device. That re-read is the path the new guard mode arrives on: once it
 * has landed, the poll's diff is edge-triggered on the same live state and sees nothing to announce. If the
 * re-read stays silent, `propertyChanged` for `armingMode` is never emitted for a mode switch, and a host
 * learns that the mode moved but never to what.
 *
 * Only the param the event declares is landed. The re-read's record is the cloud half alone, and applying
 * all of it would put the cloud's older value back over any id the device has since reported over realtime.
 */
const SN = "T8010P0000000000";
const GUARD_MODE = 1224;
const REFRESH = { param: GUARD_MODE, property: "armingMode", timeoutMs: 2_000 };

function withStation() {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", cacheTtlMs: 60_000 });
  const cloud: Record<number, string> = { [GUARD_MODE]: "1" };
  const registry = (eufy as any).registry;
  vi.spyOn(registry, "record").mockImplementation(async () => ({
    model: "T8010",
    category: "eufy_security",
    params: { ...cloud },
    paramUpdatedAt: {},
  }));
  vi.spyOn(registry, "require").mockImplementation(() => ({ sn: SN, params: { ...cloud } }));
  const refreshedList = vi.spyOn(registry, "refreshedList").mockResolvedValue(undefined);
  vi.spyOn(eufy as any, "commandContext").mockResolvedValue({
    channel: 0,
    codec: "station",
    paramIds: new Set([GUARD_MODE]),
  });
  vi.spyOn(eufy as any, "commandSinkFor").mockReturnValue({ dispatch: async () => undefined });
  vi.spyOn(eufy as any, "mediaProviderFor").mockReturnValue(undefined);
  vi.spyOn(eufy as any, "awaitFirstRealtimeState").mockResolvedValue(undefined);
  const seen: Array<[string, unknown]> = [];
  eufy.on("propertyChanged", (e) => seen.push(["propertyChanged", e]));
  eufy.on("armingModeChanged", (e) => seen.push(["armingModeChanged", e]));
  return { eufy, cloud, refreshedList, seen };
}

/** Deliver a MODE_SWITCH the way the push path does: the bare event, with the re-read it declares. */
const modeSwitch = (eufy: EufyMega) =>
  (eufy as any).emitSemantic("armingModeChanged", { deviceSn: SN }, { refresh: REFRESH });

describe("a valueless event's re-read announces what it lands", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("announces the new guard mode before the event that reports the switch", async () => {
    const { eufy, cloud, refreshedList, seen } = withStation();
    const dev = await eufy.getDevice(SN);
    expect(dev.getProperty("armingMode")?.value).toBe(1);

    refreshedList.mockImplementation(async () => {
      cloud[GUARD_MODE] = "63"; // the cloud re-read now carries the mode the station switched to
      return undefined;
    });
    modeSwitch(eufy);

    await vi.waitFor(() => expect(seen.map(([name]) => name)).toContain("armingModeChanged"));
    expect(seen).toEqual([
      ["propertyChanged", { deviceSn: SN, property: "armingMode", value: 63 }],
      ["armingModeChanged", { deviceSn: SN }],
    ]);
    expect(dev.getProperty("armingMode")?.value).toBe(63);
  });

  it("does not announce the mode again when the poll later reads the same value", async () => {
    const { eufy, cloud, refreshedList, seen } = withStation();
    await eufy.getDevice(SN);
    refreshedList.mockImplementation(async () => {
      cloud[GUARD_MODE] = "0";
      return undefined;
    });
    modeSwitch(eufy);
    await vi.waitFor(() => expect(seen.map(([name]) => name)).toContain("armingModeChanged"));

    (eufy as any).applyPolledParams([
      { deviceSn: SN, paramType: GUARD_MODE, from: "1", to: "0", params: { [GUARD_MODE]: "0" } },
    ]);

    expect(seen.filter(([name]) => name === "propertyChanged")).toHaveLength(1);
  });

  it("lands only the declared param, so a value the device reported since is not reverted", async () => {
    const { eufy, cloud, refreshedList } = withStation();
    const dev = await eufy.getDevice(SN);
    const applied: Array<Record<number, unknown>> = [];
    const applyParams = dev.applyParams.bind(dev);
    vi.spyOn(dev, "applyParams").mockImplementation((params, ts) => {
      applied.push({ ...params });
      return applyParams(params, ts);
    });
    cloud[1101] = "stale"; // another id the cloud half still carries
    refreshedList.mockImplementation(async () => {
      cloud[GUARD_MODE] = "63";
      return undefined;
    });
    modeSwitch(eufy);

    await vi.waitFor(() => expect(dev.getProperty("armingMode")?.value).toBe(63));
    expect(applied).toEqual([{ [GUARD_MODE]: "63" }]);
  });
});
