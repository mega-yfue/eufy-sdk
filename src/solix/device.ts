/**
 * A capability-driven model for a discovered Anker Solix device — the Solix analogue of the eufy
 * `Device` model: ONE `SolixDevice` class, no per-model subclasses, and behaviour resolved from what
 * the device reports (its catalog category + record fields + live telemetry) rather than switched on
 * its model. Callers branch on {@link SolixDevice.has}(capability), never on the product code.
 *
 * Grounding: `identity`, `firmware`, `connectivity`, and `energyMeter` expose typed accessors backed
 * by data we can read today (`energyMeter`'s one confirmed tag came from a live ff09 frame). `battery`
 * exposes typed accessors too, but on a weaker footing: the field NAMES are the app's own (recovered
 * from `libapp.so`), yet no Solarbank telemetry frame has been captured, so the wire→field binding is
 * unconfirmed and its accessors return `undefined` until a real frame arrives (see {@link SolixBattery}).
 * The remaining capabilities (`solarInput`, `acOutput`, `evCharger`, `charger`, `cooler`) are DETECTED
 * so `has(...)` is correct, but their named metrics are deliberately not decoded — naming a field with
 * no real frame is a guess the data-driven design avoids. Raw decoded channels are always available via
 * {@link SolixDevice.telemetry}.
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

/**
 * Product-code prefixes for the grid-tie Solarbank / home-battery family (detects `battery` +
 * `solarInput` regardless of category): A1790 = Solarbank E1600 gen-1, A17C* = Solarbank 2 / 3.
 */
export const SOLARBANK_MODELS: readonly string[] = ["A1790", "A17C"];

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

/**
 * Solarbank / home-battery live values (grid-tie battery family — A1790, A17C*). Field NAMES are the
 * app's own, recovered from the Anker app's compiled-Dart strings (`libapp.so`, packages `charging/`
 * + `ak_soft_ems/`). Unlike {@link SolixEnergyMeter} — whose one confirmed tag came from a live ff09
 * frame — the Solarbank's telemetry has NOT yet been captured from a real device, so the wire→field
 * binding is unconfirmed: each accessor reads a small set of candidate keys (JSON snake_case + Dart
 * camelCase) from the latest reading and returns `undefined` until a real frame populates them. Once a
 * Solarbank frame is captured (or `blutter` recovers the parser), tighten the candidate keys here.
 * `temperatures()` returns every reported temperature (pack / casing / BMS / per-expansion-pack).
 */
export interface SolixBattery {
  /** State of charge, percent (0–100). */
  soc(): number | undefined;
  /** Battery capacity / stored energy (Wh) if reported. */
  batteryEnergy(): number | undefined;
  /** Net battery power (W); sign convention device-defined. */
  batteryPower(): number | undefined;
  /** Charge / discharge power (W). */
  chargePower(): number | undefined;
  dischargePower(): number | undefined;
  /** PV / solar input power into the system (W). */
  solarInputPower(): number | undefined;
  /** AC output / home-supplied power (W). */
  outputPower(): number | undefined;
  /** Home load the system is serving (W). */
  homeLoadPower(): number | undefined;
  /** Grid → battery power (W), when grid-charging. */
  gridToBatteryPower(): number | undefined;
  /** Whether the battery is currently charging, if reported. */
  isCharging(): boolean | undefined;
  /** Battery / pack temperature (°C or °F per the device's unit). */
  batteryTemperature(): number | undefined;
  /** Enclosure / casing temperature. */
  casingTemperature(): number | undefined;
  /** BMS temperature. */
  bmsTemperature(): number | undefined;
  /** Every reported temperature, keyed by source (pack / casing / bms / per-pack). */
  temperatures(): Record<string, number>;
  /** All decoded telemetry values from the latest reading (raw keys). */
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

  battery(): SolixBattery | undefined {
    if (!this.has("battery")) return undefined;
    const values = this.values;
    // Read by candidate keys (JSON snake_case first, then Dart camelCase). The Solarbank frame
    // isn't captured yet, so which form arrives is unconfirmed — try both; undefined until seen.
    const num = (...keys: string[]): number | undefined => {
      for (const k of keys) {
        const v = values[k];
        if (typeof v === "number") return v;
      }
      return undefined;
    };
    return {
      soc: () => num("soc", "battery_soc", "batterySoc", "batteryLevel"),
      batteryEnergy: () => num("battery_energy", "batteryEnergy", "batteryCapacity"),
      batteryPower: () => num("battery_power", "batteryPower"),
      chargePower: () => num("charging_power", "chargingPower"),
      dischargePower: () => num("discharge_power", "dischargePower"),
      solarInputPower: () => num("photovoltaic_power", "input_power", "inputPower", "microInverterPower"),
      outputPower: () => num("output_power", "outputPower", "acOutputPower"),
      homeLoadPower: () => num("home_load_power", "homeLoadPower", "currentHomeLoad"),
      gridToBatteryPower: () => num("grid_to_battery_power", "gridToBatteryPower"),
      isCharging: () => {
        const v = values["is_charging"] ?? values["isCharging"];
        return typeof v === "number" ? v !== 0 : undefined;
      },
      batteryTemperature: () => num("battery_temperature", "batteryTemperature"),
      casingTemperature: () => num("scp_casing_temperature", "casing_temperature", "casingTemperature"),
      bmsTemperature: () => num("bms_temperature", "bmsTemperature"),
      temperatures: () => {
        const out: Record<string, number> = {};
        for (const [k, v] of Object.entries(values)) {
          if (typeof v === "number" && /temp/i.test(k)) out[k] = v;
        }
        return out;
      },
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
  if (SOLARBANK_MODELS.some((m) => record.product_code?.startsWith(m))) {
    caps.add("battery");
    caps.add("solarInput");
  }
  return caps;
}
