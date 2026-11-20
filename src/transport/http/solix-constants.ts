/**
 * Anker "Solix" cloud endpoints + app-line constants for {@link SolixClient}.
 *
 * Solix runs the SAME `algo_ecdh` passport as the eufy_mega account stack, re-skinned under a
 * different `app-name` with its own API host and key-exchange bootstrap key (the bootstrap key lives
 * in `core` beside its siblings — {@link SOLIX_LOCAL_KEY_HEX}). One Anker/eufy account logs in here
 * with the exact login handshake the eufy client uses; only these constants differ. Authenticated
 * resource reads, by contrast, are PLAIN JSON carrying just the auth token + `gtoken`.
 */

/** The `app-name` header value that scopes the passport + API to the Solix product. */
export const SOLIX_APP_NAME = "anker_power";

/** Domain-estimate bootstrap host. `POST /passport/estimate_domain {ab,mode:1}` answers the shard host. */
export const SOLIX_ESTIMATE_HOST = "uniapp-api-pr.anker.com";

/** EU-shard API host — the estimate result, and the fallback when estimate is skipped. */
export const SOLIX_DEFAULT_API_HOST = "ankerpower-api-eu.anker.com";

/** Solix cloud paths used by {@link SolixClient}. */
export const SOLIX_ENDPOINTS = {
  estimateDomain: "/passport/estimate_domain",
  keyExchange: "/openapi/oauth/key/exchange",
  login: "/passport/login",
  /** Bound devices for the account (flat list). */
  getRelateAndBindDevices: "/power_service/v1/app/get_relate_and_bind_devices",
  /** Sites (systems) the account owns; devices are grouped under a site. */
  getSiteList: "/power_service/v1/site/get_site_list",
  /** Per-user AWS-IoT MQTT credentials (cert/key/endpoint/thing) for the real-time device plane. */
  getUserMqttInfo: "/v1/openapi/devicemanage/get_user_mqtt_info",
  /** GET: the pairable-product catalog (categories → products), for labelling model codes. */
  productCategories: "/power_service/v1/product_categories",
  /** POST (encrypted+signed): write device attributes, e.g. `{ambient_light_switch: 0|1}`. */
  setDeviceAttrs: "/power_service/v1/app/device/set_device_attrs",
  /** POST (plain authed): read device attributes, e.g. the display `screen_off_time` (seconds). */
  getDeviceAttrs: "/power_service/v1/app/device/get_device_attrs",
  /** POST (plain authed): the battery discharge-cutoff (minimum-SOC) preset options. */
  getPowerCutoff: "/power_service/v1/app/compatible/get_power_cutoff",
  /** POST (encrypted+signed): select the discharge-cutoff preset by `cutoff_data_id`. */
  setPowerCutoff: "/power_service/v1/app/compatible/set_power_cutoff",
  /**
   * POST (plain authed): the site "scene" snapshot — the same clean Solarbank/grid telemetry the app
   * reads on load/refresh. Used as a low-rate BACKSTOP for the fields the realtime `ff09` push doesn't
   * carry reliably (notably `bat_temperature`), NOT as the realtime source (that is the MQTT push).
   */
  getSiteScene: "/power_service/v2/site/platform_get_site_scene",
  /**
   * POST (plain authed): read a site "device param" block by `param_type`. Body is
   * `{ site_id, param_type, cmd: 246 }`; the response's `data.param_data` is a JSON STRING the caller
   * parses. The Solarbank's SOC-limit settings live under `param_type "27"` (charge/discharge limits,
   * backup reserve).
   */
  getSiteDeviceParam: "/power_service/v1/site/get_site_device_param",
  /**
   * POST (encrypted+signed): write a site "device param" block. Body is
   * `{ site_id, cmd: 246, param_type, param_data: <JSON string> }`. Used for the SOC-limit write
   * (`param_type "27"`, `param_data` = the SocSettingParam map) — see {@link SolixClient.setSafetySocParams}.
   */
  setSiteDeviceParam: "/power_service/v1/site/set_site_device_param",
} as const;
