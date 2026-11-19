import { Device } from "../../device.js";
import { BATTERY, type BatteryActions } from "../battery.js";
import { CONTACT } from "../contact.js";
import { MOTION } from "../motion.js";
import { DeviceType } from "../../device-types.js";
import { bind as bindCapability } from "./bind.js";
import type { CameraActions } from "../camera.js";
import type { CommandSink } from "../../../core/contracts.js";
import { parseThingsList } from "../thing-description.js";

// The product's settings-bundle data, synthetic: the spec is about the code, not the shipped data.
vi.mock("../../../model/capabilities/bundle-wires.generated.json", async () => {
  const f = await import("../../../model/capabilities/__tests__/bundle-fixture.js");
  return f.bundleData("T8410", { camera_on_off: f.power("1035>2001") });
});

/**
 * Typed capability reads — the fluent read getters (`dev.battery?.()?.level`) built from each module's
 * declarative `reads` table. Verifies they (1) narrow the value to the declared type, (2) are
 * EVIDENCE-GATED (a getter exists only when the device actually reported the backing param, via
 * `ctx.paramIds`), (3) read live state, and (4) are bound-only. Param ids come from the modules' own
 * specs so a wire-id change can't leave a stale copy here.
 */
const paramOf = (mod: { properties: { name: string; paramType: number }[] }, name: string): number =>
  mod.properties.find((p) => p.name === name)!.paramType;

const noopSink: CommandSink = { dispatch: async () => undefined };
/** Bind with a ctx whose evidence (`paramIds`) is exactly the given reported params. */
const bind = (dev: Device, reported: number[]): void =>
  dev.bindActions({ channel: 0, codec: "camera", paramIds: new Set(reported) }, noopSink);

describe("typed capability reads", () => {
  it("battery exposes level/charging narrowed to their declared types", () => {
    const rec = {
      deviceType: 0,
      model: "T8114",
      category: "eufy_security",
      params: { [paramOf(BATTERY, "battery")]: "55", [paramOf(BATTERY, "charging")]: "4" },
    };
    const dev = Device.fromRecord("SN_BAT", rec);
    bind(dev, [paramOf(BATTERY, "battery"), paramOf(BATTERY, "charging")]);

    const bat = dev.battery?.();
    expect(bat).toBeDefined();
    const level: number | undefined = bat?.level;
    const charging: boolean | undefined = bat?.charging;
    expect(level).toBe(55);
    expect(charging).toBe(true); // 4 ∉ {0,2} ⇒ charging
  });

  it("evidence-gates a getter: absent when the device didn't report the backing param", () => {
    const rec = {
      deviceType: 0,
      model: "T8114",
      category: "eufy_security",
      params: { [paramOf(BATTERY, "battery")]: "80" },
    };
    const dev = Device.fromRecord("SN_BAT2", rec);
    bind(dev, [paramOf(BATTERY, "battery")]); // only `battery` reported — no health/charging evidence

    const bat = dev.battery?.();
    expect(bat?.level).toBe(80);
    expect(bat?.health).toBeUndefined(); // batteryHealth not reported → getter not installed
    expect("health" in bat!).toBe(false); // …and the key is genuinely absent, not just undefined
    expect("level" in bat!).toBe(true);
  });

  it("reflects live updates (getters read through the device's live state)", () => {
    const rec = {
      deviceType: 0,
      model: "T8114",
      category: "eufy_security",
      params: { [paramOf(BATTERY, "battery")]: "40" },
    };
    const dev = Device.fromRecord("SN_BAT3", rec);
    bind(dev, [paramOf(BATTERY, "battery")]);
    const bat = dev.battery?.();
    expect(bat?.level).toBe(40);

    dev.applyParams({ [paramOf(BATTERY, "battery")]: 41 });
    expect(bat?.level).toBe(41); // same object, no rebind
  });

  /**
   * The same liveness, for a getter derived from a member table — a separate path, and one where copying
   * the bound object by VALUE instead of by descriptor left the caller holding whatever the device
   * happened to report at bind time. A device binds once, so on a line whose state arrives only over
   * realtime that snapshot is `undefined` for the device's whole life.
   */
  it("reflects live updates through a member-derived getter too", () => {
    const detection = paramOf(MOTION, "motionDetection");
    const rec = {
      deviceType: DeviceType.FLOODLIGHT_CAMERA_8425,
      model: "T8425",
      category: "eufy_security",
      params: { [detection]: "1" },
    };
    const dev = Device.fromRecord("SN_MOT", rec);
    bind(dev, [detection]);
    const motion = dev.motion?.();
    expect(motion?.detectionEnabled).toBe(true);

    dev.applyParams({ [detection]: 0 });
    expect(motion?.detectionEnabled).toBe(false);
  });

  it("exposes fluent reads on a read-only sensor capability (contact)", () => {
    const rec = {
      deviceType: 0,
      model: "T8900",
      category: "eufy_security",
      params: { [paramOf(CONTACT, "contact")]: "1" },
    };
    const dev = Device.fromRecord("SN_CON", rec);
    bind(dev, [paramOf(CONTACT, "contact")]);

    const open: boolean | undefined = dev.contact?.()?.open;
    expect(open).toBe(true);
  });

  /**
   * 1271 reports the entire snooze config base64+json, not the bare seconds, so the getter's value comes
   * from the field inside it. Declaring the property a number instead read `undefined` forever — silently,
   * which is what pairing the read's kind with a decode now prevents.
   */
  it("lifts a duration out of a config the device reports as a whole (motion snooze)", () => {
    const snooze = paramOf(MOTION, "snoozeTime");
    const config = { snooze_time: 3600, startTime: 1784794730, motion_notify_onoff: 1 };
    const rec = {
      deviceType: DeviceType.SOLO_CAMERA_SPOTLIGHT_2K,
      model: "T8170",
      category: "eufy_security",
      params: { [snooze]: Buffer.from(JSON.stringify(config)).toString("base64") },
    };
    const dev = Device.fromRecord("SN_SNOOZE", rec);
    bind(dev, [snooze]);

    const seconds: number | undefined = dev.motion?.()?.snoozeTime;
    expect(seconds).toBe(3600);
  });

  /**
   * A `readAliases` id is the SAME value on another family's wire, so it is the same evidence. Gating on
   * the member's own `param` alone hid the read on exactly the families the alias exists for — a
   * standalone camera reports its power state on 2001 and never on 1035, so `dev.camera().enabled` was
   * permanently absent there while `getProperty` answered it fine.
   */
  it("installs a getter on a readAliases id alone, not just the member's own param", () => {
    const { acts } = bindCapability<CameraActions>(
      "camera",
      {
        channel: 0,
        codec: "camera",
        model: "T8410",
        paramIds: new Set([2001]),
        things: parseThingsList({
          things_list: [{ profile: { product_code: "T8410" }, properties: [{ identifier: "camera_on_off" }] }],
        }).T8410,
      },
      { read: (name) => (name === "enabled" ? { value: true } : undefined) },
    );
    expect("enabled" in acts).toBe(true);
    expect(acts.enabled).toBe(true);
  });

  /**
   * The stored value is not always the declared type: a non-numeric wire value is kept as the raw string
   * so the mismatch stays visible in the log. Handing that through a getter typed `number` is the lie the
   * declared type exists to prevent, so the getter answers `undefined` instead.
   */
  it("answers undefined when the stored value is not the member's declared type", () => {
    const battery = paramOf(BATTERY, "battery");
    const { acts } = bindCapability<BatteryActions>(
      "battery",
      { channel: 0, codec: "camera", paramIds: new Set([battery]) },
      { read: (name) => (name === "battery" ? { value: "not-a-number" } : undefined) },
    );
    expect("level" in acts).toBe(true);
    expect(acts.level).toBeUndefined();
  });

  it("read getters are bound-only (undefined on an unbound model)", () => {
    const rec = {
      deviceType: 0,
      model: "T8114",
      category: "eufy_security",
      params: { [paramOf(BATTERY, "battery")]: "50" },
    };
    const dev = Device.fromRecord("SN_BAT4", rec);
    expect(dev.battery?.()).toBeUndefined(); // not bound → no action object
    expect(dev.getProperty("battery")?.value).toBe(50); // low-level read still works unbound
  });
});
