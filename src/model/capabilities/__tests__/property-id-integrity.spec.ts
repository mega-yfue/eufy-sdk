import { CAPABILITY_MODULES } from "../index.js";
import { SECURITY_PARAMS, CLEAN_PARAMS, DISPLAY_PARAMS, MOWER_PARAMS } from "../../param-dictionary.js";
import { namespaceForCodec } from "../../param-namespace.js";
import { LIFE_PARAMS } from "../../life-params.js";
import type { CapabilityModule } from "../types.js";
import type { ValueMember } from "../members.js";

/**
 * Cross-module property-id integrity — the general form of the guard the siren fix needed locally.
 *
 * A capability property is a claim that a wire id carries a given meaning. Two ways that claim rots:
 *  1. it points at an id NO param dictionary knows (a `provenance:"guessed"` number nobody has
 *     grounded), so nothing schema-driven ever validates it; or
 *  2. it points at an id ANOTHER capability in the same product line already owns for a different
 *     meaning — the one-owner rule — so a device reports one and both capabilities read it, and one of
 *     them lies (e.g. a pan-tilt cam flipping the image reads back as a tilt angle).
 *
 * The siren fix caught this class for one module; iterating every module catches it everywhere and,
 * crucially, stops a NEW property from joining the debt silently. The pre-existing offenders are
 * enumerated below as explicit, tracked debt — not to bless them, but so any addition beyond this list
 * fails here and forces a conscious decision. Emptying these lists (grounding the ids / repointing the
 * collisions) is follow-up work, some of it needing on-device confirmation.
 */

const KNOWN_IDS = new Set<number>([
  ...Object.keys(SECURITY_PARAMS).map(Number),
  ...Object.keys(CLEAN_PARAMS).map(Number),
  ...Object.keys(LIFE_PARAMS).map(Number),
  ...Object.keys(DISPLAY_PARAMS).map(Number),
  ...Object.keys(MOWER_PARAMS).map(Number),
]);

/**
 * Property ids not in ANY param dictionary, each labelled with why.
 *
 * Most are `guessed` numbers nobody has grounded: they need a dictionary entry once confirmed on a
 * real device, or removal. TODO: ground or drop those; the goal is an empty map.
 *
 * A verified id can also land here, for the opposite reason: unreachable by the source the dictionary
 * is built from rather than ungrounded. Each such entry says so beneath itself.
 */
const KNOWN_UNLISTED = new Map<number, string>([
  [1612, "motion.testMode — verified on the P2P path only, absent from the cloud record"],
  [
    11450,
    "rtsp.url — the device-reported RTSP URL, a synthetic id (the string rides 1145 inbound, which the publish bool owns); P2P-notify only, never in the cloud record",
  ],
  // Not the same debt as the guessed ids below. This one is verified — replayed live, and the station
  // reports it back — but it rides the P2P notify path and never appears in the cloud record. The
  // dictionary's `observed` means "seen on a real owned device in the sweep" and the sweep reads that
  // record, so a dictionary entry could claim it only by stretching the word, leaving the field wrong
  // for every later reader. Closing this needs `observed` widened to cover the P2P path — a shared
  // invariant, so its own change rather than a capability's.
  [1014, "person_detection.personDetection — guessed"],
  [1016, "person_detection.personDetected — guessed"],
  [1560, "leak.leakDetected — guessed"],
  [1561, "smoke.smokeDetected — guessed"],
  [1562, "co.coDetected — guessed"],
  [2010, "storage.sdCard — guessed"],
  [1132, "storage.storageTotal — guessed"],
]);

/**
 * Params legitimately READ by more than one capability with the SAME meaning — a device-wide reading
 * (battery, signal, last-seen) that several capabilities surface. These are not one-owner violations.
 */
const SHARED_READS = new Set<number>([
  1101, // battery level
  1103, // battery-low
  1141, // rssi
  1551, // lastSeen
]);

type Mod = CapabilityModule & { line?: string };

describe("property id integrity (cross-module)", () => {
  it("every property of every module has a string name + numeric paramType", () => {
    const offenders: string[] = [];
    for (const [cap, m] of Object.entries(CAPABILITY_MODULES)) {
      for (const p of (m as Mod).properties ?? []) {
        if (typeof p.name !== "string" || typeof p.paramType !== "number") {
          offenders.push(`${cap}.${String(p.name)} → ${String(p.paramType)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every property paramType is in a param dictionary (or explicitly quarantined as debt)", () => {
    const offenders: string[] = [];
    for (const [cap, m] of Object.entries(CAPABILITY_MODULES)) {
      for (const p of (m as Mod).properties ?? []) {
        if (!KNOWN_IDS.has(p.paramType) && !KNOWN_UNLISTED.has(p.paramType)) {
          offenders.push(`${cap}.${p.name} → ${p.paramType} (${p.provenance ?? "guessed"})`);
        }
      }
    }
    // A new property pointing at an unknown id must ground it in the dictionary or add it to
    // KNOWN_UNLISTED on purpose — it cannot land silently.
    expect(offenders).toEqual([]);
  });

  it("no param is owned by two capabilities in the same product line (one-owner rule)", () => {
    // key = `${line}/${namespace}:${paramType}`; a real device reports one id, so two same-line
    // capabilities reading it in one id space means one is wrong. A line can hold more than one space
    // (the clean line's vacuums and mowers number their DPs independently), and a module bound to a
    // codec reads that codec's space. Only same-meaning shared reads are exempt.
    const owners = new Map<string, string[]>();
    for (const [cap, m] of Object.entries(CAPABILITY_MODULES)) {
      const line = (m as Mod).line ?? "security";
      const codecs = (m as Mod).detection?.codecs ?? [];
      const spaces = new Set(codecs.map((c) => namespaceForCodec(c)));
      const space = spaces.size === 1 ? [...spaces][0] : line;
      for (const p of (m as Mod).properties ?? []) {
        const key = `${line}/${space}:${p.paramType}`;
        owners.set(key, [...(owners.get(key) ?? []), `${cap}.${p.name}`]);
      }
    }
    const collisions = [...owners.entries()]
      .filter(([, v]) => v.length > 1)
      .filter(([key]) => {
        const id = Number(key.split(":").at(-1));
        return !SHARED_READS.has(id);
      })
      .map(([key, v]) => `${key} claimed by ${v.join(", ")}`);
    expect(collisions).toEqual([]);
  });

  it("a `readsFrom` member borrows a real owner's payload, and never grows a write for it", () => {
    // The counterpart to the one-owner rule above, and the reason that rule needs no exception: several
    // members reading different fields of ONE payload are not two capabilities disagreeing about an id.
    //
    // A member with NO param of its own must publish no spec for the borrowed one — `Device` keys stored
    // params by id and keeps the first spec that claims one, so a second spec would leave that getter
    // reading a name nothing is ever stored under, `undefined` forever and silently. `propertiesOf`
    // enforces that structurally by skipping any paramless member.
    //
    // A member WITH a param is a different case and is allowed one: it keeps its own wire and its own
    // spec, and only reaches into the owner's payload on a device that did not report that wire. That is
    // how one property spans both clean lines. What stays forbidden in both shapes is a WRITE — setting
    // a field inside a shared message means re-encoding the whole thing, so the owner keeps that wire.
    const offenders: string[] = [];
    for (const [cap, m] of Object.entries(CAPABILITY_MODULES)) {
      const members = (m as Mod).members;
      if (!members) continue;
      for (const [name, member] of Object.entries(members)) {
        const v = member as ValueMember;
        if (v.readsFrom === undefined) continue;
        const where = `${cap}.${name}`;

        let owner: ValueMember | undefined;
        if (typeof v.readsFrom === "string") {
          owner = members[v.readsFrom] as ValueMember | undefined;
          if (!owner) offenders.push(`${where} → readsFrom "${v.readsFrom}", which is not a member here`);
          else if (owner.param === undefined) offenders.push(`${where} → owner "${v.readsFrom}" declares no param`);
          else if (owner.readsFrom !== undefined) offenders.push(`${where} → owner "${v.readsFrom}" is itself derived`);
        } else {
          // The cross-module form states a property name and the param carrying it, because the member
          // cannot see the other module's table. Both halves are checked against the LINE's real owner:
          // a rename or a repointed id on the far side must fail here rather than leave this member
          // reading a name nothing is stored under — `undefined` forever and silently, which is the
          // exact failure this whole guard exists to catch.
          const { property, param } = v.readsFrom;
          const line = (m as Mod).line ?? "security";
          const real = Object.entries(CAPABILITY_MODULES)
            .filter(([, o]) => ((o as Mod).line ?? "security") === line)
            .flatMap(([oc, o]) => ((o as Mod).properties ?? []).map((sp) => [oc, sp] as const))
            .filter(([, sp]) => sp.name === property);

          if (real.length === 0)
            offenders.push(`${where} → readsFrom property "${property}", owned by nothing in line "${line}"`);
          else if (real.length > 1)
            offenders.push(
              `${where} → readsFrom property "${property}", claimed by ${real.map(([oc, sp]) => `${oc}.${sp.name}`).join(", ")}`,
            );
          else if (real[0]![1].paramType !== param) {
            offenders.push(
              `${where} → readsFrom { "${property}", ${param} } but ${real[0]![0]} owns it on ${real[0]![1].paramType}`,
            );
          } else if (real[0]![0] === cap) {
            offenders.push(
              `${where} → readsFrom "${property}" cross-module, but it is owned right here — name the sibling instead`,
            );
          }
        }
        // The borrowed value is a field of someone else's message; only a decode can reach it.
        if (v.decode === undefined) offenders.push(`${where} → readsFrom without a decode`);
        // Never a write, whichever shape: the owner keeps the wire the payload rides on.
        if (v.write !== undefined) offenders.push(`${where} → readsFrom AND a write`);
        // A member must not claim the OWNER's id as its own — that is the two-specs-one-param failure.
        const ownerParam = owner?.param ?? (typeof v.readsFrom === "string" ? undefined : v.readsFrom.param);
        if (ownerParam !== undefined && v.param === ownerParam) {
          offenders.push(`${where} → readsFrom ${JSON.stringify(v.readsFrom)} AND claims its param ${v.param}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the siren fix specifically holds: its ids are all dictionary-grounded, none quarantined", () => {
    // The module this guard was generalized from must itself be clean — a regression check that the
    // siren ids never slip back into the debt list.
    const siren = CAPABILITY_MODULES["siren"] as Mod;
    for (const p of siren.properties ?? []) {
      expect(KNOWN_IDS.has(p.paramType)).toBe(true);
      expect(KNOWN_UNLISTED.has(p.paramType)).toBe(false);
    }
  });
});
