import { afterEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import type { EufyDevice } from "../../core/types.js";
import type { MediaProvider } from "../../core/contracts.js";

afterEach(() => vi.restoreAllMocks());

describe("PoE media power through the public device API", () => {
  it.each([
    ["T8E00", "Synthetic PoE Bullet PTZ Cam S4"],
    ["T8P00", "Synthetic PoE Cam E40"],
  ])("does not apply a battery budget to %s", async (model, name) => {
    const client = new EufyMega({
      email: "synthetic@example.invalid",
      password: "synthetic",
      autoRealtime: false,
      pollMs: 0,
    });
    const internals = client as any;
    const hub = "T8N00P0000000000",
      sn = `${model}P0000000001`;
    internals.registry.devices = [
      {
        sn: hub,
        model: "T8N00",
        name: "Synthetic NVR S4",
        category: "eufy_security",
        deviceClass: "station",
        api: "mega",
        realtime: "p2p",
        raw: {},
      },
      {
        sn,
        model,
        name,
        category: "eufy_security",
        deviceClass: "camera",
        api: "mega",
        realtime: "p2p",
        stationSn: hub,
        channel: 3,
        params: { 1101: "100" },
        raw: { parent_sn: hub, device_channel: 3 },
      },
    ] as EufyDevice[];
    vi.spyOn(internals.mega, "getDeviceParamList").mockResolvedValue({ params: [] });
    const seen: unknown[] = [];
    const media: MediaProvider = {
      live: async (opts) => {
        seen.push(opts?.powered);
        return {} as never;
      },
      snapshotLive: async (opts) => {
        seen.push(opts?.powered);
        return { jpeg: Buffer.alloc(0), width: 1, height: 1 };
      },
      record: async () => Buffer.alloc(0),
    };
    // Replace only the transport boundary; preserve record resolution and capability composition.
    vi.spyOn(internals, "rtcMediaFor").mockReturnValue(media);
    const device = await client.getDevice(sn);
    await device.camera!()!.live!();
    await device.camera!()!.snapshotLive!();
    expect(seen).toEqual(["wired", "wired"]);
  });
});
