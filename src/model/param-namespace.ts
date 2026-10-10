/**
 * Param namespaces — which id space a device's reported `paramType`s live in.
 *
 * The three spaces overlap numerically and mean unrelated things, so a lookup MUST be namespaced: id
 * `163` is `battery` as a vacuum Tuya DP and `lightLength` as a `eufy_life` DP tag. Resolving a param
 * without its namespace is how one product line's state silently reads as another's.
 *
 * This lives outside `param-dictionary.ts` so the namespace union and the dispatch stay one small table
 * a reader can hold at once, next to the guard that a codec resolves to exactly one namespace — rather
 * than at the head of two thousand entries.
 *
 * @module model/param-namespace
 */
import type { Codec } from "./types.js";
import { SECURITY_PARAMS, CLEAN_PARAMS, MOWER_PARAMS, type ParamDef, DISPLAY_PARAMS } from "./param-dictionary.js";
import { LIFE_PARAMS } from "./life-params.js";

/** The param id spaces this SDK models. */
export type ParamNamespace = "security" | "clean" | "mower" | "life" | "print" | "display";

const TABLES: Record<ParamNamespace, Record<number, ParamDef>> = {
  security: SECURITY_PARAMS,
  clean: CLEAN_PARAMS,
  // Robot mowers — their own Tuya DP space, so an id stays unnamed rather than reading as a vacuum's.
  mower: MOWER_PARAMS,
  life: LIFE_PARAMS,
  // 3D-printer (ankermake) id space — empty until a live capture confirms the param↔semantic map
  // (printer-support plan Stage 3). Present so the printer codec resolves to its OWN namespace rather
  // than falling through to `security` and decoding another line's dictionary.
  print: {},
  // Smart Display (T87Ax) — ids 8001-8006, four of them named. Same reason as `print`: its own
  // dictionary rather than a corner of another line's.
  display: DISPLAY_PARAMS,
};

/** Look up a param def in the given namespace. */
export function paramDef(ns: ParamNamespace, paramType: number): ParamDef | undefined {
  return TABLES[ns][paramType];
}

/**
 * The param namespace each codec's ids live in — the one place that mapping is made, so the model and
 * the inspector can't disagree about how to read a device's params. Exhaustive over {@link Codec} on
 * purpose: a new codec is a **compile error** here rather than a silent fall-through to `security`
 * (which would read another line's dictionary — e.g. a mower's Tuya DPs decoded as security params,
 * mislabelling the security battery id on a device where it means nothing).
 *
 * `mower` is a Clean-line device but reads its OWN namespace: its Tuya product schema numbers its data
 * points 1-185 with meanings unrelated to a vacuum's (DP 110 is a mower's cutting height and a Tuya
 * vacuum's session area), so reading them against `CLEAN_PARAMS` would name one product's state with
 * the other's dictionary.
 *
 * `display` (the T87Ax Smart Display line) reads its own dictionary for the same reason every other
 * line does: nothing in the 8001-8006 range carries a security meaning, so reading those ids against
 * `SECURITY_PARAMS` would decode a future security param assigned in that range as whatever it means on
 * a camera. The product line in `CODEC_LINE` is the other half — without it, any security capability
 * whose `modelHints` regex matched this device's reported name is inference-attachable, which
 * `line-partition.spec.ts`'s `POISONED` case measures at six on a device that speaks no P2P and can
 * answer for none of them.
 */
const NAMESPACE_BY_CODEC: Record<Codec, ParamNamespace> = {
  station: "security",
  camera: "security",
  sensor: "security",
  lock: "security",
  keypad: "security",
  vacuum: "clean",
  mower: "mower",
  light: "life",
  printer: "print",
  display: "display",
};

/** The param namespace a device's ids live in, from its codec, via the module-local `NAMESPACE_BY_CODEC` table. */
export function namespaceForCodec(codec: Codec): ParamNamespace {
  return NAMESPACE_BY_CODEC[codec];
}
