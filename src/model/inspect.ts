/**
 * Device inspection — turn a real device's reported params into an enrichment report.
 *
 * Given a cloud record (model/deviceType/params), this produces:
 *  - the resolved `{ codec, capabilities, name }`,
 *  - a per-param table cross-referenced against the param dictionary (known/unknown, name,
 *    provenance, inferred type, live value),
 *  - a **paste-ready `registry.ts` row** for the device's model, and
 *  - **paste-ready param-dictionary snippets** for every param we don't yet know.
 *
 * Pure + offline (no network) so it is unit-testable; the live wrapper that fetches a device by
 * serial lives on `EufyMega.inspectDevice`.
 *
 * @module model/inspect
 */

import type { CloudRecord, PropertySource, PropertyValueType, RegistryEntry, ResolvedDevice } from "./types.js";
import { codecBaseline } from "./capabilities/index.js";
import type { ThingProperty } from "./capabilities/dp-catalog.js";
import { resolveDevice, MODEL_REGISTRY } from "./registry.js";
import { paramDef, namespaceForCodec, type ParamNamespace } from "./param-namespace.js";

/** One reported param, cross-referenced against our dictionary. */
export interface ParamInspection {
  paramType: number;
  /** Raw reported value (as delivered). */
  value: string;
  /** True when the param is in our dictionary for this namespace. */
  known: boolean;
  /** Our dictionary name, or `param<pt>` when unknown. */
  name: string;
  /** Trust of the dictionary mapping (absent ⇒ not in dictionary). */
  provenance?: PropertySource;
  /** Type inferred from the live value (bool/number/string). */
  inferredType: PropertyValueType;
}

/** Full inspection report for one device. */
export interface DeviceInspection {
  sn?: string;
  model?: string;
  deviceType?: number;
  namespace: ParamNamespace;
  resolved: ResolvedDevice;
  params: ParamInspection[];
  counts: { total: number; known: number; unknown: number; unconfirmed: number };
  /** Suggested curated registry row (codec + extra caps + name). */
  suggestedRegistry: { model: string; entry: RegistryEntry; exists: boolean };
  /** Paste-ready `registry.ts` line. */
  registrySnippet: string;
  /** Paste-ready param-dictionary lines for the unknown params. */
  dictionarySnippet: string;
  /**
   * The product's thing description by property identifier, as the record carries it — a plain object
   * so it serialises. Absent when the cloud returned none for the product code.
   */
  things?: Record<string, ThingProperty>;
}

function inferType(value: string): PropertyValueType {
  const v = value.trim();
  if (v === "0" || v === "1") return "bool";
  if (/^-?\d+(\.\d+)?$/.test(v)) return "number";
  return "string";
}

function tsString(s: string): string {
  return JSON.stringify(s);
}

function buildRegistrySnippet(model: string, entry: RegistryEntry): string {
  const caps = entry.caps?.length ? `, caps: [${entry.caps.map((c) => tsString(c)).join(", ")}]` : "";
  const name = entry.name ? `, name: ${tsString(entry.name)}` : "";
  return `  ${tsString(model)}: { codec: ${tsString(entry.codec)}${caps}${name} },`;
}

function buildDictSnippet(model: string, unknown: ParamInspection[]): string {
  if (!unknown.length) return "  // (no unknown params — all reported ids are already in the dictionary)";
  return unknown
    .map(
      (p) =>
        `  ${p.paramType}: { name: ${tsString(p.name)}, type: ${tsString(p.inferredType)}, provenance: "guessed" }, // reported by ${model}; sample value=${p.value}; needs naming/toggle-diff`,
    )
    .join("\n");
}

/**
 * Inspect a cloud device record and produce the enrichment report. `rec.params` should be the
 * device's reported `param_type → value` map (e.g. from the device list / get_device_param_list).
 */
export function inspectParams(rec: CloudRecord, sn?: string): DeviceInspection {
  const resolved = resolveDevice(rec);
  const namespace: ParamNamespace = namespaceForCodec(resolved.codec);
  const params: ParamInspection[] = [];

  // Naming precedence mirrors Device.applyParams: a capability's (curated) PropertySpec wins over
  // the raw param dictionary, which wins over `param<pt>`. So a confirmed capability name like
  // `chimeSwitch` (mega) is reported instead of the raw dictionary's guessed name.
  const specByParam = new Map(resolved.properties.map((p) => [p.paramType, p]));

  for (const [rawKey, rawVal] of Object.entries(rec.params ?? {})) {
    const pt = Number(rawKey);
    if (!Number.isFinite(pt)) continue;
    const value = String(rawVal);
    const spec = specByParam.get(pt);
    const def = paramDef(namespace, pt);
    params.push({
      paramType: pt,
      value,
      known: !!(spec || def),
      name: spec ? spec.name : def ? def.name : `param${pt}`,
      provenance: spec?.provenance ?? def?.provenance,
      inferredType: spec ? spec.type : def ? def.type : inferType(value),
    });
  }
  params.sort((a, b) => a.paramType - b.paramType);

  const unknown = params.filter((p) => !p.known);
  // "unconfirmed" = in the dictionary but with a weak (guessed) name we'd like a human to verify.
  const unconfirmed = params.filter((p) => p.known && p.provenance === "guessed");

  // Suggested registry row: the codec + the capabilities beyond the codec baseline (the "extras"
  // a curated row exists to pin), plus the resolved display name.
  const baselineCaps = new Set(codecBaseline(resolved.codec));
  const extraCaps = resolved.capabilities.filter((c) => !baselineCaps.has(c));
  const model = rec.model ?? "UNKNOWN";
  const entry: RegistryEntry = {
    codec: resolved.codec,
    ...(extraCaps.length ? { caps: extraCaps } : {}),
    name: resolved.name,
  };

  return {
    sn,
    model: rec.model,
    deviceType: rec.deviceType,
    namespace,
    resolved,
    params,
    counts: {
      total: params.length,
      known: params.length - unknown.length,
      unknown: unknown.length,
      unconfirmed: unconfirmed.length,
    },
    suggestedRegistry: { model, entry, exists: !!MODEL_REGISTRY[model.toUpperCase()] },
    registrySnippet: buildRegistrySnippet(model, entry),
    things: rec.things && Object.fromEntries(rec.things),
    dictionarySnippet: buildDictSnippet(model, unknown),
  };
}
