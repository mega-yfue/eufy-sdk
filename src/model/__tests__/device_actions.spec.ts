import { Device } from "../device.js";
import { buildCommand } from "../capabilities/index.js";
import { LIGHT_CMD } from "../capabilities/light.js";
import { PtzDirection } from "../capabilities/ptz.js";
import { DeviceType } from "../device-types.js";
import type { CommandContext, CloudRecord } from "../types.js";
import type { Command, CommandSink } from "../../core/contracts.js";

/**
 * Device-integration tests — what's unique to `Device`, NOT per-module behaviour (each capability
 * has its own colocated spec). Two things live only here:
 *   1. `bindActions` → the fluent `device.<cap>()` accessor returns an action object for a HAD
 *      capability, and `undefined` otherwise.
 *   2. `buildCommand` is gated on the device's DETECTED capabilities — a module can't emit a command
 *      for a capability the device lacks, so `setProperty` throws instead of a silent P2P no-op.
 * Test values are read straight from the modules (not hardcoded ids), so a module change can't
 * leave a stale copy here.
 */
const PT_DEVICE_TYPE = DeviceType.OUTDOOR_PT_CAMERA;
const SPOTLIGHT_PARAM = LIGHT_CMD.FLOODLIGHT_SWITCH; // presence ⇒ `light`
const makeDevice = (rec: Parameters<typeof Device.fromRecord>[1]) => Device.fromRecord("SN1", rec);

describe("Device.bindActions → fluent device.<cap>() accessors", () => {
  it("exposes an action object only for a capability the device HAS, and dispatches through the sink", async () => {
    const dev = makeDevice({ deviceType: PT_DEVICE_TYPE, model: "T8410", category: "eufy_security", params: {} });
    // Unbound: no action objects yet.
    expect(dev.ptz?.()).toBeUndefined();

    const sent: Command[] = [];
    const sink: CommandSink = { dispatch: async (c) => void sent.push(c) };
    dev.bindActions({ channel: 0, codec: "camera", deviceType: PT_DEVICE_TYPE, paramIds: new Set() }, sink);

    expect(dev.ptz?.()).toBeDefined(); // has ptz
    expect(dev.light?.()).toBeUndefined(); // no spotlight → no light
    await dev.ptz?.()!.rotate(PtzDirection.left);
    expect(sent[0]).toMatchObject({ kind: "set-json" });
  });
});

describe("buildCommand is gated on detected capabilities (no silent no-op)", () => {
  const ctx = (deviceType: number, paramIds: number[]): CommandContext => ({
    channel: 0,
    codec: "camera",
    deviceType,
    paramIds: new Set(paramIds),
  });

  it("refuses an action for a capability the device lacks → setProperty throws", () => {
    // A pan-tilt cam with no spotlight param: HAS ptz, NOT light.
    const noSpotlight = ctx(PT_DEVICE_TYPE, []);
    expect(buildCommand("light", true, noSpotlight)).toBeUndefined(); // → CapabilityNotSupportedError
    expect(buildCommand("rotate", "left", noSpotlight)).toBeDefined(); // its real capability resolves
  });

  it("resolves the action when the device HAS the capability", () => {
    // Reports a spotlight param → `light` is detected → buildCommand produces a command.
    expect(buildCommand("light", true, ctx(PT_DEVICE_TYPE, [SPOTLIGHT_PARAM]))).toBeDefined();
  });
});

describe("Device.reresolve — a capability discovered after the device was built", () => {
  /** A camera record with no battery param, so `battery` is not granted at construction. */
  const bare = (params: Record<number, string> = {}): CloudRecord => ({
    model: "T8410",
    category: "eufy_security",
    deviceType: 7,
    params,
  });

  it("grants the accessor once the evidence arrives, and reports what was gained", () => {
    const dev = Device.fromRecord("T8000P0000000000", bare());
    expect(dev.capabilities).not.toContain("battery");
    expect("battery" in dev).toBe(false);

    const gained = dev.reresolve(bare({ 1101: "88" }));

    expect(gained).toContain("battery");
    expect(dev.capabilities).toContain("battery");
    expect("battery" in dev).toBe(true);
  });

  it("reports nothing gained when the evidence adds no capability", () => {
    const dev = Device.fromRecord("T8000P0000000000", bare());
    expect(dev.reresolve(bare())).toEqual([]);
  });

  it("never retracts a capability the device stops reporting", () => {
    // A cloud record is a snapshot and can lose a field for reasons unrelated to the hardware;
    // revoking an accessor a caller already holds is worse than keeping a quiet one.
    const dev = Device.fromRecord("T8000P0000000000", bare({ 1101: "88" }));
    expect(dev.capabilities).toContain("battery");
    dev.reresolve(bare());
    expect(dev.capabilities).toContain("battery");
    expect("battery" in dev).toBe(true);
  });

  it("keeps state and bound actions across the widening", () => {
    const dev = Device.fromRecord("T8000P0000000000", bare());
    const ctx: CommandContext = { channel: 0, codec: "camera", paramIds: new Set([1101]) };
    const sent: Command[] = [];
    dev.bindActions(ctx, { dispatch: async (c: Command) => void sent.push(c) });
    dev.applyParams({ 1101: "88" });
    expect(dev.getProperty("battery")?.value).toBe(88);

    dev.reresolve(bare({ 1101: "88" }));

    expect(dev.getProperty("battery")?.value).toBe(88); // state survives
    expect(dev.camera?.()).toBeDefined(); // previously-bound accessor still bound
  });

  it("keeps the user's device name across the widening, and takes a rename from the record", () => {
    const dev = Device.fromRecord("T8000P0000000000", { ...bare(), name: "Dining room" });
    expect(dev.name).toBe("Dining room");

    dev.reresolve(bare({ 1101: "88" }));
    expect(dev.name).toBe("Dining room");

    dev.reresolve({ ...bare(), name: "Kitchen" });
    expect(dev.name).toBe("Kitchen");
  });
});

describe("device identity — the unit's name vs the product's", () => {
  const rec: CloudRecord = { model: "T8410", category: "eufy_security", deviceType: 7 };

  it("answers with the app-shown name, and states the model beside it", () => {
    const dev = Device.fromRecord("T8410P0000000000", { ...rec, name: "Dining room" });
    expect(dev.name).toBe("Dining room");
    expect(dev.model).toBe("T8410");
    expect(dev.modelName).toBe("Indoor Cam Pan & Tilt");
    expect(dev.describe()).toMatchObject({ name: "Dining room", model: "T8410", modelName: "Indoor Cam Pan & Tilt" });
  });

  it("falls back to the model's display name when the record carries no device name", () => {
    const dev = Device.fromRecord("T8410P0000000000", rec);
    expect(dev.name).toBe("Indoor Cam Pan & Tilt");
    expect(dev.modelName).toBe("Indoor Cam Pan & Tilt");
  });
});
