import { cameraPowerTier } from "../../../index.js";
import { Device } from "../../device.js";
import { resolveDevice } from "../../registry.js";
import { bind } from "./bind.js";
import { EufyMega } from "../../../client/eufy-mega.js";
import type { CameraActions } from "../camera.js";
import type { CommandContext } from "../types.js";
import type { Capability } from "../../types.js";
import type { MediaProvider } from "../../../core/contracts.js";
import type { EufyDevice } from "../../../core/types.js";

/**
 * Issue #191: the T84A1 Wall Light Cam S100 is hardwired, but it reports battery-family params, so it
 * resolved `battery` and its standalone live stream was cut by the battery budget every ~57 s. A
 * confirmed mains-only model must stream unbounded, keep a persistent session and show no cell reading.
 */
const SN = "T84A1P0000000001";
const BATTERY_CAPS = new Set<Capability>(["camera", "battery"]);

describe("mains-only camera power tier (T84A1 Wall Light Cam S100)", () => {
  it("classifies T84A1 as wired even with the battery capability resolved", () => {
    expect(cameraPowerTier("T84A1", BATTERY_CAPS)).toBe("wired");
    expect(cameraPowerTier(SN, BATTERY_CAPS)).toBe("wired");
    // A real battery camera is still budgeted, and a camera without the capability never is.
    expect(cameraPowerTier("T8114P0000000001", BATTERY_CAPS)).toBe("battery");
    expect(cameraPowerTier("T8114P0000000001", new Set(["camera"]))).toBe("wired");
  });

  it("gives every media egress the wired tier, so no battery budget is armed", async () => {
    const seen: string[] = [];
    const media: MediaProvider = {
      snapshotLive: async (opts) => {
        seen.push(opts?.powered ?? "missing");
        return { jpeg: Buffer.alloc(0), width: 1, height: 1 };
      },
      live: async (opts) => (seen.push(opts?.powered ?? "missing"), {}) as never,
      record: async () => Buffer.alloc(0),
    };
    const ctx: CommandContext = {
      channel: 0,
      codec: "camera",
      model: "T84A1",
      paramIds: new Set<number>([1101]),
      capabilities: BATTERY_CAPS,
    };
    const { acts } = bind<CameraActions>("camera", ctx, { media });
    await acts.snapshotLive!();
    await acts.live!();
    expect(seen).toEqual(["wired", "wired"]);
  });

  it("resolves by name and withholds the sentinel battery level", () => {
    const record = { deviceType: 30, model: "T84A1", params: { 1101: "100" } };
    expect(resolveDevice(record).name).toBe("Wall Light Cam S100");
    const dev = Device.fromRecord(SN, record);
    expect(dev.getProperty("battery")).toBeUndefined();
  });

  it("keeps a standalone T84A1's P2P session on the persistent wired tier", () => {
    const eufy = new EufyMega({ email: "synthetic@example.com", password: "synthetic", autoRealtime: false });
    const device = {
      sn: SN,
      stationSn: SN,
      model: "T84A1",
      category: "eufy_security",
      deviceClass: "camera",
      params: { 1101: "100" },
      raw: {},
    } as unknown as EufyDevice;
    vi.spyOn((eufy as any).registry, "list").mockReturnValue([device]);
    expect((eufy as any).stationPower(SN)).toBe("wired");
  });

  it("classifies a T8423 Floodlight S330 as wired despite battery-family parameters", async () => {
    const sn = "T8423P0000000001";
    expect(cameraPowerTier(sn, BATTERY_CAPS)).toBe("wired");

    const seen: string[] = [];
    const media: MediaProvider = {
      snapshotLive: async (opts) => {
        seen.push(opts?.powered ?? "missing");
        return { jpeg: Buffer.alloc(0), width: 1, height: 1 };
      },
      live: async (opts) => (seen.push(opts?.powered ?? "missing"), {}) as never,
      record: async () => Buffer.alloc(0),
    };
    const { acts } = bind<CameraActions>(
      "camera",
      {
        channel: 0,
        codec: "camera",
        model: "T8423",
        paramIds: new Set<number>([1101]),
        capabilities: BATTERY_CAPS,
      },
      { media },
    );
    await acts.snapshotLive!();
    await acts.live!();
    expect(seen).toEqual(["wired", "wired"]);

    const eufy = new EufyMega({ email: "synthetic@example.com", password: "synthetic", autoRealtime: false });
    const device = {
      sn,
      stationSn: sn,
      model: "T8423",
      category: "eufy_security",
      deviceClass: "camera",
      params: { 1101: "100" },
      raw: {},
    } as unknown as EufyDevice;
    vi.spyOn((eufy as any).registry, "list").mockReturnValue([device]);
    expect((eufy as any).stationPower(sn)).toBe("wired");
    expect(
      Device.fromRecord(sn, { deviceType: 9, model: "T8423", params: { 1101: "100" } }).getProperty("battery"),
    ).toBeUndefined();
  });
});
