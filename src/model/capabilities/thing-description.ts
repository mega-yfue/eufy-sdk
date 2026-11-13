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
 * `profile` names the product's settings plugin: the app's own per-product code mapping each property
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

/** A product's settings plugin, as `profile` names it. */
export interface ThingPlugin {
  readonly id: string;
  /** URL of the plugin's script. */
  readonly path: string;
  readonly zipId: string;
  /** URL of the plugin's archive. */
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
  readonly plugin: ThingPlugin;
  readonly properties: Readonly<Record<string, ThingProperty>>;
  readonly actions: Readonly<Record<string, ThingAction>>;
  readonly events: Readonly<Record<string, ThingEvent>>;
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
      plugin: {
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
