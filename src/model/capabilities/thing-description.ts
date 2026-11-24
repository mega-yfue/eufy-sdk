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

import type { AvailabilityContext } from "./types.js";

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
 * station's firmware. `params` are the device's reported `param_type → value`, which `camera_info` reads and
 * an `associated_field` derives the other property's value from.
 */
export interface ThingFacts {
  readonly serial?: string;
  readonly firmwareVersion?: string;
  readonly stationSerial?: string;
  readonly stationFirmwareVersion?: string;
  readonly country?: string;
  readonly params?: Readonly<Record<number, string>>;
  /** The device's cloud record, which the app's own lock screens read `sec_sw_version` and `ai_*_version` off. */
  readonly record?: Readonly<Record<string, unknown>>;
}

/** Java's `a.compareTo(b) >= 0` on a non-empty `a`. */
const atLeast = (a: string | undefined, b: string): boolean => !!a && a >= b;

/**
 * The app's remote-config version check (`device >= remote`): both stripped to digits and dots, then compared
 * field by field as integers, a missing field 0; false for an empty one or a field that is no integer.
 */
function dottedAtLeast(device: unknown, remote: string): boolean {
  const ints = (v: string) => (v ? v.split(".").map((f) => (/^\d+$/.test(f) ? Number(f) : NaN)) : [NaN]);
  const [a, b] = [String(device ?? "").replace(/[^0-9.]/g, ""), remote].map(ints);
  if ([...a!, ...b!].some(Number.isNaN)) return false;
  for (let i = 0; i < Math.max(a!.length, b!.length); i++)
    if ((a![i] ?? 0) !== (b![i] ?? 0)) return (a![i] ?? 0) > (b![i] ?? 0);
  return true;
}

/** Stations whose lock behind them shows loitering detection whatever its firmware. */
const LOITERING_STATIONS = /^(T8030|T9000|t9000|T90H1|t90h1|T8N00|T7000|T8040|T8025)/;

/**
 * Whether the app's own lock screens offer `identifier` on this device, the remote-config thresholds at the app's
 * compiled defaults: the T8531's rain mode from MCU version 1.2.1.6 (`"1."` and the last character of each
 * `ai_kernel_version`, `ai_algor_version`, `ai_rootfs_version` standalone, param 6621 behind a station); the T85V0's
 * radar rain mode from `sec_sw_version` 0.2.4.7, and behind a station from its firmware 3.6.9.2; its rear screen
 * settings (display mode, live view) from firmware 1.1.3.5 while param 6492 is on, below it unless its serial has `9`
 * at index 6; the T8530's loitering detection behind a {@link LOITERING_STATIONS} station, else from firmware 1.1.4.0
 * behind a station on 3.2.0.8h.
 * Versions compare as Java strings but for the radar rain mode ({@link dottedAtLeast}).
 *
 * ponytail: the three remote-config thresholds are Firebase Remote Config keys the SDK cannot fetch, pinned at the
 * app's defaults (the service overrides none today); fetch them through a Firebase client if it ever does.
 */
function lockScreenShows(identifier: string, f: ThingFacts): boolean {
  const serial = f.serial ?? "";
  const behind = !!f.stationSerial && f.stationSerial !== serial;
  if (serial.startsWith("T8531") && identifier === "smart_lock_rain_mode_switch") {
    const last = (k: string) => String(f.record?.[k] ?? "").slice(-1);
    const own = [last("ai_kernel_version"), last("ai_algor_version"), last("ai_rootfs_version")];
    return atLeast(behind ? f.params?.[6621] : own.some((c) => !c) ? "" : `1.${own.join(".")}`, "1.2.1.6");
  }
  if (serial.startsWith("T85V0") && identifier === "device_rain_mode")
    return (
      dottedAtLeast(f.record?.sec_sw_version, "0.2.4.7") &&
      (!behind || dottedAtLeast(f.stationFirmwareVersion, "3.6.9.2"))
    );
  if (serial.startsWith("T85V0") && ["smart_lock_set_back_screen", "device_live_view_switch"].includes(identifier))
    return atLeast(f.firmwareVersion, "1.1.3.5") ? /^(1|true)$/i.test(f.params?.[6492] ?? "") : serial[6] !== "9";
  if (serial.startsWith("T8530") && identifier.startsWith("detection_loitering_detection_"))
    return (
      LOITERING_STATIONS.test(f.stationSerial ?? serial) ||
      (atLeast(f.firmwareVersion, "1.1.4.0") && behind && atLeast(f.stationFirmwareVersion, "3.2.0.8h"))
    );
  return true;
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

/**
 * `camera_info`: a reported param, named by `value`'s JSON `param`, compared by `equals` (`value`), `RE`
 * (`regex`) or `json_match` (the param parsed as a JSON object, see {@link jsonMatch}).
 */
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
  if (qualifier !== "json_match" || !spec.json_match || typeof spec.json_match !== "object") return false;
  const target = json(reported) as Raw | undefined;
  return !!target && typeof target === "object" && !Array.isArray(target) && jsonMatch(target, spec.json_match);
}

/** A JSON primitive's content as a string, as the app reads it; absent for null, an object or an array. */
const content = (v: unknown): string | undefined =>
  v === null || v === undefined || typeof v === "object" ? undefined : String(v);

/** `JSON.parse`, or `undefined` for text that is not JSON. */
const json = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** `asInt(value, fallback)` as the bundles use it: the value's integer, else the fallback. */
const asInt = (v: unknown, fallback: number): number => {
  const n = Number.parseInt(String(v), 10);
  return Number.isNaN(n) ? fallback : n;
};

/**
 * The value of another property, for `associated_field`: what the product's settings bundle parses it to
 * from a reported param, as the app compares it (a string). The same in every bundle that defines it; an
 * identifier not listed, or whose param is not reported, compares an empty value.
 */
const ASSOCIATED: Readonly<Record<string, (params: Readonly<Record<number, string>>) => string | undefined>> = {
  /** `true` once `APP_CMD_SET_SILENT_OTA_SWITCH` (6287) is reported. */
  is_support_silent_ota_switch: (p) => (p[6287] === undefined ? undefined : "true"),
  /** `APP_CMD_HB3_AI_Empowerment` (1299): its JSON value, else the value as an integer (0 when none). */
  ai_empower: (p) => {
    const v = p[1299];
    if (v === undefined) return undefined;
    const parsed = json(v);
    if (parsed === undefined) return String(asInt(v, 0));
    return content(parsed) ?? JSON.stringify(parsed);
  },
  /** `APP_CMD_GET_POWER_SUPPLY_MODE` (6445): its JSON `power_source`, else `source`, as an integer; 1 when empty. */
  device_power_supply_mode: (p) => {
    const v = p[6445];
    if (v === undefined) return undefined;
    if (v === "") return "1";
    const parsed = json(v) as Raw | undefined;
    return parsed === undefined ? undefined : String(asInt(parsed?.power_source ?? parsed?.source, 1));
  },
};

/**
 * The app's `json_match`: `target` a JSON object, every check of `match` passing (`mode` `all`, the
 * default) or any one (`any`, which fails with no check). A check is a key present (`contains_key`) or
 * absent (`not_contains_key`), or a key's primitive value equal (`value_equals`), different
 * (`value_not_equals`) or matched (`value_regex`); a missing or non-primitive value fails its check.
 */
function jsonMatch(target: Raw, match: Raw): boolean {
  const checks: boolean[] = [];
  const keys = (k: string): string[] =>
    Array.isArray(match[k])
      ? match[k].map(content).filter((x: string | undefined): x is string => x !== undefined)
      : [];
  const pairs = (k: string): [string, string | undefined][] =>
    match[k] && typeof match[k] === "object" ? Object.entries(match[k]).map(([key, v]) => [key, content(v)]) : [];
  for (const k of keys("contains_key")) checks.push(Object.hasOwn(target, k));
  for (const k of keys("not_contains_key")) checks.push(!Object.hasOwn(target, k));
  const valued = (k: string, test: (actual: string, expected: string) => boolean) => {
    for (const [key, expected] of pairs(k)) {
      const actual = content(target[key]);
      checks.push(expected !== undefined && actual !== undefined && test(actual, expected));
    }
  };
  valued("value_equals", (a, e) => a === e);
  valued("value_not_equals", (a, e) => a !== e);
  valued("value_regex", (a, e) => {
    try {
      return new RegExp(e).test(a);
    } catch {
      return false;
    }
  });
  return match.mode === "any" ? checks.some(Boolean) : checks.every(Boolean);
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
    case "sdk_version":
      return version(APP_SDK_VERSION, c.qualifier, c.value);
    case "associated_field":
      return compare(ASSOCIATED[c.propId ?? ""]?.(facts.params ?? {}) ?? "", c.qualifier, c.value);
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
 * out, as is one the app's own lock screens do not offer ({@link lockScreenShows}), and actions and events
 * whose available conditions fail; one whose read conditions fail stays without its `defaultValue`.
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
    if (!p || !conditionsPass(p.availableConditions, facts) || !lockScreenShows(base, facts)) continue;
    // The app's `ThingProperty.get()` reads an empty payload off a property whose read conditions fail.
    const { defaultValue: _, ...unread } = p;
    properties[base] = conditionsPass(p.readConditions, facts) ? p : unread;
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

/**
 * Whether the product's description lists `identifier`. With no description fetched the member stays,
 * so a missing cloud reply never hides what the device reports.
 */
export const described =
  (identifier: string) =>
  (ctx: AvailabilityContext): boolean =>
    !ctx.things || identifier in ctx.things.properties;
