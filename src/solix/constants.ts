/**
 * Anker "Solix" power-station cloud — endpoints and bootstrap constants.
 *
 * Solix runs the SAME `algo_ecdh` passport as the eufy_mega account stack (see {@link
 * prepareKeyExchange}, {@link encryptLoginPassword}, {@link signRequest}), re-skinned under a
 * different `app-name` with its own key-exchange bootstrap key and API host. So one Anker/eufy
 * account logs in here with the exact login handshake the eufy client uses; only these constants
 * differ. Authenticated resource reads, by contrast, are PLAIN JSON carrying just the auth token +
 * gtoken (no per-request encryption) — see {@link SolixClient}.
 */

/** The `app-name` header value that scopes the passport + API to the Solix product. */
export const SOLIX_APP_NAME = "anker_power";

/** Domain-estimate bootstrap host. `POST /passport/estimate_domain {ab,mode:1}` answers the shard host. */
export const SOLIX_ESTIMATE_HOST = "uniapp-api-pr.anker.com";

/** EU-shard API host — the estimate result, and the fallback when estimate is skipped. */
export const SOLIX_DEFAULT_API_HOST = "ankerpower-api-eu.anker.com";

/**
 * Key-exchange bootstrap localKey for `anker_power` (AES-128, hex). The login key-exchange wraps the
 * ephemeral client public key with this and signs the request with it; distinct from the eufy_mega
 * bootstrap key ({@link EUFY_MEGA_LOCAL_KEY_HEX}).
 */
export const SOLIX_LOCAL_KEY_HEX = "e8ad18f61bbd3fbd52d5ed12d14d3b9c";

/** Solix cloud paths used by {@link SolixClient}. */
export const SOLIX_ENDPOINTS = {
  estimateDomain: "/passport/estimate_domain",
  keyExchange: "/openapi/oauth/key/exchange",
  login: "/passport/login",
  getProfile: "/passport/get_profile",
  /** Bound devices for the account (flat list). */
  getRelateAndBindDevices: "/power_service/v1/app/get_relate_and_bind_devices",
  /** Sites (systems) the account owns; devices are grouped under a site. */
  getSiteList: "/power_service/v1/site/get_site_list",
  /** Per-user AWS-IoT MQTT credentials (cert/key/endpoint/thing) for the real-time device plane. */
  getUserMqttInfo: "/v1/openapi/devicemanage/get_user_mqtt_info",
  /** GET: the pairable-product catalog (categories → products), for labelling model codes. */
  productCategories: "/power_service/v1/product_categories",
  /** GET: pairable accessories. */
  productAccessories: "/power_service/v1/product_accessories",
} as const;
