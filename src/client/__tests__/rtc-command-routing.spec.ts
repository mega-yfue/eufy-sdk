import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../core/contracts.js";
import type { EufyDevice } from "../../core/types.js";
import type { ThingDescription, ThingProperty } from "../../model/capabilities/thing-description.js";
import { DeviceType } from "../../model/device-types.js";
import { rtcLiveFrames } from "../../model/capabilities/bundle.js";
import type { RtcLiveRoute, RtcRoute } from "../../transport/rtc/command-router.js";
import { EufyMega } from "../eufy-mega.js";

/** Synthetic serials, did, license and documentation-range addresses throughout; no network. */
const HUB = "T8000P0000000000";
const CAMERA = "T8000P0000000001";
const command: Command = { kind: "set-json", param: 1400, data: { time: 0, type: 2, value: 0 }, channel: 3 };
const RECORD = {
  p2p_did: "SYNTH-000000-AAAAA",
  p2p_license: "SYNLIC",
  signaling_servers: ["https://signal.example.invalid/x", "https://192.0.2.7/path"],
  main_sw_version: "4.1.0.2",
  webrtc_sdk_version: "1.7.2",
  member: { admin_user_id: "synthetic-admin" },
};

const prop = (identifier: string, defaultValue: string) =>
  ({ identifier, defaultValue, members: [], readConditions: [], availableConditions: [] }) as unknown as ThingProperty;

/** A station of `model` whose resolved description carries `props`, and a camera attached to it on channel 3. */
function fixture(model: string, props: Record<string, string> = {}, record: Record<string, unknown> = RECORD) {
  const client = new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
  });
  const internals = client as unknown as {
    registry: { devices: EufyDevice[]; thingsOf(sn: string): ThingDescription | undefined };
    rtc: {
      dispatchCommand(route: RtcRoute, cmd: Command): Promise<void>;
      mediaProviderFor(route: RtcLiveRoute): unknown;
    };
    p2p: { dispatchCommand(sn: string, cmd: Command): Promise<void> };
    routeCommand(sn: string, cmd: Command): Promise<void>;
    rtcRouteFor(sn: string): RtcRoute | undefined;
    rtcMediaFor(sn: string): unknown;
  };
  internals.registry.devices = [
    { sn: HUB, model, raw: { device_type: DeviceType.STATION_9000, ...record } },
    { sn: CAMERA, model: "T8425", stationSn: HUB, channel: 3, raw: { parent_sn: HUB, device_channel: 3 } },
  ] as EufyDevice[];
  const properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, prop(k, v)]));
  vi.spyOn(internals.registry, "thingsOf").mockImplementation((sn) =>
    sn === HUB ? ({ properties } as unknown as ThingDescription) : undefined,
  );
  const rtc = vi.spyOn(internals.rtc, "dispatchCommand").mockResolvedValue();
  const p2p = vi.spyOn(internals.p2p, "dispatchCommand").mockResolvedValue();
  return { internals, rtc, p2p };
}

const route = (attached: boolean): RtcRoute => ({
  stationSn: HUB,
  attached,
  adminUserId: "synthetic-admin",
  did: "SYNTH-000000-AAAAA",
  lic: "SYNLIC",
  host: "192.0.2.7",
  domain: "signal.example.invalid",
  version: 4102,
  sdkVersion: "1.7.2",
});

afterEach(() => vi.restoreAllMocks());

describe("native RTC routing off is_connect_webrtc", () => {
  it.each([
    [HUB, false],
    [CAMERA, true],
  ])("routes T9000 target %s over native RTC with the station record's inputs", async (sn, attached) => {
    const { internals, rtc, p2p } = fixture("T9000", { is_connect_webrtc: "2" });
    await internals.routeCommand(sn, command);
    expect(rtc).toHaveBeenCalledExactlyOnceWith(route(attached), command);
    expect(p2p).not.toHaveBeenCalled();
  });

  it("routes a standalone T8170 whose description reads 1 over native RTC", async () => {
    const { internals, rtc, p2p } = fixture("T8170", { is_connect_webrtc: "1" });
    await internals.routeCommand(HUB, command);
    expect(rtc).toHaveBeenCalledExactlyOnceWith(route(false), command);
    expect(p2p).not.toHaveBeenCalled();
  });

  it.each([
    ["no is_connect_webrtc", {}, RECORD],
    ["is_connect_webrtc 0", { is_connect_webrtc: "0" }, RECORD],
    ["no IPv4 signalling server", { is_connect_webrtc: "2" }, { ...RECORD, signaling_servers: ["https://a.invalid"] }],
    ["no license", { is_connect_webrtc: "2" }, { ...RECORD, p2p_license: "" }],
  ])("keeps a station with %s on P2P", async (_, props, record) => {
    const { internals, rtc, p2p } = fixture("T8010", props, record);
    await internals.routeCommand(HUB, command);
    expect(p2p).toHaveBeenCalledExactlyOnceWith(HUB, command);
    expect(rtc).not.toHaveBeenCalled();
  });

  describe("a station at 1 with a sub-device list (T8030, T8025)", () => {
    const sub = (list: string) => ({ is_connect_webrtc: "1", is_connect_webrtc_sub_device_list: list });

    it("sends the station's and a listed child's commands over RTC and keeps the station's P2P connection", async () => {
      const { internals, rtc, p2p } = fixture("T8030", sub('["T8425"]'));
      await internals.routeCommand(HUB, command);
      await internals.routeCommand(CAMERA, command);
      expect(rtc.mock.calls.map(([r]) => r.attached)).toEqual([false, true]);
      expect(p2p).not.toHaveBeenCalled();
      expect(internals.rtcRouteFor(HUB)).toBeUndefined();
    });

    it("plays every child on the station's RTC session once a listed model is among them, with its hb3 frames", () => {
      const { internals } = fixture("T8030", sub('["T8425"]'));
      const hub = "T8030P0000000000";
      const [station, camera] = internals.registry.devices as [EufyDevice, EufyDevice];
      Object.assign(station, { sn: hub });
      Object.assign(camera, { stationSn: hub, raw: { parent_sn: hub, device_channel: 3 } });
      vi.mocked(internals.registry.thingsOf).mockImplementation((sn) =>
        sn === hub
          ? ({
              properties: Object.fromEntries(Object.entries(sub('["T8425"]')).map(([k, v]) => [k, prop(k, v)])),
            } as never)
          : undefined,
      );
      const media = vi.spyOn(internals.rtc, "mediaProviderFor").mockReturnValue({});
      internals.rtcMediaFor(CAMERA);
      expect(media.mock.calls[0]![0]).toMatchObject({
        stationSn: hub,
        cameraSn: CAMERA,
        live: rtcLiveFrames("T8425", hub),
      });
      expect(rtcLiveFrames("T8425", hub)?.start).toBeDefined();
      // A T8600 under it starts with 1700, above the station's 4.2.0.0 with the NVR 1350.
      expect(rtcLiveFrames("T8600", hub)?.start.cmd).toBe(1700);
      expect(rtcLiveFrames("T8600", hub, { parent: "4.2.0.1" })?.start.cmd).toBe(1350);
      // Each frame's route as its parser gates it: a T8172's NVR start from the T8030's 3.7.4.3, its stop always.
      expect(rtcLiveFrames("T8172", hub, { parent: "3.7.4.2" })).toMatchObject({
        start: { rtcSendRoute: 0 },
        stop: { rtcSendRoute: 1 },
      });
      expect(rtcLiveFrames("T8172", hub, { parent: "3.7.4.3" })?.start.rtcSendRoute).toBe(1);
      // A standalone T8223's stop from its own 3.3.7.6; its start never.
      const solo = "T8223P0000000000";
      expect(rtcLiveFrames("T8223", solo, { own: "3.3.7.5" })).toMatchObject({
        start: { cmd: 1700 },
        stop: { rtcSendRoute: 0 },
      });
      expect(rtcLiveFrames("T8223", solo, { own: "3.3.7.6" })?.stop.rtcSendRoute).toBe(1);
      expect(rtcLiveFrames("T8223", solo, { own: "3.3.7.6" })?.start.rtcSendRoute).toBeUndefined();
      expect(internals.rtcRouteFor(hub)).toBeUndefined();
    });

    it("keeps every command on P2P when no child model is listed", async () => {
      const { internals, rtc, p2p } = fixture("T8030", sub('["T8223"]'));
      await internals.routeCommand(CAMERA, command);
      expect(p2p).toHaveBeenCalledOnce();
      expect(rtc).not.toHaveBeenCalled();
    });

    it("sends a T8223 child's 1700 1000-1002 and 1004-1006 over RTC and the rest over P2P", async () => {
      const { internals, rtc, p2p } = fixture("T8025", sub('["T8223"]'));
      internals.registry.devices[1]!.model = "T8223";
      const live: Command = { kind: "set-json", param: 1001, data: {}, channel: 3 };
      const stop: Command = { kind: "set-param", param: 1004, value: 0, channel: 3 };
      for (const c of [command, live, stop]) await internals.routeCommand(CAMERA, c);
      expect(rtc.mock.calls.map(([, c]) => c)).toEqual([live, stop]);
      expect(p2p).toHaveBeenCalledExactlyOnceWith(CAMERA, command);
    });
  });

  it("gives an RTC camera's view its product's rtcLive frames under the station, none for a product without", () => {
    const { internals } = fixture("T9000", { is_connect_webrtc: "2" });
    const hub = "T9000P0000000000";
    const [station, camera] = internals.registry.devices as [EufyDevice, EufyDevice];
    Object.assign(station, { sn: hub });
    Object.assign(camera, { stationSn: hub, raw: { parent_sn: hub, device_channel: 3 } });
    vi.mocked(internals.registry.thingsOf).mockImplementation(
      (sn) => (sn === hub ? { properties: { is_connect_webrtc: prop("is_connect_webrtc", "2") } } : undefined) as never,
    );
    const media = vi.spyOn(internals.rtc, "mediaProviderFor").mockReturnValue({});
    internals.rtcMediaFor(CAMERA);
    expect(media.mock.calls[0]![0]).toMatchObject({ cameraSn: CAMERA, channel: 3, live: rtcLiveFrames("T8425", hub) });
    expect(rtcLiveFrames("T8425", hub)?.start).toMatchObject({ cmd: 1350, payload: { cmd: 1003 } });
    expect(rtcLiveFrames("T8425", hub)).toMatchObject({ talkStart: { cmd: 1005 }, talkStop: { cmd: 1006 } });
    // A camera whose param 9240 lists lenses opens the T_B_2X2 page.
    camera.params = { 9240: '[{"type":0,"id":0},{"type":1,"id":1}]' };
    internals.rtcMediaFor(CAMERA);
    expect(media.mock.calls[1]![0]).toMatchObject({
      sensors: [0, 1],
      live: { start: { payload: { payload: { stitch_mode: 5 } } } },
    });
    camera.model = "T8010";
    internals.rtcMediaFor(CAMERA);
    expect(media.mock.calls[2]![0].live).toBeUndefined();
  });

  it("refuses an attached device whose channel does not resolve back to it, before sending", async () => {
    const { internals, rtc, p2p } = fixture("T9000", { is_connect_webrtc: "2" });
    Object.assign(internals.registry.devices[1]!, { channel: 4, raw: { parent_sn: HUB, device_channel: 4 } });
    await expect(internals.routeCommand(CAMERA, command)).rejects.toThrow("unambiguous attached-device channel");
    expect(rtc).not.toHaveBeenCalled();
    expect(p2p).not.toHaveBeenCalled();
  });
});
