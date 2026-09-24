import { DeviceRegistry } from "../device-registry.js";

/**
 * `(station, channel)` → device. A station fans traffic out by channel, and the resolved serial now
 * decides where realtime state is written, so an ambiguous answer writes one device's params onto
 * another.
 */
const HUB = "T8000P0000000000";
const CAM_CH0 = "T8000P0000000001";
const SENSOR_CH16 = "T8000P0000000002";
const NO_CHANNEL = "T8000P0000000003";
const TWIN_CH0 = "T8000P0000000004";
const STANDALONE = "T8000P0000000009";

/**
 * A registry holding exactly this roster. Both the cache-bearing lookup and the roster it reads are
 * internal, so the fields are reached through a cast — the resolution rule is what is under test, and
 * exercising it through a login + cloud fetch would test neither more nor differently.
 */
type Roster = { sn: string; raw: Record<string, unknown> };
const registryWith = (devices: Roster[]) => {
  const r = new DeviceRegistry({} as never);
  (r as unknown as { devices: Roster[] }).devices = devices;
  return r as unknown as { serialForFrame(station: string, channel: number): string | undefined };
};
const attached = (sn: string, channel?: number): Roster => ({
  sn,
  raw: { parent_sn: HUB, ...(channel === undefined ? {} : { device_channel: channel }) },
});

describe("frame → device resolution", () => {
  it("resolves an attached device by the channel its record states", () => {
    const r = registryWith([{ sn: HUB, raw: {} }, attached(SENSOR_CH16, 16)]);
    expect(r.serialForFrame(HUB, 16)).toBe(SENSOR_CH16);
  });

  it("prefers the attached device that claims channel 0 over the station itself", () => {
    const r = registryWith([{ sn: HUB, raw: {} }, attached(CAM_CH0, 0)]);
    expect(r.serialForFrame(HUB, 0)).toBe(CAM_CH0);
  });

  it("gives the same answer whichever order the roster arrived in", () => {
    const forward = registryWith([{ sn: HUB, raw: {} }, attached(CAM_CH0, 0)]);
    const reversed = registryWith([attached(CAM_CH0, 0), { sn: HUB, raw: {} }]);
    expect(forward.serialForFrame(HUB, 0)).toBe(reversed.serialForFrame(HUB, 0));
  });

  it("does not let a device that states no channel claim channel 0", () => {
    const r = registryWith([{ sn: HUB, raw: {} }, attached(NO_CHANNEL, undefined)]);
    expect(r.serialForFrame(HUB, 0)).toBe(HUB);
  });

  it("answers the station itself for channel 0 when nothing is attached there", () => {
    const r = registryWith([{ sn: HUB, raw: {} }, attached(SENSOR_CH16, 16)]);
    expect(r.serialForFrame(HUB, 0)).toBe(HUB);
  });

  it("resolves a standalone device as its own station on channel 0", () => {
    const r = registryWith([{ sn: STANDALONE, raw: {} }]);
    expect(r.serialForFrame(STANDALONE, 0)).toBe(STANDALONE);
  });

  it("resolves nothing for a channel no device claims", () => {
    const r = registryWith([{ sn: HUB, raw: {} }, attached(SENSOR_CH16, 16)]);
    expect(r.serialForFrame(HUB, 42)).toBeUndefined();
  });

  it("lets no device claim a channel two attached devices both state, whichever order they arrived in", () => {
    const forward = registryWith([{ sn: HUB, raw: {} }, attached(CAM_CH0, 0), attached(TWIN_CH0, 0)]);
    const reversed = registryWith([attached(TWIN_CH0, 0), attached(CAM_CH0, 0), { sn: HUB, raw: {} }]);
    expect(forward.serialForFrame(HUB, 0)).toBeUndefined();
    expect(reversed.serialForFrame(HUB, 0)).toBeUndefined();
  });

  it("counts every attached device towards a clash, whatever its kind", () => {
    const r = registryWith([{ sn: HUB, raw: {} }, attached(SENSOR_CH16, 16), attached(CAM_CH0, 16)]);
    expect(r.serialForFrame(HUB, 16)).toBeUndefined();
  });
});
