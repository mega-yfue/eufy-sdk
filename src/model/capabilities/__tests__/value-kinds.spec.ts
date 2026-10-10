import { CAPABILITY_MODULES } from "../index.js";
import type { CapabilityModule } from "../types.js";
import { borrowedBy } from "../members.js";
import type { ValueMember } from "../members.js";
import { isKnownValueKind } from "../../types.js";
import type { PropertySpec, ValueKind } from "../../types.js";

/**
 * The value-kind vocabulary is data every consumer switches on, so the rules that keep it honest are
 * spec'd rather than left to review. What this locks:
 *
 *  1. the kinds in use are the kinds we publish (a drift lock, same pattern as `EXPECTED_ACCESSORS`),
 *  2. `kind` and `unit` never disagree — including the direction that catches a unit left behind on a
 *     property whose kind says it is not that quantity (`lastSeen`, a timestamp declared `unit: "s"`),
 *  3. a `kind` never contradicts the `type` the value is actually stored as, which is what caught
 *     `snoozeTime` declaring a duration for a value the wire delivers as a config blob,
 *  4. a `kind: "enum"` always comes with the set it is one of, so a caller can render it,
 *  5. a member only re-declares a kind where the getter genuinely departs from the property — i.e.
 *     alongside a `decode`.
 *
 * The vocabulary itself is not restated here: `KnownValueKind` is derived from `KNOWN_VALUE_KINDS`, so
 * the type and the list a caller can enumerate are one declaration and rule 1 checks against that.
 */

/** The unit a kind must be paired with, both ways round. A kind absent here carries no unit at all. */
const UNIT_FOR_KIND: Record<string, string> = {
  percent: "%",
  celsius: "°C",
  dbm: "dBm",
  seconds: "s",
  hours: "h",
  minutes: "min",
  millimetres: "mm",
  megabytes: "MB",
  degrees: "°",
};

/** Kinds whose value is a number, so the stored value has to be one (unless a `decode` produces it). */
const NUMERIC_KINDS = new Set<ValueKind>([
  "percent",
  "celsius",
  "dbm",
  "seconds",
  "hours",
  "minutes",
  "millimetres",
  "megabytes",
  "degrees",
  "scalar",
  "bitfield",
  "timestamp",
]);

const MODULES: CapabilityModule[] = Object.values(CAPABILITY_MODULES);

/** Every `(module, property)` pair in the catalogue, labelled for a readable failure. */
const properties: { label: string; mod: CapabilityModule; spec: PropertySpec }[] = MODULES.flatMap((mod) =>
  mod.properties.map((spec) => ({ label: `${mod.capability}.${spec.name}`, mod, spec })),
);

/**
 * Every readable getter in the catalogue, as one list.
 *
 * The rules below are about what a caller READS, so a member is projected onto the fields they check:
 * `decodedKind`/`decodedValues` are how a member says what its GETTER means when that departs from the
 * stored property, and both are legal only alongside a `decode`.
 */
type Read = { kind?: ValueMember["decodedKind"]; values?: ValueMember["decodedValues"]; decode?: unknown };
const reads: { label: string; mod: CapabilityModule; read: Read; spec?: PropertySpec }[] = MODULES.flatMap((mod) =>
  Object.entries(mod.members ?? {})
    .flatMap(([name, m]) => ("type" in m ? [[name, m] as const] : []))
    .filter(([, m]) => !m.writeOnly && !m.unexposed)
    .map(([name, m]: readonly [string, ValueMember]) => {
      // A `readsFrom` member with no param of its own publishes no spec — it decodes a field of the
      // OWNER's stored payload, so the owner's spec is the stored property these rules are about. One
      // that DOES declare a param keeps its own spec and only borrows on the other device family, so
      // its own spec is the right one. Resolved the way `bindMembers` resolves the read.
      const borrowed = m.param !== undefined ? undefined : borrowedBy(m, mod.members ?? {});
      const specName = borrowed ? borrowed.property : (m.property ?? name);
      // The owner's spec is usually in this module, but a cross-module borrow puts it in another one on
      // the same line — the robot's network fields read `DeviceInfo`, which the dock capability owns.
      // Searched by name across the catalogue rather than within the module, because "which module
      // publishes it" is exactly what such a member does not know.
      const spec =
        mod.properties.find((p) => p.name === specName) ??
        (borrowed ? MODULES.flatMap((o) => o.properties).find((p) => p.name === specName) : undefined);
      return {
        label: `${mod.capability}.${name}`,
        mod,
        read: { kind: m.decodedKind, values: m.decodedValues, decode: m.decode },
        spec,
      };
    }),
);

describe("value kinds — the published vocabulary", () => {
  it("every declared kind is one we publish", () => {
    const declared = new Set<ValueKind>([
      ...properties.flatMap(({ spec }) => (spec.kind ? [spec.kind] : [])),
      ...reads.flatMap(({ read }) => (read.kind ? [read.kind] : [])),
    ]);
    expect([...declared].filter((k) => !isKnownValueKind(k))).toEqual([]);
  });

  /**
   * Every value a caller can actually READ carries a kind — on the property, or on the read itself when
   * the getter departs from the property (a payload it decodes a field out of). A property with no read
   * is exempt: nothing surfaces it, so there is nothing to describe and a kind would be a guess.
   */
  it.each(reads)("$label carries a kind, on the read or on its property", ({ read, spec }) => {
    expect(read.kind ?? spec?.kind).toBeDefined();
  });
});

describe("value kinds — kind, unit and type agree", () => {
  it.each(properties)("$label pairs its kind with the matching unit", ({ spec }) => {
    expect(spec.unit).toBe(spec.kind ? UNIT_FOR_KIND[spec.kind] : undefined);
  });

  it.each(properties)("$label declares kind boolean exactly when it is stored as a bool", ({ spec }) => {
    expect(spec.kind === "boolean").toBe(spec.type === "bool");
  });

  it.each(properties.filter(({ spec }) => spec.kind && NUMERIC_KINDS.has(spec.kind)))(
    "$label is stored as a number, as its numeric kind claims",
    ({ spec }) => {
      expect(["number", "enum"]).toContain(spec.type);
    },
  );

  it.each(properties.filter(({ spec }) => spec.kind === "enum"))("$label ships the set it is one of", ({ spec }) => {
    expect(Object.keys(spec.enumValues ?? {}).length).toBeGreaterThan(0);
  });
});

describe("value kinds — a read only re-declares what it changes", () => {
  it.each(reads)("$label annotates kind/values only alongside a decode", ({ read }) => {
    if (read.kind === undefined && read.values === undefined) return;
    expect(read.decode).toBeTypeOf("function");
  });

  it.each(reads.filter(({ read }) => read.kind === "enum"))("$label ships the set it is one of", ({ read }) => {
    expect(read.values?.length).toBeGreaterThan(0);
  });

  /**
   * The escape hatch for the property-level type rule, and the reason it stays honest: a read may promise
   * a number over a property stored as something else ONLY because its own decode produces one.
   */
  it.each(reads.filter(({ read }) => read.kind && NUMERIC_KINDS.has(read.kind)))(
    "$label produces its numeric kind from a decode rather than the stored type",
    ({ read, spec }) => {
      expect(read.decode).toBeTypeOf("function");
      expect(spec).toBeDefined();
    },
  );
});
