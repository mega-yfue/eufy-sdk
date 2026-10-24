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
    { sn: CAMERA, model: "T8425", stationSn: HUB, channel: 3, raw: { parent_sn: HUB, device_channel: 3 } },
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
  ])("routes T8N00 target %s through RTC with its station identity", async (sn, attached) => {
    const { internals, rtc, p2p, devices } = fixture(DeviceType.NVR_S4_MAX);
    devices[0]!.model = "T8N00";
    devices[1]!.model = "T8E00";
    await internals.routeCommand(sn, command);
    expect(rtc).toHaveBeenCalledExactlyOnceWith(
      { stationSn: HUB, adminUserId: "synthetic-admin", attached, signalingMode: "call", iceTransportPolicy: "all" },
      command,
    );
    expect(p2p).not.toHaveBeenCalled();
  });

  it("recognises the reported T8N00 model when device_type is absent", async () => {
    const { internals, rtc, p2p, devices } = fixture();
    devices[0]!.model = "T8N00";
    devices[0]!.raw = { member: { admin_user_id: "synthetic-admin" } };
    await internals.routeCommand(HUB, command);
    expect(rtc).toHaveBeenCalledExactlyOnceWith(
      {
        stationSn: HUB,
        adminUserId: "synthetic-admin",
        attached: false,
        signalingMode: "call",
        iceTransportPolicy: "all",
      },
      command,
    );
    expect(p2p).not.toHaveBeenCalled();
  });

  it("does not infer RTC for an unqualified NVR model from its device type", async () => {
    const { internals, rtc, p2p, devices } = fixture(DeviceType.NVR_S4_MAX);
    devices[0]!.model = "T8N01";
    await internals.routeCommand(HUB, command);
    expect(p2p).toHaveBeenCalledExactlyOnceWith(HUB, command);
    expect(rtc).not.toHaveBeenCalled();
  });

  it.each(["missing", "shared", "mismatched"])("refuses a %s T8N00 child channel before sending", async (issue) => {
    const { internals, rtc, p2p, devices } = fixture(DeviceType.NVR_S4_MAX);
    devices[0]!.model = "T8N00";
    devices[1]!.model = "T8E00";
    if (issue === "missing") Object.assign(devices[1]!, { channel: undefined, raw: { parent_sn: HUB } });
    if (issue === "shared") devices.push({ ...devices[1]!, sn: "T8000P0000000002" });
    if (issue === "mismatched") Object.assign(devices[1]!, { channel: 4, raw: { parent_sn: HUB, device_channel: 4 } });
    await expect(internals.routeCommand(CAMERA, command)).rejects.toThrow("unambiguous attached-device channel");
    expect(rtc).not.toHaveBeenCalled();
    expect(p2p).not.toHaveBeenCalled();
  });

  it("does not replay an ambiguous T8N00 RTC failure through P2P", async () => {
    const { internals, rtc, p2p, devices } = fixture(DeviceType.NVR_S4_MAX);
    devices[0]!.model = "T8N00";
    rtc.mockRejectedValueOnce(new Error("ACK timed out"));
    await expect(internals.routeCommand(HUB, command)).rejects.toThrow("ACK timed out");
    expect(rtc).toHaveBeenCalledTimes(1);
    expect(p2p).not.toHaveBeenCalled();
  });

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
    if (issue === "missing") Object.assign(devices[1]!, { channel: undefined, raw: { parent_sn: HUB } });
    if (issue === "shared") devices.push({ ...devices[1]!, sn: "T8000P0000000002" });
    if (issue === "mismatched") Object.assign(devices[1]!, { channel: 4, raw: { parent_sn: HUB, device_channel: 4 } });
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

  it("serves no RTC media for a camera attached to a T8N00, whose route carries commands only", () => {
    const { internals, devices } = fixture();
    devices[0]!.model = "T8N00";
    devices[0]!.raw = { member: { admin_user_id: "synthetic-admin" } };
    const media = vi.spyOn(internals.rtc, "mediaProviderFor").mockReturnValue({ live: vi.fn() });
    expect(internals.rtcMediaFor(CAMERA)).toBeUndefined();
    expect(media).not.toHaveBeenCalled();
  });
});

describe("keepStationWarm", () => {
  const warmInternals = (internals: unknown) =>
    internals as {
      rtc: { keepWarm(route: RtcRoute): () => void };
      keepStationWarm(stationSn: string): () => void;
    };

  it("holds a T9000 station warm through the router with its station identity", () => {
    const { internals } = fixture();
    const disposer = vi.fn();
    const keepWarm = vi.spyOn(warmInternals(internals).rtc, "keepWarm").mockReturnValue(disposer);
    expect(warmInternals(internals).keepStationWarm(HUB)).toBe(disposer);
    expect(keepWarm).toHaveBeenCalledExactlyOnceWith({
      stationSn: HUB,
      adminUserId: "synthetic-admin",
      attached: false,
    });
  });

  it("throws for a station that is not a T9000, without touching the router", () => {
    const { internals } = fixture(DeviceType.HB3);
    const keepWarm = vi.spyOn(warmInternals(internals).rtc, "keepWarm");
    expect(() => warmInternals(internals).keepStationWarm(HUB)).toThrow(`rtc: ${HUB} has no warm command session`);
    expect(keepWarm).not.toHaveBeenCalled();
  });
});

describe("command context of a device behind a station", () => {
  /** The context a capability gets, from the record the command sink already holds. */
  const contextOf = (internals: unknown, sn: string, model: string) =>
    (
      internals as {
        commandContext(sn: string, known: unknown): Promise<{ stationDeviceType?: number }>;
      }
    ).commandContext(sn, { sn, model, params: {} });

  it("names the cloud device_type of the station a camera hangs off, and none for the station itself", async () => {
    const t9000 = fixture();
    expect((await contextOf(t9000.internals, CAMERA, "T8425")).stationDeviceType).toBe(DeviceType.STATION_9000);
    expect((await contextOf(t9000.internals, HUB, "T9000")).stationDeviceType).toBeUndefined();
    const linkedOnly = fixture();
    linkedOnly.devices[1]!.raw = { device_channel: 3 };
    expect((await contextOf(linkedOnly.internals, CAMERA, "T8425")).stationDeviceType).toBe(DeviceType.STATION_9000);
    const hb3 = fixture(DeviceType.HB3);
    expect((await contextOf(hb3.internals, CAMERA, "T8425")).stationDeviceType).toBe(DeviceType.HB3);
  });
});

describe("standalone T8223/T8224 doorbell", () => {
  const DOORBELL = "T8000P0000000002";
  const ROUTE = {
    stationSn: DOORBELL,
    adminUserId: "synthetic-admin",
    attached: false,
    signalingMode: "call",
    iceTransportPolicy: "all",
    mediaTrack: true,
  };

  function doorbell(model = "T8223", stationSn = DOORBELL) {
    const f = fixture();
    f.devices.splice(0, f.devices.length, {
      sn: DOORBELL,
      model,
      stationSn,
      raw: { parent_sn: stationSn, member: { admin_user_id: "synthetic-admin" } },
    } as EufyDevice);
    if (stationSn !== DOORBELL) f.devices.push({ sn: stationSn, model, raw: {} } as EufyDevice);
    const rtc = f.internals.rtc as unknown as { trackMediaProviderFor(route: unknown): unknown };
    const track = vi.spyOn(rtc, "trackMediaProviderFor").mockReturnValue({ live: vi.fn() });
    const p2pMedia = vi.spyOn(
      f.internals.p2p as unknown as { mediaProviderFor(sn: string): unknown },
      "mediaProviderFor",
    );
    const mediaProviderFor = (sn: string) =>
      (f.internals as unknown as { mediaProviderFor(sn: string): unknown }).mediaProviderFor(sn);
    return { ...f, track, p2pMedia, mediaProviderFor };
  }

  it.each(["T8223", "T8224"])("gets a %s's media over its own call route, not P2P", (model) => {
    const { track, p2pMedia, mediaProviderFor } = doorbell(model);
    expect(mediaProviderFor(DOORBELL)).toBeDefined();
    expect(track).toHaveBeenCalledExactlyOnceWith(ROUTE);
    expect(p2pMedia).not.toHaveBeenCalled();
  });

  it("sends a command to the RTC router on the same route, not P2P", async () => {
    const { internals, rtc, p2p } = doorbell();
    await internals.routeCommand(DOORBELL, command);
    expect(rtc).toHaveBeenCalledExactlyOnceWith(ROUTE, command);
    expect(p2p).not.toHaveBeenCalled();
  });

  it("leaves a T8223 whose record names another T8223 as its station on P2P", () => {
    const { internals, track } = doorbell("T8223", HUB);
    expect(internals.rtcMediaFor(DOORBELL)).toBeUndefined();
    expect(track).not.toHaveBeenCalled();
  });
});
