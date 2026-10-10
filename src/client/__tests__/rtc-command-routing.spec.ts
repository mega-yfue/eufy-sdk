import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../core/contracts.js";
import type { EufyDevice } from "../../core/types.js";
import { DeviceType } from "../../model/device-types.js";
import type { RtcRoute } from "../../transport/rtc/command-router.js";
import { EufyMega } from "../eufy-mega.js";

const HUB = "T8000P0000000000";
const CAMERA = "T8000P0000000001";
const command: Command = { kind: "set-json", param: 1400, data: { time: 0, type: 2, value: 0 }, channel: 3 };

/** A hub whose cloud record carries `device_type` 27 (STATION_9000), or another station family's. */
function fixture(stationType: number = DeviceType.STATION_9000) {
  const client = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
  });
  const internals = client as unknown as {
    registry: { list(): EufyDevice[]; devices: EufyDevice[] };
    rtc: { dispatchCommand(route: RtcRoute, cmd: Command): Promise<void>; mediaProviderFor(route: unknown): unknown };
    p2p: { dispatchCommand(sn: string, cmd: Command): Promise<void> };
    routeCommand(sn: string, cmd: Command): Promise<void>;
    rtcMediaFor(sn: string): unknown;
  };
  const devices = [
    { sn: HUB, model: "T9000", raw: { device_type: stationType, member: { admin_user_id: "synthetic-admin" } } },
    { sn: CAMERA, model: "T8425", stationSn: HUB, raw: { parent_sn: HUB, device_channel: 3 } },
  ] as EufyDevice[];
  internals.registry.devices = devices;
  const rtc = vi.spyOn(internals.rtc, "dispatchCommand").mockResolvedValue();
  const p2p = vi.spyOn(internals.p2p, "dispatchCommand").mockResolvedValue();
  return { internals, rtc, p2p, devices };
}

afterEach(() => vi.restoreAllMocks());

describe("station-owned RTC command routing", () => {
  it.each([
    [HUB, false],
    [CAMERA, true],
  ])("routes %s through RTC with the station's serial and admin id", async (sn, attached) => {
    const { internals, rtc, p2p } = fixture();
    await internals.routeCommand(sn, command);
    expect(rtc).toHaveBeenCalledExactlyOnceWith({ stationSn: HUB, adminUserId: "synthetic-admin", attached }, command);
    expect(p2p).not.toHaveBeenCalled();
  });

  it("leaves the admin id to the router when the station carries no member identity", async () => {
    const { internals, rtc, devices } = fixture();
    devices[0]!.raw = { device_type: DeviceType.STATION_9000 };
    await internals.routeCommand(HUB, command);
    expect(rtc).toHaveBeenCalledExactlyOnceWith({ stationSn: HUB, adminUserId: undefined, attached: false }, command);
  });

  it("keeps another station family on its existing transport", async () => {
    const { internals, rtc, p2p } = fixture(DeviceType.HB3);
    await internals.routeCommand(CAMERA, command);
    expect(p2p).toHaveBeenCalledExactlyOnceWith(CAMERA, command);
    expect(rtc).not.toHaveBeenCalled();
  });

  it("does not infer RTC from a camera model without a supported station", async () => {
    const { internals, rtc, p2p, devices } = fixture();
    devices.shift();
    await internals.routeCommand(CAMERA, command);
    expect(p2p).toHaveBeenCalledExactlyOnceWith(CAMERA, command);
    expect(rtc).not.toHaveBeenCalled();
  });

  it("does not replay an ambiguous RTC failure through P2P", async () => {
    const { internals, rtc, p2p } = fixture();
    rtc.mockRejectedValueOnce(new Error("ACK timed out"));
    await expect(internals.routeCommand(CAMERA, command)).rejects.toThrow("ACK timed out");
    expect(rtc).toHaveBeenCalledTimes(1);
    expect(p2p).not.toHaveBeenCalled();
  });

  it.each(["missing", "shared", "mismatched"])("refuses a %s attached-device channel before sending", async (issue) => {
    const { internals, rtc, p2p, devices } = fixture();
    if (issue === "missing") devices[1]!.raw = { parent_sn: HUB };
    if (issue === "shared") devices.push({ ...devices[1]!, sn: "T8000P0000000002" });
    if (issue === "mismatched") devices[1]!.raw = { parent_sn: HUB, device_channel: 4 };
    await expect(internals.routeCommand(CAMERA, command)).rejects.toThrow("unambiguous attached-device channel");
    expect(rtc).not.toHaveBeenCalled();
    expect(p2p).not.toHaveBeenCalled();
  });

  it("serves an attached camera's media over RTC on its resolved channel, and no other device's", () => {
    const { internals } = fixture();
    const media = vi.spyOn(internals.rtc, "mediaProviderFor").mockReturnValue({ live: vi.fn() });
    expect(internals.rtcMediaFor(CAMERA)).toBeDefined();
    expect(media).toHaveBeenCalledExactlyOnceWith({
      stationSn: HUB,
      adminUserId: "synthetic-admin",
      attached: true,
      cameraSn: CAMERA,
      channel: 3,
    });
    expect(internals.rtcMediaFor(HUB)).toBeUndefined();
    const other = fixture(DeviceType.HB3);
    expect(other.internals.rtcMediaFor(CAMERA)).toBeUndefined();
  });
});
