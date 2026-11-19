import { describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { Device } from "../../model/device.js";

/** A robot data point no capability decodes still lands on the held device, for a bundle-read member to read. */
describe("a realtime data-point report", () => {
  it("lands every point the device reported", () => {
    const sn = "T2261A0000000000";
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });
    const dev = Device.fromRecord(sn, { model: "T2261A", category: "eufy_home_tuya", params: {} });
    const target = eufy as never as {
      liveDevices: Map<string, WeakRef<Device>>;
      registry: { applyRealtimeParams: () => void };
      makeTuyaDpInbound(): { onDps(sn: string, dps: Record<string, unknown>): void };
    };
    target.liveDevices.set(sn, new WeakRef(dev));
    vi.spyOn(target.registry, "applyRealtimeParams").mockImplementation(() => {});
    target.makeTuyaDpInbound().onDps(sn, { 987: "CgI=", 988: true });
    const reported = Object.values(dev.getProperties()).map((p) => [p.paramType, p.value]);
    expect(reported).toEqual(
      expect.arrayContaining([
        [987, "CgI="],
        [988, "1"],
      ]),
    );
  });
});
