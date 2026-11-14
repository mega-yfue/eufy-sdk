/**
 * A product's **thing description** — the per-product model the vendor's things service returns from
 * `app/things/get_things_list` and the v6 app builds its device settings from.
 *
 * One description per product code. Its properties are the product's settings and states, keyed by a
 * stable `identifier` (`nightvision_type`, `led_on_off`, …); its actions and events are keyed the same
 * way. A property declares its access (`R` read-only, `RW` writable), its data type and, per type, its
 * specs: an enum lists its members, an `int` its bounds, most types a default. Each enum member carries
 * the app's UI value (`value`), its label (`desc`) and — for a member that maps onto the device's own
 * wire — that wire value (`associatedValue`); a member without one is a named constant, not a mode.
 *
 * A property may exist in several **variants**: `identifier`, `identifier__v1`, `identifier__v2`, …, each
 * gated by conditions on the device (`read_conditions`, `available_conditions`): its firmware
 * (`device_version`), its station's serial and firmware (`parent_sn`, `parent_version`), its own serial
 * (`device_sn`), another property's value (`associated_field`), the account's country (`user_country`)
 * or the app's SDK version (`sdk_version`). A condition list is held here as data, exactly as listed.
 *
 * `profile` names the product's settings bundle: the app's own per-product code mapping each property
 * to the commands it reads and writes. The vendor's member key is spelled `eunmList`; the parser reads
 * that spelling.
 *
 * Everything is parsed defensively — a malformed entry is skipped, never thrown on — and held as plain
 * null-prototype objects, so a description serialises as it is and a lookup never reaches a prototype.
 *
 * @module model/capabilities/thing-description
 */

/** One condition of a condition list: `type` compared by `qualifier` against `value`. */
export interface ThingCondition {
  /** What is compared: `device_version`, `parent_sn`, `parent_version`, `device_sn`, `associated_field`, `user_country`, `sdk_version`, … */
  readonly type: string;
  /** How: `=`, `<`, `<=`, `>=` (versions, values), `RE` (regular expression), `SE` (regular expression on the device serial). */
  readonly qualifier: string;
  readonly value: string;
  /** For `associated_field`: the identifier of the property whose value is compared. */
  readonly propId?: string;
}

/** A condition list as the description gives it: its entries, each a set of conditions. */
export type ThingConditions = readonly (readonly ThingCondition[])[];

/** One member of an enum property. */
export interface ThingMember {
  /** The app's UI value for this member. */
  readonly value: string;
  /** The value on the device's own wire (`associatedValue`); absent for a named constant. */
  readonly wireValue?: string;
  readonly desc: string;
  readonly isDefault: boolean;
}

/** One property of a thing description. */
export interface ThingProperty {
  readonly identifier: string;
  /** `R` read-only or `RW` writable, as declared. */
  readonly accessMode: string;
  /** `bool`, `int`, `string`, `text`, `enum`, `tenum`, `ienum`, … */
  readonly type: string;
  /** An enum's members in the listed order; empty for any other type. */
  readonly members: readonly ThingMember[];
  readonly defaultValue?: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly unit?: string;
  readonly readConditions: ThingConditions;
  readonly writeConditions: ThingConditions;
  readonly availableConditions: ThingConditions;
}

/** One action of a thing description; its input and output types, when declared. */
export interface ThingAction {
  readonly identifier: string;
  readonly inputType?: string;
  readonly outputType?: string;
  readonly availableConditions: ThingConditions;
}

/** One event of a thing description; its output type and default (often a list of param ids), when declared. */
export interface ThingEvent {
  readonly identifier: string;
  readonly eventType: string;
  readonly outputType?: string;
  readonly defaultValue?: string;
  readonly availableConditions: ThingConditions;
}

/** A product's settings bundle, as `profile` names it. */
export interface ThingBundle {
  readonly id: string;
  /** URL of the bundle's script. */
  readonly path: string;
  readonly zipId: string;
  /** URL of the bundle's archive. */
  readonly zipPath: string;
}

/** A product's thing description. */
export interface ThingDescription {
  readonly productCode: string;
  readonly version: string;
  /** Unix seconds of the last change, as the service states it — the value `code_time_map` sends back. */
  readonly updateTime: number;
  readonly largeVersion: number;
  readonly largeVersionUpdateTime: number;
  readonly bundle: ThingBundle;
  readonly properties: Readonly<Record<string, ThingProperty>>;
  readonly actions: Readonly<Record<string, ThingAction>>;
  readonly events: Readonly<Record<string, ThingEvent>>;
}

/**
 * What a device's conditions are evaluated against. `stationSerial` is the serial of the station the
 * device is reached through — its own serial when it stands alone — and `stationFirmwareVersion` that
 * station's firmware. An `associated_field` / `parent_associated_field` condition compares an empty
 * string. `params` are the device's reported `param_type → value`, for `camera_info`.
 */
export interface ThingFacts {
  readonly serial?: string;
  readonly firmwareVersion?: string;
  readonly stationSerial?: string;
  readonly stationFirmwareVersion?: string;
  readonly country?: string;
  readonly params?: Readonly<Record<number, string>>;
}

/** The SDK version the v6 app evaluates `sdk_version` conditions against (6.1.32). */
const APP_SDK_VERSION = "2.3.3.1";

/** Stations whose firmware strings carry a non-numeric suffix the app strips before comparing. */
const SUFFIXED_STATION_PREFIXES = ["T8010", "T8020", "T8021", "T8023"];

/**
 * A regular-expression condition, as the app runs it: an empty pattern or value passes, an over-long one
 * (pattern > 512, value > 2048) fails, an invalid pattern fails, otherwise the pattern must be found in
 * the value. Java's inline `(?i)` becomes the case-insensitive flag.
 */
function re(pattern: string, value: string): boolean {
  if (!pattern || !value) return true;
  if (pattern.length > 512 || value.length > 2048) return false;
  try {
    const insensitive = pattern.includes("(?i)");
    return new RegExp(pattern.replaceAll("(?i)", ""), insensitive ? "i" : "").test(value);
  } catch {
    return false;
  }
}

/** A version's dot-separated parts, each part's trailing letters dropped as the app does. */
const parts = (v: string): string[] => v.split(".");
const intOf = (s: string | undefined): number | undefined => {
  const t = (s ?? "0").replace(/[a-zA-Z]+$/, "");
  return /^[+-]?\d+$/.test(t) ? Number(t) : undefined;
};
const numericPrefix = (p: string[]): number => {
  const i = p.findIndex((s) => intOf(s) === undefined);
  return i < 0 ? p.length : i;
};

/** `a > b` as the app's `versionBiggerThan` decides it. */
function versionAbove(a: string, b: string): boolean {
  const pa = parts(a);
  const pb = parts(b);
  const n = Math.max(numericPrefix(pa), numericPrefix(pb));
  for (let i = 0; i < n; i++) {
    const d = (intOf(pa[i]) ?? 0) - (intOf(pb[i]) ?? 0);
    if (d !== 0) return d > 0;
  }
  const ta = pa.slice(n);
  const tb = pb.slice(n);
  if (!ta.length || !tb.length) return ta.length > 0 && !tb.length;
  const lastInt = (t: string[]) => t.findLastIndex((s) => /^[+-]?\d+$/.test(s));
  const ia = lastInt(ta);
  const ib = lastInt(tb);
  const head = (t: string[], i: number) => (i >= 0 ? t.slice(0, i) : t).join(".");
  if (head(ta, ia) !== head(tb, ib)) return false;
  return (ia >= 0 ? Number(ta[ia]) : 0) > (ib >= 0 ? Number(tb[ib]) : 0);
}

/** `a = b` as the app's `versionEquals` decides it. */
function versionEqual(a: string, b: string): boolean {
  const pa = parts(a);
  const pb = parts(b);
  const n = Math.max(numericPrefix(pa), numericPrefix(pb));
  for (let i = 0; i < n; i++) if ((intOf(pa[i]) ?? 0) !== (intOf(pb[i]) ?? 0)) return false;
  return pa.slice(n).join(".") === pb.slice(n).join(".");
}

/** A version condition: `<`, `<=`, `=`, `!=`, `>=`, `>` compare versions, `RE` matches the version. */
function version(current: string, qualifier: string, target: string): boolean {
  switch (qualifier) {
    case "<":
      return versionAbove(target, current);
    case "<=":
      return versionAbove(target, current) || versionEqual(current, target);
    case "=":
      return versionEqual(current, target);
    case "!=":
      return !versionEqual(current, target);
    case ">=":
      return versionAbove(current, target) || versionEqual(current, target);
    case ">":
      return versionAbove(current, target);
    case "RE":
      return re(target, current);
    default:
      return false;
  }
}

/** A value condition: `RE` matches, otherwise `=`, `!=`, `<`, `<=`, `>=`, `>` compare the strings. */
function compare(current: string, qualifier: string, target: string): boolean {
  if (qualifier === "RE") return re(target, current);
  switch (qualifier) {
    case "=":
      return current === target;
    case "!=":
      return current !== target;
    case "<":
      return current < target;
    case "<=":
      return current <= target;
    case ">=":
      return current >= target;
    case ">":
      return current > target;
    default:
      return false;
  }
}

/** `camera_info`: a reported param, named by `value`'s JSON `param`, compared by `equals` (`value`) or `RE` (`regex`). */
function cameraInfo(facts: ThingFacts, qualifier: string, value: string): boolean {
  let spec: Raw;
  try {
    spec = JSON.parse(value);
  } catch {
    return false;
  }
  const reported = typeof spec?.param === "number" ? facts.params?.[spec.param] : undefined;
  if (reported === undefined) return false;
  if (qualifier === "equals") return typeof spec.value === "string" && spec.value === reported;
  if (qualifier === "RE") return typeof spec.regex === "string" && re(spec.regex, reported);
  return false;
}

/** One condition, as the app's condition runner evaluates it; a type it does not know fails. */
function condition(c: ThingCondition, facts: ThingFacts): boolean {
  const station = facts.stationSerial ?? facts.serial ?? "";
  switch (c.type) {
    case "device_version":
      return version(facts.firmwareVersion ?? "", c.qualifier, c.value);
    case "parent_version": {
      const v = facts.stationFirmwareVersion ?? "";
      const clean = SUFFIXED_STATION_PREFIXES.some((p) => station.startsWith(p)) ? v.replace(/[^0-9.][^.]*/g, "") : v;
      return version(clean, c.qualifier, c.value);
    }
    case "parent_sn":
      return re(c.value, station);
    case "device_sn":
      return re(c.value, facts.serial ?? "");
    case "user_country":
      return re(c.value, facts.country ?? "");
    case "user_domain":
      return re(c.value, "");
    case "sdk_version":
      return version(APP_SDK_VERSION, c.qualifier, c.value);
    case "associated_field":
    case "parent_associated_field":
      return compare("", c.qualifier, c.value);
    case "user_permission":
      return c.qualifier === "in";
    case "camera_info":
      return cameraInfo(facts, c.qualifier, c.value);
    default:
      return false;
  }
}

/**
 * Whether a condition list passes for a device, as the app decides it: an empty list passes; otherwise
 * any entry passing is enough, and an entry passes when every one of its conditions does.
 */
export function conditionsPass(list: ThingConditions, facts: ThingFacts): boolean {
  return list.length === 0 || list.some((entry) => entry.every((c) => condition(c, facts)));
}

/** The base identifier of a variant: the part before `__v` (case-insensitive), or the identifier itself. */
const bare = (identifier: string): string => {
  const i = identifier.toLowerCase().indexOf("__v");
  return i > 0 ? identifier.slice(0, i) : identifier;
};

/**
 * A product's description **as one device sees it**, resolved the way the v6 app resolves each lookup.
 * Properties are keyed by their base identifier and hold the variant this device uses: among the
 * `identifier__vN` whose read conditions pass (a variant without read conditions is never chosen), the
 * one with the most conditions, the first listed on a tie, else the base `identifier`. The chosen
 * property's `identifier` keeps the variant's name. A property whose available conditions fail is left
 * out, as are actions and events whose available conditions fail. A property whose write conditions fail
 * is held as `R`.
 */
export function resolveThing(td: ThingDescription, facts: ThingFacts): ThingDescription {
  const properties: Record<string, ThingProperty> = Object.create(null);
  const keys = Object.keys(td.properties);
  for (const base of new Set(keys.map(bare))) {
    let chosen = base;
    let most = -1;
    for (const key of keys) {
      if (key === base || bare(key) !== base) continue;
      const p = td.properties[key]!;
      if (p.readConditions.length === 0 || !conditionsPass(p.readConditions, facts)) continue;
      const count = p.readConditions.reduce((n, entry) => n + entry.length, 0);
      if (count > most) [chosen, most] = [key, count];
    }
    const p = td.properties[chosen];
    if (!p || !conditionsPass(p.availableConditions, facts)) continue;
    properties[base] = conditionsPass(p.writeConditions, facts) ? p : { ...p, accessMode: "R" };
  }
  const available = <T extends { availableConditions: ThingConditions }>(entries: Readonly<Record<string, T>>) => {
    const out: Record<string, T> = Object.create(null);
    for (const [k, v] of Object.entries(entries)) if (conditionsPass(v.availableConditions, facts)) out[k] = v;
    return out;
  };
  return { ...td, properties, actions: available(td.actions), events: available(td.events) };
}

type Raw = Record<string, any>;

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const optStr = (v: unknown): string | undefined => (v == null || v === "" ? undefined : str(v));
const num = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);

function conditions(v: unknown): ThingConditions {
  return list((v as Raw | undefined)?.condition_list).map((entry) =>
    list(entry.conditions).map((c) => ({
      type: str(c.type),
      qualifier: str(c.qualifier),
      value: str(c.value),
      ...(c.prop_id ? { propId: str(c.prop_id) } : {}),
    })),
  );
}

function keyed<T extends { identifier: string }>(entries: Raw[], parse: (e: Raw) => T): Record<string, T> {
  const out: Record<string, T> = Object.create(null);
  for (const e of entries) if (typeof e.identifier === "string" && e.identifier) out[e.identifier] = parse(e);
  return out;
}

function property(p: Raw): ThingProperty {
  const specs: Raw = p.data_type?.specs ?? {};
  return {
    identifier: p.identifier,
    accessMode: str(p.access_mode),
    type: str(p.data_type?.type),
    members: list(specs.eunmList).map((m) => ({
      value: str(m.value),
      ...(m.associatedValue != null ? { wireValue: str(m.associatedValue) } : {}),
      desc: str(m.desc),
      isDefault: m.isDefault === 1 || m.isDefault === true,
    })),
    ...(optStr(specs.defaultValue) !== undefined ? { defaultValue: str(specs.defaultValue) } : {}),
    ...(num(specs.min) !== undefined ? { min: num(specs.min) } : {}),
    ...(num(specs.max) !== undefined ? { max: num(specs.max) } : {}),
    ...(num(specs.step) !== undefined ? { step: num(specs.step) } : {}),
    ...(optStr(specs.unit) !== undefined ? { unit: str(specs.unit) } : {}),
    readConditions: conditions(p.read_conditions),
    writeConditions: conditions(p.write_conditions),
    availableConditions: conditions(p.available_conditions),
  };
}

/**
 * Parse an `app/things/get_things_list` reply into each listed product's {@link ThingDescription}, keyed
 * by `profile.product_code`. `raw` is the reply's `data` object, holding `things_list`. An entry without a
 * product code is skipped; any other shape mismatch yields an empty result — never throws.
 */
export function parseThingsList(raw: unknown): Readonly<Record<string, ThingDescription>> {
  const out: Record<string, ThingDescription> = Object.create(null);
  for (const t of list((raw as Raw | null)?.things_list)) {
    const profile: Raw = t.profile ?? {};
    const code = profile.product_code;
    if (typeof code !== "string" || !code) continue;
    out[code] = {
      productCode: code,
      version: str(t.version),
      updateTime: num(t.update_time) ?? 0,
      largeVersion: num(t.large_version) ?? 0,
      largeVersionUpdateTime: num(t.large_version_update_time) ?? 0,
      bundle: {
        id: str(profile.plugin_id),
        path: str(profile.plugin_path),
        zipId: str(profile.plugin_id_zip),
        zipPath: str(profile.plugin_path_zip),
      },
      properties: keyed(list(t.properties), property),
      actions: keyed(list(t.actions), (a) => ({
        identifier: a.identifier,
        ...(optStr(a.input_data?.type) ? { inputType: str(a.input_data.type) } : {}),
        ...(optStr(a.output_data?.type) ? { outputType: str(a.output_data.type) } : {}),
        availableConditions: conditions(a.available_conditions),
      })),
      events: keyed(list(t.events), (e) => ({
        identifier: e.identifier,
        eventType: str(e.event_type),
        ...(optStr(e.output_data?.type) ? { outputType: str(e.output_data.type) } : {}),
        ...(optStr(e.output_data?.specs?.defaultValue) ? { defaultValue: str(e.output_data.specs.defaultValue) } : {}),
        availableConditions: conditions(e.available_conditions),
      })),
    };
  }
  return out;
}
