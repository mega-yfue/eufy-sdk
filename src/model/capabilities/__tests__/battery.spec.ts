import {
  BATTERY,
  BATTERY_PARAM,
  CELL_PARAMS,
  resolveWorkingMode,
  resolveWorkingModeValue,
  WORKING_MODE_MAPS,
  WorkingMode,
  PowerSource,
  cameraPowerTier,
  type BatteryActions,
  type WorkingModeName,
  type PowerSourceName,
} from "../battery.js";
import { buildCommand } from "../index.js";
import { propertiesOf } from "../members.js";
import type { AvailabilityContext } from "../types.js";
import { Device } from "../../device.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";
import type { Capability } from "../../types.js";

/**
 * A ctx for a fully-reporting battery camera. Every write is now gated on the device reporting the
 * param it reads back, so a bare `paramIds` resolves no command at all — which is the point: a T8900
 * entry sensor reports a level and nothing else, and must not be handed a power-source frame.
 */
const evidenced = (over: Partial<CommandContext> = {}): CommandContext => ({
  channel: 0,
  codec: "camera",
  capabilities: new Set<Capability>(["battery"]),
  paramIds: new Set(BATTERY.properties.map((p) => p.paramType)),
  ...over,
});

describe("battery capability module", () => {
  it("classifies mains models and charge status without treating solar charging as mains", () => {
    const battery = new Set(["battery"]);
    expect(cameraPowerTier("T8425P00", battery, 0)).toBe("wired");
    expect(cameraPowerTier("T8423P00", battery)).toBe("wired");
    expect(cameraPowerTier("T8410P00", battery, 0)).toBe("wired");
    expect(cameraPowerTier("T8114P00", new Set())).toBe("wired");
    expect(cameraPowerTier("T8114P00", battery, 0)).toBe("battery");
    expect(cameraPowerTier("T8214P00", battery, 1)).toBe("wired");
    expect(cameraPowerTier("T8214P00", battery, 4)).toBe("battery");
    expect(cameraPowerTier("T8214P00", battery)).toBe("battery");
    expect(cameraPowerTier("T8214P00", battery, "invalid")).toBe("battery");
  });
  it("exposes WorkingMode + PowerSource enums with the app's canonical values", () => {
    expect(WorkingMode.OptimalBatteryLife).toBe("Optimal Battery Life");
    expect(WorkingMode.CustomizeRecording).toBe("Customize Recording");
    expect(PowerSource.Battery).toBe("battery");
    expect(PowerSource.ExternalSolarPanel).toBe("external");
    // every WorkingMode value must exist in the DEFAULT or a model map (no typos).
    const known = new Set(Object.values(WORKING_MODE_MAPS).flatMap((m) => Object.values(m)));
    for (const name of Object.values(WorkingMode)) expect(known.has(name)).toBe(true);
  });

  it("declares the capability + schema", () => {
    expect(BATTERY.capability).toBe("battery");
    expect(BATTERY.properties.map((p) => p.name)).toEqual([
      "battery",
      "charging",
      "powerSource",
      "workingMode",
      "recordDuration",
      "recordInterval",
      "recordAutoStop",
      "batteryTemperature",
      "batteryHealth",
      "solarIntensity",
      "solarConnected24h",
      "batteryPowerStats",
      "cameraInfo",
    ]);
  });

  it("proves battery via the reported battery-level param 1101", () => {
    expect(BATTERY.detection?.evidenceParams).toContain(1101);
  });

  it("names exactly seven cell params, pinned independently of the list itself", () => {
    // The one place duplication is right. Every other assertion here iterates CELL_PARAMS, so dropping
    // an entry drops its own check with it — and since `cellGated` applies the gate FROM that list, a
    // deletion would silently un-gate a read and stay green. A test that takes its expectation from the
    // thing under test proves nothing about it, so the expected set is written out.
    expect([...CELL_PARAMS].sort((a, b) => a - b)).toEqual(
      [1101, 1138, 1198, 2111, 3100, 6482, 1309].sort((a, b) => a - b),
    );
  });

  it("publishes NO physical-cell read on a mains camera, whichever sentinel it reports", () => {
    // A mains camera reports the whole family as sentinels, so gating the level alone left it a cell
    // temperature, a state of health and a solar harvest — on a device with no cell and, for the last
    // two, no panel to attach one to. The temperature is the one that showed: a constant 30 everywhere.
    //
    // Driven off CELL_PARAMS rather than a second list of names, because `cellGated` applies the gate
    // from exactly that list: naming them again here would test the copy instead of the thing.
    const published = (model: string | undefined) =>
      new Set(propertiesOf(BATTERY.members!, { model } as AvailabilityContext).map((p) => p.paramType));

    // Mains-only floodlight and indoor models must withhold cell readings.
    for (const model of ["T8425P00", "T8423P00", "T8419P00", "T8410P00"]) {
      for (const param of CELL_PARAMS) {
        expect(published(model), `${model} still publishes ${param}`).not.toContain(param);
      }
    }
    // The settings beside them stay, which is the whole reason the capability remains attached.
    expect(published("T8410P00")).toContain(BATTERY_PARAM.WORKING_MODE);
    expect(published("T8410P00")).toContain(BATTERY_PARAM.RECORD_DURATION);
    // A real battery cam keeps every one of them.
    for (const param of CELL_PARAMS) expect(published("T8114P00")).toContain(param);
  });

  it("fails OPEN: a record with no model keeps every cell read", () => {
    // The chosen direction, not an oversight. `notMainsCamera` matches a prefix, so a record carrying no
    // model matches nothing and publishes everything — the same as any model the list does not name.
    // A real battery camera never silently loses its charge because its record was thin; the cost is
    // that the guard is a floor, and a mains model nobody has enumerated still shows the sentinels.
    const published = (ctx: AvailabilityContext) =>
      new Set(propertiesOf(BATTERY.members!, ctx).map((p) => p.paramType));
    for (const param of CELL_PARAMS) {
      expect(published({} as AvailabilityContext), `no model should publish ${param}`).toContain(param);
      expect(published({ model: "" } as AvailabilityContext)).toContain(param);
    }
  });

  it("gates the BINDER too, not just the published schema", () => {
    // `propertiesOf` is one projection; `bindMembers` makes its own `available` decision, and a caller
    // holding `dev.battery()` goes through that one. Covering only the schema would leave the surface a
    // caller actually touches unpinned — and it is the surface the original symptom was reported from.
    const ctx = (model: string): CommandContext => ({
      channel: 0,
      codec: "camera",
      capabilities: new Set<Capability>(["battery"]),
      paramIds: new Set(CELL_PARAMS.concat([BATTERY_PARAM.POWER_CHARGE, BATTERY_PARAM.WORKING_MODE])),
      model,
    });
    // Member names, not property names: the bound object is keyed by the table's own keys.
    const bound = (model: string) => Object.keys(bind<BatteryActions>("battery", ctx(model)).acts as object).sort();

    // Everything a mains camera binds, pinned whole rather than as absences — so a cell getter that
    // starts installing shows up here even if nobody thought to name it.
    expect(bound("T8410P00")).toEqual(["powerSource", "setPowerSource", "setWorkingMode", "workingMode"]);
    // And the same context on a real battery cam binds the cell reads beside them.
    for (const name of ["level", "charging", "temperature", "health", "solarIntensity", "solarConnected24h"]) {
      expect(bound("T8114P00"), `a battery camera lost ${name}`).toContain(name);
    }
  });

  it("withholds the reading from getProperty too, not just from the typed surface", () => {
    // The gate has to hold on the surface a host actually reads, and `propertiesOf` is not that surface.
    // `applyParams` names by precedence — curated spec, then the param dictionary — so dropping the
    // member leaves the value to be re-named by the dictionary. For 1101 and 1309 the dictionary name is
    // the SAME (`battery`, `solarIntensity`), which made the gate invisible to a caller: `getProperty`
    // answered 88 on a camera with no cell. The others came back under the dictionary's spelling
    // (`batteryTemp`, `devBatteryHealthyV2`, `solarPanelConnect24h`, `batteryPowerDatas`) — renamed,
    // not withheld.
    const params = { 1101: "88", 1138: "30", 1198: "95", 2111: "0", 1309: "7", 6482: "1", 3100: "{}", 1293: "0" };
    const of = (model: string) =>
      Device.fromRecord(`${model}P0000000000`, {
        deviceType: 30,
        model,
        category: "eufy_security",
        params,
      } as never);

    const mains = of("T8410");
    for (const name of ["battery", "solarIntensity", "batteryTemperature", "batteryHealth", "batteryPowerStats"]) {
      expect(mains.getProperty(name), `a mains camera served ${name}`).toBeUndefined();
    }
    // Including under the dictionary's own spelling, which is the half that made this invisible.
    for (const name of ["batteryTemp", "devBatteryHealthyV2", "solarPanelConnect24h", "batteryPowerDatas"]) {
      expect(mains.getProperty(name), `a mains camera served ${name}`).toBeUndefined();
    }
    // Kept, not dropped: the graceful-unknown rule says the data survives, under a name claiming nothing.
    const keys = Object.keys(mains.getProperties()).sort();
    for (const param of CELL_PARAMS) expect(keys).toContain(`unknown_${param}`);
    // And the supply it genuinely reports is still named.
    expect(mains.getProperty("powerSource")).toBeDefined();

    // A real battery camera is untouched, under the member's name.
    const cell = of("T8114");
    expect(cell.getProperty("battery")?.value).toBe(88);
    expect(cell.getProperty("solarIntensity")?.value).toBe(7);
    expect(Object.keys(cell.getProperties())).not.toContain("unknown_1101");
  });

  it("gates the READS only — detection and the cell alerts are untouched, deliberately", () => {
    // The claim this guard makes is about what a device REPORTS, and it stops there. `evidenceParams`
    // still names 1101, so a mains camera reporting that sentinel still resolves as `battery` — which is
    // load-bearing: the capability owns the working-mode and recording settings it genuinely has, and
    // detecting it away would take those with it. The push events are the same shape: a station can still
    // deliver a low- or hot-cell alert for one of these models, and nothing here filters that.
    //
    // So the surface is honest and the plumbing is not yet. Pinned rather than fixed, because detaching
    // either would need evidence about what these models actually push, which nothing here has.
    expect(BATTERY.detection?.evidenceParams).toContain(BATTERY_PARAM.BATTERY);
    expect(BATTERY.events?.length).toBeGreaterThan(0);
  });

  it("writes recordAutoStop as an INVERTED station-scalar on the device channel (wire-verified T8170)", () => {
    const ctx = evidenced({ channel: 1 });
    // OFF ⇒ value 1, ON ⇒ value 0 (inverted); 132-byte station-scalar body (no channel word) on ch1.
    expect(buildCommand("recordAutoStop", false, ctx)).toEqual({
      kind: "p2p-station-scalar",
      cmd: BATTERY_PARAM.RECORD_AUTO_STOP,
      value: 1,
      channel: 1,
    });
    expect(buildCommand("recordAutoStop", true, ctx)).toEqual({
      kind: "p2p-station-scalar",
      cmd: BATTERY_PARAM.RECORD_AUTO_STOP,
      value: 0,
      channel: 1,
    });
  });

  it("writes recordDuration/recordInterval as station-scalars on the device channel (wire-verified T8170)", () => {
    const ctx = evidenced({ channel: 1 });
    expect(buildCommand("recordDuration", 70, ctx)).toEqual({
      kind: "p2p-station-scalar",
      cmd: BATTERY_PARAM.RECORD_DURATION,
      value: 70,
      channel: 1,
    });
    expect(buildCommand("recordInterval", 10, ctx)).toEqual({
      kind: "p2p-station-scalar",
      cmd: BATTERY_PARAM.RECORD_INTERVAL,
      value: 10,
      channel: 1,
    });
  });

  it("keeps workingMode (1246) a raw number — the value→mode map is device-specific, not a universal enum", () => {
    const wm = BATTERY.properties.find((p) => p.name === "workingMode");
    expect(wm?.type).toBe("number");
    // No hardcoded enumValues: T8170 value 2 = "Customize Recording" but T8214 value 0 =
    // "Balance Surveillance" — the app maps per model, so a static enum would mislabel.
    expect(wm?.enumValues).toBeUndefined();
  });

  it("resolveWorkingMode maps per model — cameras use DEFAULT, the T8214 doorbell its own map (confirmed live)", () => {
    // 3-mode cameras (identity) via DEFAULT fallback.
    expect(resolveWorkingMode("T8170T0000000000", 2)).toBe("Customize Recording");
    expect(resolveWorkingMode("T8124", 0)).toBe("Optimal Battery Life");
    expect(resolveWorkingMode("T8110", 1)).toBe("Optimal Surveillance");
    // T8214 doorbell — its own 4-mode map (0 = Balance Surveillance, 3 = Optimal Battery Life).
    expect(resolveWorkingMode("T8214T2124", 0)).toBe("Balance Surveillance");
    expect(resolveWorkingMode("T8214T2124", 3)).toBe("Optimal Battery Life");
    // Unknown value → undefined; unknown model → DEFAULT.
    expect(resolveWorkingMode("T8170", 9)).toBeUndefined();
    expect(resolveWorkingMode("T9999", 0)).toBe("Optimal Battery Life");
    expect(WORKING_MODE_MAPS.DEFAULT[2]).toBe("Customize Recording");
  });

  it("writes workingMode as a direct-binary cmd 1246 (decrypted wire, verified live T8124R)", () => {
    const ctx = evidenced({ channel: 6 });
    expect(buildCommand("workingMode", 1, ctx)).toEqual({
      kind: "set-param",
      param: 1246,
      value: 1,
      form: "direct-binary",
      channel: 6,
    });
  });

  it("writes powerSource as a 1350 SET_PAYLOAD (cmd 1293, {charge_mode}, mValue3:0) — decrypted from the app", () => {
    const ctx = evidenced({ channel: 6 });
    // External Solar Panel = charge_mode 1 (byte-confirmed by decrypting the app's own frame).
    expect(buildCommand("powerSource", 1, ctx)).toEqual({
      kind: "set-payload",
      cmd: 1293,
      payload: { charge_mode: 1 },
      channel: 6,
      mValue3: 0,
      form: "auto",
    });
    // Battery = charge_mode 0.
    expect(buildCommand("powerSource", 0, ctx)).toEqual({
      kind: "set-payload",
      cmd: 1293,
      payload: { charge_mode: 0 },
      channel: 6,
      mValue3: 0,
      form: "auto",
    });
  });

  /**
   * `powerSource`'s own lambda maps anything that isn't `"external"`/`1` onto charge_mode 0, so before
   * the domain was enforced for it, `5` dispatched a real frame that set the source to Battery — a
   * fire-and-forget write of a value the member's own message calls invalid, looking like success.
   */
  it("powerSource rejects a value outside its enum instead of writing a plausible-looking one", async () => {
    const ctx = evidenced({ channel: 6 });
    expect(() => buildCommand("powerSource", 5, ctx)).toThrow(
      /powerSource: 5 is not a valid value \(must be one of 0\/1\)/,
    );
    const { acts, sent } = bind<BatteryActions>("battery", ctx);
    await expect(acts.setPowerSource!(5)).rejects.toThrow(
      /powerSource: 5 is not a valid value \(must be one of 0\/1\)/,
    );
    expect(sent).toEqual([]);
  });

  it("a setter REFUSES an unbuildable value rather than silently no-op — matches setProperty", async () => {
    // "Balance Surveillance" is a real mode name, but a 3-mode T8124 doesn't offer it → resolves to no
    // command. The derived setter must refuse (like setProperty) rather than succeed on a typo.
    const ctx = evidenced({ channel: 6, model: "T8124" });
    const { acts, sent } = bind<BatteryActions>("battery", ctx);
    await expect(acts.setWorkingMode!(WorkingMode.BalanceSurveillance)).rejects.toThrow(
      'workingMode: "Balance Surveillance" is not a valid value',
    );
    expect(sent).toEqual([]);
  });

  it("setWorkingMode accepts a mode NAME resolved per model (resolveWorkingModeValue)", () => {
    // 3-mode cameras (DEFAULT): Optimal Battery Life = 0, Customize Recording = 2.
    expect(resolveWorkingModeValue("T8124R", "Optimal Battery Life")).toBe(0);
    expect(resolveWorkingModeValue("T8170", "Customize Recording")).toBe(2);
    // T8214 doorbell has a scrambled map: Optimal Battery Life = 3, Balance Surveillance = 0.
    expect(resolveWorkingModeValue("T8214", "Optimal Battery Life")).toBe(3);
    expect(resolveWorkingModeValue("T8214", "Balance Surveillance")).toBe(0);
    // a mode the model doesn't offer → undefined.
    expect(resolveWorkingModeValue("T8124", "Balance Surveillance")).toBeUndefined();
    // buildCommand resolves the name via ctx.model → the direct-binary 1246 command.
    const ctx = evidenced({ channel: 6, model: "T8214" });
    expect(buildCommand("workingMode", "Optimal Battery Life", ctx)).toEqual({
      kind: "set-param",
      param: 1246,
      value: 3,
      form: "direct-binary",
      channel: 6,
    });
  });

  /**
   * Read through the descriptors: a getter must not be INVOKED to be enumerated, and the setters are the
   * function-valued half. The getter list is every one the schema publishes, and neither unexposed param.
   */
  it("the bound object exposes the fluent dev.battery() setters that dispatch the decrypted wires", async () => {
    const ctx = evidenced({ channel: 6 });
    const { acts, sent } = bind<BatteryActions>("battery", ctx);
    const own = Object.getOwnPropertyDescriptors(acts);
    expect(
      Object.keys(own)
        .filter((k) => typeof own[k].value === "function")
        .sort(),
    ).toEqual(["setPowerSource", "setRecordAutoStop", "setRecordDuration", "setRecordInterval", "setWorkingMode"]);
    expect(Object.keys(own).filter((k) => own[k].get)).toEqual([
      "level",
      "charging",
      "powerSource",
      "workingMode",
      "recordDuration",
      "recordInterval",
      "recordAutoStop",
      "temperature",
      "health",
      "solarIntensity",
      "solarConnected24h",
    ]);
    await acts.setPowerSource!(PowerSource.ExternalSolarPanel);
    await acts.setWorkingMode!(WorkingMode.OptimalBatteryLife); // no ctx.model → DEFAULT map → 0
    expect(sent[0]).toEqual({
      kind: "set-payload",
      cmd: 1293,
      payload: { charge_mode: 1 },
      channel: 6,
      mValue3: 0,
      form: "auto",
    });
    expect(sent[1]).toEqual({ kind: "set-param", param: 1246, value: 0, form: "direct-binary", channel: 6 });
  });

  it("derives `charging` from BATTERY_STATUS (2111) as value ∉ {0,2} — matching the app decode", () => {
    const charging = BATTERY.properties.find((p) => p.name === "charging");
    expect(charging?.paramType).toBe(BATTERY_PARAM.BATTERY_STATUS);
    const decode = charging?.decode; // the member's ingest-time `coerce`, projected onto the schema
    expect(decode).toBeDefined();
    // 0 / 2 = not charging; anything else (e.g. 4 = solar-connected trickle) = charging.
    expect(decode!("0")).toBe(false);
    expect(decode!("2")).toBe(false);
    expect(decode!("4")).toBe(true);
    expect(decode!("1")).toBe(true);
  });
});

/**
 * The derived surface, pinned at COMPILE time — these assertions have no runtime half, which is the
 * point: what a developer sees in the editor is the same table the runtime installs from, and the two
 * cannot drift. Checked by `npm run typecheck`; a widened type fails the build here.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
declare const bat: BatteryActions;

// A getter is optional (evidence-gated) and narrowed to what the member declares it is stored as.
const _level: Exact<typeof bat.level, number | undefined> = true;
const _charging: Exact<typeof bat.charging, boolean | undefined> = true;
const _recordAutoStop: Exact<typeof bat.recordAutoStop, boolean | undefined> = true;

// `accepts` widens the SETTER past the getter: a mode/source NAME as well as the index that is stored.
const _workingModeRead: Exact<typeof bat.workingMode, number | undefined> = true;
const _workingModeWrite: Exact<Parameters<NonNullable<typeof bat.setWorkingMode>>[0], WorkingModeName | number> = true;
const _powerSourceWrite: Exact<Parameters<NonNullable<typeof bat.setPowerSource>>[0], PowerSourceName | number> = true;

// Every write is evidence-gated, so every setter is OPTIONAL — a caller is made to check.
const _setClipOptional: Exact<undefined extends typeof bat.setRecordDuration ? true : false, true> = true;
const _setWorkingOptional: Exact<undefined extends typeof bat.setWorkingMode ? true : false, true> = true;

// Read-only members get no setter.
const _noSetLevel: Exact<"setLevel" extends keyof BatteryActions ? true : false, false> = true;
const _noSetCharging: Exact<"setCharging" extends keyof BatteryActions ? true : false, false> = true;

// Reported but unexposed: in the schema, reachable via getProperty, NOT on the typed surface. 1103 is
// pinned here by BOTH names — a getter over it must not reappear under either.
const _noCameraInfo: Exact<"cameraInfo" extends keyof BatteryActions ? true : false, false> = true;
const _noPowerStats: Exact<"batteryPowerStats" extends keyof BatteryActions ? true : false, false> = true;
const _noBatteryLow: Exact<"batteryLow" extends keyof BatteryActions ? true : false, false> = true;

export const _surfaceAssertions = [
  _level,
  _charging,
  _recordAutoStop,
  _workingModeRead,
  _workingModeWrite,
  _powerSourceWrite,
  _setClipOptional,
  _setWorkingOptional,
  _noSetLevel,
  _noSetCharging,
  _noCameraInfo,
  _noPowerStats,
  _noBatteryLow,
];
