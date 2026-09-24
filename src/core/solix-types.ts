/**
 * Anker Solix vendor-JSON record shapes — the cross-layer contract between the transport client (which
 * RETURNS them off the wire) and the model layer (which resolves them into `SolixDevice`). They live in
 * `core` for the same reason the command/media boundary does: the hard `transport ⊥ model` rule forbids
 * either layer importing the other, so a type both need is neither's to own.
 *
 * @module core/solix-types
 */

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

/**
 * One battery discharge-cutoff (minimum-SOC) preset, as returned by
 * `SolixClient.getPowerCutoff()`. `output_cutoff_data` is the minimum state-of-charge percent the
 * option enforces; `id` is what `setPowerCutoff()` takes; `is_selected` (1) marks the current one.
 */
export interface SolixPowerCutoffOption {
  id: number;
  output_cutoff_data: number;
  is_selected?: number;
  [k: string]: unknown;
}

/**
 * The Solarbank's battery SOC-limit settings — the `param_data` block read from / written to
 * `site/get_site_device_param` under `param_type "27"` (verified live on an AE103). All values are
 * whole-percent integers. `chargeUpperLimit` caps charging (the app's "charge limit" / max SOC) and
 * `dischargeLowerLimit` floors discharging (the "discharge limit" / minimum SOC — the same quantity the
 * realtime `b5` telemetry blob reports). `backupReserve` (+ its switch) is the reserved-for-outage SOC;
 * `socCalibrationEnable` is the periodic full-cycle calibration toggle. The wire keys are the
 * snake_case form (`charge_upper_limit`, `discharge_lower_limit`, `backup_reserve`,
 * `backup_reserve_switch`, `soc_calibration_enable`).
 */
export interface SolixSocParams {
  chargeUpperLimit: number;
  dischargeLowerLimit: number;
  backupReserve: number;
  backupReserveSwitch: number;
  socCalibrationEnable: number;
}

/** One product in the pairable-product catalog. Extra vendor fields (images, guides) are preserved. */
export interface SolixProduct {
  /** SKU / model code, e.g. `A1782`. */
  product_code: string;
  /** Marketing name, e.g. `SOLIX F3000`. */
  name: string;
  /** Variant/sub-model codes under this product, when present. */
  p_codes?: unknown[];
  [k: string]: unknown;
}

/** A catalog category (e.g. "Portable Power Station") and its products. */
export interface SolixProductCategory {
  name: string;
  products: SolixProduct[];
  [k: string]: unknown;
}

/** One device's membership entry within a site, as carried by `get_site_list`'s `site_device_list`. */
export interface SolixSiteDeviceEntry {
  device_sn: string;
  /** The device's product/model code (the site list names this field `device_model`). */
  device_model: string;
  device_name?: string;
  /** Anker device-type discriminator (e.g. 3 = Solarbank/battery, 6 = smart meter). */
  device_type?: number;
  [k: string]: unknown;
}

/**
 * A site ("system") record, as returned by `SolixClient.getSites()`. A site is the account's home
 * energy system — the "My Home" the app shows — grouping the member devices ({@link site_device_list})
 * that a {@link SolixSiteReader} resolves into a `SolixSite`. Extra vendor fields are preserved.
 */
export interface SolixSiteRecord {
  site_id: string;
  site_name?: string;
  /** Anker's site-type discriminator (e.g. 20 for a Solarbank-anchored home system). */
  power_site_type?: number;
  site_device_list?: SolixSiteDeviceEntry[];
  [k: string]: unknown;
}

/**
 * One Solarbank/battery entry inside a site "scene" snapshot ({@link SolixSiteScene}). The scene mirrors
 * the app's dashboard read: values arrive as STRINGS. Only the fields this SDK actually consumes are
 * typed (chiefly `bat_temperature`, the realtime `ff09` push doesn't reliably carry); the index signature
 * preserves the rest (`bat_charge_power`, `charging_status`, `load_port_*`, `function_switch`, …) verbatim.
 */
export interface SolixSceneSolarbank {
  device_sn?: string;
  device_pn?: string;
  /** Battery pack temperature in °C (string on the wire). The scene is the reliable source for this. */
  bat_temperature?: string | number;
  /** State of charge, % (string on the wire). Cross-checks the `ff09` `0xa3` SOC. */
  bat_soc?: string | number;
  /**
   * Number of ATTACHED expansion battery packs — the built-in battery is the host, not a pack. Read as
   * `expansionPacks`. Observed live as `0` on a standalone AE103 main unit; a populated value (and the
   * matching per-pack `bms_list` detail) has not yet been captured with a pack attached.
   */
  sub_package_num?: string | number;
  [k: string]: unknown;
}

/**
 * A site "scene" snapshot from {@link SolixClient.getSiteScene} — the app's dashboard read. The
 * battery detail lives under `solarbank_info.solarbank_list` (NOT a top-level list). Only the shape this
 * SDK reads is typed; everything else (grid_info, home_load_power, function flags, …) is preserved by the
 * index signature. This is a low-rate backstop, never the realtime telemetry source.
 */
export interface SolixSiteScene {
  solarbank_info?: {
    solarbank_list?: SolixSceneSolarbank[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}
