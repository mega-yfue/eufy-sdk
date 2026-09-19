/**
 * Device registry + the **3-tier resolver**.
 *
 * Resolving a {@link CloudRecord} to a {@link ResolvedDevice} (`{ codec, capabilities,
 * properties, name }`) is the heart of the data-driven model. Most-specific wins, but the
 * result is always *additive* so nothing is ever lost:
 *
 *  1. **model row** (curated, tier 1) — a hand-authored {@link RegistryEntry} keyed by T-code.
 *     Best naming + curated extra capabilities. Optional; most devices never need one.
 *  2. **category default** (tier 2) — {@link classify} maps the cloud `device_type` (or, failing
 *     that, the model code) to a {@link Codec}, which contributes its baseline capabilities.
 *  3. **inference** (tier 3) — {@link detectCapabilities} adds whatever the device can *prove*
 *     about itself from its reported params + model/category strings (graceful unknown).
 *
 * The final capability set is the union of all three tiers (deduped), minus the ones a module marks
 * {@link import("./capabilities/types").CapabilityModule.ownedByStation} when the record says this
 * device hangs off a parent — the one place the result is subtractive, because a control the group's
 * owner holds is one this device cannot answer for however it was granted. `source` records the most
 * authoritative tier that fired, for diagnostics.
 *
 * The curated rows below are intentionally a **small seed** — the system classifies and works
 * read-only for devices with no row at all. Rows exist only to add curation (pretty names,
 * capabilities not provable from params alone). They are the place to encode model-specific
 * knowledge as it is *confirmed* (via the APK / a mega query) — never as a dumping ground.
 *
 * @module model/registry
 */

import type { CloudRecord, RegistryEntry, ResolvedDevice, Capability, Codec, PropertySpec } from "./types.js";
import { classify, codecForType, codecFromModel } from "./classify.js";
import {
  mergeProperties,
  detectCapabilities,
  codecBaseline,
  STATION_OWNED_CAPABILITIES,
} from "./capabilities/index.js";
import { inferName } from "./infer.js";

/**
 * Curated model rows (tier 1), keyed by **uppercase T-code**. Seed set only — extend as model
 * specifics are confirmed. Capabilities here are *added* to the codec baseline + inference.
 *
 * NOTE: these are illustrative seeds chosen to exercise the resolver; each should be confirmed
 * against first-party evidence before being relied on (same trust rule as param ids).
 */
export const MODEL_REGISTRY: Readonly<Record<string, RegistryEntry>> = {
  // Stations / hubs.
  T9000: { codec: "station", name: "HomeBase S1 Pro" },
  T8030: { codec: "station", name: "HomeBase 3" },
  T8010: { codec: "station", name: "HomeBase" },
  T8002: { codec: "station", name: "HomeBase E" },

  // Cameras with curated extras that aren't always provable from a fresh device's params.
  T8423: { codec: "camera", caps: ["light", "battery"], name: "Floodlight Cam" },
  T8210: { codec: "camera", caps: ["doorbell", "battery"], name: "Video Doorbell" },
  // Confirmed against a real owned unit (named "Doorbell"): Video Doorbell Dual.
  T8214: { codec: "camera", caps: ["doorbell", "battery"], name: "Video Doorbell Dual" },
  // Confirmed against a real owned unit: the mains-powered Wired Doorbell 2K. No `battery` row
  // member on purpose — this model is wired, so the codec baseline plus inference is the whole
  // truth for power. Without this row it classified as a plain camera, so the doorbell capability
  // never appeared and consumers got no doorbell event entity or ring trigger.
  T8200: { codec: "camera", caps: ["doorbell"], name: "Wired Doorbell 2K" },

  // Cameras observed on real owned hardware (inspect-device sweep). Names from the app's own
  // model-family constants (scripts/data/app_model_registry.json); caps mirror what the device
  // reports. T8171 has no family entry in that dump, so it keeps the raw T-code.
  T8114: { codec: "camera", caps: ["light", "battery"], name: "eufyCam" },
  // ptz is NOT curated on these rows on purpose — infer.ts proves it from evidence for the
  // whole fleet (verified live): SoloCam (T8170/T8171) via their reported PTZ preset params
  // (6090/6091/6092, 6210); Indoor-PT (T8410) via its vendor deviceType 31 = INDOOR_PT_CAMERA.
  // The rotate command (6030) is write-only and leaves no param trace, so it is never the signal.
  // `light` (spotlight) is NOT hardcoded — it's detected from real spotlight params (light.ts),
  // so devices with a spotlight (T8170: 1400/1401/1403; T8442: 6080/6082) get it
  // and LED-only cams (T8171/T8400/T8410) correctly do NOT. The status LED (1045) is `camera`.
  // `arming` here is the STANDALONE case only — `ownedByStation` withholds it again once the record
  // shows a parent, so an attached cam never advertises the hub's guard mode.
  T8170: { codec: "camera", caps: ["battery", "arming"], name: "SoloCam" },
  T8171: { codec: "camera", caps: ["battery", "arming"], name: "T8171" },
  T8400: { codec: "camera", caps: ["arming"], name: "Indoor Cam" },
  T8410: { codec: "camera", caps: ["arming"], name: "Indoor Cam Pan & Tilt" },
  T8442: { codec: "camera", caps: ["arming"], name: "Indoor/Outdoor Cam 1080p" },

  // Sensors — the concrete sensor kind is curated (DeviceType 2 alone is ambiguous).
  T8900: { codec: "sensor", caps: ["contact"], name: "Entry Sensor" },
  T8910: { codec: "sensor", caps: ["battery"], name: "Motion Sensor" },

  // Keypad (DeviceType 11).
  T8960: { codec: "keypad", name: "Keypad" },

  // Clean line — robot vacuums (Tuya-DP transport) + robot mowers (own `mower` codec, Tuya P2P).
  // Provenance is split, and the split is checkable against the V6 app's OWN device catalog
  // (`DEVICE_CATALOG.json` in the eufy_decompiled dump, `ui_category:"clean"` = 30 SKUs):
  //   • App-verified (present in that V6 catalog): T2070, T2080, T211A, T2120, T2150, T2267, T2268,
  //     T2276, T2278, T2280, T2320, T2351, T2353 — plus the mowers below.
  //   • The remaining RoboVac rows are OLDER models NOT in the V6 clean catalog. Their names are carried
  //     from the legacy device list — NAME-ONLY and UNVERIFIED against V6 (kept so the codes classify;
  //     per the V6-truth rule the legacy list is never authority for behaviour). A live
  //     get_product_data_point sweep of a real unit is what promotes one to verified. (Some V6-catalog
  //     names weren't individually extractable from the strings dump — e.g. T2080 — so a V6-listed code
  //     can still carry a legacy name until a capture pins it; those are flagged where known.)
  // The X10 Pro Omni (T2351) is the one line driven on real hardware so far — its name is the device's
  // own DeviceInfo self-report.
  T1250: { codec: "vacuum", name: "RoboVac 35C (T1250)" }, // legacy list — name-only, not in V6 catalog
  T2070: { codec: "vacuum", name: "RoboVac 3-in-1 E20" },
  T2080: { codec: "vacuum", name: "RoboVac S1" },
  T2081: { codec: "vacuum", name: "RoboVac S2" },
  T2103: { codec: "vacuum", name: "RoboVac 11C" },
  T2117: { codec: "vacuum", name: "RoboVac 35C (T2117)" }, // legacy list — name-only, not in V6 catalog
  T2118: { codec: "vacuum", name: "RoboVac 30C" },
  T2119: { codec: "vacuum", name: "RoboVac 11S" },
  T2120: { codec: "vacuum", name: "RoboVac 15C MAX" },
  T2123: { codec: "vacuum", name: "RoboVac 25C (T2123)" }, // legacy list — name-only, not in V6 catalog
  T2128: { codec: "vacuum", name: "RoboVac 15C MAX (T2128)" }, // legacy list — name-only, not in V6 catalog
  T2130: { codec: "vacuum", name: "RoboVac 30C MAX" },
  T2132: { codec: "vacuum", name: "RoboVac 25C (T2132)" }, // legacy list — name-only, not in V6 catalog
  T2150: { codec: "vacuum", name: "RoboVac G10 Hybrid" },
  T2181: { codec: "vacuum", name: "RoboVac LR30 Hybrid+" },
  T2182: { codec: "vacuum", name: "RoboVac LR35 Hybrid+" },
  T2190: { codec: "vacuum", name: "RoboVac L70 Hybrid" },
  T2192: { codec: "vacuum", name: "RoboVac LR20" },
  T2193: { codec: "vacuum", name: "RoboVac LR30 Hybrid" },
  T2194: { codec: "vacuum", name: "RoboVac LR35 Hybrid" },
  T2210: { codec: "vacuum", name: "RoboVac G50" },
  T211A: { codec: "vacuum", name: "RoboVac C28" },
  T2250: { codec: "vacuum", name: "RoboVac G30 (T2250)" }, // legacy list — name-only, not in V6 catalog
  T2251: { codec: "vacuum", name: "RoboVac G30 (T2251)" }, // legacy list — name-only, not in V6 catalog
  T2252: { codec: "vacuum", name: "RoboVac G30 Verge" },
  T2253: { codec: "vacuum", name: "RoboVac G30 Hybrid" },
  T2254: { codec: "vacuum", name: "RoboVac G35" },
  T2255: { codec: "vacuum", name: "RoboVac G40" },
  T2256: { codec: "vacuum", name: "RoboVac G40 Hybrid" },
  T2257: { codec: "vacuum", name: "RoboVac G20" },
  T2258: { codec: "vacuum", name: "RoboVac G20 Hybrid" },
  T2259: { codec: "vacuum", name: "RoboVac G32" },
  T2261: { codec: "vacuum", name: "RoboVac X8 Hybrid" },
  T2262: { codec: "vacuum", name: "RoboVac X8" },
  T2266: { codec: "vacuum", name: "RoboVac X8 Pro" },
  T2267: { codec: "vacuum", name: "RoboVac L60" },
  T2268: { codec: "vacuum", name: "RoboVac L60 Hybrid" },
  T2270: { codec: "vacuum", name: "RoboVac G35+" },
  T2272: { codec: "vacuum", name: "RoboVac G30+ SES" },
  T2273: { codec: "vacuum", name: "RoboVac G40 Hybrid+" },
  T2276: { codec: "vacuum", name: "RoboVac X8 Pro SES" },
  T2277: { codec: "vacuum", name: "RoboVac L60 SES" },
  T2278: { codec: "vacuum", name: "RoboVac L60 Hybrid SES" },
  T2280: { codec: "vacuum", name: "RoboVac C20" },
  T2292: { codec: "vacuum", name: "RoboVac C10" },
  T2320: { codec: "vacuum", name: "RoboVac X9 Pro" },
  T2351: { codec: "vacuum", name: "Clean X10 Pro Omni" }, // V6 catalog + live DeviceInfo self-report
  T2352: { codec: "vacuum", name: "RoboVac E28" },
  T2353: { codec: "vacuum", name: "RoboVac E25" },

  // Robot mowers — `mower` codec. Clean line, but the app's `TuyaP2PMower` family: the transport is
  // **Tuya P2P**, NOT the vacuums' AIoT MQTT (the AIoT predicate explicitly excludes them). Control is
  // a future path; classified + named today. Codes/names from the V6 app `ProductTypeUtils` predicates
  // (`isMowC15`/`isMowE15`/`isMowE18`); the `…B` rows are that model's hardware variant (the app groups
  // each pair under one predicate, so they share the model name).
  T280B: { codec: "mower", name: "Mower C15" },
  T2801: { codec: "mower", name: "Mower E18" },
  T2880: { codec: "mower", name: "Mower E15" },

  // eufy_life smart lighting — its own secure-MQTT "DP" TLV wire (`cmd/eufy_life/…`), NOT the P2P
  // security stack. The `light` codec's baseline is the `smart_light` capability; see
  // src/model/capabilities/smart-light.ts. The model list is the `T8L0x` family the app's shared device
  // handler (`T8L02Handle.mix.js`) enumerates; names are from the retail boxes. Only T8L02 has been
  // driven on a real device (2026-07) — the rest are classification/naming rows. The effect-frame
  // encoding is per-family and reversed for T8L02 only, so `setEffect` is gated to it (the others still
  // classify + do on/off/brightness); see the capability for the gate.
  T8L00: { codec: "light", name: "Permanent Outdoor Light E120 (30 m)" },
  T8L01: { codec: "light", name: "Permanent Outdoor Light E120 (15 m)" },
  T8L02: { codec: "light", name: "Permanent Outdoor Lights E22" },
  T8L04: { codec: "light", name: "Permanent Outdoor Lights S4" },
  T8L10: { codec: "light", name: "Outdoor String Lights E10" },
  T8L20: { codec: "light", name: "Outdoor Spotlights E10" },
  T8L30: { codec: "light", name: "Outdoor Pathway Lights E10" },
  T8L40: { codec: "light", name: "Indoor Floor Lamp E10" },
  // 3D printers (eufyMake/AnkerMake) classify from `category` alone — no curated model-code rows, since
  // no printer has been observed on a code yet (rows would guess; the category path already resolves one).

  // eufy_mega category — its own `display` codec (classify.ts). Confirmed live (2026-09-04): the
  // cloud record's top-level `device_name` field held the generic "Eufy Smart Display", while its own
  // param 8005 separately reported the model's retail name, "Smart Display E10" — curated here since
  // it's the more specific of the two, not because the two fields agreed. No capabilities are curated —
  // no screen/audio/assistant param has been observed yet.
  T87A0: { codec: "display", name: "Smart Display E10" },
};

/** Deduplicate a capability list, preserving first-seen order (precedence). */
function dedupeCaps(caps: Capability[]): Capability[] {
  const seen = new Set<Capability>();
  const out: Capability[] = [];
  for (const c of caps) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/**
 * Resolve a cloud device record into its full model shape via the 3-tier lookup.
 *
 * Capability precedence (earlier = wins on property-name conflicts in `mergeProperties`):
 * curated row caps → codec baseline → inferred extras.
 *
 * @param rec the minimal cloud record (deviceType / model / category / params).
 * @returns the resolved `{ codec, capabilities, properties, name, source }`.
 */
export function resolveDevice(rec: CloudRecord): ResolvedDevice {
  const modelKey = rec.model?.trim().toUpperCase();
  const row = modelKey ? MODEL_REGISTRY[modelKey] : undefined;

  // Codec: a curated row's codec wins; otherwise classify (device_type → model → camera default).
  const codec = row?.codec ?? classify(rec);

  // Capabilities: union of curated extras + codec baseline + per-module detection (each
  // capability module owns how it's detected — evidence params, vendor deviceType, model hints),
  // minus whatever the group's owner keeps to itself once this device is behind a parent.
  const attached = !!rec.parentSn && codec !== "station";
  const capabilities = dedupeCaps([
    ...(row?.caps ?? []),
    ...codecBaseline(codec),
    ...detectCapabilities(rec, codec),
  ]).filter((c) => !(attached && STATION_OWNED_CAPABILITIES.has(c)));

  const properties = resolveProperties(rec, codec, capabilities);

  // Name: curated → inferred clean T-code → raw model → "unknown".
  const name = row?.name ?? inferName(rec) ?? rec.model ?? "unknown";

  // Diagnostics: which tier was the most authoritative source of the codec/caps?
  const classifiedByCategory =
    (rec.deviceType !== undefined && codecForType(rec.deviceType) !== undefined) ||
    codecFromModel(rec.model) !== undefined;
  const source: ResolvedDevice["source"] = row ? "model" : classifiedByCategory ? "category" : "inferred";

  return { codec, capabilities, properties, name, source };
}

/**
 * The property manifest for a device, from its capabilities and the record's facts. The single place
 * an {@link AvailabilityContext} is built — so a family-gate (`available`) and a per-model enum
 * (`enumValuesFor`) are decided from the same truthful, session-free view on every path (initial
 * resolve and {@link Device.reresolve}). Populated only from what a record carries, never transport
 * fields a live session hasn't produced.
 */
export function resolveProperties(rec: CloudRecord, codec: Codec, capabilities: Capability[]): PropertySpec[] {
  const paramIds = new Set<number>();
  if (rec.params && typeof rec.params === "object") {
    for (const k of Object.keys(rec.params)) {
      const n = Number(k);
      if (Number.isFinite(n)) paramIds.add(n);
    }
  }
  return mergeProperties(capabilities, {
    codec,
    deviceType: rec.deviceType,
    model: rec.model,
    category: rec.category,
    capabilities: new Set(capabilities),
    paramIds,
  });
}
