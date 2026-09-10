/**
 * A capability-driven model for a discovered Anker Solix device — the Solix analogue of the eufy
 * `Device` model: ONE `SolixDevice` class, no per-model subclasses, and behaviour resolved from what
 * the device reports (its catalog category + record fields + live telemetry) rather than switched on
 * its model. Callers branch on {@link SolixDevice.has}(capability), never on the product code.
 *
 * Grounding: capabilities whose values come from data we can actually read today — `identity`,
 * `firmware`, `connectivity`, and `energyMeter` (grid voltage + raw telemetry channels) — expose typed
 * value accessors. The other categories' capabilities (`battery`, `solarInput`, `acOutput`,
 * `evCharger`, `charger`, `cooler`) are DETECTED so `has(...)` is correct, but their named metrics are
 * deliberately not decoded yet: naming a datapoint field without a real frame from that device type
 * would be a guess, which is exactly what the data-driven design exists to avoid. Their raw decoded
 * channels are still available via {@link SolixDevice.telemetry}.
 */
import type { SolixProductCategory } from "./solix-client.js";
import { buildModelIndex } from "./solix-client.js";
import { SOLIX_METER_FIELD_NAMES, type SolixReading } from "./solix-mqtt.js";

/** Every capability a Solix device may carry. `has(...)` gates each; only some have value accessors. */
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
 * The capabilities each Anker catalog category implies. Category is a detection SIGNAL (like eufy's
 * `deviceTypes`), not the model's identity — a device still resolves `energyMeter` from telemetry even
 * though its category is "Accessory". Unlisted categories contribute nothing here and rely on
 * telemetry/model detection.
 */
export const CATEGORY_CAPABILITIES: Readonly<Record<string, readonly SolixCapability[]>> = {
  "Portable Power Station": ["battery", "acOutput", "solarInput"],
  "Plug-in Home Battery": ["battery", "solarInput", "acOutput", "energyMeter"],
  "Powered Cooler": ["battery", "cooler"],
  "Power Bank": ["battery"],
  "Smart EV Charger": ["evCharger"],
  Charger: ["charger"],
  Accessory: [], // device-specific — the smart meter resolves energyMeter from telemetry/model below
};

/** Product-code prefixes known to be grid/energy meters (detects `energyMeter` regardless of category). */
export const SOLIX_METER_MODELS: readonly string[] = ["AE1X0"];

/** A discovered Solix device record, as returned by `SolixClient.getDevices()`. */
export interface SolixDeviceRecord {
  device_sn: string;
  product_code: string;
  device_name?: string;
  alias_name?: string;
  device_sw_version?: string;
  wifi_online?: boolean;
  wifi_name?: string;
  rssi?: string | number;
  [k: string]: unknown;
}

export interface SolixIdentity {
  serial: string;
  productCode: string;
  /** Friendly name — the catalog marketing name if resolvable, else the record's alias/name. */
  name: string;
  /** Anker catalog category (e.g. "Accessory", "Portable Power Station"), if resolvable. */
  category?: string;
}
export interface SolixConnectivity {
  online: boolean;
  rssi?: number;
  ssid?: string;
}
/**
 * Grid/energy-meter live values (Smart Meter AE1X0). The meter is 3-phase-capable and reports each
 * quantity per line (L1/L2/L3) plus a total; on a single-phase / single-CT install only L1 + total
 * carry data. `meterVoltageL1` is confirmed against live data; the other named accessors are a
 * structural inference (see {@link SOLIX_METER_FIELD_NAMES}). `channels` carries every decoded float,
 * including tags with no name yet (`channel_b5`..`channel_b7`).
 */
export interface SolixEnergyMeter {
  /** Latest line voltage (V). L1 is confirmed; L2/L3 read 0 on a single-phase supply. */
  meterVoltageL1(): number | undefined;
  meterVoltageL2(): number | undefined;
  meterVoltageL3(): number | undefined;
  /** Latest line current (A). */
  meterCurrentL1(): number | undefined;
  meterCurrentL2(): number | undefined;
  meterCurrentL3(): number | undefined;
  meterCurrentTotal(): number | undefined;
  /** Latest active power (W) per line and aggregate total. */
  meterPowerL1(): number | undefined;
  meterPowerL2(): number | undefined;
  meterPowerL3(): number | undefined;
  meterPowerTotal(): number | undefined;
  /** Cumulative imported / exported energy. */
  meterImportEnergy(): number | undefined;
  meterExportEnergy(): number | undefined;
  /** All decoded float channels from the latest reading, keyed `channel_<tag>` (+ any named ones). */
  channels(): Record<string, number>;
}

/** Options for {@link SolixDevice}. */
export interface SolixDeviceOptions {
  /** Catalog categories (from `SolixClient.getProductCatalog()`) — used to resolve name + category. */
  catalog?: SolixProductCategory[];
}

/**
 * A discovered Solix device with resolved category + capabilities. Feed live telemetry with
 * {@link applyReading} (from {@link SolixMqtt}'s `reading` events) to populate value accessors.
 */
export class SolixDevice {
  readonly serial: string;
  readonly productCode: string;
  readonly record: SolixDeviceRecord;
  private readonly caps: Set<SolixCapability>;
  private readonly identity_: SolixIdentity;
  private values: Record<string, number> = {};

  constructor(record: SolixDeviceRecord, opts: SolixDeviceOptions = {}) {
    this.record = record;
    this.serial = record.device_sn;
    this.productCode = record.product_code;
    const label = opts.catalog ? buildModelIndex(opts.catalog).get(record.product_code) : undefined;
    this.identity_ = {
      serial: record.device_sn,
      productCode: record.product_code,
      name: label?.name ?? record.alias_name ?? record.device_name ?? record.product_code,
      category: label?.category,
    };
    this.caps = resolveCapabilities(record, this.identity_.category);
  }

  /** All capabilities this device carries. */
  get capabilities(): SolixCapability[] {
    return [...this.caps];
  }

  /** Whether the device carries a capability — the only correct way to branch on behaviour. */
  has(capability: SolixCapability): boolean {
    return this.caps.has(capability);
  }

  /** Merge a live telemetry reading (from `SolixMqtt`) so the value accessors reflect it. */
  applyReading(reading: Pick<SolixReading, "values">): void {
    this.values = { ...this.values, ...reading.values };
  }

  /** All decoded float telemetry channels from the latest applied reading (raw, `channel_<tag>` keys). */
  telemetry(): Record<string, number> {
    return { ...this.values };
  }

  identity(): SolixIdentity {
    return { ...this.identity_ };
  }

  firmware(): { version: string } | undefined {
    return this.record.device_sw_version ? { version: this.record.device_sw_version } : undefined;
  }

  connectivity(): SolixConnectivity | undefined {
    if (!this.has("connectivity")) return undefined;
    const rssi = this.record.rssi != null ? Number(this.record.rssi) : undefined;
    return {
      online: !!this.record.wifi_online,
      rssi: Number.isFinite(rssi) ? rssi : undefined,
      ssid: this.record.wifi_name,
    };
  }

  energyMeter(): SolixEnergyMeter | undefined {
    if (!this.has("energyMeter")) return undefined;
    const values = this.values;
    const at = (tag: number) => values[SOLIX_METER_FIELD_NAMES[tag] as string];
    return {
      meterVoltageL1: () => at(0xac),
      meterVoltageL2: () => at(0xad),
      meterVoltageL3: () => at(0xae),
      meterCurrentL1: () => at(0xaf),
      meterCurrentL2: () => at(0xb0),
      meterCurrentL3: () => at(0xb1),
      meterCurrentTotal: () => at(0xb2),
      meterPowerL1: () => at(0xa8),
      meterPowerL2: () => at(0xa9),
      meterPowerL3: () => at(0xaa),
      meterPowerTotal: () => at(0xab),
      meterImportEnergy: () => at(0xb3),
      meterExportEnergy: () => at(0xb4),
      channels: () => ({ ...values }),
    };
  }
}

/** Resolve a device's capability set from its record fields, catalog category, and model. */
function resolveCapabilities(record: SolixDeviceRecord, category?: string): Set<SolixCapability> {
  const caps = new Set<SolixCapability>(["identity"]);
  if (record.device_sw_version) caps.add("firmware");
  if (record.wifi_online !== undefined || record.rssi != null || record.wifi_name) caps.add("connectivity");
  for (const c of (category && CATEGORY_CAPABILITIES[category]) || []) caps.add(c);
  if (SOLIX_METER_MODELS.some((m) => record.product_code?.startsWith(m))) caps.add("energyMeter");
  return caps;
}
