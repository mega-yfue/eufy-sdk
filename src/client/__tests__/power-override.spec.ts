import { EufyMega } from "../eufy-mega.js";
import type { EufyDevice } from "../../core/types.js";
import type { MediaProvider } from "../../core/contracts.js";

const BASE = "T8000P0000000000";
const DOORBELL = "T8000P0000000001";

function doorbell(): EufyDevice {
  return {
    sn: DOORBELL,
    stationSn: BASE,
    model: "T8214",
    category: "eufy_security",
    deviceClass: "camera",
    api: "mega",
    realtime: "p2p",
    p2pDid: "XXXXXXX-000000-XXXXX",
    params: { 1101: "98", 2111: "3" },
    raw: { parent_sn: BASE, device_type: 16, device_channel: 1 },
  } as EufyDevice;
}

describe("local operating-power override", () => {
  it("is available on a bound battery device and changes the next media call", async () => {
    const eufy = new EufyMega({
      email: "synthetic@example.com",
      password: "synthetic",
      autoRealtime: false,
      storedSnapshotCache: false,
    });
    const record = doorbell();
    vi.spyOn((eufy as any).registry, "list").mockReturnValue([record]);
    vi.spyOn((eufy as any).registry, "record").mockResolvedValue({
      model: record.model,
      deviceType: 16,
      category: record.category,
      parentSn: BASE,
      params: record.params,
      paramUpdatedAt: {},
    });
    vi.spyOn(eufy as any, "commandContext").mockResolvedValue({
      channel: 1,
      codec: "camera",
      serial: DOORBELL,
      model: "T8214",
      capabilities: new Set(["camera", "battery"]),
      paramIds: new Set([1101, 2111]),
    });
    const seen: string[] = [];
    vi.spyOn((eufy as any).p2p, "mediaProviderFor").mockReturnValue({
      snapshotLive: async (opts: Parameters<MediaProvider["snapshotLive"]>[0]) => {
        seen.push(opts?.powered ?? "missing");
        return { jpeg: Buffer.alloc(0), width: 1, height: 1 };
      },
    } satisfies Partial<MediaProvider>);
    const update = vi.spyOn((eufy as any).p2p, "updatePowerTier").mockImplementation(() => {});
    const device = await eufy.getDevice(DOORBELL);
    const battery = device.battery?.();
    expect(battery?.powerOverride?.()).toBe("auto");
    await device.camera?.()?.snapshotLive?.();
    battery?.setPowerOverride?.("always-on");
    expect(battery?.powerOverride?.()).toBe("always-on");
    await device.camera?.()?.snapshotLive?.();
    battery?.setPowerOverride?.("battery");
    await device.camera?.()?.snapshotLive?.();
    battery?.setPowerOverride?.("auto");
    expect(battery?.powerOverride?.()).toBe("auto");
    expect(seen).toEqual(["battery", "wired", "battery"]);
    expect(update).toHaveBeenCalledWith(DOORBELL, "wired");
    expect(update).toHaveBeenCalledWith(DOORBELL, "battery");
  });

  it("applies an initial claim before a standalone battery station is warmed", () => {
    const eufy = new EufyMega({
      email: "synthetic@example.com",
      password: "synthetic",
      powerOverrides: { [DOORBELL]: "always-on" },
    });
    vi.spyOn((eufy as any).registry, "list").mockReturnValue([{ ...doorbell(), stationSn: DOORBELL, raw: {} }]);
    expect((eufy as any).stationPower(DOORBELL)).toBe("wired");
  });
});
