import { buildActions, CAPABILITY_MODULES } from "../index.js";
import { actionSpecOf, camelCase } from "../access.js";
import { bind } from "./bind.js";
import { isKnownValueKind } from "../../types.js";
import { codecForType } from "../../classify.js";
import type { Codec } from "../../types.js";
import type { ActionArgSpec, ActionSpec, CapabilityActions, CapabilityModule, CommandContext } from "../types.js";
import type { CommandSink, Ff09SettingsReader, MediaProvider, RawDpCodec } from "../../../core/contracts.js";
import type { Surface } from "../members.js";

/**
 * A description is what turns a callable method into an offerable control, so the rules that keep one
 * from lying are spec'd rather than left to review. What this locks:
 *
 *  1. a description describes a WRITE, never a read-shaped method living on the same object,
 *  2. `reflects` names a real read of the same capability — which for a control is true by construction,
 *     and is checked here because a hand-written description can still get it wrong,
 *  3. a stateful action always reflects something, so a control can show its own state,
 *  4. every argument is described in the published value vocabulary, and a fixed-set argument always has
 *     a domain — on the argument or on the property behind its read,
 *  5. nothing is gated on being described: a module installs more actions than it describes,
 *  6. which modules describe anything is a ratchet — coverage grows by a conscious edit, never by accident,
 *  7. every property the schema publishes as `writable` has a setter a caller can actually reach.
 *
 * Read off a BUILT object, the only place a caller can read it: a control's setter is derived by the
 * barrel and a hand-written one carries its description on the method, so neither exists in the module
 * as a table to inspect. That is also what makes "the described method exists" unfalsifiable here — a
 * renamed method takes its description with it.
 */
/** Every module with a bindable surface — a pure-detection capability has no action object to read. */
const MODULES: CapabilityModule[] = Object.values(CAPABILITY_MODULES).filter((m) => m.actions || m.members);

/**
 * The modules describing at least one action. Coverage is deliberately partial (an action stays callable
 * without a description), so this list is what makes adding — or silently dropping — a wave visible.
 *
 * `locate`, `lock` and `ptz` describe momentary/method members rather than value setters: a `method`- or
 * provider-backed member owns its whole signature, so the table can only say the method exists and what
 * it does — which is still a description, and is why they joined the list.
 */
const DESCRIBED_MODULES = [
  "arming",
  "audio",
  "battery",
  "doorbell",
  "camera",
  "contact",
  "light",
  "locate",
  "lock",
  "motion",
  "ptz",
  "rtsp",
  "siren",
  "smart_drop",
  "smart_light",
  "suction",
  "vacuum_clean",
] as const;

const sink: CommandSink = { dispatch: async () => undefined };
const FALLBACK_CODECS: readonly Codec[] = [
  "sensor",
  "station",
  "lock",
  "keypad",
  "vacuum",
  "mower",
  "light",
  "printer",
];

/**
 * Build a module's action object with every optional provider present and every backing param reported,
 * so an action can only be missing because it isn't installed at all. The providers are empty fakes:
 * nothing here calls an action, it only reads what is attached to one. The default camera context
 * preserves the catalogue-wide baseline; a module that installs nothing there retries its declared
 * device type, then codecs admitted by its own custom detection predicate.
 */
const built = (m: CapabilityModule): CapabilityActions => {
  const ctx: CommandContext = {
    channel: 0,
    codec: "camera",
    category: "eufy_home",
    paramIds: new Set(m.properties.map((p) => p.paramType)),
    capabilities: new Set([m.capability, "snapshot"]),
  };
  const bindContext = (context: CommandContext): CapabilityActions => {
    const actions = buildActions([m.capability], {
      ctx: context,
      sink,
      read: () => undefined,
      media: { snapshotStored: async () => Buffer.alloc(0) } as MediaProvider,
      ff09Settings: {} as Ff09SettingsReader,
      rawDp: {} as RawDpCodec,
    });
    return actions[camelCase(m.capability) as keyof typeof actions] as CapabilityActions;
  };
  const installsAction = (actions: CapabilityActions): boolean =>
    Object.values(Object.getOwnPropertyDescriptors(actions)).some(
      (descriptor) => typeof descriptor.value === "function",
    );
  const initial = bindContext(ctx);
  if (installsAction(initial)) return initial;
  const deviceType = m.detection?.deviceTypes?.[0];
  if (deviceType !== undefined) {
    const typed = bindContext({ ...ctx, codec: codecForType(deviceType) ?? ctx.codec, deviceType });
    if (installsAction(typed)) return typed;
  }
  const params = Object.fromEntries([...ctx.paramIds].map((param) => [param, "1"]));
  for (const codec of FALLBACK_CODECS) {
    if (m.detection?.detect?.({ params }, codec) !== true) continue;
    const candidate = bindContext({ ...ctx, codec });
    if (installsAction(candidate)) return candidate;
  }
  return initial;
};

/**
 * The installed ACTIONS of a built object: a data property whose value is a function. Read through the
 * descriptors rather than `Object.entries`, which would invoke every read getter — the same reason a
 * caller enumerating a device must never spread one.
 */
const installedActions = (obj: CapabilityActions): [string, unknown][] =>
  Object.entries(Object.getOwnPropertyDescriptors(obj))
    .filter(([, d]) => typeof d.value === "function")
    .map(([name, d]) => [name, d.value]);

/**
 * Every described `(module, action)` pair in the catalogue, labelled for a readable failure. The built
 * function is carried along because its arity is what "takes no arguments" is checked against.
 */
const specs: { label: string; mod: CapabilityModule; name: string; spec: ActionSpec; arity: number }[] =
  MODULES.flatMap((mod) =>
    installedActions(built(mod)).flatMap(([name, fn]) => {
      const spec = actionSpecOf(fn);
      return spec ? [{ label: `${mod.capability}.${name}`, mod, name, spec, arity: (fn as () => void).length }] : [];
    }),
  );

/** Every described `(module, action, argument)` triple, so an argument failure names the argument. */
const args: { label: string; mod: CapabilityModule; spec: ActionSpec; arg: ActionArgSpec }[] = specs.flatMap(
  ({ label, mod, spec }) => (spec.args ?? []).map((arg) => ({ label: `${label}(${arg.name})`, mod, spec, arg })),
);

/**
 * The read an action reflects, or `undefined` — the join every rule below hangs off.
 */
const reflected = (
  mod: CapabilityModule,
  spec: ActionSpec,
): { property?: string; values?: readonly (string | number)[] } | undefined => {
  if (!spec.reflects) return undefined;
  const member = mod.members?.[spec.reflects];
  if (member && "param" in member) return { property: member.property ?? spec.reflects, values: member.decodedValues };
  return undefined;
};

/** Every value the reflected read can report — its decoded set, or the property schema's own labels. */
const readDomain = (mod: CapabilityModule, spec: ActionSpec): readonly (string | number)[] | undefined => {
  const read = reflected(mod, spec);
  if (read?.values) return read.values;
  const property = mod.properties.find((p) => p.name === read?.property);
  return property?.enumValues && Object.keys(property.enumValues).map(Number);
};

/**
 * The accessors a module READS under. A member table also holds momentary actions and methods, which are writes living beside the reads — so the reads are the value members that survive to
 * the surface as a getter, exactly what {@link Surface} installs one for.
 */
const readAccessors = (mod: CapabilityModule): string[] => [
  ...Object.entries(mod.members ?? {})
    .filter(([, m]) => "type" in m && !m.writeOnly && !m.unexposed)
    .map(([name]) => name),
];

describe("described actions — what carries a description", () => {
  it.each(specs)("$label describes a write, not a read", ({ mod, name }) => {
    expect(readAccessors(mod)).not.toContain(name);
  });

  it("describes exactly the modules on the coverage list", () => {
    const described = new Set(specs.map(({ mod }) => mod.capability));
    expect([...described].sort()).toEqual([...DESCRIBED_MODULES].sort());
  });
});

describe("described actions — what a stateful one reflects", () => {
  it.each(specs.filter(({ spec }) => spec.form === "stateful"))("$label reflects a read", ({ spec }) => {
    expect(spec.reflects).toBeDefined();
  });

  it.each(specs.filter(({ spec }) => spec.reflects))(
    "$label reflects a read of its own capability",
    ({ mod, spec }) => {
      expect(reflected(mod, spec)).toBeDefined();
    },
  );

  /**
   * The same guarantee for the member table — a write-only member has no state to reflect.
   *
   * `available`-gated members are excluded: the gates are MUTUALLY EXCLUSIVE (audio's camera half and
   * its HomeBase half), so no single ctx installs both and `built()` can only ever be one device.
   */
  it.each(
    MODULES.flatMap((mod) =>
      Object.entries(mod.members ?? {})
        .filter(([, m]) => "write" in m && m.write && !m.writeOnly && !m.unverified && !("available" in m))
        .map(([name, m]) => ({ mod, name, member: m as { writeAs?: string } })),
    ),
  )("$mod.capability.$name derives a setter that reflects itself", ({ mod, name, member }) => {
    const setter = member.writeAs ?? `set${name[0].toUpperCase()}${name.slice(1)}`;
    expect(actionSpecOf(built(mod)[setter])?.reflects).toBe(name);
  });

  /**
   * A reflected read IS the action's evidence gate, so naming one the device never reported would promise
   * a control whose position a caller cannot show — and rule 3 above would then be a lie for exactly the
   * devices that lack the param. Still offerable, just not as a switch with a state.
   */
  it("omits reflects — and is momentary — when the read was not installed", () => {
    const unreported: CommandContext = { channel: 0, codec: "camera", paramIds: new Set() };
    const { acts } = bind<Record<string, unknown>>("camera", unreported);
    expect("imageFlipped" in acts).toBe(false);
    expect(actionSpecOf(acts.setImageFlipped)).toMatchObject({ form: "momentary" });
    expect(actionSpecOf(acts.setImageFlipped)!.reflects).toBeUndefined();
  });

  /**
   * A `method` or provider-backed member owns its whole signature, so the table cannot say what its
   * argument means — but it can still say the method exists and what it does, and a caller offering
   * controls reads both through the same accessor.
   */
  it("describes a method-backed and a provider-backed member too, not only derived setters", () => {
    const ptz = built(CAPABILITY_MODULES.ptz);
    expect(actionSpecOf(ptz.rotate)).toMatchObject({ form: "momentary", description: expect.any(String) });
    const camera = built(CAPABILITY_MODULES.camera);
    expect(actionSpecOf(camera.snapshotStored)).toMatchObject({ form: "momentary", description: expect.any(String) });
  });
});

describe("described actions — arguments a caller can solicit a value for", () => {
  it.each(args)("$label declares a kind we publish", ({ arg }) => {
    expect(isKnownValueKind(arg.kind)).toBe(true);
  });

  it.each(args)("$label names its arguments once, within bounds", ({ spec, arg }) => {
    expect(spec.args!.filter((a) => a.name === arg.name)).toHaveLength(1);
    if (arg.min !== undefined && arg.max !== undefined) expect(arg.min).toBeLessThanOrEqual(arg.max);
  });

  /**
   * A fixed-set argument needs the set from SOMEWHERE, or a caller renders a picker with nothing to pick.
   * The reflected read's property is the preferred source — it already publishes `enumValues`, so the arg
   * omits its own copy rather than shipping a second one that can drift.
   */
  it.each(args.filter(({ arg }) => arg.kind === "enum"))("$label has a domain to offer", ({ mod, spec, arg }) => {
    const domain = arg.values?.length || readDomain(mod, spec)?.length;
    expect(domain).toBeGreaterThan(0);
  });

  /**
   * An argument that states its own `values` beside a read that publishes a set is narrowing that set, not
   * replacing it — `arming` reads eight guard modes and can set the three whose wire was captured. Offering
   * a value the read cannot report would be the inverse mistake, and a worse one: a picker entry for a state
   * the device will never show back.
   */
  it.each(args.filter(({ arg, spec }) => arg.values && spec.reflects))(
    "$label offers a subset of what its read reports",
    ({ mod, spec, arg }) => {
      const domain = readDomain(mod, spec);
      if (domain) expect(domain).toEqual(expect.arrayContaining([...arg.values!]));
    },
  );

  /**
   * An EMPTY argument list means "takes none" and absent means "not stated" — the distinction a caller
   * needs to tell an offerable button from a method nobody has described yet. Arity is what keeps the two
   * honest, and it is the reason a stated list is checked against it in BOTH directions: a required
   * argument added to a nullary method makes the derived `[]` a lie, and one removed makes a stated
   * argument point at nothing.
   *
   * Optional arguments are excluded from the count because a default parameter is invisible to
   * `Function.length` — which is exactly why a method with one has to name it (`locate`).
   */
  it.each(specs.filter(({ spec }) => spec.args))(
    "$label states as many required arguments as it takes",
    ({ spec, arity }) => {
      expect(spec.args!.filter((a) => !a.optional)).toHaveLength(arity);
    },
  );

  /**
   * A member that ANSWERS rather than acts takes no arguments without being a control — `ptz.preset()`
   * hands back the namespace its verbs live on, `lock.getAutoLockState()` a snapshot. Deriving `[]` for
   * those would render a button that calls them and discards the result, so they stay unstated, which is
   * the same signal every other un-offerable method gives.
   */
  const answering = (mod: CapabilityModule, name: string): boolean =>
    (mod.members?.[name] as { answers?: true } | undefined)?.answers === true;

  it.each(specs.filter(({ mod, name }) => answering(mod, name)))(
    "$label states no arguments — it answers",
    ({ spec }) => {
      expect(spec.args).toBeUndefined();
    },
  );

  /**
   * Every OTHER action taking no required argument says so: it takes none at all (the derived `[]`) or
   * every argument it takes is one a default hides from arity, and it names them. Silence there is the
   * ambiguity this closes — a caller could not tell `lock()` from a method awaiting a description.
   */
  it.each(specs.filter(({ arity, mod, name }) => arity === 0 && !answering(mod, name)))(
    "$label states what it takes, rather than staying silent",
    ({ spec }) => {
      expect(spec.args).toBeDefined();
      expect(spec.args!.every((a) => a.optional)).toBe(true);
    },
  );
});

describe("described actions — nothing is gated on being described", () => {
  /**
   * The load-bearing non-property: what a device can do is decided by the member table and `actions()`,
   * never by a description. If any of them consulted one, an undescribed action would
   * silently vanish from a device that can perform it.
   *
   * Asserted over the CATALOGUE rather than per module: a module whose every write is a described member
   * legitimately describes all of them (`battery` does), so a per-module `installed > described` would
   * fail on exactly the modules that finished migrating. What has to stay true is that being described is
   * not a precondition anywhere — i.e. undescribed actions are installed and callable.
   */
  it("installs actions that carry no description at all", () => {
    const installed = MODULES.flatMap((mod) => installedActions(built(mod)));
    const undescribed = installed.filter(([, fn]) => !actionSpecOf(fn));
    expect(undescribed.length).toBeGreaterThan(0);
  });

  /** And every described module really does install the actions it describes — coverage is not empty. */
  it.each(MODULES.filter((m) => DESCRIBED_MODULES.includes(m.capability as (typeof DESCRIBED_MODULES)[number])))(
    "$capability installs every action it describes",
    (mod) => {
      const installed = installedActions(built(mod));
      const described = installed.filter(([, fn]) => actionSpecOf(fn));
      expect(described.length).toBeGreaterThan(0);
      expect(installed.length).toBeGreaterThanOrEqual(described.length);
    },
  );
});

/** Every installed setter that drives a `bool` member, labelled by the module that declares it. */
const boolSetters: { label: string; setter: (v: unknown) => Promise<void> }[] = MODULES.flatMap((mod) => {
  const acts = built(mod) as Record<string, (v: unknown) => Promise<void>>;
  return Object.entries(mod.members ?? {})
    .filter(([, m]) => "type" in m && m.type === "bool" && m.write !== undefined && !m.unverified)
    .map(([key, m]) => ({
      key,
      name: (m as { writeAs?: string }).writeAs ?? `set${key[0].toUpperCase()}${key.slice(1)}`,
    }))
    .filter(({ name }) => typeof acts[name] === "function")
    .map(({ key, name }) => ({ label: `${mod.capability}.${key} (${name})`, setter: acts[name] }));
});

/**
 * A `bool` member declares no `enumValues`, so nothing in the published domain bounds it — but `asBool`
 * does: every value outside the set it recognises becomes `false`. Unchecked, `setProperty("power", 12)`
 * reads as "turn it off" and, on a fire-and-forget wire, is indistinguishable from success.
 */
describe("a bool member refuses a value asBool would silently read as false", () => {
  it.each(boolSetters)("$label", async ({ setter }) => {
    await expect(setter(999999)).rejects.toThrow(/is not a valid value/);
    await expect(setter("yes")).rejects.toThrow(/is not a valid value/);
  });

  it.each(boolSetters)("$label still takes every value asBool gives meaning to", async ({ setter }) => {
    for (const ok of [true, false, 0, 1, "0", "1", "true", "false"]) {
      await setter(ok).catch((e: Error) => {
        expect(e.message).not.toMatch(/is not a valid value/);
      });
    }
  });
});

/** Every `writable` PropertySpec in the catalogue, labelled by the module that publishes it. */
const writables: { label: string; mod: CapabilityModule; property: string }[] = MODULES.flatMap((mod) =>
  mod.properties
    .filter((p) => p.writable)
    .map((p) => ({ label: `${mod.capability}.${p.name}`, mod, property: p.name })),
);

/**
 * A member whose own `write` reaches this property name — in ANY module, since one setting is sometimes
 * published by the capability that reads it and written by the one that owns the wire (a doorbell's
 * ringtone volume is written by `audio`).
 *
 * Checked over the member TABLES rather than by calling `buildCommand`, so the answer does not depend on
 * picking a value inside each member's declared domain.
 */
const writtenByAMember = (property: string): boolean =>
  MODULES.some((mod) =>
    Object.entries(mod.members ?? {}).some(
      ([key, m]) =>
        "write" in m &&
        m.write !== undefined &&
        !m.unverified &&
        ((m.property ?? key) === property || m.intentNames?.includes(property) === true),
    ),
  );

/**
 * The setter for a property no member's `write` can drive, and the name it goes by.
 *
 * These are the `writtenElsewhere` cases a name cannot be derived for: a two-frame pair, a momentary
 * trigger whose argument is optional, a pair of opposite verbs, and a level validated against the model's
 * own range. Listing them is what makes the flag falsifiable — the named function has to exist on the
 * bound surface, and an entry that no longer answers for a `writtenElsewhere` property fails too.
 */
const SETTER_ELSEWHERE: Record<string, string> = {
  "rtsp.recordingMode": "setRecordingMode",
  "locate.locating": "locate",
  "lock.locked": "lock",
  // Both halves of the doorbell's param 1705 (live-view quality + encoding format) must be written
  // together, so `videoQuality` is `writtenElsewhere` via setVideoQuality, which takes both.
  "doorbell.videoQuality": "setVideoQuality",
};

describe("published schema — every writable property has a reachable setter", () => {
  it.each(writables)("$label is settable, not writable-in-name-only", ({ mod, property }) => {
    const named = SETTER_ELSEWHERE[`${mod.capability}.${property}`];
    const reachable = writtenByAMember(property) || (named !== undefined && typeof built(mod)[named] === "function");
    expect(reachable).toBe(true);
  });

  it("names an elsewhere-setter only for a property that still needs one", () => {
    const needed = writables.filter(({ property }) => !writtenByAMember(property)).map(({ label }) => label);
    expect(Object.keys(SETTER_ELSEWHERE).sort()).toEqual(needed.sort());
  });
});
