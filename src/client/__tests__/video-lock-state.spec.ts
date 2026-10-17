import { afterEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { Device } from "../../model/device.js";

const SN = "T8530P0000000000";
const HUB = "T8030P0000000000";
const record = { deviceType: 55, model: "T8530", parentSn: HUB, params: { 6000: "3", 6001: "65" }, paramUpdatedAt: {} };
const roster = [
  {
    sn: SN,
    model: "T8530",
    stationSn: HUB,
    channel: 7,
    params: record.params,
    category: "eufy_security",
    raw: {
      device_type: 55,
      parent_sn: HUB,
      device_channel: 7,
      member: { admin_user_id: "device-admin", short_user_id: "0002" },
    },
  },
  {
    sn: HUB,
    model: "T8030",
    raw: {
      device_type: 18,
      time_zone: "reported-vendor-zone",
      member: { admin_user_id: "station-admin", short_user_id: "0001", nick_name: "synthetic-member" },
    },
  },
];
afterEach(() => vi.restoreAllMocks());

function harness() {
  const client = new EufyMega({ email: "test@example.com", password: "x", autoRealtime: false });
  const internal = client as any;
  internal.registry.devices = structuredClone(roster);
  vi.spyOn(internal.registry, "record").mockImplementation(async (sn: unknown) => ({
    ...record,
    dpParams: internal.registry.dpParams.get(sn),
  }));
  const dev = Device.fromRecord(SN, record);
  dev.bindActions(
    { channel: 7, codec: "lock", deviceType: 55, paramIds: new Set([6000, 6001]) },
    { dispatch: async () => {} },
  );
  internal.liveDevices.set(SN, new WeakRef(dev));
  internal.boundParamIds.set(SN, new Set([6000, 6001]));
  return { client, internal, dev };
}
const frame = (payload: unknown, channel = 7) => ({
  stationSn: HUB,
  channel,
  commandId: 1351,
  json: { cmd: 1955, payload },
});

describe("video lock status integration", () => {
  it("lands in registry and a held device before emitting property changes", async () => {
    const { client, internal, dev } = harness();
    const properties: unknown[] = [];
    const semantic: unknown[] = [];
    client.on("propertyChanged", (event) => {
      expect(dev.lock?.()?.locked).toBe(true);
      properties.push(event);
    });
    client.on("lockState", (event) => {
      expect(dev.lock?.()?.locked).toBe(true);
      semantic.push(event);
    });
    internal.onP2PFrame(HUB, frame({ code: 0, slState: "4", slBattery: "66" }));
    expect(dev.lock?.()?.locked).toBe(true);
    expect(dev.lock?.()?.battery).toBe(66);
    expect(internal.registry.dpParams.get(SN)).toEqual({ 6000: "4", 6001: "66" });
    expect(properties).toContainEqual({ deviceSn: SN, property: "locked", value: true });
    expect(semantic).toEqual([]);
    internal.onP2PFrame(HUB, frame({ code: 0, slState: 4 }));
    expect(semantic).toEqual([]);
    const fetched = await client.getDevice(SN);
    expect(fetched.lock?.()?.locked).toBe(true);
  });
  it("keeps the last settled state when an unknown native report arrives", () => {
    const { internal, dev } = harness();
    internal.onP2PFrame(HUB, frame({ code: 0, slState: "4" }));
    internal.onP2PFrame(HUB, frame({ code: 0, slState: "5", slBattery: "66" }));
    expect(dev.lock?.()?.locked).toBe(true);
    expect(dev.lock?.()?.battery).toBe(66);
    expect(internal.registry.dpParams.get(SN)[6000]).toBe("4");
  });
  it("does not land errors, malformed reports, or another channel's status", () => {
    const { internal, dev } = harness();
    internal.onP2PFrame(HUB, frame({ code: -106, slState: 4 }));
    internal.onP2PFrame(HUB, frame(null));
    internal.onP2PFrame(HUB, frame({ code: 0, slState: 4 }, 8));
    expect(dev.lock?.()?.locked).toBe(false);
    expect(internal.registry.dpParams.get(SN)).toBeUndefined();
  });
  it("uses device identity and the parent station time_zone for public controls", async () => {
    const { client, internal } = harness();
    const query = vi.fn().mockResolvedValue({ code: 0, slState: "3", slBattery: "65" });
    vi.spyOn(internal, "mediaProviderFor").mockReturnValue({ p2pQuery: query });
    const ctx = await internal.commandContext(SN);
    expect(ctx).toMatchObject({
      adminUserId: "device-admin",
      shortUserId: "0002",
      stationSerial: HUB,
      timezone: "reported-vendor-zone",
    });
    expect(ctx.accountName).toBe("test");
    const dev = await client.getDevice(SN);
    expect(dev.lock?.()?.lock).toBeTypeOf("function");
    await expect(dev.lock?.()?.refreshStatus?.()).resolves.toBe(false);
    expect(query).toHaveBeenCalledExactlyOnceWith(1955, {
      payload: { timezone: "reported-vendor-zone" },
    });
    delete internal.registry.devices[1].raw.time_zone;
    const withoutTimezone = await client.getDevice(SN);
    expect(withoutTimezone.lock?.()?.refreshStatus).toBeUndefined();
  });
});
