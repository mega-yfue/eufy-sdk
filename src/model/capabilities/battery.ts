import { CusPushEvent } from "../push-events.js";
import { asBool } from "../../core/util.js";
import { setStationScalar, setPayload, setScalar } from "./access.js";
import type { AvailabilityContext, CapabilityActions, CapabilityModule, CommandContext } from "./types.js";
import { accepts, propertiesOf, type MemberDeps, type Members, type Surface } from "./members.js";
import type { Command, PowerOverride } from "../../core/contracts.js";

/**
 * The P2P **param-type ids** this battery/power capability reads and writes — the `param_type` a device
 * self-reports in `get_devs_list` / the `GET_CAMERA_INFO` (1103) live param list. Capability-owned wire
 * vocabulary (a curated subset; the full id→name catalog + schema live in `../param-dictionary.ts`).
 * Distinct from a feature-COMMAND id (the write outer-command) — these are STATE/settings param ids.
 */
export const BATTERY_PARAM = {
  // ── battery / power ───────────────────────────────────────────────────────────────────────────
  /** Battery level 0-100 (app `BATTERY_VALUE`). */
  BATTERY: 1101,
  /**
   * Battery/charge **status bitfield** (app `BATTERY_STATUS`). The app decodes it, not shown raw:
   * `charging = value ∉ {0,2}`; solar-panel-connected when `value ∈ {4,5,12,20}`. Drives the battery
   * `charging` property.
   */
  BATTERY_STATUS: 2111,
  /** Battery temperature °C (app `GET_BATTERY_TEMP`). */
  BATTERY_TEMP: 1138,
  /** Battery health 0-100 (app `APP_CMD_DEV_BATTERY_HEALTHY_V2`). */
  BATTERY_HEALTH: 1198,
  /** Charging-in-progress flag (app `APP_CMD_SET_POWER_CHARGE`). */
  POWER_CHARGE: 1293,
  /** Power **working mode** enum, e.g. optimal-battery / optimal-surveillance / custom (app `SET_INDOOR_POWER_MODE`). */
  WORKING_MODE: 1246,
  // ── custom working-mode recording settings (apply when WORKING_MODE = custom) ──
  /** Clip length in seconds (app `SET_RECORD_DURATION`). */
  RECORD_DURATION: 1249,
  /** Minimum interval between clips, seconds (app `SET_RECORD_INTERVAL`). */
  RECORD_INTERVAL: 1250,
  /** End-clip-early toggle — stop recording when motion ends (app `SET_RECORD_AUTO_STOP`). INVERTED: raw 0 = ON. */
  RECORD_AUTO_STOP: 1251,
  /** Solar-panel light/charge intensity; 0 = none (app `APP_CMD_SOLAR_INTENSITY`). */
  SOLAR_INTENSITY: 1309,
  /** Whether a solar panel supplied power in the last 24h (app `APP_CMD_GET_SOLAR_PANEL_CONNECT_24H`). */
  SOLAR_CONNECT_24H: 6482,
  /** Battery power-history stats JSON (app `APP_CMD_GET_BATTERY_POWER_DATAS`). Often P2P-dump-only. */
  BATTERY_POWER_DATAS: 3100,
  /**
   * `GET_CAMERA_INFO` — reported by battery cameras, meaning NOT evidenced. Read live as the constant
   * `5` on a T8170 at 92% and a T8171 at 27%, so nothing about it tracks the battery. See
   * `BATTERY_MEMBERS`'s `cameraInfo`.
   */
  CAMERA_INFO: 1103,
} as const;

/**
 * `battery` — battery level, charging state, health, temperature, solar input, and the power settings
 * that decide how hard the device works: the working mode, plus the three `record*` members that tune
 * its Customize-Recording mode (how long a recording runs, how soon the next may start, whether it stops
 * early when motion ends).
 *
 * Every param is a confirmed app-enum id read live off the fleet. `charging` is derived from the
 * `BATTERY_STATUS` (2111) bitfield the way the app itself decodes it (`value ∉ {0,2}`).
 * `batteryPowerStats` (3100) is only in the P2P param dump on some devices — read it via the live P2P
 * param query (the owner-gated cloud call can't return it).
 */
/**
 * The working modes the app offers (names shared across models). Use `WorkingMode.CustomizeRecording`
 * etc. with `setWorkingMode` / `setProperty` — each is resolved to that model's raw index via
 * {@link WORKING_MODE_MAPS} (models number them differently; a mode a model lacks is a safe no-op).
 */
export const WorkingMode = {
  OptimalBatteryLife: "Optimal Battery Life",
  OptimalSurveillance: "Optimal Surveillance",
  CustomizeRecording: "Customize Recording",
  BalanceSurveillance: "Balance Surveillance",
} as const;
/** A working-mode name — the value side of {@link WorkingMode}. */
export type WorkingModeName = (typeof WorkingMode)[keyof typeof WorkingMode];

/** Power source options — pass `PowerSource.Battery` / `PowerSource.ExternalSolarPanel` to `setPowerSource`. */
export const PowerSource = {
  Battery: "battery",
  ExternalSolarPanel: "external",
} as const;
/** A power-source name — the value side of {@link PowerSource}. */
export type PowerSourceName = (typeof PowerSource)[keyof typeof PowerSource];

/**
 * Bound battery/power state and controls — the object returned by `dev.battery()`.
 *
 * Parameter-backed getters, setters, argument types and descriptions derive from `BATTERY_MEMBERS`.
 * The local operating-power claim is a bound action because it is independent of device parameters.
 * Device writes are fire-and-forget; confirm a change by re-reading.
 */
export type BatteryActions = Surface<typeof BATTERY_MEMBERS> & {
  /** The local operating-power claim, when bound to an SDK client. */
  powerOverride?: () => PowerOverride;
  /** Replace the local claim without sending a device command. */
  setPowerOverride?: (override: PowerOverride) => void;
};

/**
 * Reinterpret the reported power source (1293), whose wire form VARIES BY MODEL: a plain int on some
 * (T8124R), a JSON string `{"power_source":N}` on others. Both reduce to the numeric N; a value that is
 * neither is passed through as-is rather than turned into a plausible number.
 *
 * The richer raw `APP_CMD_SET_POWER_SOURCE` blob is a separate param, surfaced as `powerSourceInfo`.
 */
function decodePowerSource(raw: string | number | boolean): number | string {
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      const n = Number((JSON.parse(raw) as { power_source?: number }).power_source);
      return Number.isFinite(n) ? n : String(raw);
    } catch {
      return String(raw);
    }
  }
  const num = Number(raw);
  return Number.isFinite(num) ? num : String(raw);
}

/**
 * A custom-working-mode record setting: a 132-byte station-scalar `[u32 value][account_id pad128]` on
 * the DEVICE channel (not station 255), signCode 8, outer-cmd = the param id. Verified live on T8170.
 */
function recordSetting(param: number, value: number, ctx: CommandContext): Command {
  return setStationScalar(param, value, ctx.channel);
}

/**
 * Camera models that are MAINS-powered yet still report the battery params as fixed sentinels, not a
 * real cell. They keep the `battery` capability — it owns the working-mode and recording settings,
 * which a mains camera genuinely has — but every read that describes a PHYSICAL CELL is withheld via
 * {@link notMainsCamera}, so they don't sprout a bogus battery %, a cell temperature, a state of
 * health or a solar harvest.
 *
 * Which reads those are is {@link CELL_PARAMS}, and {@link cellGated} applies this from it. The settings
 * beside them are deliberately NOT gated, and that split is the whole reason the capability stays
 * attached.
 *
 * **It FAILS OPEN.** A record carrying no `model` matches no prefix, so every cell read is published —
 * the same shape as any model this list does not name. That is the safer direction of the two (a real
 * battery camera never silently loses its charge) and it is why the list can only ever be a floor: a
 * device whose record is thin still shows the sentinels. A spec pins it so the behaviour is chosen
 * rather than inherited.
 *
 * It is also a STATIC fact about a model, not a live reading of what is powering the device. Nothing
 * here handles a unit whose supply can change — a camera moved onto a battery base, say. Moot for these
 * listed mains-only models, which have no cell to charge, and stated because the shape of the guard
 * does not say so.
 *
 * An explicit list, NOT a `device-family.ts` predicate (`isFloodLight`/`isIndoorCamera`): composing
 * those would over-reach — not every floodlight or indoor cam is mains-only, and this must assert mains
 * only for hardware actually checked. `WORKING_MODE_DEFAULT_MODELS` in this file is the same shape.
 * Evidence bars differ: T8425 (Floodlight Cam) is confirmed on owned hardware; T8419 (Indoor Cam) is
 * taken from the app's own mains-cam handling (see the note on `publishedWorkingModeDomain`); T8410
 * (Indoor Cam Pan & Tilt) is confirmed mains-only by the maintainer, reported after a live unit showed
 * a battery level, a cell temperature and both solar reads it cannot have. T8423 (Floodlight Cam 2 Pro)
 * is mains-only: the vendor's Floodlight Cam 2 Pro FAQ says it has no battery and requires a
 * 110-240 V constant supply. The exact set of cell sentinels it reports remains unverified.
 *
 * The same model evidence also determines the camera's live-media power tier.
 */
const MAINS_CAMERA_MODELS = ["T8425", "T8423", "T8419", "T8410"] as const;

/**
 * Camera power tier from the resolved battery capability and confirmed mains-only models. A device
 * with a cell remains battery-budgeted even when it reports charging: the charge-status bitfield does
 * not establish that external input can sustain a persistent session or unbounded live stream.
 */
export function cameraPowerTier(model: string | undefined, capabilities: ReadonlySet<string>): "wired" | "battery" {
  return !capabilities.has("battery") || !notMainsCamera({ model }) ? "wired" : "battery";
}

/** False for a mains camera whose battery params are sentinels — gates every physical-cell read. */
const notMainsCamera = (ctx: AvailabilityContext): boolean => {
  const model = (ctx.model ?? "").toUpperCase();
  return !MAINS_CAMERA_MODELS.some((prefix) => model.startsWith(prefix));
};

/**
 * The params whose subject IS the physical cell — so every member reading one must carry
 * {@link notMainsCamera}.
 *
 * The ONE place that fact is declared. {@link cellGated} applies {@link notMainsCamera} from this list
 * when the table is built, so a member never states the gate itself: adding a cell read is adding its
 * param here, and there is no second place for it to be missing from. A per-member `available` was the
 * alternative and is what the first two passes of this guard got wrong, in both directions — first by
 * covering two of the seven, then by reading `unexposed` as covering a third.
 *
 * What is NOT here matters as much.
 *
 *  - `workingMode` and the three `record*` settings describe how hard the camera works, not what powers
 *    it, and a mains camera genuinely has them. They are the reason the capability stays attached.
 *  - `cameraInfo` (1103) is a number whose meaning is unevidenced. Gating it would assert it is a
 *    battery fact, which is the kind of claim this guard exists to stop making.
 *  - `powerSource` (1293) is the open one. Both values it names — `Battery` and `External Solar Panel` —
 *    describe how a CELL is fed, so by this list's own rule it arguably belongs here. It is out because
 *    every param above is one a live mains camera was observed to publish and 1293 was not among them,
 *    and because it is `requires`-gated on its own param, so it appears only where the device reports
 *    it. Gating it would also withhold a described WRITE rather than a read, which is a different class
 *    of change. Unresolved rather than decided: see the note in the pull request.
 *
 * The two solar params ARE here: a panel exists to charge a cell, so a device without one has no solar
 * harvest to report either.
 */
export const CELL_PARAMS: readonly number[] = [
  BATTERY_PARAM.BATTERY,
  BATTERY_PARAM.BATTERY_STATUS,
  BATTERY_PARAM.BATTERY_TEMP,
  BATTERY_PARAM.BATTERY_HEALTH,
  BATTERY_PARAM.SOLAR_INTENSITY,
  BATTERY_PARAM.SOLAR_CONNECT_24H,
  BATTERY_PARAM.BATTERY_POWER_DATAS,
];

/**
 * Apply {@link notMainsCamera} to every member reading a {@link CELL_PARAMS} param, as the table is built.
 *
 * Applied rather than checked, so the gate cannot be omitted: a member declares its param and nothing
 * about mains power, and the two facts stay one declaration. The alternative — the gate on each member,
 * with a spec holding the two lists equal — states "this read describes the cell" twice and needs a test
 * to keep the copies in step.
 *
 * A member's own `available` is composed with, never replaced: none declares one today, and a future one
 * would be about something else entirely (a family, a codec), so silently dropping it would be a gate
 * that reads as present and is not.
 */
function cellGated<T extends Members>(members: T): T {
  const gated = Object.entries(members).map(([name, m]) => {
    const param = (m as { param?: unknown }).param;
    if (typeof param !== "number" || !CELL_PARAMS.includes(param)) return [name, m] as const;
    const own = (m as { available?: (ctx: AvailabilityContext) => boolean }).available;
    const available = own ? (ctx: AvailabilityContext) => notMainsCamera(ctx) && own(ctx) : notMainsCamera;
    return [name, { ...(m as object), available }] as const;
  });
  return Object.fromEntries(gated) as T;
}

/**
 * Every `battery` feature, declared once — the property schema, the evidence-gated getters, the derived
 * setters, the intent routes and the descriptions all come out of this table. Order is schema order.
 *
 * Each write is gated on the device reporting the param it reads back, because "has a battery" is much
 * weaker evidence than "speaks this setting": an entry sensor reports a level (1101) and nothing else,
 * and handing it a power-source frame it never accepts would look like success.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const BATTERY_MEMBERS = cellGated({
  /**
   * The headline percentage, and this capability's detection evidence: reporting 1101 is what proves a
   * device is battery-powered, which is also the fact `MediaProvider` reads to decide a stream needs a
   * power budget. Published flat as `battery` — `level` alone is claimed by `suction` too.
   */
  level: {
    param: BATTERY_PARAM.BATTERY,
    property: "battery",
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "verified",
    description: "Battery level 0-100 (verified: param 1101).",
  },
  /**
   * Derived from `BATTERY_STATUS` (2111), NOT `powerCharge` (1293): the app decodes it as
   * `charging = value ∉ {0,2}` (Hermes `device_charging_mode` parser). That catches solar
   * trickle-charge which 1293 misses — a T8124 with a built-in solar panel reads 4 = charging.
   */
  charging: {
    param: BATTERY_PARAM.BATTERY_STATUS,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    coerce: (v) => {
      const n = Number(v);
      return n !== 0 && n !== 2;
    },
    description:
      "Charging in progress — derived from BATTERY_STATUS (2111) as `value ∉ {0,2}`, matching the app's own " +
      "decode. 0/2 = not charging; a solar/USB charge (incl. a built-in solar panel, which reads 4) is non-zero.",
  },
  /**
   * 1293 is the READABLE indicator (6445 is write-only/cloud-hidden). Verified live on a T8124R via an
   * app-toggle before/after diff: 0 = Battery, 1 = External Solar Panel. Values beyond 0/1 (some models
   * report 5) are shown raw — `enumValues` only labels the two that are confirmed.
   *
   * The write is a `1350` SET_PAYLOAD, inner cmd 1293, `{charge_mode:N}`, `mValue3` 0 (the app uses 0,
   * not the cmd id), and the setter accepts a NAME as well as the index the getter answers.
   */
  powerSource: {
    param: BATTERY_PARAM.POWER_CHARGE,
    type: "enum",
    kind: "enum",
    enumValues: { 0: "Battery", 1: "External Solar Panel" },
    provenance: "verified",
    coerce: decodePowerSource,
    requires: [BATTERY_PARAM.POWER_CHARGE],
    args: [{ name: "source", kind: "enum", description: "The raw value, or the name `battery`/`external`." }],
    ...accepts<PowerSourceName>(),
    description:
      "Configured power source (1293): 0 = Battery, 1 = External Solar Panel. Verified live on T8124R. " +
      "The richer raw APP_CMD_SET_POWER_SOURCE blob is surfaced separately as `powerSourceInfo` (6445). " +
      "Format varies by model (plain int or JSON {power_source:N}); values beyond 0/1 shown raw.",
    write: (v, ctx) =>
      setPayload(
        BATTERY_PARAM.POWER_CHARGE,
        { charge_mode: v === "external" ? 1 : v === "battery" ? 0 : asBool(v) ? 1 : 0 },
        ctx,
        0,
        undefined,
        "auto",
      ),
  },
  /**
   * A DEVICE-SPECIFIC mode index: the app maps value→mode through a per-model config (Hermes
   * `doValueConvertToUIIndex` + a per-device `mappingConfigObject`), NOT a universal enum. The domain
   * is resolved per device by {@link publishedWorkingModeDomain}: a confirmed model publishes its
   * {index → label} set (the 3-mode identity map for battery cameras, the 4-mode map for the T8214
   * doorbell), and a model with no confirmed set publishes none. Name a value with {@link
   * resolveWorkingMode}.
   *
   * The static `kind` stays `"scalar"`: a member with no static `enumValues` cannot declare `kind:
   * "enum"` (the value-kinds guard). `enumValuesFor` supplies the per-device domain, and the resolver
   * stamps the RESOLVED spec/read as an enum so the published surface is self-consistent.
   *
   * The write is DIRECT-BINARY, outer-cmd 1246, `[channel][value=mode][account_id]`. A mode NAME the
   * model does not offer resolves to nothing, which is what makes the setter refuse rather than send a
   * wrong index.
   */
  workingMode: {
    param: BATTERY_PARAM.WORKING_MODE,
    type: "number",
    kind: "scalar",
    enumValuesFor: publishedWorkingModeDomain,
    provenance: "verified",
    requires: [BATTERY_PARAM.WORKING_MODE],
    min: 0,
    args: [
      {
        name: "mode",
        kind: "scalar",
        min: 0,
        description: "A mode index, or its name. The set is per-model — name one with resolveWorkingMode.",
      },
    ],
    ...accepts<WorkingModeName>(),
    description:
      "Power working mode (1246 SET_INDOOR_POWER_MODE) — a device-specific mode index the app maps per " +
      "model (not a universal enum). WRITE verified live on T8124R (direct-binary cmd 1246; set the raw value).",
    write: (v, ctx) => {
      const mode = typeof v === "string" && !/^\d+$/.test(v.trim()) ? resolveWorkingModeValue(ctx.model, v) : Number(v);
      return mode == null || Number.isNaN(mode)
        ? undefined
        : setScalar(BATTERY_PARAM.WORKING_MODE, mode, ctx, "direct-binary");
    },
  },
  /**
   * One of the three Customize-Recording settings, and the pair to `recordInterval`: this bounds how
   * long a clip runs, that bounds how soon the next may begin. Writing it on a device in another
   * working mode changes the stored setting but nothing observable, so set `workingMode` first. Gated
   * on the device reporting 1249, since "has a battery" does not mean "speaks this setting".
   */
  recordDuration: {
    param: BATTERY_PARAM.RECORD_DURATION,
    type: "number",
    unit: "s",
    kind: "seconds",
    provenance: "verified",
    requires: [BATTERY_PARAM.RECORD_DURATION],
    min: 0,
    description:
      "How long each motion-triggered recording runs, in seconds (1249 SET_RECORD_DURATION). Applies in the " +
      "device's Customize-Recording working mode. Write verified live on T8170, which reports it back (read live: 60).",
    write: (v, ctx) => recordSetting(BATTERY_PARAM.RECORD_DURATION, Number(v), ctx),
  },
  /**
   * The motion re-arm gap: seconds of enforced quiet after a clip ends before another may start, so it
   * is the setting that decides how much a busy scene costs the battery. Same Customize-Recording
   * scope and same per-param gate as `recordDuration`; the two are usually tuned together.
   */
  recordInterval: {
    param: BATTERY_PARAM.RECORD_INTERVAL,
    type: "number",
    unit: "s",
    kind: "seconds",
    provenance: "verified",
    requires: [BATTERY_PARAM.RECORD_INTERVAL],
    min: 0,
    description:
      "Minimum seconds the device waits after one recording before it will start another (1250 " +
      "SET_RECORD_INTERVAL) — the motion re-arm gap. Applies in the Customize-Recording working mode. " +
      "Write verified live on T8170, which reports it back (read live: 5).",
    write: (v, ctx) => recordSetting(BATTERY_PARAM.RECORD_INTERVAL, Number(v), ctx),
  },
  /**
   * INVERTED on the wire (a disable flag): the app decodes `stop-early = (value === 0)` (Hermes
   * `motion_stop_end_early = asBooleanToIntString("0" === value)`), so raw 0 means the feature is ON.
   */
  recordAutoStop: {
    param: BATTERY_PARAM.RECORD_AUTO_STOP,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    requires: [BATTERY_PARAM.RECORD_AUTO_STOP],
    invert: true,
    description:
      "Stop a recording as soon as motion ends, rather than running the full recordDuration (1251 " +
      "SET_RECORD_AUTO_STOP). Applies in the Customize-Recording working mode. Inverted on the wire — raw 0 " +
      "= ON, per the app's own decode. Write wire-verified live on T8170.",
    write: (v, ctx) => recordSetting(BATTERY_PARAM.RECORD_AUTO_STOP, asBool(v) ? 0 : 1, ctx),
  },
  /**
   * The cell temperature the device measures, in its own degrees Celsius — never converted, since
   * rescaling a number sourced only from the app's param table would be inventing precision. Read-only:
   * `apk` provenance means the id comes from the disassembled app, not from a captured toggle, so
   * nothing here establishes a write. Pairs with the `batteryAlert` HOT push.
   */
  temperature: {
    param: BATTERY_PARAM.BATTERY_TEMP,
    property: "batteryTemperature",
    type: "number",
    unit: "°C",
    kind: "celsius",
    provenance: "apk",
    description: "Battery temperature (1138 GET_BATTERY_TEMP).",
  },
  /**
   * Remaining cell capacity as a percentage of new — a slow-moving ageing figure, NOT the current
   * charge (`level` is that), which is why it takes its own flat name `batteryHealth`. `apk`
   * provenance: the id is read out of the disassembled app rather than from a captured change.
   */
  health: {
    param: BATTERY_PARAM.BATTERY_HEALTH,
    property: "batteryHealth",
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "apk",
    description: "Battery health 0-100 (1198 APP_CMD_DEV_BATTERY_HEALTHY_V2).",
  },
  /**
   * How much light the solar panel is currently harvesting. A bare `scalar` on purpose: only the zero
   * point is established (0 = no solar input), so the SDK declares no unit and no ceiling rather than
   * publishing a percentage the wire has not been shown to be. `apk` provenance.
   */
  solarIntensity: {
    param: BATTERY_PARAM.SOLAR_INTENSITY,
    type: "number",
    kind: "scalar",
    provenance: "apk",
    description: "Solar-panel light/charge intensity (1309 APP_CMD_SOLAR_INTENSITY); 0 = no solar input.",
  },
  /**
   * A rolling 24-hour verdict on whether the panel contributed anything — so it stays true through a
   * night, and is the right read for "is the panel actually working", where `solarIntensity` only says
   * what it is doing this instant. `apk` provenance; the id is the app's own, not a captured toggle.
   */
  solarConnected24h: {
    param: BATTERY_PARAM.SOLAR_CONNECT_24H,
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    description: "Whether a solar panel supplied power in the last 24h (6482 APP_CMD_GET_SOLAR_PANEL_CONNECT_24H).",
  },
  /**
   * Reported, so it stays in the schema and answers through `getProperty` — but given no typed getter:
   * the payload's fields have never been decoded, and a getter would hand back an opaque blob typed as
   * though it meant something.
   *
   * `unexposed` is NOT a substitute for the cell gate. It suppresses the fluent GETTER; `propertiesOf`
   * filters `writeOnly` and `available` and deliberately not `unexposed`, because a schema entry
   * reachable through `getProperty` is the whole point of the mark. So a cell param needs
   * {@link CELL_PARAMS} either way, or a mains camera publishes "battery power history" and answers it.
   */
  batteryPowerStats: {
    param: BATTERY_PARAM.BATTERY_POWER_DATAS,
    type: "string",
    kind: "text",
    provenance: "apk",
    unexposed: true,
    description:
      "Battery power-history stats JSON (3100 APP_CMD_GET_BATTERY_POWER_DATAS). Often only in the live " +
      "P2P param dump, not the cloud device list.",
  },
  /**
   * `GET_CAMERA_INFO` (1103), reported by battery cameras with its meaning unevidenced — so it is in the
   * schema and reachable through `getProperty`, with no typed getter.
   *
   * It is NOT a low-battery flag, on two independent grounds: the app's own param table names 1103
   * `GET_CAMERA_INFO`, and a T8170 at 92% and a T8171 at 27% both report the constant `5`. Typed as a
   * bool it would read `false` on every device forever — a shape indistinguishable from a real answer.
   */
  cameraInfo: {
    param: BATTERY_PARAM.CAMERA_INFO,
    type: "number",
    kind: "scalar",
    provenance: "apk",
    unexposed: true,
    description:
      "Raw GET_CAMERA_INFO value (1103), meaning unevidenced — read live as the constant 5 on a T8170 at " +
      "92% and a T8171 at 27%, so it is NOT a low-battery flag.",
  },
} as const satisfies Members);

export const BATTERY: CapabilityModule = {
  capability: "battery",
  description: "Battery level, charging, health, temperature, and solar input.",
  members: BATTERY_MEMBERS,
  properties: propertiesOf(BATTERY_MEMBERS),
  actions({ ctx, powerOverride }: MemberDeps): CapabilityActions {
    if (!powerOverride || !notMainsCamera(ctx)) return {};
    return {
      powerOverride: () => powerOverride.getOverride(),
      setPowerOverride: (override: PowerOverride) => powerOverride.setOverride(override),
    };
  },
  /** A reported battery-level param (1101) is the verified proof the device is battery-powered. */
  detection: { evidenceParams: [BATTERY_PARAM.BATTERY] },
  /**
   * `batteryAlert` is an FCM threshold push (`CusPushEvent` 6 LOW / 7 HOT / 11 FULL) — a STATE with no
   * level value, whose `payload.state` says which fired. That threshold crossing is what earns it a name:
   * the level itself carries no name of its own, because "param 1101 moved" is exactly what the generic
   * `propertyChanged` announcement says, and it carries the coerced 0-100 number rather than a raw string.
   */
  events: [
    { source: "push", match: CusPushEvent.BATTERY_LOW, emit: "batteryAlert", payload: { state: "low" } },
    { source: "push", match: CusPushEvent.BATTERY_HOT, emit: "batteryAlert", payload: { state: "hot" } },
    { source: "push", match: CusPushEvent.BATTERY_FULL, emit: "batteryAlert", payload: { state: "full" } },
  ],
};

/**
 * Working-mode value → label maps, keyed by device model T-code. Models number the same mode
 * differently and the mapping is per-device, so the maps are kept here and resolved by model.
 * **Expand as new models are confirmed** — most battery cameras use the 3-mode identity map
 * (`DEFAULT`); a model with a different set (e.g. a doorbell's extra "Balance Surveillance") gets its
 * own entry, matched by model T-code prefix.
 */
export const WORKING_MODE_MAPS: Readonly<Record<string, Readonly<Record<number, string>>>> = {
  /** 3-mode battery cameras — identity map. */
  DEFAULT: { 0: "Optimal Battery Life", 1: "Optimal Surveillance", 2: "Customize Recording" },
  /** 4-mode video doorbell — adds "Balance Surveillance"; Optimal Battery Life shifts to 3. */
  T8214: { 0: "Balance Surveillance", 1: "Optimal Surveillance", 2: "Customize Recording", 3: "Optimal Battery Life" },
};

/**
 * Resolve a `workingMode` raw value to its human mode label for a device model — or `undefined`
 * if the value isn't in that model's map. Matches the model against the {@link WORKING_MODE_MAPS} keys
 * by T-code prefix, falling back to the 3-mode camera `DEFAULT`.
 */
export function resolveWorkingMode(model: string | undefined, value: number): string | undefined {
  return workingModeMap(model)[value];
}

/**
 * Return the working-mode {index → label} map for a device model — its own {@link WORKING_MODE_MAPS}
 * entry when one matches by T-code prefix, otherwise the 3-mode `DEFAULT`. Always returns a map (used
 * for name↔index resolution), unlike {@link publishedWorkingModeDomain} which may return `undefined`.
 */
export function workingModeMap(model: string | undefined): Readonly<Record<number, string>> {
  const m = (model ?? "").toUpperCase();
  const key = Object.keys(WORKING_MODE_MAPS).find((k) => k !== "DEFAULT" && m.startsWith(k));
  return (key && WORKING_MODE_MAPS[key]) || WORKING_MODE_MAPS.DEFAULT;
}

/**
 * Battery-camera models confirmed on owned hardware to use the 3-mode `DEFAULT` working-mode domain,
 * matched by T-code prefix: the eufyCam (T8114) and SoloCam (T8124/T8170/T8171) families.
 */
const WORKING_MODE_DEFAULT_MODELS = ["T8114", "T8124", "T8170", "T8171"] as const;

/**
 * Return the working-mode {index → label} domain to publish for a device, or `undefined` when the
 * device has no confirmed domain. Returns a model's own {@link WORKING_MODE_MAPS} entry when one
 * matches by T-code prefix, else the 3-mode `DEFAULT` for a {@link WORKING_MODE_DEFAULT_MODELS} model,
 * else `undefined` — so a camera that merely reports the param without a confirmed set (e.g. the mains
 * Indoor Cam T8419) publishes no domain rather than an unverified one.
 */
function publishedWorkingModeDomain(ctx: AvailabilityContext): Readonly<Record<number, string>> | undefined {
  const m = (ctx.model ?? "").toUpperCase();
  const key = Object.keys(WORKING_MODE_MAPS).find((k) => k !== "DEFAULT" && m.startsWith(k));
  if (key) return WORKING_MODE_MAPS[key];
  return WORKING_MODE_DEFAULT_MODELS.some((p) => m.startsWith(p)) ? WORKING_MODE_MAPS.DEFAULT : undefined;
}

/**
 * Inverse of {@link resolveWorkingMode}: the raw index for a mode NAME on a device model — or
 * `undefined` if that model doesn't offer the named mode. Used to let `setWorkingMode` take names.
 */
export function resolveWorkingModeValue(model: string | undefined, name: string): number | undefined {
  const map = workingModeMap(model);
  const hit = Object.entries(map).find(([, label]) => label.toLowerCase() === name.trim().toLowerCase());
  return hit ? Number(hit[0]) : undefined;
}
