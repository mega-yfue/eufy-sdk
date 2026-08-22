/**
 * A capability's surface, declared once per feature.
 *
 * Each entry in a module's `members` table is one thing a device exposes, and everything else is
 * DERIVED from it: the property schema the model consumes, the TYPE of the bound `dev.<cap>()` object,
 * the evidence-gated getter, the setter beside it, the intent name `setProperty` resolves through, and
 * the description a caller reads to offer the feature as a control.
 *
 * The alternative — a table per concern, joined by name — is what let one feature be spelled in six
 * places and disagree with itself. Here a rename moves everything at once, because there is only one
 * declaration to rename.
 *
 * Deriving the type is what makes this pay for a developer as well as for discovery: `dev.motion()`
 * autocompletes from the same table the runtime installs from, with no hand-written `*Actions`.
 *
 * @module model/capabilities/members
 */
import {
  observeCommand,
  type Command,
  type CommandSink,
  type Ff09SettingsReader,
  type MediaProvider,
  type RawDpCodec,
} from "../../core/contracts.js";
import { describedAction, readBool, readNum, readStr } from "./access.js";
import type { ActionArgSpec, ActionSpec, AvailabilityContext, CapabilityStateReader, CommandContext } from "./types.js";
import type { Capability } from "../types.js";
import type { PropertySpec, PropertyValueType, ValueKind } from "../types.js";

// ── the contract ────────────────────────────────────────────────────────────────────────────────

/** A member backed by a device property: a getter, plus a setter when `write` is declared. */
export interface ValueMember {
  /**
   * The wire id carrying this value. Optional only for a {@link writeOnly} member whose write is not a
   * param at all — camera privacy is a frame BURST, and the id that burst is built from belongs to the
   * transport that plays it, not to a capability that would be naming another layer's vocabulary.
   */
  param?: number;
  /**
   * The name this value takes in the device's FLAT property namespace, when the member key would
   * collide there. The key is the accessor and is scoped by its capability (`dev.battery().level`);
   * a property is not — `level` alone is claimed by both `battery` and `suction`, `volume` by three
   * capabilities. Defaults to the key, which is right for the ~70% that do not collide.
   */
  property?: string;
  type: PropertyValueType;
  kind?: ValueKind;
  unit?: string;
  enumValues?: Record<number, string>;
  /**
   * A per-device enum resolved at manifest time from the device context — for a value whose options
   * are real but vary by model, so a single static {@link enumValues} cannot state them (e.g.
   * `workingMode`, whose indices number differently per camera). `mergeProperties` calls this with the
   * device context and stamps the result onto that device's spec. Returning `undefined` leaves the
   * static `enumValues` (or none) in place.
   */
  enumValuesFor?: (ctx: AvailabilityContext) => Record<number, string> | undefined;
  provenance?: PropertySpec["provenance"];
  invert?: boolean;
  description: string;
  /** The wire, or absent for read-only. `undefined` from it = this value is not one we accept. */
  write?: (value: boolean | number | string, ctx: CommandContext) => Command | undefined;
  /** @internal Policy for confirming this write through bounded readback before emitting its transition event. */
  observation?: {
    event: string;
    expected(value: boolean | number | string): boolean | number | string;
    resetStandaloneSession?: boolean;
    timeoutMs: number;
  };
  /** Setter name when `set` + the key reads wrong (`isOn` → `set`, not `setIsOn`). */
  writeAs?: string;
  /**
   * A setter for this value EXISTS, but is not this member's own {@link write} — so the published
   * schema's `writable` cannot be derived from `write` alone.
   *
   * `writable` means "a setter exists", and one legitimately lives elsewhere when a `method` member
   * drives the value because a single `write` cannot (rtsp's recording mode sends a two-frame pair), or
   * the setter needs per-bind state the table cannot hold (a vacuum's suction level validates against
   * the model's own range). Guarded by `action-specs.spec.ts`,
   * which asserts every `writable` property has a reachable setter — so this cannot drift into a lie.
   */
  writtenElsewhere?: true;
  /** Extra intent verbs routed to `write`, each carrying the value it stands for. */
  aliases?: Record<string, boolean | number | string>;
  /**
   * Install the WRITE only on a device that reported one of these params.
   *
   * Distinct from the getter's own evidence gate: a siren's volume write was captured on a real siren,
   * and the evidence that a device IS one is that it reports a siren param — so handing the write to a
   * camera the name hint gave this capability to would send a frame that family never accepts. A member
   * that declares this lands OPTIONAL on the surface, since whether it exists is a runtime fact.
   *
   * Absent = install on any device with the capability, which is right for a wire the whole family
   * speaks.
   */
  requires?: readonly number[];
  /** Install the write only when this member's family-valid primary param or read alias was reported. */
  requiresRead?: true;
  /** Whether the primary read parameter carries this member on the current device family. */
  readAvailable?: (ctx: AvailabilityContext) => boolean;
  /**
   * Install the write only where this predicate holds — the general form of {@link requires}, for a gate
   * no list of params can express.
   *
   * A lock's rain mode exists on the P2P video lock and not on the MQTT garage door: a TOPOLOGY fact, not
   * a reported param. Audio's controls split the same way on device FAMILY — a HomeBase has an alarm
   * volume, a camera has a microphone, and neither reports the other's params. Like `requires`, a member
   * that declares this lands OPTIONAL on the surface, because whether it exists is a runtime fact.
   *
   * Takes an {@link AvailabilityContext} (not a full CommandContext): the manifest applies the same
   * gate at resolve time, before a live session exists, so it must read only device facts a record
   * carries — never `channel`/`paramIds`.
   */
  available?: (ctx: AvailabilityContext) => boolean;
  /**
   * The write wire is NOT confirmed on a real device.
   *
   * A fire-and-forget write that is wrong looks exactly like success, so it must not ship as a callable
   * method: any {@link write} declared beside this is NOT installed, and the setter lands optional on the
   * surface so a caller learns at COMPILE time. Declare it with no `write` at all when the frame shape is
   * unknown — the flag is what states "the device accepts this, we have not captured how", which is the
   * distinction the intent path answers with rather than a generic "not supported".
   */
  unverified?: true;
  /**
   * Extra names the intent path should route here, taking the caller's value as-is. Unlike
   * {@link aliases}, no value is supplied: it is the same write under a second name.
   */
  intentNames?: readonly string[];
  /** Extra wire ids that also carry this value on some families, with their own polarity and family gate. */
  readAliases?: readonly {
    paramType: number;
    invert?: boolean;
    available?: (ctx: AvailabilityContext) => boolean;
  }[];
  /**
   * What the setter accepts, when the member's own kind and bounds do not say it well enough — an
   * argument whose name reads better than the member's, or one the caller may omit.
   */
  args?: readonly ActionArgSpec[];
  /**
   * A value the setter takes BEYOND what the getter answers — declare it with {@link accepts}.
   *
   * A video-quality tier is stored and read as a number, but the write also resolves the resolution
   * NAME it maps to; without this the derived setter would narrow to the stored type and a caller
   * would lose the names it can pass. Only the TYPE is used — nothing reads the value.
   */
  accepts?: unknown;
  /** Numeric bounds a caller can solicit within — the same constants `write` clamps with. */
  min?: number;
  max?: number;
  /**
   * Install the getter on capability alone, not on having seen the param — for state that only ever
   * arrives over realtime, where "has reported already" is the wrong evidence.
   */
  realtime?: boolean;
  /**
   * A setting the device ACCEPTS but never reports back.
   *
   * No getter (it could only ever answer `undefined`) and no entry in the property schema, which
   * describes what a device reports. It still declares its param and type, because that is what the
   * write needs. Camera privacy is one of these.
   */
  writeOnly?: true;
  /**
   * Reported by the device — so it IS in the property schema and reachable through `getProperty` — but
   * given no typed getter, because its value space is not evidenced.
   *
   * The distinction from {@link writeOnly} is which half is missing: there the device says nothing, here
   * WE cannot yet say what the value means. Publishing a typed getter over a meaning we have not
   * confirmed is the same guess the never-ship-a-guessed-param rule forbids.
   */
  unexposed?: true;
  /**
   * Reinterpret the RAW wire value at ingest, for a param the app reads as something other than its face
   * value — a bitfield the device reports as an object, a code that means a flag.
   *
   * Distinct from {@link decode}, and the two are not interchangeable: this runs once when params are
   * applied and REPLACES the default type coercion, so the stored property already holds the corrected
   * value and every reader sees it. `decode` runs per read, inside the getter, where the injected codec
   * is in scope — which is the only way to reach a field inside a payload.
   */
  coerce?: (raw: string | number | boolean) => boolean | number | string;
  /**
   * Derive the getter's value from the stored one, for a param delivered as a payload rather than a
   * scalar. Its return type wins over {@link type} on the surface, since it IS the value a caller gets —
   * and it is kept EXACTLY, so a decode answering a named union (`VacuumActivity`) surfaces that union
   * rather than the `string` it is stored as. Widening the declared return here would quietly erase it.
   *
   * `codec` is the injected {@link RawDpCodec}, `undefined` on an unbound device — the only place a
   * capability gets one, and the reason a structured DP payload can be read without the transport
   * knowing what its fields mean.
   */
  decode?: (raw: unknown, codec: RawDpCodec | undefined, ctx: CommandContext) => boolean | number | string | undefined;
  /** What the decoded value means, when it differs from the stored property's own {@link kind}. */
  decodedKind?: ValueKind;
  /**
   * The option set of a decoded `enum` — the counterpart to a property schema's `enumValues`, for a
   * getter whose value that schema cannot express. Legal only alongside {@link decode}, since without
   * one the property's own set is the answer and a second copy could only drift.
   */
  decodedValues?: readonly (string | number)[];
}

/** A member with no readable state: a momentary command. */
export interface ActionMember {
  action: (ctx: CommandContext) => Command;
  description: string;
  /** Install only on a device reporting one of these params — see {@link ValueMember.requires}. */
  requires?: readonly number[];
  /** Install only where this holds — see {@link ValueMember.available}. */
  available?: (ctx: CommandContext) => boolean;
}

/**
 * What a member's binder is handed — the same providers `actions()` receives today, so a member that
 * needs live state or a transport provider is expressible without leaving the table.
 */
export interface MemberDeps {
  ctx: CommandContext;
  sink: CommandSink;
  read: CapabilityStateReader;
  rawDp?: RawDpCodec;
  /**
   * The media provider, when the device is bound to one.
   *
   * Distinct from `provided`("media"), which makes a member EXIST only with a provider. A method
   * that merely uses one when available takes it here instead: a doorbell's quick response plays over an
   * already-open stream with no provider at all, and only needs one to open a stream itself.
   */
  media?: MediaProvider;
}

/**
 * A method the table cannot derive: its value is not one param's, so it owns its whole signature.
 *
 * The escape hatch that keeps the table honest instead of pretending everything is a property — a
 * sensitivity STEP is resolved across four wire ids and two numeric directions, so it is neither a
 * getter over one param nor a momentary command. Its signature flows through to the surface type, so a
 * caller still gets autocomplete on it.
 */
export interface MethodMember<F> {
  method: (deps: MemberDeps) => F;
  description: string;
  /** Install only where this holds — see {@link ValueMember.available}. */
  available?: (ctx: CommandContext) => boolean;
  /**
   * What the method accepts, for a signature whose arity does not state it: a parameter with a DEFAULT is
   * absent from `Function.length`, so `locate(on = true)` would otherwise be described as taking nothing
   * at all. Naming it is also the better description — a caller learns the beep can be cancelled.
   *
   * Only needed for that case. A method taking its arguments plainly is described as existing with its
   * arguments unstated, and a nullary one has them derived (see `describe`).
   */
  args?: readonly ActionArgSpec[];
  /**
   * This member ANSWERS rather than ACTS: a sub-API namespace (`ptz.preset()`) or a live query whose
   * returned value is the whole point (`lock.getAutoLockState()`).
   *
   * Both take no arguments, but that arity says nothing about a control — offering one as a button calls it
   * and throws the answer away. So the empty argument list is NOT derived here, leaving the arguments
   * unstated, which is exactly what keeps a caller from auto-offering it. It stays described, and callable,
   * for code that reaches it deliberately.
   */
  answers?: true;
}

/**
 * Declare a `MethodMember` — the wrapper exists so `F` is inferred from the returned function.
 * Pass `available` for a method only some devices have; it then lands optional on the surface.
 */
export function method<F>(build: (deps: MemberDeps) => F, description: string): MethodMember<F>;
/**
 * The gate has to survive into the TYPE, which is why passing one widens the return rather than only
 * setting a field: `available` is optional on `MethodMember`, and an optional property never
 * satisfies the `extends { available: unknown }` test that lands a member optional on the surface.
 */
export function method<F>(
  build: (deps: MemberDeps) => F,
  description: string,
  available: (ctx: CommandContext) => boolean,
): MethodMember<F> & { available: (ctx: CommandContext) => boolean };
export function method<F>(
  build: (deps: MemberDeps) => F,
  description: string,
  available?: (ctx: CommandContext) => boolean,
): MethodMember<F> {
  return available ? { method: build, description, available } : { method: build, description };
}

/** The injected providers a member may be built from, by the technical job each names. */
export interface Providers {
  media: MediaProvider;
  ff09Settings: Ff09SettingsReader;
}

/**
 * A member only a device bound to a given provider has. Its signature is taken FROM that provider, so
 * the surface cannot claim a shape the provider does not have, and it lands OPTIONAL because an unbound
 * device — or one bound without that provider — genuinely does not have it.
 */
export interface ProvidedMember<P extends keyof Providers, F> {
  needs: P;
  provided: (provider: Providers[P], deps: MemberDeps) => F;
  description: string;
  /** This member ANSWERS rather than ACTS — see {@link MethodMember.answers}. */
  answers?: true;
  /** Additional resolved capability evidence required before this provider method is installed. */
  requiredCapabilities?: readonly Capability[];
}

/**
 * Widen a setter's argument past the value its getter answers — see {@link ValueMember.accepts}.
 * Spread into the member (`...accepts<VideoQualityName>()`); the carried value is never read.
 */
export function accepts<T>(): { accepts: T } {
  return { accepts: undefined as T };
}

/** Declare a {@link ProvidedMember} — the wrapper exists so `F` is inferred from the returned function. */
export function provided<P extends keyof Providers, F>(
  needs: P,
  build: (provider: Providers[P], deps: MemberDeps) => F,
  description: string,
  requiredCapabilities?: readonly Capability[],
): ProvidedMember<P, F> {
  return { needs, provided: build, description, requiredCapabilities };
}

/** Whether the resolved capability set satisfies a provider member's additional evidence gate. */
export function hasRequiredCapabilities(
  member: { requiredCapabilities?: readonly Capability[] },
  capabilities: ReadonlySet<Capability> | undefined,
): boolean {
  return !member.requiredCapabilities?.some((capability) => !capabilities?.has(capability));
}

/**
 * The provider-backed shape as the union sees it. `never` in the provider position is deliberate: a
 * parameter is contravariant, so a member built from ONE provider is only assignable to the union when
 * the union's parameter is the bottom type.
 */
export type AnyProvidedMember = {
  needs: keyof Providers;
  provided: (provider: never, deps: MemberDeps) => unknown;
  description: string;
  answers?: true;
  requiredCapabilities?: readonly Capability[];
};

export type Member = ValueMember | ActionMember | MethodMember<unknown> | AnyProvidedMember;
export type Members = Record<string, Member>;

// ── the derived TYPE — what a developer sees in the editor ──────────────────────────────────────

/** The runtime narrowing (`bool`→boolean, `number`/`enum`→number, `string`→string), at type level. */
export type ValueOf<T> = T extends "bool" ? boolean : T extends "string" ? string : number;

/**
 * The members a getter is derived for: those backed by a device property, minus the two kinds that
 * declare a param but publish no read — a `writeOnly` setting the device never reports back, and an
 * `unexposed` one whose value space is not evidenced yet.
 */
export type ValueKeys<M extends Members> = {
  [K in keyof M]: M[K] extends ValueMember
    ? M[K] extends { writeOnly: true } | { unexposed: true }
      ? never
      : K
    : never;
}[keyof M];
/** The members that declare their own write wire, so a setter is derived beside the getter. */
export type WritableKeys<M extends Members> = {
  [K in keyof M]: M[K] extends { write: unknown } ? K : never;
}[keyof M];
/** The momentary commands — a member with no readable state to reflect. */
export type ActionKeys<M extends Members> = { [K in keyof M]: M[K] extends ActionMember ? K : never }[keyof M];
/** The members owning their whole signature, which the table cannot derive from one param. */
export type MethodKeys<M extends Members> = { [K in keyof M]: M[K] extends MethodMember<unknown> ? K : never }[keyof M];
/** The members that exist only on a device bound to the provider they name. */
export type ProvidedKeys<M extends Members> = { [K in keyof M]: M[K] extends { needs: unknown } ? K : never }[keyof M];

/**
 * Writes whose wire is not confirmed on a real device. Declared here so the capability documents what
 * the device has, but NOT installed — and therefore OPTIONAL on the surface, which is how a caller
 * learns at COMPILE time that it is not settable yet.
 *
 * This is the type-level half of the never-guess rule: a present method means a verified wire. Flipping
 * `unverified` off once a capture lands is the only edit needed to promote one.
 */
export type UnverifiedKeys<M extends Members> = {
  [K in keyof M]: M[K] extends { unverified: true } ? K : never;
}[keyof M];

/**
 * Members whose presence is a runtime fact, so the surface must make a caller check: a write installed
 * only on the devices that prove they speak it ({@link ValueMember.requires}), or one whose wire is not
 * captured ({@link ValueMember.unverified}).
 */
export type ConditionalKeys<M extends Members> =
  | UnverifiedKeys<M>
  | { [K in keyof M]: M[K] extends { requires: readonly number[] } ? K : never }[keyof M]
  | { [K in keyof M]: M[K] extends { requiresRead: true } ? K : never }[keyof M]
  | { [K in keyof M]: M[K] extends { available: unknown } ? K : never }[keyof M];

/**
 * What a getter answers: a `decode`'s own return type when there is one, otherwise the narrowing of the
 * stored `type`. A decode IS the value a caller receives, so its type has to win — that is exactly the
 * case (`snoozeTime`, a duration lifted out of a config blob) where the stored type is not the answer.
 */
export type ReadValue<T> = T extends { decode: (...a: never[]) => infer R }
  ? Exclude<R, undefined>
  : T extends { type: infer P }
    ? ValueOf<P>
    : never;

/**
 * What a setter takes: the getter's own value, plus anything the member declares it {@link ValueMember.accepts} on
 * top — a name for a value stored as a number. The two are a union because both reach the same wire.
 */
export type WriteValue<T> = T extends { accepts: infer A } ? ReadValue<T> | A : ReadValue<T>;

/** `brightness` → `setBrightness`, unless the member names its own setter. */
export type SetterName<K extends string, T> = T extends { writeAs: infer W extends string } ? W : `set${Capitalize<K>}`;

/**
 * The bound `dev.<cap>()` object, derived from the member table.
 *
 * Getters are optional because they are evidence-gated at runtime — the device may never have reported
 * the param. A write is offered on any device with the capability unless the member gates it.
 *
 * Every branch maps over `keyof M` and filters in the `as` clause rather than over a pre-filtered key
 * union. The two describe the same keys, but only the first is HOMOMORPHIC, and a homomorphic mapped type
 * carries each member's JSDoc through to the projection — so hovering `dev.lock().lock()` in an editor
 * shows what the member table says about it. Mapping over `[K in MethodKeys<M>]` silently drops it, which
 * costs the derived surface the one thing a hand-written `*Actions` type still had over it.
 *
 * The provider branch matches STRUCTURALLY on the built function rather than on `ProvidedMember<P, F>`:
 * the provider sits in a contravariant position, so a nominal match against the union's provider type
 * never succeeds. A builder's falsy half is its way of DECLINING, which the optional `?` already says,
 * so it is stripped rather than leaking into what a caller holds after the guard.
 */
export type Surface<M extends Members> = {
  readonly [K in keyof M as K extends ValueKeys<M> ? K : never]?: ReadValue<M[K]>;
} & {
  [K in keyof M as K extends Exclude<WritableKeys<M>, ConditionalKeys<M>> & string ? SetterName<K, M[K]> : never]: (
    value: WriteValue<M[K]>,
  ) => Promise<void>;
} & {
  [K in keyof M as K extends Extract<WritableKeys<M>, ConditionalKeys<M>> & string ? SetterName<K, M[K]> : never]?: (
    value: WriteValue<M[K]>,
  ) => Promise<void>;
} & {
  [K in keyof M as K extends Exclude<ActionKeys<M>, ConditionalKeys<M>> & string ? K : never]: () => Promise<void>;
} & {
  [K in keyof M as K extends Extract<ActionKeys<M>, ConditionalKeys<M>> & string ? K : never]?: () => Promise<void>;
} & {
  [K in keyof M as K extends Exclude<MethodKeys<M>, ConditionalKeys<M>> ? K : never]: M[K] extends MethodMember<infer F>
    ? F
    : never;
} & {
  [K in keyof M as K extends Extract<MethodKeys<M>, ConditionalKeys<M>> ? K : never]?: M[K] extends MethodMember<
    infer F
  >
    ? F
    : never;
} & {
  [K in keyof M as K extends ProvidedKeys<M> ? K : never]?: M[K] extends {
    provided: (...args: never[]) => infer F;
  }
    ? Exclude<F, false | undefined>
    : never;
};

// ── the derived RUNTIME ─────────────────────────────────────────────────────────────────────────

/**
 * Resolve a member's enum options for a device, evaluating `enumValuesFor` at most once. Returns the
 * options and whether they came from the device context (`dynamic`), so a caller derives both the
 * option set and the enum `kind` from a single result. A context domain (`enumValuesFor(ctx)`) is
 * returned when present; absent that (or with no context) the static `enumValues`; a member with
 * neither yields no options.
 */
export function resolvedEnum(
  m: ValueMember,
  ctx?: AvailabilityContext,
): { values?: Record<number, string>; dynamic: boolean } {
  const dynamic = ctx ? m.enumValuesFor?.(ctx) : undefined;
  return dynamic ? { values: dynamic, dynamic: true } : { values: m.enumValues, dynamic: false };
}

/**
 * The property schema the rest of the model consumes, derived from the same table.
 *
 * A write-only member contributes nothing: the schema describes what a device REPORTS, and a setting it
 * accepts but never reports back has no state to publish. Its wire still reaches `setProperty` through
 * the member's own `write`.
 *
 * When `ctx` is given, a member's availability gate is applied (a gated-out member contributes no spec)
 * and its enum options are resolved for the device via {@link resolvedEnum}; a context-resolved domain
 * makes the spec's `kind` `"enum"` rather than the member's stored scalar kind. A throwing gate
 * propagates.
 */
export function propertiesOf(members: Members, ctx?: AvailabilityContext): PropertySpec[] {
  return Object.entries(members).flatMap(([name, m]) => {
    if (!("type" in m) || m.param === undefined || m.writeOnly) return [];
    if (ctx && m.available && !m.available(ctx)) return [];
    const primaryAvailable = !ctx || !m.readAvailable || m.readAvailable(ctx);
    const aliases = m.readAliases?.filter((alias) => !ctx || !alias.available || alias.available(ctx));
    const promoted = primaryAvailable ? undefined : aliases?.[0];
    if (!primaryAvailable && !promoted) return [];
    const { values: enumValues, dynamic } = resolvedEnum(m, ctx);
    return [
      {
        name: m.property ?? name,
        paramType: promoted?.paramType ?? m.param,
        type: m.type,
        kind: dynamic ? "enum" : m.kind,
        unit: m.unit,
        enumValues,
        provenance: m.provenance,
        invert: promoted?.invert ?? m.invert,
        decode: m.coerce,
        readAliases: aliases?.slice(promoted ? 1 : 0).map(({ paramType, invert }) => ({ paramType, invert })),
        writable: m.write !== undefined || m.writtenElsewhere === true,
        description: m.description,
      },
    ];
  });
}

/** What `asBool` gives meaning to — every other value would silently read as `false`. */
const BOOL_VALUES: ReadonlySet<unknown> = new Set([true, false, 0, 1, "0", "1", "true", "false"]);

/**
 * Build a member's wire for a value, or throw the reason it will not.
 *
 * The ONE write path: the fluent setter and the intent route both come through here, so the declared
 * domain is enforced once and refused with one message. Splitting them is how `setProperty` came to
 * report an out-of-range value as a device that lacks the feature while the setter beside it named the
 * set the value had to come from.
 * @internal
 */
export function memberWrite(
  name: string,
  m: ValueMember,
  value: boolean | number | string,
  ctx: CommandContext,
): Command {
  if (!inDomain(m, value)) throw new Error(rejection(name, m, value));
  const cmd = m.write?.(value, ctx);
  if (!cmd) throw new Error(rejection(name, m, value));
  return m.observation && m.param !== undefined
    ? observeCommand(cmd, {
        event: m.observation.event,
        expected: m.observation.expected(value),
        param: m.param,
        property: m.property ?? name,
        resetStandaloneSession: m.observation.resetStandaloneSession,
        timeoutMs: m.observation.timeoutMs,
      })
    : cmd;
}

/**
 * The option set the WRITE accepts, which is not always the one the READ reports.
 *
 * Three declarations can state it, checked in narrowing order. A member's own {@link ValueMember.args}
 * wins, because the only reason to state an argument's `values` beside an `enumValues` that already
 * publishes the read's set is that the two DIFFER: `arming` reports eight guard modes and can set only the
 * three whose wire was captured. Then {@link ValueMember.decodedValues}, for a getter whose set the
 * property schema cannot express, and last the schema's own `enumValues`.
 *
 * One source for all three consumers — the check, the generated refusal, and the argument a caller is
 * offered — so a caller is never shown a value it will then be refused for sending.
 */
function writeDomain(m: ValueMember): readonly (string | number)[] | undefined {
  return m.args?.[0]?.values ?? m.decodedValues ?? (m.enumValues && Object.keys(m.enumValues).map(Number));
}

/**
 * Whether a value falls in the domain the member PUBLISHES — the set {@link rejection} names.
 *
 * Enforced here rather than in each `write`, because a domain declared for the description and enforced
 * somewhere else is two copies: the 22 lambdas disagreed on the same declaration, some refusing an
 * out-of-range value and some clamping it, and one (`powerSource`) enforcing nothing at all — which on a
 * fire-and-forget wire sent a value the member's own message says is invalid and looked like success.
 *
 * Only a value of the STORED type is judged. A member may {@link ValueMember.accepts} more than its
 * getter answers — a resolution name for a tier stored as an int — and that vocabulary is the `write`'s
 * own, not something the published domain can state.
 *
 * A `bool` member declares no set, but it has one: `asBool` maps everything outside it to FALSE, so an
 * unchecked `setProperty("power", 999999)` reads as "turn it off" and, on a fire-and-forget wire, looks
 * like success. The values it accepts are the ones `asBool` gives meaning to.
 */
function inDomain(m: ValueMember, value: unknown): boolean {
  if (m.type === "bool") return BOOL_VALUES.has(typeof value === "string" ? value.toLowerCase() : value);
  if (typeof value === "number") {
    if (m.min !== undefined && value < m.min) return false;
    if (m.max !== undefined && value > m.max) return false;
  }
  const domain = writeDomain(m)?.filter((v) => typeof v === typeof value);
  return !domain?.length || domain.includes(value as string | number);
}

/**
 * Why a member refused a value, naming the set it had to come from when the schema publishes one.
 *
 * Generated rather than written per member: a hand-written message is one more copy of the domain, and
 * the copy is what goes stale when the set grows. It names the {@link writeDomain} rather than the read's
 * own set, so a mode the device reports but cannot be set is refused by naming the three that can — the
 * message and the offered argument answer from one declaration.
 */
function rejection(name: string, m: ValueMember, value: unknown): string {
  const options = writeDomain(m);
  const domain = options?.length
    ? `one of ${options.join("/")}`
    : m.min !== undefined && m.max !== undefined
      ? `in ${m.min}..${m.max}`
      : m.min !== undefined
        ? `>= ${m.min}`
        : undefined;
  return `${name}: ${JSON.stringify(value)} is not a valid value` + (domain ? ` (must be ${domain})` : "");
}

/**
 * The description a caller reads to offer a member as a control, derived from the member itself.
 *
 * `reflects` names the member's own accessor, but only where that accessor was actually installed:
 * {@link ActionSpec} states that a stateful action's reflected read IS its evidence gate, so naming a
 * read the device never reported would promise a control whose state a caller cannot show. A write-only
 * member has no state to reflect at all, and a member whose read is absent describes the same way —
 * still offerable, just not as a switch with a position.
 *
 * The argument defaults to the member's own kind and bounds, so a boolean switch and an enum picker
 * describe themselves with nothing declared. A member that names its own {@link ValueMember.args}
 * OVERRIDES only what it states — the derived domain survives underneath, which is what keeps
 * `videoQuality`'s tier set from vanishing when it renames its argument.
 *
 * The derived argument carries `decodedValues` but NOT `enumValues`, which the reflected read already
 * publishes; a second copy on the argument could only drift from it. So a caller offers the argument's own
 * set where it has one and the read's otherwise — the same precedence {@link writeDomain} enforces with,
 * which is what makes a stated `values` a NARROWING of the read rather than an unrelated second list.
 */
function describeWrite(name: string, m: ValueMember, reported: boolean): ActionSpec {
  const stateful = !m.writeOnly && reported;
  const derived: ActionArgSpec = {
    name,
    kind: m.decodedKind ?? m.kind ?? "text",
    ...(m.min === undefined ? {} : { min: m.min }),
    ...(m.max === undefined ? {} : { max: m.max }),
    ...(m.decodedValues ? { values: m.decodedValues } : {}),
  };
  return {
    form: stateful ? "stateful" : "momentary",
    reflects: stateful ? name : undefined,
    args: m.args ? m.args.map((a, i) => (i === 0 ? { ...derived, ...a } : a)) : [derived],
    description: m.description,
  };
}

/**
 * Attach a member's description to the function it built, so every member kind is discoverable through
 * `actionSpecOf` and not only the derived setters.
 *
 * A `method` or provider-backed member owns its whole signature, so the table cannot say what its
 * argument means the way {@link describeWrite} can for a value — but it can still say the method exists
 * and what it does. `momentary` is the honest form for both: neither reflects a read this table knows of.
 * Without this, `description` was required at 29 call sites and read at none, so a contributor writing
 * one believed they had described a method that reported itself undescribed.
 *
 * **An EMPTY argument list is derived from the function's arity**, which is the one thing the table can
 * read off a signature it did not write. Absent arguments only ever meant "not stated", so a caller could
 * not tell `lock()` — which genuinely takes none and is offerable as a plain button — from a method whose
 * arguments nobody has described yet. A function declaring no parameters says the former, and it cannot
 * drift, because the function IS the declaration.
 *
 * Two members are excluded from that derivation, each for its own reason. A DEFAULT parameter is invisible
 * to `length`, so a method that accepts one names it (see {@link MethodMember.args}) rather than being
 * derived as nullary. And a member that ANSWERS instead of acting ({@link MethodMember.answers}) takes no
 * arguments without being a control at all. Both leave the arguments unstated;
 * `action-specs.spec.ts` holds every stated required argument against the same arity.
 */
function describe(description: string, fn: unknown, m: { args?: readonly ActionArgSpec[]; answers?: true }): unknown {
  const built = fn as (...a: never[]) => unknown;
  const args = m.args ?? (built.length || m.answers ? undefined : []);
  return describedAction({ form: "momentary", description, args }, built);
}

/** Whether the device reported any of the params a member requires; `undefined` requires nothing. */
function reports(requires: readonly number[] | undefined, ctx: CommandContext): boolean {
  return !requires || requires.some((p) => ctx.paramIds.has(p));
}

/**
 * Narrow a stored property to the member's declared type, answering `undefined` on a mismatch rather
 * than lie-casting — the guard {@link ReadValue} promises a caller at compile time.
 *
 * A stored value is not always the declared type: `coerceByType` keeps a non-numeric wire value as the
 * raw string so the mismatch is visible in the log, and a param the dictionary declares `json`-encoded
 * is stored as a decoded object. Handing either through a getter typed `number` is the one lie this
 * table exists to prevent.
 */
function narrow(
  type: PropertyValueType,
  read: CapabilityStateReader,
  prop: string,
): boolean | number | string | undefined {
  if (type === "bool") return readBool(read, prop);
  if (type === "string") return readStr(read, prop);
  return readNum(read, prop);
}

/**
 * Whether the device reported the value this member reads — its evidence gate.
 *
 * A {@link ValueMember.readAliases} id counts as the same evidence as the member's own `param`: an alias
 * is the SAME value on another family's wire, and `Device` resolves one into this member's property, so a
 * device that reports only the alias does hold the state. Gating on `param` alone hid the read on exactly
 * the families the alias exists for — a standalone camera reports its power state on 2001, never 1035.
 */
function reads(
  m: Pick<ValueMember, "param" | "realtime" | "readAvailable" | "readAliases">,
  ctx: CommandContext,
): boolean {
  if (m.realtime === true) return true;
  if ((!m.readAvailable || m.readAvailable(ctx)) && m.param !== undefined && ctx.paramIds.has(m.param)) return true;
  return m.readAliases?.some((a) => (!a.available || a.available(ctx)) && ctx.paramIds.has(a.paramType)) === true;
}

/**
 * Both presence gates at once: the params a member requires, and its own {@link ValueMember.available}.
 *
 * Shared with the intent path, so `setProperty("alarmVolume", …)` is gated by exactly what decides
 * whether the fluent setter exists — one declaration, both entry points. Missing the `available` half
 * here would let the intent path build a HomeBase's station frame for an NVR.
 * @internal
 */
export function installs(
  m: {
    requires?: readonly number[];
    requiresRead?: true;
    available?: (c: CommandContext) => boolean;
    param?: number;
    realtime?: boolean;
    readAvailable?: ValueMember["readAvailable"];
    readAliases?: ValueMember["readAliases"];
  },
  ctx: CommandContext,
): boolean {
  return reports(m.requires, ctx) && (!m.requiresRead || reads(m, ctx)) && (!m.available || m.available(ctx));
}

/**
 * Bind the table: evidence-gated getters, derived setters, momentary actions.
 *
 * Three rules the loop enforces for every member, so no module restates them:
 *
 *  - **One evidence gate for every read, decoded or not.** A `decode` changes how a value is READ, never
 *    whether the device reports it, so gating only the plain branch would publish a getter for a param
 *    the device never sent — one answering `undefined` forever. `realtime` is the opt-out.
 *  - **A provider builder answering nothing DECLINES.** The provider is there but the member is not
 *    available on it (an optional method, or one the device gave no evidence for), so the member is
 *    ABSENT rather than a key holding `undefined` — `"talkback" in cam` has to mean the camera can talk.
 *    Any falsy answer counts, so a builder can guard with `&&` instead of spelling out a ternary.
 *  - **A derived setter never throws synchronously.** A builder may throw (arming's needs the account
 *    identity and says so by throwing) and a method returning `Promise<void>` must not surprise a caller
 *    chaining `.catch()`. Caught here once rather than in each module's own wrapper.
 *
 * A getter is skipped for a `writeOnly` or `unexposed` member, and a setter for an `unverified` one —
 * declared so the capability documents the device, never installed.
 */
export function bindMembers<M extends Members>(
  members: M,
  ctx: CommandContext,
  sink: CommandSink,
  read: CapabilityStateReader,
  media?: MediaProvider,
  rawDp?: RawDpCodec,
  ff09Settings?: Ff09SettingsReader,
): Surface<M> {
  const out: Record<string, unknown> = {};
  const deps: MemberDeps = { ctx, sink, read, rawDp, media };
  for (const [name, m] of Object.entries(members)) {
    if ("provided" in m) {
      if (!hasRequiredCapabilities(m, ctx.capabilities)) continue;
      const provider = m.needs === "media" ? media : ff09Settings;
      if (!provider) continue;
      const built = (m.provided as (p: unknown, d: MemberDeps) => unknown)(provider, deps);
      if (typeof built === "function") out[name] = describe(m.description, built, m);
      else if (built) out[name] = built;
      continue;
    }
    if ("method" in m) {
      if (installs(m, ctx)) out[name] = describe(m.description, m.method(deps), m);
      continue;
    }
    if ("action" in m) {
      if (installs(m, ctx)) out[name] = describe(m.description, () => sink.dispatch(m.action(ctx)), {});
      continue;
    }
    const prop = m.property ?? name;
    // One availability decision across getter, setter and manifest: a member gated off by `available`
    // for this device is not exposed as a getter either (the manifest already omits it).
    const available = !m.available || m.available(ctx);
    const reported = available && reads(m, ctx);
    if (reported && !m.writeOnly && !m.unexposed) {
      const decode = m.decode;
      const get = decode ? () => decode(read(prop)?.value, rawDp, ctx) : () => narrow(m.type, read, prop);
      Object.defineProperty(out, name, { get, enumerable: true, configurable: true });
    }
    if (!m.write || m.unverified || !installs(m, ctx)) continue;
    const setter = m.writeAs ?? `set${name[0].toUpperCase()}${name.slice(1)}`;
    out[setter] = describedAction(describeWrite(name, m, reported), (value: boolean | number | string) => {
      try {
        return sink.dispatch(memberWrite(name, m, value, ctx));
      } catch (e) {
        return Promise.reject(e);
      }
    });
  }
  Object.defineProperty(out, UNOBSERVABLE, { value: Object.freeze(unobservableOf(members, ctx)) });
  return out as Surface<M>;
}

/**
 * Carries the unobservable-member list out of band, so it never appears among a capability's own keys — it
 * describes the surface rather than being a member of it. Same device as `core/contracts`' command-observation
 * symbol: metadata a caller can read without it becoming part of the shape.
 */
const UNOBSERVABLE = Symbol("unobservable-members");

/**
 * The members this device accepts but never reports back, so a caller can tell "observed as off" from "cannot
 * be observed" instead of inferring it from a getter that is missing.
 *
 * `cam.privacy === undefined` reads identically for a device that reports the value as unset and one that
 * never reports it, and guessing between them is what a caller must not do: refusing a working camera
 * withdraws it, and allowing a dead one shows a viewer a stream that will never carry frames. This answers it.
 *
 * Empty for a capability with nothing write-only, and for a surface not built by {@link bindMembers}.
 */
export function unobservableMembers(surface: object): readonly string[] {
  return (surface as { [UNOBSERVABLE]?: readonly string[] })[UNOBSERVABLE] ?? [];
}

/**
 * The `writeOnly` members this device actually has — those `available` gates off for it are not among them.
 *
 * `unexposed` members are deliberately excluded. The device does report those — they are in the property
 * schema and reachable through `getProperty`; what is missing is a confirmed MEANING for the value, which is
 * a different thing from the value never being reported.
 */
function unobservableOf(members: Members, ctx: CommandContext): string[] {
  return Object.entries(members)
    .filter(([, m]) => "type" in m && m.writeOnly === true && (!m.available || m.available(ctx)))
    .map(([name]) => name);
}
