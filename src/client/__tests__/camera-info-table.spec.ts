import { afterEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";

/**
 * A HomeBase's camera-info table reports every attached camera at once, keyed by channel. Each channel's
 * params belong to the camera on that channel, so a camera whose cloud record still holds a stale value
 * reads the station's live one as soon as the table arrives.
 */
const HUB = "T8030P0000000000";
const CAM_CH0 = "T8419P0000000000";
const CAM_CH5 = "T8425P0000000000";
const roster = [
  { sn: HUB, model: "T8030", raw: { device_type: 18 } },
  {
    sn: CAM_CH0,
    model: "T8419",
    stationSn: HUB,
    channel: 0,
    raw: { device_type: 33, parent_sn: HUB, device_channel: 0 },
  },
  {
    sn: CAM_CH5,
    model: "T8425",
    stationSn: HUB,
    channel: 5,
    raw: { device_type: 47, parent_sn: HUB, device_channel: 5 },
  },
];
afterEach(() => vi.restoreAllMocks());

function harness() {
  const client = new EufyMega({ email: "test@example.com", password: "x", autoRealtime: false });
  const internal = client as any;
  internal.registry.devices = structuredClone(roster);
  const landed = new Map<string, Record<number, string>>();
  vi.spyOn(internal.registry, "applyRealtimeParams").mockImplementation((sn: unknown, params: unknown) => {
    landed.set(sn as string, { ...(landed.get(sn as string) ?? {}), ...(params as Record<number, string>) });
  });
  return { internal, landed };
}

describe("a station's camera-info table", () => {
  it("lands each channel's params on the camera attached at that channel", () => {
    const { internal, landed } = harness();
    internal.onP2PFrame(HUB, {
      stationSn: HUB,
      channel: 255,
      commandId: 1103,
      json: {},
      channelParams: { 0: { 1400: "0", 1401: "0" }, 5: { 1400: "0", 1401: "100" }, 255: { 1176: "192.0.2.10" } },
    });
    expect(landed.get(CAM_CH0)).toEqual({ 1400: "0", 1401: "0" });
    expect(landed.get(CAM_CH5)).toEqual({ 1400: "0", 1401: "100" });
  });
});
