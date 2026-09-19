/**
 * What a device exposes, as data — one JSON-safe shape per device, with no branch per capability.
 *
 * A bound device is fully callable but states nothing about ITSELF from outside the package: neither
 * what is installed nor what a value means is readable off it. The member table states both, and this
 * turns that statement into a public, JSON-safe shape: which reads a device actually installed, which
 * of its actions are offerable, and which events it emits.
 *
 * **Derived from the LIVE bound objects, not recomputed from the tables.** The descriptors of the bound
 * object are the only source that cannot disagree with what `bindMembers` installed — evidence
 * gates, provider gates and unverified writes are all already applied there. Recomputing the same answer
 * from the module tables would be a second implementation of the gate, and it would be wrong in exactly
 * the cases that matter: a media method on a device bound without that provider, a read for a param
 * the device never reported. The table is joined in only for SEMANTICS (what the value means), which the
 * bound object does not carry.
 *
 * **Never spread, `Object.entries` or `JSON.stringify` a bound object here.** All three invoke its
 * getters, and a getter with a `decode` calls into the injected codec. Property descriptors only.
 *
 * @module model/capabilities/manifest
 */
import type { Capability, Codec, PropertyValueType, ResolvedDevice, ValueKind } from "../types.js";
import { actionSpecOf, camelCase } from "./access.js";
import { resolvedEnum, type ValueMember } from "./members.js";
import type { ActionSpec, AvailabilityContext, CapabilityModule, EventClaim } from "./types.js";

/** One read installed on a bound capability object — a value the device reports, and what it means. */
export interface ReadDescriptor {
  /** The getter's name on the capability object (`dev.battery()?.level` → `level`). */
  accessor: string;
  /** The name the same value carries in the device's flat property namespace (`getProperty`). */
  property: string;
  /** How the value is stored. */
  type: PropertyValueType;
  /** What the value MEANS, as opposed to how it is stored. See {@link ValueKind}. */
  kind?: ValueKind;
  /** The unit the device reports the value in, when it has one (`"%"`, `"°C"`, `"dBm"`). */
  unit?: string;
  /** The option set, for a value out of a fixed domain. */
  values?: readonly (string | number)[];
  /** Labels for {@link values}, keyed by the raw value as a string. */
  labels?: Readonly<Record<string, string>>;
  /**
   * Whether a setter for this value is installed BESIDE the getter on the same object.
   *
   * Read off the bound object rather than the schema, so it means "a caller can write this on THIS
   * device" — a write the device gave no evidence for, or one whose wire is not confirmed, is not
   * installed and reads `false` here. A value driven by a differently-named method (a pair of frames,
   * a validating setter) is `false` too and appears under the capability's {@link
   * CapabilityDescriptor.actions} instead, which is where its signature is described.
   */
  writable: boolean;
  description?: string;
}

/**
 * One offerable action: an {@link ActionSpec} plus the name it is installed under.
 *
 * The name is taken from the enumeration rather than carried in the spec, so a renamed method takes its
 * description with it and cannot leave one behind pointing at nothing.
 */
export interface ActionDescriptor extends ActionSpec {
  name: string;
}

/** What one capability exposes on a device — the join of its bound object and its own declaration. */
export interface CapabilityDescriptor {
  capability: Capability;
  /** The fluent accessor this capability is reached under: `dev[accessor]()`. */
  accessor: string;
  /** The reads INSTALLED on this device, never the theoretical set. */
  reads: readonly ReadDescriptor[];
  /** The installed actions that carry a description. */
  actions: readonly ActionDescriptor[];
  /**
   * Installed, callable actions with no description — usable, but not auto-offerable. Published rather
   * than hidden so the gap is visible instead of looking like the action doesn't exist.
   */
  undescribedActions: readonly string[];
  /** The semantic event names this capability emits. */
  events: readonly string[];
}

/**
 * A device's public shape: its identity, its capabilities, and what each of those exposes.
 *
 * `bound` is explicit because an unbound model object (no live client) has no bound objects to
 * enumerate, so its `details` are empty — a caller has to be able to tell "this device exposes nothing"
 * from "ask again once it is bound".
 */
export interface DeviceManifest {
  sn: string;
  /** What the user named the device in the app; falls back to {@link modelName} when unnamed. */
  name: string;
  /** Model / T-code ("T8410"), when the record states one. */
  model?: string;
  /** The model's own display name ("Indoor Cam Pan & Tilt") — the product, not this unit. */
  modelName: string;
  codec: Codec;
  source: ResolvedDevice["source"];
  bound: boolean;
  capabilities: readonly Capability[];
  details: readonly CapabilityDescriptor[];
}

/**
 * Describe the capability objects a device has bound, one descriptor each.
 *
 * Parameterised over the module list; the barrel binds it to the real one. A capability the device did
 * not bind — because it does not have it, or because nothing is bound yet — contributes no descriptor
 * at all.
 * @internal
 */
export function describeBound(
  modules: readonly CapabilityModule[],
  bound: Readonly<Record<string, unknown>>,
  ctx?: AvailabilityContext,
): CapabilityDescriptor[] {
  const out: CapabilityDescriptor[] = [];
  for (const m of modules) {
    const accessor = camelCase(m.capability);
    const obj = bound[accessor];
    if (!obj || typeof obj !== "object") continue;
    const descriptors = Object.getOwnPropertyDescriptors(obj);
    const reads: ReadDescriptor[] = [];
    const actions: ActionDescriptor[] = [];
    const undescribedActions: string[] = [];
    for (const [name, d] of Object.entries(descriptors)) {
      if (d.get) {
        // A getter the member table doesn't declare has no semantics to publish; `manifest.spec.ts`
        // cross-checks the two sets, so a hand-written getter fails there rather than shipping bare.
        const member = m.members?.[name];
        if (member && "type" in member) reads.push(readDescriptor(name, member, descriptors, ctx));
        continue;
      }
      if (typeof d.value !== "function") continue;
      const spec = actionSpecOf(d.value);
      if (spec) actions.push({ name, ...spec });
      else undescribedActions.push(name);
    }
    out.push({
      capability: m.capability,
      accessor,
      reads,
      actions,
      undescribedActions,
      events: emitsOf(m, reads, ctx),
    });
  }
  return out;
}

/**
 * A member's semantics, as published.
 *
 * The DECODED kind and option set win where a member declares them: a decode IS the value handed over,
 * so describing the payload it came out of would mis-describe the value that is actually delivered.
 * Absent a decode, a context-resolved enum domain ({@link resolvedEnum}) is reported with enum
 * `kind`; otherwise the member's stored kind and static options stand.
 */
function readDescriptor(
  name: string,
  m: ValueMember,
  descriptors: Record<string, PropertyDescriptor>,
  ctx?: AvailabilityContext,
): ReadDescriptor {
  const setter = m.writeAs ?? `set${name[0].toUpperCase()}${name.slice(1)}`;
  const { values: enumValues, dynamic } = resolvedEnum(m, ctx);
  return {
    accessor: name,
    property: m.property ?? name,
    type: m.type,
    kind: m.decodedKind ?? (dynamic ? "enum" : m.kind),
    unit: m.unit,
    values: m.decodedValues ?? (enumValues && Object.keys(enumValues).map(Number)),
    labels: enumValues && Object.fromEntries(Object.entries(enumValues)),
    writable: typeof descriptors[setter]?.value === "function",
    description: m.description,
  };
}

/**
 * Every event name a capability announces ON THIS DEVICE: the mappings whose claim this device meets,
 * plus what its own decoder emits.
 *
 * An unclaimed mapping belongs to every device that binds the capability, which is most of them — an
 * id the vendor issues per capability rather than per family needs no evidence beyond having the
 * capability at all. A claimed one names the evidence that tells shared families apart; see
 * {@link EventClaim}.
 *
 * The escape-hatch `emits` list is not claimable: those names come out of a module's own binary
 * decoder, which already ran against this device's frames.
 */
function emitsOf(m: CapabilityModule, reads: readonly ReadDescriptor[], ctx?: AvailabilityContext): string[] {
  const installed = new Set(reads.map((r) => r.accessor));
  const claimed = (m.events ?? []).filter((e) => holds(e.claim, installed, ctx)).map((e) => e.emit);
  return [...new Set([...claimed, ...(m.emits ?? [])])];
}

/**
 * Whether this device meets a mapping's claim — every stated field, against evidence that contradicts
 * it rather than evidence that confirms it.
 *
 * A read the device never reported is the contradiction for `reads`: the getter is absent from the
 * bound object, which is the same evidence gate the read itself answers to. A topology the context
 * does not state contradicts nothing, so the event stands; narrowing on an unknown would withdraw an
 * event from every caller that describes a device without resolving its parent.
 *
 * `codecs` is the exception to that leniency, and for the reason {@link AvailabilityContext.codec}
 * gives: an absent codec is a device outside the eufy device model rather than one whose family is
 * merely unresolved, so it matches no family's vocabulary and cannot be issuing the family's ids.
 */
function holds(claim: EventClaim | undefined, installed: ReadonlySet<string>, ctx?: AvailabilityContext): boolean {
  if (!claim) return true;
  if (claim.codecs && (ctx?.codec === undefined || !claim.codecs.includes(ctx.codec))) return false;
  if (claim.reads?.some((name) => !installed.has(name))) return false;
  if (claim.homeBaseAttached !== undefined && ctx?.homeBaseAttached !== undefined) {
    return ctx.homeBaseAttached === claim.homeBaseAttached;
  }
  return true;
}
