import { afterEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import type { CommandContext } from "../../model/capabilities/types.js";
import { parseThingsList } from "../../model/capabilities/thing-description.js";

// The product's settings-bundle data, synthetic: the spec is about the code, not the shipped data.
vi.mock("../../model/capabilities/bundle-wires.generated.json", async () => {
  const f = await import("../../model/capabilities/__tests__/bundle-fixture.js");
  return f.bundleData("T8410", { camera_on_off: f.power() });
});

afterEach(() => vi.restoreAllMocks());

describe("camera power context", () => {
  it("uses the normalized parent station when raw topology uses station_sn", async () => {
    const client = new EufyMega({ email: "t@example.com", password: "x" });
    const sn = "T8410P0000000000";
    const stationSn = "T8030P0000000000";
    const internal = client as any;
    vi.spyOn(internal.registry, "record").mockResolvedValue({
      deviceType: 31,
      model: "T8410",
      category: "eufy_security",
      parentSn: stationSn,
      params: { 1035: "0" },
    });
    vi.spyOn(internal.registry, "require").mockReturnValue({
      sn,
      category: "eufy_security",
      raw: { station_sn: stationSn, device_channel: 3, main_sw_version: "2.3.2.4" },
    });
    const ctx: CommandContext = await internal.commandContext(sn);
    expect(ctx.stationSerial).toBe(stationSn);
  });

  it.each([true, false])("dispatches enabled=%s without polling stale 1035 for confirmation", async (enabled) => {
    const client = new EufyMega({ email: "t@example.com", password: "x" });
    const internal = client as any;
    vi.spyOn(internal, "commandContext").mockResolvedValue({
      codec: "camera",
      model: "T8410",
      deviceType: 31,
      channel: 3,
      stationSerial: "T8030P0000000000",
      homeBaseAttached: true,
      firmwareVersion: "2.3.2.4",
      paramIds: new Set([1035]),
      capabilities: new Set(["camera"]),
      things: parseThingsList({
        things_list: [{ profile: { product_code: "T8410" }, properties: [{ identifier: "camera_on_off" }] }],
      }).T8410,
    });
    const route = vi.spyOn(internal, "routeCommand").mockResolvedValue(undefined);
    const refresh = vi.spyOn(internal.registry, "refreshedList");
    await client.setProperty("T8410P0000000000", "enabled", enabled);
    expect(route).toHaveBeenCalledWith(
      "T8410P0000000000",
      expect.objectContaining({
        kind: "set-payload",
        cmd: 6250,
        payload: expect.objectContaining({ switch: enabled ? 0 : 1 }),
        channel: 3,
        mValue3: 0,
      }),
    );
    expect(refresh).not.toHaveBeenCalled();
  });
});
