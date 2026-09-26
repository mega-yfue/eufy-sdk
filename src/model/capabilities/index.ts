/**
 * Capability-module barrel — collects every `capabilities/<cap>.ts` module and exposes the
 * fleet-wide helpers (`getCapabilityModule`, `mergeProperties`, `detectCapabilities`,
 * `decodeFrame`, `buildCommand`). Adding a capability = a new file + one import line here.
 *
 * @module model/capabilities
 */

import type { Capability, CloudRecord, Codec, PropertyChange, PropertySpec } from "../types.js";
import {
  bindMembers,
  hasRequiredCapabilities,
  installs,
  memberWrite,
  propertiesOf,
  type MemberDeps,
} from "./members.js";
import { camelCase } from "./access.js";
import { describeBound, type CapabilityDescriptor } from "./manifest.js";
import type {
  CapabilityModule,
  EventMapping,
  CapabilityEvent,
  DecodedState,
  ProductLine,
  InboundSignal,
  CapabilityActions,
  CommandContext,
  AvailabilityContext,
} from "./types.js";
import type { Command } from "../../core/contracts.js";

import { VIDEO } from "./video.js";
import { RTSP } from "./rtsp.js";
import { SNAPSHOT } from "./snapshot.js";
import { MOTION } from "./motion.js";
import { PERSON_DETECTION } from "./person-detection.js";
import { BATTERY } from "./battery.js";
export { RtspRecordingMode, type RtspRecordingModeValue, type RtspAuthScheme } from "./rtsp.js";
export { EntryAlarmTone, type EntryAlarmToneValue } from "./contact.js";
export { SirenVolume, type SirenVolumeValue, SirenAlarmDuration, type SirenAlarmDurationValue } from "./siren.js";
/**
 * Ask what a bound capability can be told to change but can never report back, and what it reports without
 * that value reflecting its own setter.
 */
export { unobservableMembers, unreflectedMembers } from "./members.js";
export {
  Watermark,
  type WatermarkValue,
  NightVision,
  type NightVisionValue,
  RecordingQuality,
  type RecordingQualityName,
  RECORDING_QUALITY_TIERS,
  StreamingQuality,
  type StreamingQualityName,
  STREAMING_QUALITY_TIERS,
  resolveStreamingQuality,
  resolveStreamingQualityTier,
  resolveRecordingQuality,
  resolveRecordingQualityValue,
  resolveRecordingQualityTier,
} from "./camera.js";
export {
  WorkingMode,
  PowerSource,
  cameraPowerTier,
  resolveWorkingMode,
  resolveWorkingModeValue,
  WORKING_MODE_MAPS,
  type WorkingModeName,
  type PowerSourceName,
} from "./battery.js";
import { LIGHT } from "./light.js";
import { SMART_LIGHT } from "./smart-light.js";
import { PTZ } from "./ptz.js";
import { CAMERA } from "./camera.js";
import { AUDIO } from "./audio.js";
import { DOORBELL } from "./doorbell.js";
import { CONTACT } from "./contact.js";
import { LEAK } from "./leak.js";
import { SMOKE } from "./smoke.js";
import { CO } from "./co.js";
import { SIREN } from "./siren.js";
import { LOCK } from "./lock.js";
import { KEYPAD } from "./keypad.js";
import { ARMING } from "./arming.js";
import { STORAGE } from "./storage.js";
import { VACUUM_CLEAN } from "./vacuum-clean.js";
import { VACUUM_DOCK } from "./vacuum-dock.js";
import { SUCTION } from "./suction.js";
export { type DpCatalog, EMPTY_DP_CATALOG } from "./dp-catalog.js";
import { DISPLAY } from "./display.js";
import { LOCATE } from "./locate.js";
import { INFO } from "./info.js";

// Per-capability typed action objects. Type-only — no runtime coupling. These feed the
// DeviceActionMap projection below (the single place a capability's accessor type is registered).
import type { PtzActions } from "./ptz.js";
import type { LightActions } from "./light.js";
import type { RgbColor, SmartLightActions } from "./smart-light.js";
import type { CameraActions } from "./camera.js";
import type { AudioActions } from "./audio.js";
import type { BatteryActions } from "./battery.js";
import type { LockActions } from "./lock.js";
import type { SirenActions } from "./siren.js";
import type { ArmingActions } from "./arming.js";
import type { DoorbellActions } from "./doorbell.js";
import type { MotionActions } from "./motion.js";
import type { ContactActions } from "./contact.js";
import type { LeakActions } from "./leak.js";
import type { SmokeActions } from "./smoke.js";
import type { CoActions } from "./co.js";
import type { KeypadActions } from "./keypad.js";
import type { RtspActions } from "./rtsp.js";
import type { VacuumCleanActions } from "./vacuum-clean.js";
import type { VacuumDockActions } from "./vacuum-dock.js";
import type { DisplayActions } from "./display.js";
import type { SuctionActions } from "./suction.js";
import type { LocateActions } from "./locate.js";
import type { DeviceInfo } from "./info.js";

/** Every capability module, in a stable order (governs `mergeProperties`/`buildCommand` precedence). */
const MODULES: CapabilityModule[] = [
  VIDEO,
  RTSP,
  SNAPSHOT,
  MOTION,
  PERSON_DETECTION,
  BATTERY,
  LIGHT,
  SMART_LIGHT,
  PTZ,
  CAMERA,
  AUDIO,
  DOORBELL,
  CONTACT,
  LEAK,
  SMOKE,
  CO,
  SIREN,
  LOCK,
  KEYPAD,
  ARMING,
  STORAGE,
  VACUUM_CLEAN,
  VACUUM_DOCK,
  SUCTION,
  LOCATE,
  DISPLAY,
  INFO,
];

const BY_CAP = new Map<Capability, CapabilityModule>(MODULES.map((m) => [m.capability, m]));

/**
 * Look up the {@link CapabilityModule} for a capability, or `undefined` if none is registered.
 * @internal
 */
export function getCapabilityModule(cap: Capability): CapabilityModule | undefined {
  return BY_CAP.get(cap);
}

/**
 * The complete capability → module map. Every member of the {@link Capability} union has an entry.
 * @internal
 */
export const CAPABILITY_MODULES = Object.fromEntries(MODULES.map((m) => [m.capability, m])) as Record<
  Capability,
  CapabilityModule
>;

/**
 * Every param these capabilities declare before any gate — the set a device's schema is a subset of.
 *
 * A param in here that a device's schema does NOT carry is one a gate withheld: the capability resolved,
 * and its member decided the read does not describe this device — a cell reading on a mains model, a mode
 * a family does not carry. Read-aliases count, since a member reads them under its own name.
 * @internal
 */
export function claimedParams(caps: Capability[]): Set<number> {
  const claimed = new Set<number>();
  for (const cap of caps)
    for (const spec of getCapabilityModule(cap)?.properties ?? []) {
      claimed.add(spec.paramType);
      for (const alias of spec.readAliases ?? []) claimed.add(alias.paramType);
    }
  return claimed;
}

/**
 * Merge the property schemas of several capabilities into one flat, de-duplicated list.
 *
 * Properties are de-duplicated by `PropertySpec.name` with **first-wins** semantics, so the
 * caller controls precedence through the order of `caps`. Capabilities with no registered module
 * are skipped.
 *
 * @param caps - capabilities to combine (order = precedence).
 * @returns the union of all contributed `PropertySpec`s, unique by `name`.
 * @internal
 */
export function mergeProperties(caps: Capability[], ctx?: AvailabilityContext): PropertySpec[] {
  const seen = new Set<string>();
  const merged: PropertySpec[] = [];
  for (const cap of caps) {
    const module = getCapabilityModule(cap);
    if (!module) continue;
    // With a device context, re-derive the property list from the SAME `propertiesOf` the module's
    // static list comes from — now applying that device's `available` gates and per-model enums. This
    // keeps one interpreter of the members table (getter, setter and manifest agree); without a
    // context the precomputed static list is used unchanged.
    const props = ctx && module.members ? propertiesOf(module.members, ctx) : module.properties;
    for (const spec of props) {
      if (seen.has(spec.name)) continue;
      seen.add(spec.name);
      merged.push(spec);
    }
  }
  return merged;
}

/**
 * Build the lowercase haystack used for regex hints: model code, category and any free-text name
 * fields that may live on the (loosely-typed) cloud record. Tolerates missing fields.
 */
function hintHaystack(rec: CloudRecord): string {
  const parts: Array<string | undefined> = [rec.model, rec.category];
  const loose = rec as Readonly<Record<string, unknown>>;
  for (const key of ["name", "device_name", "alias", "product_name"]) {
    const v = loose[key];
    if (typeof v === "string") parts.push(v);
  }
  return parts.filter((p): p is string => typeof p === "string").join(" ");
}

/**
 * Which product line each codec belongs to — the device-side half of the line partition enforced in
 * {@link detectCapabilities}. Exhaustive over {@link Codec} on purpose: a new codec must state its
 * line rather than silently defaulting into the security ecosystem.
 *
 * `display` is its own line, not a corner of `security` — see {@link ProductLine} for why one
 * capability still earns one, and `param-namespace.ts` for the matching split of the id space.
 */
const CODEC_LINE: Record<Codec, ProductLine> = {
  station: "security",
  camera: "security",
  sensor: "security",
  lock: "security",
  keypad: "security",
  vacuum: "clean",
  mower: "clean",
  light: "life",
  printer: "print",
  display: "display",
};

/**
 * Whether a capability may appear on a device of this codec at all — the line partition.
 *
 * Applied before any detection evidence is examined, because the evidence fields are OR-ed and
 * several capabilities are detected by NAME alone. eufy's retail vocabulary collides across
 * ecosystems ("Outdoor Spotlights" is a smart light, not a camera spotlight), so without this a
 * name match hands a device a capability whose wire it cannot speak.
 */
function lineAllows(module: CapabilityModule, codec: Codec | undefined): boolean {
  const line = module.line ?? "security";
  return line === "any" || (codec !== undefined && line === CODEC_LINE[codec]);
}

/**
 * Detect the capabilities a device exposes from its cloud record and codec. A capability is added
 * if its product line matches the codec's ({@link lineAllows}, checked first) AND ANY of its
 * {@link import("./types").DetectionSpec} fields match:
 *  - an `evidenceParams` id is present in `rec.params` keys,
 *  - `deviceTypes` includes `rec.deviceType`,
 *  - a `modelHints` regex matches the model/category/name haystack,
 *  - `codecs` includes `codec`,
 *  - `detect(rec, codec)` returns true.
 *
 * An absent `codec` belongs to no line, so only the line-agnostic capabilities can match — the truthful
 * answer for a device outside the eufy families entirely. Never throws. Returns a de-duplicated array.
 * @internal
 */
export function detectCapabilities(rec: CloudRecord, codec?: Codec): Capability[] {
  const found = new Set<Capability>();

  // Set of reported param_type ids (keys arrive as strings on rec.params).
  const paramIds = new Set<number>();
  const params = rec?.params;
  if (params && typeof params === "object") {
    for (const rawKey of Object.keys(params)) {
      const pt = Number(rawKey);
      if (Number.isFinite(pt)) paramIds.add(pt);
    }
  }

  const haystack = hintHaystack(rec);

  for (const m of MODULES) {
    const d = m.detection;
    if (!d) continue;
    if (!lineAllows(m, codec)) continue;
    let matched = false;

    if (d.evidenceParams) {
      matched = d.evidenceParams.some((p) => paramIds.has(p));
    }
    if (!matched && d.deviceTypes && rec.deviceType !== undefined) {
      matched = d.deviceTypes.includes(rec.deviceType);
    }
    if (!matched && d.modelHints && haystack.length > 0) {
      matched = d.modelHints.some((re) => re.test(haystack));
    }
    if (!matched && d.codecs && codec !== undefined) {
      matched = d.codecs.includes(codec);
    }
    if (!matched && d.detect && codec !== undefined) {
      try {
        matched = d.detect(rec, codec) === true;
      } catch {
        matched = false;
      }
    }

    if (matched) found.add(m.capability);
  }

  return [...found];
}

/**
 * The baseline capabilities a codec grants every device of that family — derived from the modules
 * that declare the codec in their {@link import("./types").DetectionSpec} `codecs`. Each capability
 * file owns "I am part of codec X's baseline", so the codec→caps table is a projection of the modules,
 * not a second source of truth.
 *
 * @param codec the resolved codec.
 * @returns a fresh array of baseline capabilities for that codec (possibly empty).
 * @internal
 */
export function codecBaseline(codec: Codec): Capability[] {
  return MODULES.filter((m) => m.detection?.codecs?.includes(codec)).map((m) => m.capability);
}

/**
 * The capabilities only the device that OWNS a group may expose, folded from every module's
 * {@link CapabilityModule.ownedByStation}.
 *
 * A barrel projection like {@link codecBaseline}: it lets `resolveDevice` withhold a group-owned
 * control from an attached device without naming a capability, so the next one that turns out to live
 * on the hub is a flag on its own module rather than another branch in the resolver.
 *
 * @internal
 */
export const STATION_OWNED_CAPABILITIES: ReadonlySet<Capability> = new Set(
  MODULES.filter((m) => m.ownedByStation).map((m) => m.capability),
);

/** @internal */
interface ResolvedEventRefresh {
  param: number;
  property: string;
  timeoutMs: number;
}

/**
 * An index hit: the semantic event name, the capability that claims the id, and any static payload
 * the mapping attached. The capability is what disambiguates a shared id.
 * @internal
 */
export type EventHit = Pick<EventMapping, "payload" | "derive"> & {
  emit: string;
  capability: Capability;
  refresh?: ResolvedEventRefresh;
};
type EventIndex = { exact: Map<number, EventHit[]>; ranges: Array<{ lo: number; hi: number } & EventHit> };

/**
 * Build the inbound-event index from a module list: keyed by source ("push" | "poll"), then exact id →
 * the candidate hits, plus a small list of `[lo,hi]` ranges. Dispatch is a direct lookup — no loop over
 * modules, no per-module decode code for the common case.
 *
 * Each id maps to a LIST because push ids are namespaced **per device family**, not globally: the same
 * integer means different things on different hardware (`SmartDropPushEvent.TAMPERED_WARNING` and
 * `CusPushEvent.ALARM` are both 10; SmartDrop's battery ids 6/7/11 are `CusPushEvent`'s
 * BATTERY_LOW/HOT/FULL). With one entry per id, whichever module happens to be registered last wins for
 * every device — turning a tamper alert into a battery alert. Candidates are resolved against the target
 * device's capabilities at dispatch time ({@link CapabilityModule.decodeEvent}).
 *
 * Parameterised over the modules rather than closing over the registry; the real index is built once
 * from every registered capability module.
 * @internal
 */
export function buildEventIndex(modules: readonly CapabilityModule[]): Record<"push" | "poll", EventIndex> {
  const mk = (): EventIndex => ({ exact: new Map(), ranges: [] });
  const idx: Record<"push" | "poll", EventIndex> = { push: mk(), poll: mk() };
  for (const m of modules) {
    for (const e of m.events ?? []) {
      const declaredMember = e.refresh && m.members?.[e.refresh.member];
      const refresh =
        declaredMember &&
        "param" in declaredMember &&
        typeof declaredMember.param === "number" &&
        declaredMember.observation?.event === e.emit
          ? {
              param: declaredMember.param,
              property: declaredMember.property ?? e.refresh!.member,
              timeoutMs: declaredMember.observation.timeoutMs,
            }
          : undefined;
      if (e.refresh && !refresh) {
        throw new TypeError(`${m.capability}.${e.emit} refreshes an unknown readable member ${e.refresh.member}`);
      }
      const hit = { emit: e.emit, capability: m.capability, payload: e.payload, derive: e.derive, refresh };
      if (Array.isArray(e.match)) idx[e.source].ranges.push({ lo: e.match[0], hi: e.match[1], ...hit });
      else {
        const at = idx[e.source].exact;
        const existing = at.get(e.match);
        if (existing) existing.push(hit);
        else at.set(e.match, [hit]);
      }
    }
  }
  return idx;
}

const EVENT_INDEX: Record<"push" | "poll", EventIndex> = buildEventIndex(MODULES);

/**
 * Semantic event name → the payload field carrying its state, folded from every module's
 * {@link CapabilityModule.stateEvents}.
 *
 * A barrel projection like the action/event maps: it lets the facade be edge-triggered on state
 * without naming a capability. An event ABSENT here is a pulse and is always announced.
 */
export const STATE_EVENT_FIELDS: Readonly<Record<string, string>> = Object.fromEntries(
  MODULES.flatMap((m) => (m.stateEvents ?? []).map((s) => [s.event, s.field] as const)),
);

/**
 * Every mapping registered for a push/poll id — usually one, more when families share the integer.
 * Exact matches win over ranges (a range is the coarse fallback for a block like the lock's 257..771).
 */
function lookupEvents(source: "push" | "poll", id: number | undefined): EventHit[] {
  if (typeof id !== "number") return [];
  const ix = EVENT_INDEX[source];
  const exact = ix.exact.get(id);
  if (exact?.length) return exact;
  return ix.ranges.filter((r) => id >= r.lo && id <= r.hi);
}

/**
 * Pick the mapping that belongs to THIS device when several families claim the same id.
 *
 * With one candidate there is nothing to resolve — emit it, so a device whose capabilities can't be
 * resolved still gets the event. With several, the device's own capability set decides; if
 * that isn't known, the SDK emits NOTHING rather than guessing, because naming the wrong event (a
 * tamper reported as a battery alert) is worse than staying silent about it.
 */
export function resolveHits(hits: EventHit[], capabilities?: ReadonlySet<Capability>): EventHit[] {
  if (hits.length <= 1) return hits;
  if (!capabilities) return [];
  return hits.filter((h) => capabilities.has(h.capability));
}

type DecodedCapabilityEvent = CapabilityEvent & { refresh?: ResolvedEventRefresh };

/**
 * Normalize an inbound {@link InboundSignal} (push / P2P frame / poll) into the semantic
 * {@link CapabilityEvent}s to emit. Push/poll resolve via the declarative index (pure data);
 * P2P frames run the modules' {@link CapabilityModule.decodeEvent} escape hatch (binary parsing).
 * A `deviceSn`/`stationSn` from the signal is folded into each payload.
 *
 * `capabilities`, when supplied, has a different job per source:
 *
 *  - **p2p-frame / mqtt** — an allow-list over the escape-hatch decoders, mirroring `buildCommand`'s
 *    gate on the outbound side. A frame reusing a shared command id (e.g. 1700
 *    `CMD_DOORBELL_SET_PAYLOAD`) would otherwise be fed to every module's binary parser and could
 *    fabricate a semantic event on hardware lacking the capability that owns that parser.
 *  - **push / poll** — a tie-breaker only, between families claiming the SAME id (see
 *    the shared event index). An id with one claimant emits regardless of capabilities: detection is
 *    evidence-based and can under-report, so gating every push on it would silently drop real events.
 *    A contested id with no capability context emits nothing rather than a guess.
 *
 * A mapping's static payload is spread LAST, so the raw push body cannot overwrite it. Push payloads
 * carry short, generic keys straight off the wire, and a discriminator like `phase` is the only thing
 * separating a fired alarm from a countdown — letting the wire win there would silently change an
 * event's meaning.
 *
 * Omitted (undefined) = run all escape-hatch modules and accept any single-claimant id.
 * @internal
 */
export function decodeEvent(signal: InboundSignal, capabilities?: ReadonlySet<Capability>): DecodedCapabilityEvent[] {
  if (signal.source === "push") {
    return resolveHits(lookupEvents("push", signal.eventType), capabilities).map((hit) => ({
      event: hit.emit,
      refresh: hit.refresh,
      payload: {
        deviceSn: signal.deviceSn,
        stationSn: signal.stationSn,
        eventType: signal.eventType,
        thumbnailUrl: signal.thumbnailUrl,
        ...signal.payload,
        ...hit.payload,
        ...hit.derive?.(signal),
      },
    }));
  }
  if (signal.source === "poll") {
    return resolveHits(lookupEvents("poll", signal.paramType), capabilities).map((hit) => ({
      event: hit.emit,
      refresh: hit.refresh,
      payload: {
        deviceSn: signal.deviceSn,
        paramType: signal.paramType,
        from: signal.from,
        to: signal.to,
        ...hit.payload,
        ...hit.derive?.(signal),
      },
    }));
  }
  // p2p-frame / mqtt → escape-hatch decoders on the modules (binary parsing, bespoke payloads).
  // (No module maps `mqtt` yet — the Tuya-DP realtime format isn't reversed; the branch is ready.)
  const scope = signal.source === "p2p-frame" ? { stationSn: signal.stationSn } : { deviceSn: signal.deviceSn };
  const events: DecodedCapabilityEvent[] = [];
  for (const m of MODULES) {
    if (!m.decodeEvent) continue;
    if (capabilities && !capabilities.has(m.capability)) continue; // gate on the device's caps
    const ev = m.decodeEvent(signal);
    if (ev) events.push({ event: ev.event, payload: { ...scope, ...ev.payload } });
  }
  return events;
}

/** Whether any of these capabilities has realtime-init commands to send — checked before the caller
 * pays for a {@link CommandContext}, which costs a device-param fetch. */
export function needsRealtimeInit(capabilities: ReadonlySet<Capability>): boolean {
  return MODULES.some((m) => m.realtimeInit && capabilities.has(m.capability));
}

/**
 * The commands to send once a device's realtime channel is up, from every capability it has that asks
 * for one. Empty for a device whose state arrives without being asked.
 */
export function buildRealtimeInit(capabilities: ReadonlySet<Capability>, ctx: CommandContext): Command[] {
  const out: Command[] = [];
  for (const m of MODULES) {
    if (!m.realtimeInit || !capabilities.has(m.capability)) continue;
    out.push(...m.realtimeInit(ctx));
  }
  return out;
}

/**
 * Whether any of these capabilities feeds its readable state from realtime rather than from a pollable
 * cloud param — i.e. whether a device is worth waiting on before its reads are meaningful.
 */
export function hasRealtimeReads(capabilities: ReadonlySet<Capability>): boolean {
  return MODULES.some((m) => m.decodeState && capabilities.has(m.capability));
}

/**
 * Recover device state from an inbound signal — the state-side dual of {@link CapabilityModule.decodeEvent}. Gated by
 * the reporting device's capabilities exactly as events are, so one product line's decoder never runs
 * against another line's traffic. One entry per module that recognised the signal; a module that
 * decoded no fields is dropped.
 */
export function decodeState(signal: InboundSignal, capabilities?: ReadonlySet<Capability>): DecodedState[] {
  const out: DecodedState[] = [];
  for (const m of MODULES) {
    if (!m.decodeState) continue;
    if (capabilities && !capabilities.has(m.capability)) continue;
    const st = m.decodeState(signal);
    if (st && Object.keys(st.params).length) out.push(st);
  }
  return out;
}

/**
 * Resolve a semantic `action` into a transport-neutral {@link Command} for a device, using
 * {@link CommandContext} to pick the right variant. The first module that handles the action wins
 * (module order = precedence). `undefined` if no module has a recipe.
 * @internal
 */
export function buildCommand(
  action: string,
  value: boolean | number | string,
  ctx: CommandContext,
): Command | undefined {
  // Only modules whose capability the device actually HAS may produce a command — otherwise a
  // module (e.g. `light`) would happily build a spotlight command for a device with no spotlight,
  // and the fire-and-forget P2P write would silently no-op. Gate on the RESOLVED capability set
  // (`ctx.capabilities`) when the caller supplied it — that's the exact set `device.has(cap)` /
  // `buildActions` saw, computed from the full fresh record (category/name + fresh params). Only
  // when it's absent (unit tests that hand evidence directly) do we re-detect from the partial ctx;
  // that re-detect lacks category/name, so relying on it alone would reject name/category-only caps.
  const has =
    ctx.capabilities ??
    new Set(
      detectCapabilities(
        {
          deviceType: ctx.deviceType,
          model: ctx.model,
          params: Object.fromEntries([...ctx.paramIds].map((p) => [p, "1"])),
        },
        ctx.codec,
      ),
    );
  for (const m of MODULES) {
    if (!has.has(m.capability)) continue;
    const cmd = memberCommand(m, action, value, ctx) ?? m.buildCommand?.(action, value, ctx);
    if (cmd !== undefined) return cmd;
  }
  return undefined;
}

/**
 * Fields every semantic event carries — which device/station it came from. `decodeEvent` always
 * folds these in from the signal.
 */
export interface SemanticEventBase {
  /** Serial of the device the event is about (present for push/poll signals). */
  deviceSn?: string;
  /** Serial of the station that delivered it (present for P2P / HomeBase-relayed signals). */
  stationSn?: string;
}

/** A push-delivered semantic event (motion, doorbell, person, package, lock). */
export interface PushSemanticEvent extends SemanticEventBase {
  /** The raw FCM event-type code that produced this event. */
  eventType?: number;
  /** A thumbnail URL when the push carried one. */
  thumbnailUrl?: string;
}

/** A poll-delivered semantic event — a cloud param that changed between polls. */
export interface PollSemanticEvent extends SemanticEventBase {
  /** The param id that changed. */
  paramType?: number;
  /** Previous raw value. */
  from?: string;
  /** New raw value. */
  to?: string;
}

/**
 * The typed **event** surface, keyed by semantic event name → payload type. THE projection point
 * for events (the sibling of {@link DeviceActionMap}): a capability that emits a new event name adds
 * one line here. `EufyMega`'s typed `on`/`once`/`off`/`emit` overloads are derived from this map, so
 * `eufy.on("motion", e => e.deviceSn)` autocompletes the name and types the payload. Names MUST
 * match the module `emit:` / `decodeEvent` `event:` strings.
 */
export interface DeviceEventMap {
  /** Motion detected (camera / PIR sensor). */
  motion: PushSemanticEvent;
  /** A recognized/known or stranger person detected. */
  personDetected: PushSemanticEvent;
  /** Doorbell button pressed. */
  doorbellPress: PushSemanticEvent;
  /** Pet detected. */
  petDetection: PushSemanticEvent;
  /** A package was delivered (drop/porch). */
  packageDelivered: PushSemanticEvent;
  /** A previously-delivered package was taken. */
  packageTaken: PushSemanticEvent;
  /** A delivered package has been left unattended too long. */
  packageStranded: PushSemanticEvent;
  /** A person the device does NOT recognise (distinct from {@link personDetected}). */
  strangerDetected: PushSemanticEvent;
  /** Sound above the configured threshold. */
  soundDetected: PushSemanticEvent;
  /** Crying detected (indoor/baby-monitor families). */
  cryingDetected: PushSemanticEvent;
  /** A vehicle was detected. */
  vehicleDetected: PushSemanticEvent;
  /** A dog was detected; `kind` distinguishes the licking/fouling sub-events when the device reports one. */
  dogDetected: PushSemanticEvent & { kind?: "lick" | "poop" };
  /** The guard mode changed. Carries no mode value — re-read the current mode. */
  armingModeChanged: PushSemanticEvent;
  /**
   * A camera's own enablement was confirmed changed, after a write this SDK issued was read back off the
   * device. Carries no value — re-read `enabled`, which has converged by the time this fires.
   *
   * Distinct from {@link propertyChanged}, which reports `enabled` moving for any reason on whichever
   * inbound path saw it. This one says a write LANDED, which is a different fact and the only thing that
   * can be known about a value nothing pushes.
   */
  cameraEnabledChanged: PushSemanticEvent;
  /** Station alarm lifecycle; `phase` says whether it fired or is counting down. */
  alarm: PushSemanticEvent & { phase?: "triggered" | "delayed" };
  /** Lock (un)locked or a lock alarm fired. */
  lockState: PushSemanticEvent;
  /**
   * Entry sensor opened/closed. Arrives via push (seconds) or cloud poll (minutes), which carry the
   * state under different raw keys — read `open`, which both normalise to. Absent when the signal
   * carried no contact value, so `undefined` means "not reported here", not "closed".
   */
  contactState: PushSemanticEvent & PollSemanticEvent & { open?: boolean };
  /**
   * A property this device reports changed value — the generic announcement, derived from the same
   * `members` table the getters are, for every readable property of every capability.
   *
   * `property` is the name `Device.getProperty` takes and the one a capability getter answers, so a
   * caller can re-read immediately; `Device.describe()` publishes the `{ accessor, property }` pair,
   * which maps the name back to the fluent accessor behind it. `value` is what `getProperty` now serves,
   * narrowed the way the capability getter narrows it and read from the same live state rather than
   * re-converted from the wire. It is absent where no scalar can honestly be given — a property whose
   * stored form is a payload, or one whose stored value does not match its declared type — which means
   * "this moved, re-read it". No wire id travels with it: several ids resolve to one property, which is
   * the point.
   *
   * Announced from the cloud poll, from a realtime report, and from the read-through cache's own
   * background re-read, for a change with any cause — the SDK cannot tell its own write's echo from a
   * change made in the vendor app, and suppressing on a guess would lose a real external change in
   * exchange for one redundant re-read. Not announced on first sight of a device (that is discovery, not
   * a transition), nor inside a write's own confirmation (already reported through that command's
   * outcome).
   *
   * Announced against a `Device` the caller is holding, since the value is read out of that device's own
   * live state and the SDK holds the devices it hands out weakly.
   *
   * Every readable property of every capability, with nothing filtered for being uninteresting. So a
   * sensor's own check-in timestamp is announced too, even though the `deviceState` event already
   * carries that fact.
   *
   * Latency is the inbound path's: seconds for a property a device reports over realtime. For one that
   * only ever arrives as a cloud param — which is most of them — it is whichever comes first of the poll
   * (`EufyMegaOptions.pollMs`, `EufyMega.setPollInterval`) and the cache's re-read
   * (`EufyMegaOptions.cacheTtlMs`), both the caller's to choose.
   */
  propertyChanged: SemanticEventBase & PropertyChange & { deviceSn: string };
  /** Battery alert — `state` discriminates low / hot / full. */
  batteryAlert: PushSemanticEvent & { state?: "low" | "hot" | "full" };
  /** Pan/tilt status streamed while the camera moves. */
  ptzNotify: SemanticEventBase & {
    kind: "rotate" | "zoom" | "position";
    payload?: unknown;
    coords?: Array<[number, number]>;
  };
  /**
   * A eufy_life smart light reported its state (secure-MQTT DP status report). Every field is
   * optional: a report carries only the fields the device sent, and an absent one is silence about
   * that field rather than a change to it.
   */
  smartLightState: SemanticEventBase & {
    power?: boolean;
    brightness?: number;
    lightLength?: number;
    effectId?: number;
    colorGradient?: boolean;
    cloudEffectId?: number;
  };
}

/**
 * The typed action surface, keyed by the **camelCased capability id** (the fluent accessor name).
 *
 * THE projection point for actions: adding a capability with an `actions()` factory = add its
 * typed-actions import above + one line here. `device.ts` and the client stay capability-agnostic —
 * the fluent `dev.ptz()` accessors are derived from this map ({@link CapabilityAccessors}), so
 * nothing outside a capability file names a capability.
 *
 * A key here MUST match `camelCase(module.capability)` for the runtime accessor install to line up
 * with the type. (Only capabilities whose module defines `actions()` appear.)
 */
export interface DeviceActionMap {
  /** Pan/tilt/zoom control: `rotate(dir, step)` + `left`/`right`/`up`/`down`, `zoom`, preset() namespace (goto/preview/save/setDefault/delete/list/image). */
  ptz: PtzActions;
  /** Floodlight/spotlight: `on`/`off`/`set`, `setBrightness`/`setColorTemp`/`setEnabled`, `setAutoSpotlight`. */
  light: LightActions;
  /** eufy_life smart light (T8L0x): `on`/`off`, `setBrightness`, T8L02 `setColor`, `setEffect(lightId)`. */
  smartLight: SmartLightActions;
  /** Camera: `on`/`off`, privacy, status LED; `snapshot`/`live`/`record` when bound to a live client. */
  camera: CameraActions;
  /** Audio/volume (family-gated): mic, speaker + volume, in-video recording, doorbell ringtone, HomeBase alarm/prompt. */
  audio: AudioActions;
  /** Battery/power: power source, working mode, and the custom-mode clip/interval/auto-stop settings. */
  battery: BatteryActions;
  /** Smart lock: `lock()`/`unlock()` + verified `setRainMode`/`setAutoLock`. The 6 source-confirmed-but-uncaptured setting toggles are ABSENT until captured (present method ⇒ wire verified). */
  lock: LockActions;
  /** Siren: reads `active`, `volume`, `alarmDuration`, `doNotDisturb`; writes `setVolume`, `setAlarmDuration`, `test`, `stop` (config setters present when the param is reported). No direct "sound the alarm" wire — a real alarm is driven by the `arming` system; `test` is the on-demand trigger. */
  siren: SirenActions;
  /** Guard mode: `setMode(ArmingMode)` + `setAlarmDelayConfig(mode, config)`. Of the 9 modes a station reports, only `away`/`home`/`custom1`/`disarmed` are confirmed as writes (`ArmingMode`); the alarm-delay write takes the narrower byte-captured `AlarmDelayMode`. */
  arming: ArmingActions;
  /** Doorbell: `playQuickResponse(voiceId)` (the canned voice replies). */
  doorbell: DoorbellActions;
  /** Motion/PIR: `setDetection(on)` (sensitivity is read-only until its write wire is captured). */
  motion: MotionActions;
  /** Entry (door/window) sensor: reads `open`, `lastSeen`, `rssi`, `alarmSoundType`, `alarmVolume`; writes `setAlarmSoundType`, `setAlarmVolume` (present when the sensor reports the alarm params). */
  contact: ContactActions;
  /** Water-leak / freeze sensor reads (read-only): `leakDetected`, `lastSeen`. */
  leak: LeakActions;
  /** Smoke-detector reads (read-only): `smokeDetected`, `lastSeen`. */
  smoke: SmokeActions;
  /** CO-detector reads (read-only): `coDetected`, `lastSeen`. */
  co: CoActions;
  /** Security-keypad reads (read-only): `rssi`. */
  keypad: KeypadActions;
  /** RTSP publish for a NAS/NVR: `publish`/`withdraw` + `published`, `requireAuth`/`allowAnonymous`, `recordingMode`/`setRecordingMode`. One camera at a time per station. */
  rtsp: RtspActions;
  /** RoboVac core state and controls: `power`, `activity` (WorkStatus), `volume`, `battery`, `cleanType`; `setPower`, `startCleaning`, `returnToDock`, `pauseCleaning`. */
  vacuumClean: VacuumCleanActions;
  /** RoboVac Omni dock controls: `emptyDust`, `washMops`, `dryMops`; raw `dockState` unexposed until wire confirmed. */
  vacuumDock: VacuumDockActions;
  /** RoboVac suction: `level`, `boostIq`, `supportedLevels`; `setSuctionLevel`, `setBoostIq`. */
  suction: SuctionActions;
  /** RoboVac locate (find-robot beep): `locating`; `locate(on?)`. */
  locate: LocateActions;
  /** Smart Display (read-only): `battery`. No display write is captured. */
  display: DisplayActions;
  /** Identity metadata (read-only): `{ manufacturer, model, serialNumber, name, deviceType?, firmwareVersion?, hardwareVersion? }`. */
  info: DeviceInfo;
}

/**
 * The fluent capability accessors merged onto `Device`: `dev.ptz?.()?.rotate(PtzDirection.left)`.
 *
 * **Each accessor is optional**, because a device carries only the accessors for capabilities it
 * actually has — a smart light has no `camera` at all. Calling one that exists still yields `undefined`
 * until the device is bound to a live transport, so a call site needs `?.` twice: `dev.ptz?.()?.…`,
 * the first for "does this device have it", the second for "is it bound yet".
 */
export type CapabilityAccessors = {
  [K in keyof DeviceActionMap]?: () => DeviceActionMap[K] | undefined;
};

/**
 * Every fluent-accessor name the SDK knows — the camelCased id of every module with a `members` table
 * or an `actions()` factory. A module needs only ONE of the two: `contact` is all members and `ptz` all
 * hand-written actions. The runtime twin of {@link DeviceActionMap}'s keys (types erase at
 * build). A projection of `MODULES`, so `device.ts` stays capability-agnostic. A device installs the
 * subset it has: see {@link accessorNamesFor}.
 * @internal
 */
export const ACTION_ACCESSOR_NAMES: readonly (keyof DeviceActionMap)[] = MODULES.filter(
  (m) => m.actions || m.members,
).map((m) => camelCase(m.capability) as keyof DeviceActionMap);

/**
 * The fluent-accessor names a device with THESE capabilities should carry — the subset of
 * {@link ACTION_ACCESSOR_NAMES} it can actually answer for.
 *
 * A device only advertises what it can do: a smart light has no `camera` accessor at all, rather than
 * one that answers `undefined` forever. That makes the object's own shape a truthful description of the
 * device, and it makes `"camera" in dev` mean what a reader expects it to.
 * @internal
 */
export function accessorNamesFor(capabilities: ReadonlySet<Capability>): (keyof DeviceActionMap)[] {
  return MODULES.filter((m) => (m.actions || m.members) && capabilities.has(m.capability)).map(
    (m) => camelCase(m.capability) as keyof DeviceActionMap,
  );
}

/** Whether this resolved set owns a provider-backed member with the given action name. */
export function hasProvidedAction(capabilities: ReadonlySet<Capability>, action: string): boolean {
  return MODULES.some((module) => {
    if (!capabilities.has(module.capability)) return false;
    const member = module.members?.[action];
    return member !== undefined && "provided" in member && hasRequiredCapabilities(member, capabilities);
  });
}

/**
 * Build the map of action-objects for the capabilities a device HAS, e.g.
 * `{ light: {on, off, ...}, ptz: {rotate, ...}, camera: {on, snapshot, ...} }`. Keys are
 * camelCased {@link Capability} ids. Only capabilities in `caps` with an `actions` factory appear.
 * Consumed by `Device` to install the fluent `dev.<cap>()` accessors. `media`/`ff09Settings`/`rawDp`
 * are the optional transport-supplied providers — media actions (snapshot/live/record) only appear when
 * a provider is supplied, likewise `dev.lock()?.getAutoLockState()`, and a member declaring a
 * `decode` returns `undefined` without a codec. Each names a technical job — a media session,
 * an `ff09` settings query, a payload shape — never the capability that calls it first; see
 * {@link CapabilityModule.actions}'s doc before adding another.
 * @internal
 */
export function buildActions(caps: readonly Capability[], deps: MemberDeps): Partial<DeviceActionMap> {
  const out: Record<string, CapabilityActions> = {};
  const capSet = new Set(caps);
  for (const m of MODULES) {
    if ((!m.actions && !m.members) || !capSet.has(m.capability)) continue;
    const acts = (m.actions ? m.actions(deps) : {}) as CapabilityActions;
    if (m.members) {
      Object.defineProperties(acts, Object.getOwnPropertyDescriptors(bindMembers(m.members, deps)));
    }
    out[camelCase(m.capability)] = acts;
  }
  return out as Partial<DeviceActionMap>;
}

/**
 * Describe the capability objects a device has bound — the capability half of `Device.describe()`.
 *
 * The projection point for discovery, the way {@link buildActions} is for control: `device.ts` hands
 * over the bound objects it holds and gets back what each exposes, without naming a capability.
 * @internal
 */
export function describeCapabilities(
  bound: Partial<DeviceActionMap>,
  ctx?: AvailabilityContext,
): CapabilityDescriptor[] {
  return describeBound(MODULES, bound as Record<string, unknown>, ctx);
}

/**
 * Resolve an intent name against a module's members — the property name, an alias verb carrying its own
 * value, or an extra intent name the member claims. The same builder the fluent setter uses, gated by
 * the same evidence, so the two entry points cannot diverge.
 *
 * A member that CLAIMS the name but declares its wire unverified throws that reason rather than falling
 * through. The fluent side says it at compile time by omitting the setter, but an intent takes a string
 * and has no compile time — and answering `undefined` would report an uncaptured wire as a device that
 * lacks the feature, which is the one thing the never-guess rule is about.
 */
function memberCommand(
  m: CapabilityModule,
  action: string,
  value: boolean | number | string,
  ctx: CommandContext,
): Command | undefined {
  for (const [name, member] of Object.entries(m.members ?? {})) {
    if (!("type" in member)) continue;
    const property = member.property ?? name;
    const aliased = member.aliases?.[action];
    const claims = action === property || member.intentNames?.includes(action) === true;
    if (!claims && aliased === undefined) continue;
    if (member.unverified) {
      throw new Error(`${m.capability}: ${name} write wire unverified — confirm it on a device before sending`);
    }
    if (!member.write || !installs(member, ctx)) continue;
    return memberWrite(name, member, claims ? value : (aliased as boolean | number | string), ctx);
  }
  return undefined;
}

// Nothing ptz-specific leaks out of the barrel: PtzDirection, PTZ_ROTATE and the rotate
// command builder all stay PRIVATE to ptz.ts. Callers go through buildActions / buildCommand
// (generic), never a ptz symbol.
// The transport boundary contract (Command/CommandSink/MediaProvider/ScalarForm) is NOT re-exported
// here — it lives in core/contracts (imported directly by capabilities that emit intent), so it has
// a single source at the root barrel.
export type {
  CommandContext,
  CapabilityActions,
  CapabilityStateReader,
  CapabilityModule,
  DetectionSpec,
  CapabilityFrame,
  CapabilityEvent,
  InboundSignal,
  EventClaim,
  EventMapping,
  ProductLine,
  ActionArgSpec,
  DecodedState,
} from "./types.js";
/**
 * The value-kind vocabulary a read is annotated with, re-exported from the barrel that publishes the
 * read itself, so the union a member's `kind` is drawn from is reachable from the same import.
 */
export type { ValueKind, KnownValueKind } from "../types.js";
export { KNOWN_VALUE_KINDS, isKnownValueKind } from "../types.js";
/**
 * The member-table vocabulary a capability's surface is declared in — published because
 * `CapabilityModule.members` is.
 */
export type {
  Members,
  Member,
  ValueMember,
  ActionMember,
  MethodMember,
  ProvidedMember,
  AnyProvidedMember,
  MemberDeps,
  Providers,
  Surface,
} from "./members.js";
/**
 * The type-level parts `Surface` is assembled from — published because `Surface` NAMES them.
 * `ValueKeys` and its
 * siblings select which members each branch of the projection covers; `ReadValue`/`WriteValue` say what
 * a getter answers and a setter takes; `SetterName` gives the setter its name.
 */
export type {
  ValueKeys,
  WritableKeys,
  ActionKeys,
  MethodKeys,
  ProvidedKeys,
  UnverifiedKeys,
  ConditionalKeys,
  ValueOf,
  ReadValue,
  WriteValue,
  SetterName,
} from "./members.js";
export { CapabilityNotSupportedError } from "./types.js";
/**
 * The shape `Device.describe()` answers with — published from the barrel that publishes the surface it
 * describes.
 */
export type { DeviceManifest, CapabilityDescriptor, ReadDescriptor, ActionDescriptor } from "./manifest.js";
export type { ActionSpec } from "./types.js";
/**
 * Ask ONE method what it accepts, without walking a whole manifest.
 *
 * `Device.describe()` is the discovery entry point; this is the same answer for a method already in
 * hand, read off the function itself rather than carried beside it. Every member
 * kind is wrapped, so it answers for a derived setter, a momentary action and a method alike, and
 * `undefined` for an action nothing describes.
 */
export { actionSpecOf } from "./access.js";

// The per-capability typed action objects + the fluent-accessor projection.
export type {
  PtzActions,
  LightActions,
  SmartLightActions,
  RgbColor,
  CameraActions,
  LockActions,
  SirenActions,
  ArmingActions,
  BatteryActions,
  MotionActions,
  ContactActions,
  LeakActions,
  SmokeActions,
  CoActions,
  KeypadActions,
  RtspActions,
  VacuumCleanActions,
  SuctionActions,
  LocateActions,
};
/**
 * The member table each `*Actions` type is DERIVED from (`LockActions = Surface<typeof LOCK_MEMBERS>`),
 * so the type names the table and the table is part of the published surface.
 *
 * It is also the one declaration of what a capability exposes: per feature its wire id, value type,
 * `kind`, domain (`min`/`max`/`enumValues`), presence gate and the description published for it.
 * `Surface` and the runtime install from the same entry, so there is no second table to disagree with it.
 */
export { ARMING_MEMBERS } from "./arming.js";
export { AUDIO_MEMBERS } from "./audio.js";
export { BATTERY_MEMBERS } from "./battery.js";
export { CAMERA_MEMBERS } from "./camera.js";
export { CO_MEMBERS } from "./co.js";
export { CONTACT_MEMBERS } from "./contact.js";
export { DOORBELL_MEMBERS } from "./doorbell.js";
export { KEYPAD_MEMBERS } from "./keypad.js";
export { LEAK_MEMBERS } from "./leak.js";
export { LIGHT_MEMBERS } from "./light.js";
export { LOCATE_MEMBERS } from "./locate.js";
export { LOCK_MEMBERS } from "./lock.js";
export { MOTION_MEMBERS } from "./motion.js";
export { PTZ_MEMBERS } from "./ptz.js";
export { RTSP_MEMBERS } from "./rtsp.js";
export { SIREN_MEMBERS } from "./siren.js";
export { SMART_LIGHT_MEMBERS } from "./smart-light.js";
export { SMOKE_MEMBERS } from "./smoke.js";
export { DISPLAY_MEMBERS, type DisplayActions } from "./display.js";
export { SUCTION_MEMBERS } from "./suction.js";
export { VACUUM_CLEAN_MEMBERS } from "./vacuum-clean.js";
// The read-only identity metadata object returned by `dev.info()` — a public consumer type.
export type { DeviceInfo } from "./info.js";
// The options bag for LightActions.setAutoSpotlight (public param type — a consumer needs to name it).
export type { AutoSpotlightOptions } from "./light.js";
// Doorbell fluent actions + quick-response type/parser (public API) — all owned by the doorbell module.
export type { DoorbellActions, QuickResponse } from "./doorbell.js";
export { parseQuickResponses } from "./doorbell.js";
export { DoorbellRingtone, type DoorbellRingtoneValue } from "./doorbell.js";
export type { AudioActions } from "./audio.js";
export { VACUUM_DOCK_MEMBERS } from "./vacuum-dock.js";
export type { VacuumDockActions } from "./vacuum-dock.js";
/**
 * The dock's activity is the declared return of the public `dev.vacuumDock()?.dockState` getter, so the
 * union is published — and the list it is taken from, since it names its own.
 */
export type { DockActivity } from "./vacuum-dock.js";
export { DOCK_ACTIVITIES } from "./vacuum-dock.js";
export { HubAlarmTone, type HubAlarmToneValue } from "./siren.js";
/**
 * RoboVac activity and clean type are the declared returns of the public `dev.vacuumClean()` getters,
 * so both unions are published.
 */
export type {
  VacuumActivity,
  VacuumCleanType,
  CarpetStrategy,
  CleanExtent,
  VacuumRoomTarget,
  VacuumZoneTarget,
} from "./vacuum-clean.js";
/** The lists those unions are taken from — published because each union names its own. */
export { VACUUM_ACTIVITIES, VACUUM_CLEAN_TYPES, CARPET_STRATEGIES, CLEAN_EXTENTS, MOP_LEVELS } from "./vacuum-clean.js";
// RoboVac suction levels — a host reads `suction` as a raw int and names it via suctionLevelName; the
// SuctionLevel map + resolver are the public way to do that.
export { SuctionLevel, suctionLevelName, type SuctionLevelValue } from "./suction.js";
// PTZ preset sub-API + the public param/return shapes referenced by PtzActions.
export type { PtzPresetActions, ZoomRegion, PtzPreset, PtzPresetImage } from "./ptz.js";

// Named argument constants for the fluent actions (value + companion type): `ArmingMode.home`,
// `PtzDirection.left`. The on-wire `PTZ_ROTATE` map stays private — not re-exported here.
export { AlarmDelayMode, ArmingMode } from "./arming.js";
export type { AlarmDelayConfig, AlarmDelayCountdown, AlarmDelayDeviceAction, AlarmDelaySeconds } from "./arming.js";
export { PtzDirection } from "./ptz.js";
export { AiDetectType, encodeAiDetectType, decodeAiDetectType, type AiDetectFlags } from "./motion.js";

// The typed semantic-event surface (payload types + the DeviceEventMap projection are declared
// above and exported by their `export interface` declarations).
