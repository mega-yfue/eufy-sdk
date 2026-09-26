/**
 * Device model — shared contract.
 *
 * The whole model is **data-driven and capability-based**.
 * There is exactly ONE concrete device class; behaviour comes from:
 *
 *  - a **codec** (axis B2 — how commands are framed/routed for a device *family*), and
 *  - a set of composable **capabilities** (axis A — what the device exposes), each of which
 *    contributes a property schema (and, later, command behaviour).
 *
 * A device's `{ codec, capabilities }` is resolved by a 3-tier lookup
 * (exact model row → category default → inference). New SKUs in a known family need no code.
 *
 * This file is the integration contract: every other `src/model/*` module imports from here.
 */

/**
 * Command-codec families (axis B2). One per genuinely-different wire protocol.
 *
 * `station|camera|sensor|lock|keypad` are the eufy **security** families (P2P; param space
 * 1000+). `vacuum` is the eufy **clean** line (RoboVac) — a different transport (Tuya/MQTT
 * data-points) and a different param namespace (DP ids ~150-180), so its params come from a
 * separate authoritative source (`get_product_data_point` → `data_point_list`), NOT the P2P
 * device list. Per-namespace param dictionaries, not one global table.
 *
 * `light` is the eufy **life** smart-lighting line (e.g. T8L02 "Permanent Outdoor Lights") — its
 * own secure-MQTT "DP" TLV wire, decoded by its own transport codec. Named distinctly
 * from the camera-floodlight `light` *capability* so the two never collide as bare `"light"`.
 *
 * `display` is the T87Ax Smart Display line — its own codec because its `device_type` collides with
 * the security residual range (confirmed live, 2026-09-04: it connects over secure MQTT with no
 * `p2p_did`, never P2P). It owns its own param namespace (ids 8001-8006) and its own product line, so
 * no other line's capability can attach to it — see `namespaceForCodec` and `CODEC_LINE`. The `display`
 * capability targets it and reads the charge; no screen/audio/assistant param has been observed, so
 * those are absent rather than deferred.
 */
export type Codec =
  "station" | "camera" | "sensor" | "lock" | "keypad" | "vacuum" | "mower" | "light" | "printer" | "display";

/**
 * Capability identifiers (axis A). A capability is a composable feature a device exposes;
 * it maps to a {@link CapabilityModule} that owns its property schema. Extend this union as
 * new capabilities are modelled — adding one never requires a subclass.
 */
export type Capability =
  | "video"
  | "snapshot"
  | "motion"
  | "person_detection"
  | "battery"
  | "light"
  | "ptz"
  | "doorbell"
  | "contact"
  | "leak"
  | "smoke"
  | "co"
  | "siren"
  | "lock"
  | "keypad"
  | "arming"
  | "storage"
  // Publish a camera's stream over RTSP for a NAS/NVR (the vendor's NAS/RTSP feature).
  | "rtsp"
  // Camera power/privacy control (on/off + privacy mode). Distinct from the `camera` *codec*.
  | "camera"
  // Two-way audio: microphone / speaker mute + speaker volume.
  | "audio"
  // --- vacuum / clean line (Tuya DP namespace) ---
  | "vacuum_clean"
  | "vacuum_dock"
  | "suction"
  | "locate"
  // eufy_life smart lighting (own secure-MQTT DP namespace) — the T8L0x line's on/off/brightness/
  // effect control. Distinct from the camera-floodlight `light` capability above.
  | "smart_light"
  // --- Smart Display line (own 8001-8006 param namespace, secure MQTT, never P2P) ---
  // What a T87Ax Smart Display reports about itself. Read-only: no display write is captured.
  | "display"
  // Universal read-only identity metadata (manufacturer/model/serial/name) — every device has it.
  | "info";

/** Value type of a property. */
export type PropertyValueType = "bool" | "number" | "string" | "enum";

/**
 * What a value MEANS, as opposed to how it is stored — the semantic annotation that makes a reading
 * convertible without a hardcoded table per property.
 *
 * `PropertyValueType` says a value is a number; this says whether that number is a battery
 * percentage, a temperature, a signal strength, a duration or an instant. The distinction is not
 * cosmetic: a `seconds` duration and a `timestamp` instant are both numbers of seconds, and treating
 * one as the other is wrong in a way no type check catches.
 *
 *  - `boolean` — an on/off state (always paired with `type: "bool"`).
 *  - `percent` / `celsius` / `dbm` / `seconds` / `hours` / `megabytes` / `degrees` — a measured quantity
 *    in the unit the device reports it in; each pairs with the matching `unit`. Values are
 *    never converted on the way out — a converted reading is an invented one. `seconds` and `hours`
 *    are separate kinds for exactly that reason: a robot reports a run in seconds and a consumable's
 *    wear in hours, and normalising one into the other would publish a number the device never sent.
 *  - `scalar` — a plain number in no unit at all: a step on a ladder, a mode index, a raw level, a
 *    segment count. Ordered and comparable, but its range and direction are the device's, so nothing
 *    but the device says what a given value means.
 *  - `bitfield` — a number whose individual bits carry the meaning, not its magnitude.
 *  - `enum` — one of a named set; the set is the property's `enumValues` (raw → label) or, for a value
 *    a read decodes, the read's own `values`.
 *  - `identifier` — an opaque id whose domain lives elsewhere (a cloud-fetched list), so it is not
 *    ordered and not arithmetic.
 *  - `timestamp` — an instant, unix seconds.
 *  - `text` — free-form or structured text with no further promise.
 *
 * Three pairs are close enough to pick wrongly, so the test for each:
 *
 *  - **`scalar` vs a measured quantity** — is there a unit the device reports it in? A sensitivity
 *    step, a mode index and a segment count are all `scalar` precisely because there is none; they
 *    are NOT counts of anything, and the name says only "a bare number". A quantity with a unit takes
 *    the kind naming that unit, and the two are checked against each other in both directions.
 *  - **`identifier` vs `enum`** — can we publish the set? An `enum` ships its options with it, so its
 *    label needs nothing else. An `identifier` is a number whose domain is
 *    held somewhere we do not control (a catalogue the app fetches), so there is no set to ship and
 *    arithmetic on it — ordering, nearest-value, a range — is meaningless.
 *  - **`bitfield` vs `enum`** — one value, or several at once? A bitfield's bits combine, so it has no
 *    single label and its magnitude means nothing. The named bits belong to the capability that
 *    decodes them and are exported beside that decoder; unlike an enum's options they are not carried
 *    here, which is a gap this vocabulary does not close on its own.
 */
export const KNOWN_VALUE_KINDS = [
  "boolean",
  "percent",
  "celsius",
  "dbm",
  "seconds",
  "hours",
  "megabytes",
  "degrees",
  "scalar",
  "bitfield",
  "enum",
  "identifier",
  "timestamp",
  "text",
] as const;

/** One of the kinds this version models — the closed half of {@link ValueKind}. */
export type KnownValueKind = (typeof KNOWN_VALUE_KINDS)[number];

/**
 * A value kind — {@link KnownValueKind}, left **open** on purpose.
 *
 * Adding a member to a closed union is a breaking change for every caller with an exhaustive switch;
 * adding one to the open form is not. A caller maps the kinds it knows and falls through to a default
 * for the rest, so a newly-modelled kind degrades to "shown raw" instead of failing to compile.
 */
export type ValueKind = KnownValueKind | (string & {});

/**
 * Whether a kind is one this version models, narrowing it to {@link KnownValueKind}.
 *
 * The counterpart to leaving the union open: the compiler cannot tell a caller that a kind is one it
 * has a branch for, because at a declaration site any string is accepted. This is how a caller writes
 * the fallback branch the open union asks for — and, in the other direction, how the SDK's own specs
 * catch a kind that was typed rather than modelled.
 */
export function isKnownValueKind(kind: ValueKind): kind is KnownValueKind {
  return (KNOWN_VALUE_KINDS as readonly string[]).includes(kind);
}

/**
 * How much a param's name and meaning can be trusted, most-trusted first. This is the one definition;
 * the param dictionary and every `provenance` field use it.
 *  - `mega`     — stated by the vendor's own cloud: a real device's params as the mega API reports
 *                 them, or the cloud's data-point catalog (`get_product_data_point`).
 *  - `verified` — seen on a real device: our own capture or observation of the param changing.
 *  - `apk`      — the v6 app's own decompiled constant name, not yet seen on a device.
 *  - `guessed`  — no name source; a plausible placeholder until a toggle-diff settles it.
 *
 * A third-party reverse-engineering project is never a source: every name we ship comes from the
 * vendor's cloud, our own observation or the app itself. Absent provenance is treated as `guessed`.
 * @internal
 */
export type PropertySource = "mega" | "apk" | "verified" | "guessed";

/**
 * A single device property, mapped to its P2P `param_type`. This is pure data — the same
 * spec is reused across every device whose capability contributes it.
 */
export interface PropertySpec {
  /** Stable, code-facing name (e.g. "battery", "light", "motionDetection"). */
  name: string;
  /** The eufy P2P `param_type` carrying this value (the wire id). */
  paramType: number;
  type: PropertyValueType;
  /** Human unit, when meaningful (e.g. "%", "°C", "dBm"). */
  unit?: string;
  /**
   * What the value means ({@link ValueKind}) — the machine-readable half of {@link unit}.
   *
   * Absent when the stored value carries no scalar meaning of its own: a structured payload whose
   * semantic value is a field inside it declares the kind on the member that decodes it
   * instead, since that is where the meaning becomes true.
   */
  kind?: ValueKind;
  /** Whether the value can be written back to the device (a setter exists). */
  writable: boolean;
  /** Allowed values for `type: "enum"` (raw → label). */
  enumValues?: Record<number, string>;
  /**
   * Trust level of this `paramType` mapping. Default (absent) = `guessed`. Anything still `guessed`
   * is a candidate for confirmation against a first-party source, never relied on.
   */
  provenance?: PropertySource;
  /**
   * Wire polarity for a `bool` property whose param is a *disable* flag: when `true`, a raw
   * `0`/`false` means the property is TRUE (e.g. a camera's `enabled` — the flag is the
   * disable bit, so `"0"` ⇒ enabled). Ignored for non-bool types.
   */
  invert?: boolean;
  /**
   * Custom decode for a value the wire delivers as a code the app *reinterprets* — a bitfield/enum
   * that means something other than its face value. Given the raw param value, returns the decoded
   * property value. When present it REPLACES the default type-coercion (and `invert`). Example: the
   * battery `charging` flag is derived from the reported charge status, matching the app's
   * own Hermes decode — see `capabilities/battery.ts`.
   */
  decode?: (raw: string | number | boolean) => boolean | number | string;
  /**
   * This param carries a STRUCTURED PAYLOAD rather than a scalar — a base64 protobuf that the
   * capability's own getter reads a field out of, with the injected codec in scope.
   *
   * The stored value is that payload verbatim, and {@link type} describes what the getter ANSWERS
   * rather than what arrives on the wire. Those are different for every Raw DP on the clean line: nine
   * consumable counters are `"number"` over one base64 string, and reading the value as a number is
   * exactly what must NOT happen at ingest.
   *
   * Storage already keeps such a value intact — a non-numeric string cannot be coerced to a number, so
   * it is passed through. What this flag changes is that the pass-through stops being reported as a
   * mistake: a robot reporting ten Raw DPs on every push logged ten warnings a time saying its
   * properties were misdeclared, which is how a real warning goes unread.
   */
  raw?: true;
  /**
   * Extra wire param ids that ALSO carry this property on some device families, with their own
   * polarity. The device's own `paramType` wins; otherwise the first alias the device reports wins.
   * Lets one property (e.g. `enabled`) read correctly across families that report it under
   * different ids (a battery camera and a standalone one disagree) — the family variance lives
   * in the capability spec, not in per-device branches.
   */
  readAliases?: ReadonlyArray<{ paramType: number; invert?: boolean }>;
  /** Short description for docs / discovery. */
  description?: string;
}

/**
 * A decoded property value. Most params are scalar, but some carry a structured payload that the
 * device delivers **encoded** (base64-wrapped JSON, or a JSON string) — e.g. motion-detection
 * zones, privacy zones, guard-mode configs. Those are decoded to the object/array form.
 */
export type ParamValue = boolean | number | string | Record<string, unknown> | unknown[];

/** How a param's wire value is encoded (when it isn't a plain scalar). */
export type ParamEncoding = "base64+json" | "json";

/** A live property value plus the param_type it came from. */
export interface PropertyValue {
  name: string;
  paramType: number;
  value: ParamValue;
  /** When the value was last observed (epoch ms). */
  ts: number;
}

/**
 * One property whose value moved — the payload of a property-change announcement.
 *
 * Identified by property NAME and nothing else. The name is unique per device, is what `applyParams`
 * already answers with, and is the key `Device.getProperty` takes — so a caller can re-read
 * immediately. No wire id travels with it: resolving several ids to one property is the whole job the
 * param → spec map does, and handing the id back out undoes it and gives a caller a second identifier
 * to key on, which then breaks on the family where that property's read alias is promoted. The ids stay
 * available through `inspectDevice` and `Device.describe()`.
 *
 * The capability accessor behind the name is published by `Device.describe()` as the
 * `{ accessor, property }` pair, joined once at setup.
 */
export interface PropertyChange {
  /** The property whose value moved — a key of this device's own schema. */
  property: string;
  /**
   * What {@link Device.getProperty} now serves for this property, narrowed to its declared type the same
   * way a capability getter narrows it.
   *
   * Read out of live state, never re-converted from the wire, so it cannot disagree with the getter
   * beside it. Said as "what `getProperty` serves" rather than "what the getter answers" because a
   * schema property does not always HAVE a typed getter: an `unexposed` member is reported and readable
   * but has no confirmed meaning for its value, so promising the getter here would be a claim this SDK
   * has not made anywhere else.
   *
   * Absent where no scalar can honestly be given: a property whose stored value is a PAYLOAD rather than
   * the value (see {@link PropertySpec.raw}), and one whose stored value does not match its declared
   * type. In both cases the honest answer is "this moved, re-read it".
   */
  value?: boolean | number | string;
}

/**
 * A capability module = property schema + detection + inbound decode + outbound commands.
 * Written ONCE, reused by every device that lists the capability. This is how "extra bits" (a
 * camera's light, pan-tilt, doorbell button) attach without subclassing. The full shape lives in
 * `capabilities/types.ts`; re-exported here so existing `./types` importers keep working.
 */
export type {
  CapabilityModule,
  DetectionSpec,
  CapabilityFrame,
  CapabilityEvent,
  CommandContext,
  AvailabilityContext,
  CapabilityActions,
} from "./capabilities/types.js";

/**
 * A curated registry row (tier 1). Keyed by model (T-code) in the registry. Everything is
 * optional except `codec` — capabilities can also come from the category default or inference.
 */
export interface RegistryEntry {
  codec: Codec;
  /** Capabilities to attach in addition to the codec's baseline. */
  caps?: Capability[];
  /** Pretty display name. */
  name?: string;
  /**
   * Per-device one-off behaviour. Quarantined to this row — the escape hatch that replaces
   * subclassing. Keys are command names; values are device-specific implementations.
   */
  overrides?: Record<string, unknown>;
}

/**
 * The minimal slice of a cloud device record the model needs to classify + infer. The real
 * record (`EufyDevice.raw`) has far more; we read only these.
 */
export interface CloudRecord {
  /** eufy's own numeric DeviceType (authoritative classifier). */
  deviceType?: number;
  /** Model / product code (T-code), e.g. "T8423". */
  model?: string;
  /** Anker category string, e.g. "eufy_security". */
  category?: string;
  /**
   * What the user named this device in the app (`device_name`), when the record carries one. Not a
   * classification signal — carried so a device answers with the name its owner sees.
   */
  name?: string;
  /**
   * The parent HomeBase's serial when this device hangs off one (`parent_sn` ≠ own sn); absent when
   * the device stands alone. A topology signal, not a param — used by {@link resolveDevice} to withhold
   * station-scoped capabilities (guard-mode `arming`) from a camera behind a HomeBase, where the
   * HomeBase owns them.
   */
  parentSn?: string;
  /** Reported param_type → raw value. Presence of a param is a capability signal. */
  params?: Record<number, string>;
}

/** The fully-resolved device shape produced by the 3-tier resolver. */
export interface ResolvedDevice {
  codec: Codec;
  capabilities: Capability[];
  /** Merged, de-duplicated property schema from all resolved capabilities. */
  properties: PropertySpec[];
  /** Display name (curated row → inferred → model code). */
  name: string;
  /** How the codec/caps were resolved, for diagnostics. */
  source: "model" | "category" | "inferred";
}
