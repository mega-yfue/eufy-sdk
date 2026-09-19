import type { DpCatalog } from "./dp-catalog.js";

/**
 * Capability-module contract — the extended shape each `capabilities/<cap>.ts` file implements.
 *
 * A capability module is **self-contained**: it owns everything about one feature —
 *  - its **property schema** (the properties it contributes),
 *  - how the device is **detected** as having the capability ({@link DetectionSpec}),
 *  - how to **decode inbound frames** it cares about ({@link CapabilityModule.decodeFrame}),
 *  - how to **build outbound commands** ({@link CapabilityModule.buildCommand}).
 *
 * The barrel (`capabilities/index.ts`) collects the modules and exposes fleet-wide helpers
 * (`detectCapabilities`, `decodeFrame`, `buildCommand`). Deleting a module file = removing one
 * import line from the barrel; nothing else needs editing.
 *
 * @module model/capabilities/types
 */

import type { Capability, Codec, CloudRecord, PropertySpec, PropertyValue, ValueKind } from "../types.js";
import type { Members, MemberDeps } from "./members.js";
// The transport boundary contract lives in core/ — imported by BOTH the capability layer (which
// produces intent) and the transport layer (which consumes it), so neither imports the other.
// Capability modules import Command/CommandSink/MediaProvider/ScalarForm straight from core/contracts.
import type { Command, Ff09SettingsReader, DpInboundFrame } from "../../core/contracts.js";

/**
 * How a capability is discovered on a device. All fields are additive OR-ed evidence — a device
 * has the capability if ANY field matches. Mechanisms, most-to-least dynamic:
 *  - `evidenceParams` — a reported `param_type` whose PRESENCE proves the capability (the device
 *    self-reports it when its info is pulled over P2P). Namespace-agnostic: security param ids and
 *    vacuum Tuya-DP ids are declared the same way.
 *  - `deviceTypes` — vendor `DeviceType` numbers that guarantee the capability (static vendor
 *    table, e.g. Indoor-PT = 31/35/111). Used when there is no honest self-reported signal.
 *  - `modelHints` — regexes over the model / category / name strings.
 *  - `codecs` — the codec baseline already implies it (e.g. any `camera` has video).
 *  - `detect` — escape hatch for logic that doesn't fit the declarative fields. Must never throw.
 */
export interface DetectionSpec {
  evidenceParams?: number[];
  deviceTypes?: number[];
  modelHints?: RegExp[];
  codecs?: Codec[];
  detect?(rec: CloudRecord, codec: Codec): boolean;
}

/**
 * Which product line a capability or a codec belongs to.
 *
 * eufy ships several ecosystems that share a cloud account and nothing else: `security` (cameras,
 * stations, locks, sensors — P2P plus the security-scoped broker), `life` (the T8L0x smart-lighting
 * line — its own credential and its own DP wire), `clean` (robot vacuums — Tuya data points) and
 * `display` (the T87Ax Smart Display — secure MQTT, never P2P, its own 8001-8006 param space).
 * They overlap in retail vocabulary but share no wire, no param space and no semantics.
 *
 * `display` is a line of its own for the second of those reasons rather than the first: without it,
 * every security capability detected by a NAME regex is attachable to a Smart Display — measured at six,
 * on a device that can answer for none of them because it speaks no P2P at all. A line holding one
 * capability still buys that, which is why the count is not the measure of whether a line is worth
 * declaring.
 *
 * `any` is for the handful of capabilities that are genuinely line-independent (device identity).
 */
export type ProductLine = "security" | "life" | "clean" | "print" | "display" | "any";

/**
 * A structural subset of a P2P frame. Deliberately NOT `import`ed from `p2p/*` — keeping it
 * structural avoids a model→p2p cycle, and the real `P2PFrame` is assignable to it. It is the
 * `p2p-frame` shape of {@link InboundSignal}.
 */
export interface CapabilityFrame {
  stationSn: string;
  commandId: number;
  channel: number;
  data?: Buffer;
  json?: { cmd?: number; payload?: unknown } & Record<string, unknown>;
}

/**
 * A transport-neutral **inbound signal** — the dual of {@link Command}. Device events reach the
 * SDK from three sources; a capability's {@link CapabilityModule.decodeEvent} normalizes ANY of
 * them into one semantic {@link CapabilityEvent} (`motion`, `doorbellPress`, `lockState`,
 * `ptzNotify`, …), so the consumer never has to know which transport delivered it:
 *  - `push` — an FCM notification, already normalized: a numeric `eventType` + optional thumbnail.
 *  - `p2p-frame` — a live P2P frame ({@link CapabilityFrame}).
 *  - `poll` — a cloud param that changed between polls (`paramType` from→to).
 */
export type InboundSignal =
  | {
      source: "push";
      eventType?: number;
      eventName?: string;
      deviceSn?: string;
      stationSn?: string;
      thumbnailUrl?: string;
      payload: Record<string, unknown>;
    }
  | ({ source: "p2p-frame" } & CapabilityFrame)
  | { source: "poll"; deviceSn: string; paramType: number; from?: string; to?: string; params: Record<number, string> }
  // Secure-MQTT realtime. `raw` is the untouched message; `frame` is present when the transport
  // recognised it as a DP TLV frame and unwrapped it, so a capability reads tags without owning any
  // framing (the inbound dual of emitting a `mqtt-dp` command and letting the router frame it).
  // `dpParams` is the same split for the line whose reports are a JSON data-point map rather than a
  // frame: the transport unwraps the envelope to `id → value` and the capability keeps the ids.
  | {
      source: "mqtt";
      deviceSn?: string;
      topic?: string;
      raw: unknown;
      frame?: DpInboundFrame;
      dpParams?: Record<number, string>;
    };

interface EventRefresh {
  member: string;
}

/**
 * A **declarative** inbound-event mapping — the dual of {@link DetectionSpec} for events. A
 * capability lists which push `eventType`s / poll `paramType`s belong to it and the semantic event
 * name each emits. The barrel folds all modules' mappings into one lookup index (built once), so
 * dispatch is a direct id→event lookup — no per-module decode code for the common case.
 */
export interface EventMapping {
  /** Which source this id comes from. (p2p-frame decoding uses {@link CapabilityModule.decodeEvent}.) */
  source: "push" | "poll";
  /** An exact id, or an inclusive `[lo, hi]` range (e.g. lock push events 257..771). */
  match: number | [number, number];
  /** The semantic SDK event name to emit (e.g. `"motion"`, `"doorbellPress"`, `"lockState"`). */
  emit: string;
  /** @internal Refresh one reflected member before emitting a valueless transition. */
  refresh?: EventRefresh;
  /**
   * Static fields folded into the emitted event payload — lets several ids emit the same event
   * name with a discriminator (e.g. battery pushes 6/7/11 all → `batteryAlert` with
   * `{state:"low"|"hot"|"full"}`). Merged OVER the signal's own fields, so a raw wire key can't
   * overwrite a discriminator.
   */
  payload?: Record<string, unknown>;
  /**
   * Fields DERIVED from the signal — for state a push carries under an opaque single-letter wire key.
   * Merged last, over both the raw body and {@link payload}.
   *
   * Same evidence bar as everything else: only map a key whose meaning is confirmed in the V6 app or a
   * capture. Return `{}` when this signal doesn't carry the field, so nothing is invented.
   */
  derive?(signal: InboundSignal): Record<string, unknown>;
  /**
   * Evidence that this device deals in the classification the id names, for an id whose presence in
   * the wire vocabulary does not prove it.
   *
   * The AI-detection ids are shared verbatim across the camera families, so the id space says what an
   * integer MEANS and never which units classify that way. A claim is how a mapping states the
   * evidence that separates them, and it narrows the DESCRIPTION only: {@link EventMapping} stays in
   * the dispatch index unclaimed, so a device that sends the push still gets the event. Under-reporting
   * what a device is expected to emit is recoverable; dropping an event it did emit is not.
   *
   * Every field must hold — the AND to {@link DetectionSpec}'s OR, because a claim rules a family OUT
   * rather than finding one more reason to say yes. A fact the context does not carry rules nothing
   * out: only evidence that positively contradicts the claim withdraws the event.
   */
  claim?: EventClaim;
}

/**
 * Evidence separating the families that share one inbound id.
 *
 * Both fields are optional and independent; an empty claim asserts nothing and is the same as none.
 */
export interface EventClaim {
  /**
   * The codecs whose devices issue the id. For an id drawn from a vocabulary one device family owns:
   * the AI-detection ids belong to the camera families, and a standalone sensor announces its own
   * motion under a different id entirely.
   */
  codecs?: readonly Codec[];
  /**
   * Member names whose INSTALLED getter is the evidence — the device reported the parameter behind
   * the classification, which is the same bar every typed read is held to.
   */
  reads?: readonly string[];
  /**
   * The topology the id belongs to: `true` for an id only a station's attached device sends, `false`
   * for one only a standalone unit sends. Compared against {@link AvailabilityContext.homeBaseAttached},
   * and ignored where that is absent.
   */
  homeBaseAttached?: boolean;
}

/**
 * A decoded inbound event a capability wants surfaced on the SDK. `event` is the EufyMega event
 * name (e.g. `"ptzNotify"`); `payload` is spread into the emitted object after `stationSn`.
 */
export interface CapabilityEvent {
  event: string;
  payload: Record<string, unknown>;
}

/**
 * Device state a capability recovered from an inbound realtime signal, expressed as `paramType →
 * value` in the device's own param namespace — the same shape the cloud record reports, so it flows
 * through `Device.applyParams` and reaches the typed {@link CapabilityModule.members} getters unchanged.
 *
 * Attribution stays with the signal: the transport already resolves which device a message came from,
 * and a capability re-deriving it from the payload would be a second, disagreeable source of truth.
 */
export interface DecodedState {
  params: Record<number, string>;
}

/**
 * Device context handed to {@link CapabilityModule.buildCommand} / {@link CapabilityModule.actions}
 * so a capability can resolve the right command **variant** for THIS device — the same evidence
 * `detection` keys on. Namespace-agnostic: `paramIds` holds security param ids OR vacuum Tuya DPs.
 */
/**
 * The device facts an availability / per-model gate reads. A truthful subset a {@link CloudRecord}
 * can populate at resolve time — before a live session exists — without fabricating the transport
 * fields ({@link CommandContext.channel}, {@link CommandContext.paramIds}) a real command carries.
 * Every {@link CommandContext} is one structurally, so a gate written against this runs unchanged on
 * the manifest path and the command path.
 */
export interface AvailabilityContext {
  /**
   * Resolved codec/family. Absent for a device outside the eufy device model entirely — the codecs are
   * the eufy transport families, so an ecosystem with its own backend has no truthful value here and
   * says so by omission rather than borrowing another family's. Every gate that reads it compares
   * against a specific codec, so an absent one matches none.
   */
  codec?: Codec;
  /** eufy DeviceType, when known. */
  deviceType?: number;
  /** Model / T-code, when known. */
  model?: string;
  /** API category string, when known. */
  category?: string;
  /** The device's resolved capability set, when known. */
  capabilities?: ReadonlySet<Capability>;
  /**
   * Whether the device is reachable over P2P — a live-transport fact, so it is absent on the pure
   * resolve-time (manifest) path and present only when a command context is built. Availability gates
   * that read it (a lock's P2P-only writes) are all `writeOnly`, which the manifest never lists, so
   * its absence there changes nothing.
   */
  hasP2p?: boolean;
  /**
   * The param_type / DP ids this device has actually reported. Present at bind time (a real
   * `CommandContext`); absent on the manifest path. DP-based availability gates should treat
   * `undefined` as an empty set — `ctx.paramIds?.has(dp) ?? false`.
   */
  paramIds?: ReadonlySet<number>;
  /**
   * Whether the device hangs off a HomeBase (a `parent_sn` other than its own) rather than standing
   * alone. A DEVICE fact, not a transport one — the same class of routing evidence as {@link hasP2p} —
   * which is why it sits here rather than on {@link CommandContext}: it is as true of a described
   * device as of a commanded one. The `rtsp` capability gates on it because a station serves an
   * attached camera's stream itself and ignores that camera's authentication setting, so the write
   * cannot do what its name promises there.
   */
  homeBaseAttached?: boolean;
}

export interface CommandContext extends AvailabilityContext {
  /** Device channel (0 for standalone, `device_channel` on a HomeBase). */
  channel: number;
  /** eufy DeviceType, when known. */
  deviceType?: number;
  /** Model / T-code, when known. */
  model?: string;
  /**
   * API category string — e.g. `"eufy_home"`, `"eufy_home_tuya"`, `"eufy_security"`. Primary
   * transport discriminator for the clean line: `"eufy_home_tuya"` = ThingClips/Tuya Cloud, not
   * Anker AIoT MQTT. Absent in unit-test contexts that build a minimal context without a real API.
   */
  category?: string;
  /** Full device serial number, when known. */
  serial?: string;
  /** Display name, when known — sourced from the device record by the facade (for `info`). */
  name?: string;
  /**
   * Firmware (main software) version — the device record's `main_sw_version`, the same field the v6
   * app maps to its `firmware_main_version` label. `undefined` when the record doesn't carry it.
   */
  firmwareVersion?: string;
  /**
   * Hardware version — the device record's `main_hw_version` (app label `hardware_version`).
   * `undefined` when the record doesn't carry it.
   */
  hardwareVersion?: string;
  /** Secondary/sub firmware version — the record's `sec_sw_version` (app label `firmware_sub_version`). */
  firmwareSubVersion?: string;
  /** Wi-Fi MAC address — the record's `wifi_mac` (app label `mac_address`). */
  macAddress?: string;
  /** Firmware-update-available flag — the record's `needUpdate`. */
  updateAvailable?: boolean;
  /** The param_type / DP ids this device has actually reported (evidence for variant selection). */
  paramIds: ReadonlySet<number>;
  /**
   * The capability set the device was RESOLVED to have (from `resolveDevice`: curated row +
   * codec baseline + per-module detection over the full, fresh record). `buildCommand` gates on
   * this so the authorization matches exactly what `device.has(cap)` / `buildActions` saw — never a
   * weaker re-detection from a partial context. Omit only in unit tests that pass evidence directly.
   */
  capabilities?: ReadonlySet<Capability>;
  /**
   * The lock owner's account id — the identity a lock command is authenticated against. Present on
   * lock-family devices; absent elsewhere.
   */
  adminUserId?: string;
  /** The acting member's short id (`member.short_user_id`, hex, e.g. `"0003"`) — the lock cmd `A5` field. */
  shortUserId?: string;
  /**
   * The acting name a command attributes itself to — the lock cmd acting-username `A4` field, and the
   * `user_name` of the guard-mode and HomeBase-alarm writes. The logged-in account's display name
   * (email local-part) unless the client pins a different label for it.
   */
  accountName?: string;
  /**
   * Whether the device has a usable P2P endpoint (a non-empty `p2p_did`). A HomeBase-attached lock
   * (T8531) is P2P-reachable; a standalone garage/lock (T85D0, `p2p_did:""`) is MQTT-only. The lock
   * capability uses this to route lock/unlock to P2P vs. reject with a clear MQTT-not-wired error.
   */
  hasP2p?: boolean;
  /**
   * Parsed `get_product_data_point` catalog for this device's SKU — present for vacuum/mower devices,
   * absent for all other codecs. Capabilities use it for per-model feature-availability and value-range
   * data (e.g. which suction levels DP 158 admits). Absent means "catalog not fetched" — fall back to
   * static defaults rather than treating the device as incapable.
   */
  dpCatalog?: DpCatalog;
}

/**
 * The **loose base** for a capability's bound action object — a bag of async methods. Each module
 * declares its own precise, JSDoc'd alias (e.g. `PtzActions`, `CameraActions`) and returns THAT
 * from `actions()`; those aliases are what the fluent `dev.<cap>()` accessors expose (assembled into
 * `DeviceActionMap` in the barrel). This base only exists so `CapabilityModule.actions` has a common
 * return type that every concrete alias is assignable to. Control actions resolve to `void` (they
 * dispatch a {@link Command}); media actions resolve to data — a `Promise` of a still/stream/buffer,
 * or a synchronous `AsyncIterable` (continuous fragment recording), so the return type is `any`.
 *
 * This models the common case: a **methods-bag** (control capabilities). A READ-ONLY *data*
 * capability (`info`, returning a plain `DeviceInfo`) is the deliberate exception — it asserts its
 * result to this type locally (see `info.ts`) rather than weaken this base for every module. The
 * consumer-facing types stay precise via `DeviceActionMap` (`ptz: PtzActions`,
 * `info: DeviceInfo`, …), from which the fluent `dev.<cap>()` accessors are derived.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CapabilityActions = Record<string, (...args: any[]) => any>;

/**
 * Live-state accessor handed to {@link CapabilityModule.actions} so a capability can expose **typed
 * read getters** on its fluent object (`dev.battery()?.level: number`) alongside its write methods —
 * closing the read/write asymmetry (writes are typed+fluent; a raw `getProperty("battery")?.value` is
 * the loose `ParamValue`). Returns the current property value for a property NAME, or
 * `undefined` if never observed. The facade wires it to the device's live state, so a getter built
 * once stays current as realtime/poll updates land. The `readNum`/`readBool`/`readStr` extractors in
 * `./access.ts` guard the runtime type rather than lie-cast.
 */
export type CapabilityStateReader = (name: string) => PropertyValue | undefined;

/**
 * One argument a described action accepts, in the same value vocabulary the reads use ({@link ValueKind}).
 *
 * A numeric range belongs here as `min`/`max`/`step`, and must be the SAME constant the action clamps
 * with: a retyped range is a drift bug no test can catch, since both copies stay individually valid.
 *
 * `values`/`labels` publish a fixed option set for an argument whose domain the schema cannot otherwise
 * reach. A `kind: "enum"` argument normally omits both: it belongs to a control whose property already
 * publishes its `enumValues`, and declaring the same set twice can only drift from it.
 */
export interface ActionArgSpec {
  name: string;
  kind: ValueKind;
  optional?: boolean;
  min?: number;
  max?: number;
  step?: number;
  values?: readonly (string | number)[];
  labels?: Readonly<Record<string, string>>;
  description?: string;
}

/**
 * What one action on `dev.<cap>()` accepts and what it changes — the write-side counterpart to a
 * member's read getter.
 *
 * Carries no name: it is attached to the method itself (`describedAction` in `./access.ts`), so the
 * action's own key is its name and a rename cannot leave a description behind pointing at nothing.
 *
 * **A spec never gates anything.** {@link CapabilityModule.actions} alone decides which methods exist;
 * an undescribed action stays fully callable, it just cannot be offered automatically.
 *
 * **Describe the method that TAKES the value, not its aliases.** `on()`/`off()` drive the same wire as
 * `set(v)`, and describing all three would render three controls for one state.
 *
 * **A stateful action's {@link reflects} read is its evidence gate.** Each described write works exactly
 * on the devices whose reflected read is installed — the read's backing param and the write's own
 * precondition are the same evidence (`motion.setDetection` needs the PIR switch a standalone sensor
 * never reports; `setHumanOnlyAtNight` and `setLoiteringDetection` each need the id their read gates on).
 * So a description is a promise the method works wherever its read answers, and an action whose read is
 * absent on a device is not offerable there.
 *
 * Describe only a wire confirmed on real hardware, for the same reason an unverified write rejects
 * rather than guesses: a described control that always fails turns "a present method means a verified
 * wire" into "a present description means nothing".
 */
export interface ActionSpec {
  form: "momentary" | "stateful";
  /** For a stateful action, the read accessor on the same capability whose value it changes. */
  reflects?: string;
  args?: readonly ActionArgSpec[];
  description?: string;
}

/**
 * A capability module: property schema + detection + inbound decode + outbound commands. Written
 * once, reused by every device that lists the capability.
 */
export interface CapabilityModule {
  capability: Capability;
  /**
   * Properties this capability contributes.
   *
   * A module with a {@link members} table sets this to `propertiesOf(ITS_MEMBERS)` rather than writing
   * it out: the schema is derived from the same declaration as the getters and setters, and is
   * materialised here so every existing consumer keeps reading it the same way.
   */
  properties: PropertySpec[];
  /** Human description for docs. */
  description?: string;
  /** How devices are detected as having this capability. Absent = only via codec baseline / registry. */
  detection?: DetectionSpec;
  /**
   * The product line this capability belongs to; defaults to `security` (the bulk of the catalogue).
   *
   * Checked BEFORE any detection evidence, so a capability can never land on a device from another
   * line. This matters because the detection fields are OR-ed and several capabilities are found by
   * NAME alone — eufy's retail vocabulary collides across ecosystems, so a light called "Outdoor
   * Spotlights" or a strip named for a water effect otherwise picks up a camera or leak capability
   * whose wire it does not speak.
   */
  line?: ProductLine;
  /**
   * The capability belongs to whichever device OWNS the group, so a device that hangs off a parent
   * station must not claim it — even when a curated row grants it or the device mirrors the param.
   *
   * Guard mode is the case that grounds this: a standalone SoloCam/Indoor cam owns its own mode (read
   * live: `armingMode` answers on a standalone T8170/T8171/T8410), but behind a HomeBase the hub owns
   * it and the app shows it there, not per camera — an attached T8170 reports no mode at all. Applied
   * AFTER the three tiers are unioned (see `resolveDevice`), because the point is to withhold a
   * control the device cannot answer for however it was granted.
   */
  ownedByStation?: boolean;
  /**
   * Declarative inbound-event mappings (push eventType / poll param → semantic event name). The
   * common case: pure data, no code. The barrel indexes these for direct lookup.
   */
  events?: EventMapping[];
  /**
   * Semantic event names this capability emits from {@link decodeEvent}, which the flat {@link events}
   * table cannot express — a frame the module parses itself has no id to list there.
   *
   * Declared so the published manifest can state what a capability emits without a caller subscribing
   * blind: the manifest's event list is this union'd with the table's own `emit` names. A capability
   * whose events all come from the table omits it; `decode-event.spec.ts` locks the union against a
   * hardcoded list, since the typed event map erases at build and cannot keep this honest.
   */
  emits?: readonly string[];
  /**
   * Semantic events that describe a **state**, and the payload field holding it — so a state that
   * several transports report is announced once per real change instead of once per transport.
   *
   * One physical change can reach the SDK on more than one path: an entry sensor's contact arrives
   * as a station notify ~2 s before the same value arrives as an FCM push. Both are real, but they
   * describe one change. Listing the event here makes the emitter edge-triggered on that field: a
   * value equal to the last one announced for that device is suppressed.
   *
   * Declare this ONLY for events carrying a settled state. An event that is a **pulse** — motion,
   * a doorbell press — must be omitted: consecutive pulses are identical by nature and deduping them
   * would drop real detections.
   *
   * Edge-triggering is applied to realtime sources only. A poll still re-announces an unchanged
   * state, so a missed realtime frame is re-synchronised rather than left waiting for the state to
   * change again.
   */
  stateEvents?: { event: string; field: string }[];
  /**
   * Escape hatch for inbound signals a flat {@link EventMapping} table can't express — e.g. parsing
   * a binary P2P frame (the pan-tilt position stream). Return the semantic {@link CapabilityEvent}
   * or `null`. Simple capabilities use only `events` and omit this.
   */
  decodeEvent?(signal: InboundSignal): CapabilityEvent | null;
  /**
   * Recover device STATE from an inbound signal, as wire ids in this device's own param namespace —
   * the input to `Device.applyParams`, so a realtime-only line's values reach the same
   * {@link CapabilityModule.members} getters a pollable cloud param would.
   *
   * Separate from {@link CapabilityModule.decodeEvent} because the two answer different questions: a
   * report that repeats the current state carries no event worth emitting but must still refresh the
   * readable state. A module that decodes both shares one private parser between the hooks.
   */
  decodeState?(signal: InboundSignal): DecodedState | null;
  /**
   * Commands to send once this device's realtime channel is up — e.g. a state-snapshot request, for a
   * line whose state is pushed on change with no periodic heartbeat, so the typed reads are populated
   * at connect instead of only after the first write. Best-effort: a failure is reported, never fatal.
   */
  realtimeInit?(ctx: CommandContext): Command[];
  /**
   * Resolve a semantic action into a transport-neutral {@link Command} for THIS device, or
   * `undefined` if this module doesn't handle `(action)`. `action` is a capability-local verb
   * (e.g. `"on"`, `"off"`, `"setBrightness"`, `"rotate"`), NOT a param id. Uses `ctx` to
   * pick the right variant. This is where per-device variance lives — once, in the module.
   */
  buildCommand?(action: string, value: boolean | number | string, ctx: CommandContext): Command | undefined;
  /**
   * The object of bound action methods exposed on a device that HAS this capability
   * (e.g. `device.light()` → `{on, off, setBrightness}`). Control actions resolve a
   * {@link Command} and emit it through `sink`; media actions (snapshot/live/record) delegate to
   * the optional `media` provider (absent on a model object not bound to a live client).
   *
   * Every injected provider here names a **technical job**, never the capability that happens to be
   * its first caller: `media` is shared by every media-capable device, and `ff09Settings` is named for
   * the frame family it reads, so any device driven by that frame can use it. That is the rule, not a
   * convention — a provider that cannot be named without saying "lock" or "vacuum" is a provider split
   * in the wrong place.
   *
   * `ff09Settings` exists as its own boundary because `GET_SETTINGS` is a request/reply query
   * (decrypt + parse + pick P2P-vs-MQTT), and neither `CommandSink` (write-only, `Promise<void>`) nor
   * `MediaProvider.p2pQuery` (P2P-only, raw passthrough, no decrypt) fits it. A further `ff09` setting
   * needing a live read is one more method on {@link Ff09SettingsReader}; a genuinely different wire
   * family is its own provider, not another parameter bolted on next to this one.
   */
  actions?(deps: MemberDeps): CapabilityActions;
  /**
   * The capability's surface, one entry per feature — the schema, the getters, the setters, the intent
   * routes and the descriptions all derived from it. See `./members.ts`.
   *
   * A feature is spelled ONCE: {@link properties} is `propertiesOf(X_MEMBERS)`, never a second list.
   *
   * Absent only on a capability with no surface to bind: pure detection (`video`, `snapshot`), or one
   * whose object is a projection rather than device params (`info`).
   */
  members?: Members;
}

/**
 * Thrown when a control is requested on a device that doesn't support it — instead of silently
 * sending a command into the void (the eufy P2P write path is fire-and-forget, so an unsupported
 * command otherwise looks like success). Raised by `setProperty` / action paths when no capability
 * module produces a command for the (device, action).
 */
export class CapabilityNotSupportedError extends Error {
  constructor(
    readonly sn: string,
    readonly action: string,
  ) {
    super(`device ${sn} does not support '${action}'`);
    this.name = "CapabilityNotSupportedError";
  }
}
