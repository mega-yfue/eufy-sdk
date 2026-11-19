/**
 * Anker **Solix** capability surface. Solix is a separate ecosystem — its own Anker account, backend
 * and product catalog — so it keeps its own capability id union rather than joining eufy's `Capability`
 * / `Codec` unions, and detection is by Anker catalog CATEGORY + product-code prefix (see
 * {@link detectSolixCapabilities}) rather than eufy param ids.
 *
 * What it shares is the `members` engine: the one feature with a readable wire declares ONE `members`
 * table, and its property schema, evidence gate and typed surface all derive from it through
 * `members.ts` (`bindMembers` / `Surface`), exactly as a eufy capability does.
 *
 * @module model/capabilities/solix
 */
import type { Members, Surface } from "./members.js";

/** Every capability a Solix device may carry. Solix's OWN union (not eufy's `Capability`). */
export type SolixCapability =
  | "identity"
  | "firmware"
  | "connectivity"
  | "energyMeter"
  | "battery"
  | "solarInput"
  | "acOutput"
  | "evCharger"
  | "charger"
  | "cooler";

/**
 * The `energyMeter` surface — the electrical readings the vendor app names, as typed members. Each is
 * read-only and evidence-gated: `bindMembers` installs a getter only once a frame that REPORTS that tag
 * has landed, and answers `undefined` (not a fabricated `0`) before any has. The gate is "reported", not
 * "non-zero": a single-phase / single-CT meter still reports its L2/L3 slots as `0.0`, so those members
 * install and read `0` rather than staying absent — a caller sees `0` for an idle phase, not `undefined`.
 *
 * The app's field VOCABULARY (these twelve names) is authoritative. For the tag→field binding, a live
 * single-phase frame confirmed the L1 and total magnitudes (a nominal mains voltage, an equal line/total
 * power pair, the line current). The L2/L3 tags are never non-zero on a single-CT install and the app
 * itself receives the meter as named JSON — there is no tag→phase decoder in the app binary — so their
 * phase assignment is inferred from the block ordering. The energy counters (`meterImportEnergy`/`meterExportEnergy`) are named
 * on the wire but are NOT members here: their tag→name is confirmed, but their unit SCALE is not (a live
 * reading is consistent with either Wh or kWh), so they stay raw named values via
 * {@link SOLIX_METER_FIELD_NAMES} until a capture pins the scale, rather than ship a member with a guessed unit.
 *
 * @internal — the declaration `SolixEnergyMeterReads` derives from; exported (like the eufy `*_MEMBERS`
 * tables) so it is a known symbol, but excluded from the rendered API reference.
 */
export const SOLIX_ENERGY_METER_MEMBERS = {
  /** Line-1 voltage (V), ff09 tag `0xAC` — confirmed live (a nominal mains voltage). */
  meterVoltageL1: {
    param: 0xac,
    type: "number",
    kind: "scalar",
    unit: "V",
    description: "Meter line-1 voltage (V) — ff09 tag 0xAC, confirmed against a live single-phase frame.",
  },
  /** Line-2 voltage (V), ff09 tag `0xAD` — the app's field; reads 0 until a multi-phase frame carries it. */
  meterVoltageL2: {
    param: 0xad,
    type: "number",
    kind: "scalar",
    unit: "V",
    description:
      "Meter line-2 voltage (V) — ff09 tag 0xAD; phase assignment inferred from block ordering (never observed non-zero), 0 on a single-phase install.",
  },
  /** Line-3 voltage (V), ff09 tag `0xAE` — the app's field; reads 0 until a multi-phase frame carries it. */
  meterVoltageL3: {
    param: 0xae,
    type: "number",
    kind: "scalar",
    unit: "V",
    description:
      "Meter line-3 voltage (V) — ff09 tag 0xAE; phase assignment inferred from block ordering (never observed non-zero), 0 on a single-phase install.",
  },
  /** Line-1 current (A), ff09 tag `0xAF` — confirmed live (the line's CT current). */
  meterCurrentL1: {
    param: 0xaf,
    type: "number",
    kind: "scalar",
    unit: "A",
    description: "Meter line-1 current (A) — ff09 tag 0xAF, confirmed against a live single-phase frame.",
  },
  /** Line-2 current (A), ff09 tag `0xB0` — the app's field; reads 0 until a multi-phase frame carries it. */
  meterCurrentL2: {
    param: 0xb0,
    type: "number",
    kind: "scalar",
    unit: "A",
    description:
      "Meter line-2 current (A) — ff09 tag 0xB0; phase assignment inferred from block ordering (never observed non-zero), 0 on a single-phase install.",
  },
  /** Line-3 current (A), ff09 tag `0xB1` — the app's field; reads 0 until a multi-phase frame carries it. */
  meterCurrentL3: {
    param: 0xb1,
    type: "number",
    kind: "scalar",
    unit: "A",
    description:
      "Meter line-3 current (A) — ff09 tag 0xB1; phase assignment inferred from block ordering (never observed non-zero), 0 on a single-phase install.",
  },
  /** Line-1 active power (W), ff09 tag `0xA8` — confirmed live; negative on export. */
  meterPowerL1: {
    param: 0xa8,
    type: "number",
    kind: "scalar",
    unit: "W",
    description: "Meter line-1 active power (W) — ff09 tag 0xA8, confirmed live; negative on export.",
  },
  /** Line-2 active power (W), ff09 tag `0xA9` — the app's field; reads 0 until a multi-phase frame carries it. */
  meterPowerL2: {
    param: 0xa9,
    type: "number",
    kind: "scalar",
    unit: "W",
    description:
      "Meter line-2 active power (W) — ff09 tag 0xA9; phase assignment inferred from block ordering (never observed non-zero), 0 on a single-phase install.",
  },
  /** Line-3 active power (W), ff09 tag `0xAA` — the app's field; reads 0 until a multi-phase frame carries it. */
  meterPowerL3: {
    param: 0xaa,
    type: "number",
    kind: "scalar",
    unit: "W",
    description:
      "Meter line-3 active power (W) — ff09 tag 0xAA; phase assignment inferred from block ordering (never observed non-zero), 0 on a single-phase install.",
  },
  /** Aggregate active power (W), ff09 tag `0xAB` — confirmed live; equals line-1 on a single phase. */
  meterPowerTotal: {
    param: 0xab,
    type: "number",
    kind: "scalar",
    unit: "W",
    description: "Meter total active power (W) — ff09 tag 0xAB, confirmed live; equals L1 on one phase.",
  },
} as const satisfies Members;

/** Bound `energyMeter` reads (the members-derived half of `dev.energyMeter()`). Read-only. */
export type SolixEnergyMeterReads = Surface<typeof SOLIX_ENERGY_METER_MEMBERS>;

/**
 * The capabilities each Anker catalog category implies. Category is a detection SIGNAL (like eufy's
 * `deviceTypes`), not the model's identity — a device still resolves `energyMeter` from its product code
 * even though its category is "Accessory", which is why that category maps to nothing on its own.
 * Unlisted categories contribute nothing here.
 */
export const CATEGORY_CAPABILITIES: Readonly<Record<string, readonly SolixCapability[]>> = {
  "Portable Power Station": ["battery", "acOutput", "solarInput"],
  /**
   * NOT `energyMeter`: a home battery measures its own grid/PV/output power, but that is a different
   * ff09 tag family than the AE1X0 Smart Meter's — the `energyMeter` members are AE1X0-specific, so a
   * Solarbank frame decoded through them mislabels (tag `0xac` is power on a Solarbank, voltage on the
   * meter — enforced by the meter-family gate in {@link SOLIX_METER_MODELS} / the transport decoder,
   * see PR #186). `energyMeter` is model-detected for the meter, not category-detected.
   */
  "Plug-in Home Battery": ["battery", "solarInput", "acOutput"],
  "Powered Cooler": ["battery", "cooler"],
  "Power Bank": ["battery"],
  "Smart EV Charger": ["evCharger"],
  Charger: ["charger"],
  Accessory: [],
};

/**
 * Product-code prefixes known to be grid/energy meters (detects `energyMeter` regardless of category).
 * Keep in lockstep with `SOLIX_METER_PRODUCT_PREFIXES` in `transport/mqtt/solix-mqtt.ts` (the same meter
 * prefixes, transport-side, that gate the tag→name table): a prefix added here but not there grants
 * `energyMeter` to a device whose frames the decoder then refuses to name. Add a meter prefix to both.
 */
export const SOLIX_METER_MODELS: readonly string[] = ["AE1X0"];

/**
 * Product-code prefixes for the grid-tie Solarbank / home-battery family (detects `battery` +
 * `solarInput` regardless of category, so a caller that builds a device without the catalog still gets
 * them): `A1790` = Solarbank E1600 gen-1, `A17C*` = Solarbank 2 / 3, `AE10*` = Solarbank 4 E5000 Pro /
 * SOLIX Power Dock.
 *
 * Grounded in the live `product_categories` catalog: `A17C0`–`A17C5` and `AE100` all list under
 * category `"Plug-in Home Battery "`, and `AE103` by the device spec. `AE1X0`/`AE1R0` meters start
 * `AE1X`/`AE1R`, so `AE10` does not catch them.
 *
 * The speculative `A17E` ("Solarbank Max AC") and `AE11` ("Solarbank Max") were dropped: neither is in
 * the catalog, and the only `AE11x` product there — `AE113` "XE 6/8kW" — is a Residential Storage
 * System, a different family whose telemetry is unverified, so granting it `battery`/`solarInput` would
 * be an unevidenced false positive (exactly what this detection is otherwise careful to avoid).
 */
export const SOLARBANK_MODELS: readonly string[] = ["A1790", "A17C", "AE10"];

/** The minimum device shape {@link detectSolixCapabilities} reads. */
export interface SolixDetectionInput {
  product_code: string;
  device_sw_version?: string;
  wifi_online?: boolean;
  wifi_name?: string;
  rssi?: string | number;
}

/**
 * Resolve a Solix device's capability set from its record fields, catalog category, and product-code
 * prefix — the Solix analogue of eufy's `detectCapabilities`, kept Solix-scoped so eufy detection is
 * untouched. `identity` is universal; the rest are OR-ed evidence.
 */
export function detectSolixCapabilities(rec: SolixDetectionInput, category?: string): Set<SolixCapability> {
  const caps = new Set<SolixCapability>(["identity"]);
  if (rec.device_sw_version) caps.add("firmware");
  if (rec.wifi_online !== undefined || rec.rssi != null || rec.wifi_name) caps.add("connectivity");
  // The category is already trimmed at ingest (buildModelIndex), so an exact lookup is safe here.
  for (const c of (category && CATEGORY_CAPABILITIES[category]) || []) caps.add(c);
  if (SOLIX_METER_MODELS.some((m) => rec.product_code?.startsWith(m))) caps.add("energyMeter");
  if (SOLARBANK_MODELS.some((m) => rec.product_code?.startsWith(m))) {
    caps.add("battery");
    caps.add("solarInput");
  }
  return caps;
}
