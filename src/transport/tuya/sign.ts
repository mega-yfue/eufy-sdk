/**
 * Tuya `api.json` request signing for eufy Home/Clean app vacuums.
 *
 * The signature is `HMAC-SHA256(keyHmac, preimage)` (lowercase hex), where:
 *   keyHmac = certSign + '_' + secret2 + '_' + secret
 *           = {@link TUYA_HOME_HMAC_KEY}
 *
 * All three components are extracted from the eufy Home/Clean APK (`com.oceanwing.battery.cam`):
 * certSign is the package name + SHA-256 signing-certificate fingerprint (from the APK manifest
 * and signing metadata), secret2 is embedded in the native security library, and secret is the
 * `THING_SMART_SECRET` value in `AndroidManifest.xml`.
 *
 * The preimage follows the standard Tuya scheme: keep only allowlisted keys with a non-empty value,
 * sort ascending, join as `key=value` with `||`. `postData` is folded via {@link swapMd5} before joining.
 */
import { createHash, createHmac } from "node:crypto";

/**
 * Keys that participate in the signature, in no particular order (the preimage builder sorts).
 * `chKey` IS included — confirmed from a live-captured `smartlife.p.time.get` golden preimage
 * (see `scripts/tuya/setup-sign-key.mjs`). Non-allowlisted keys (sdkVersion, platform,
 * appRnVersion, …) are excluded from the sign.
 */
export const SIGN_ALLOWLIST: ReadonlySet<string> = new Set([
  "a",
  "v",
  "lat",
  "lon",
  "lang",
  "deviceId",
  "appVersion",
  "chKey",
  "ttid",
  "isH5",
  "h5Token",
  "os",
  "clientId",
  "postData",
  "time",
  "requestId",
  "et",
  "n4h5",
  "sid",
  "sp",
]);

/**
 * The `postData` sign transform: md5 the body to 32 hex chars, then rotate the four 8-char blocks
 * `[b0 b1 b2 b3]` → `[b1 b0 b3 b2]`. Same transform used by both the ThingClips SDK and the eufy
 * Home/Clean app.
 */
export function swapMd5(postData: string): string {
  const h = createHash("md5").update(postData, "utf-8").digest("hex");
  return h.slice(8, 16) + h.slice(0, 8) + h.slice(24, 32) + h.slice(16, 24);
}

/**
 * Build the exact sign **preimage** from a request param map. Keeps only allowlisted keys with a
 * non-empty value, sorts them ascending, and joins `key=value` pairs with `||`. `postData` is
 * folded via {@link swapMd5} before joining.
 */
export function buildSignPreimage(params: Readonly<Record<string, string | undefined>>): string {
  const keys = Object.keys(params)
    .filter((k) => SIGN_ALLOWLIST.has(k) && params[k] !== undefined && params[k] !== "")
    .sort();
  return keys.map((k) => `${k}=${k === "postData" ? swapMd5(params[k] as string) : params[k]}`).join("||");
}

/** The native signing seam. Given the {@link buildSignPreimage} output, return the sign (64 hex chars). */
export interface TuyaSigner {
  sign(preimage: string): string;
}

/** Placeholder {@link TuyaSigner} that throws. For unit-testing with an injected fake. */
export class StubSigner implements TuyaSigner {
  sign(_preimage: string): string {
    throw new Error("tuya StubSigner: inject a real TuyaSigner for live calls");
  }
}

/**
 * eufy Home/Clean app clientId / appKey.
 * Extracted from `THING_SMART_APPKEY` in `AndroidManifest.xml` of the eufy Home/Clean APK
 * (`com.oceanwing.battery.cam`).
 */
export const TUYA_HOME_APP_KEY = "w8x4ppqkdxvqnd73ahj9";

/**
 * Package name + SHA-256 signing-certificate fingerprint — the first component of the HMAC key.
 * Extracted from the APK signing metadata (`com.oceanwing.battery.cam`).
 */
export const TUYA_HOME_CERT_SIGN =
  "com.oceanwing.battery.cam_16:6C:23:45:57:B7:76:CA:D8:AC:94:C9:79:37:9E:48:DF:38:7D:4D:8F:96:A3:43:DF:40:FC:D9:05:BF:F6:86";

/** Second component of the HMAC key — embedded in the native security library of the APK. */
export const TUYA_HOME_SECRET2 = "dn9erpyp7nmeuvah8ktghqsgpay87maa";

/**
 * App-secret component of the HMAC key.
 * Extracted from `THING_SMART_SECRET` in `AndroidManifest.xml` of the eufy Home/Clean APK.
 */
export const TUYA_HOME_SECRET = "pt585qhmt75hwcynchnps9dnxh9suhwd";

/**
 * The assembled HMAC-SHA256 signing key: `certSign + '_' + secret2 + '_' + secret`.
 * A constant — no env var or per-install derivation needed.
 * All three components extracted from the eufy Home/Clean APK (`com.oceanwing.battery.cam`).
 */
export const TUYA_HOME_HMAC_KEY = `${TUYA_HOME_CERT_SIGN}_${TUYA_HOME_SECRET2}_${TUYA_HOME_SECRET}` as const;

/**
 * The real signing implementation: `sign = HMAC-SHA256(TUYA_HOME_HMAC_KEY, preimage)` (hex).
 * Works out of the box — the key is a constant extracted from the eufy Home/Clean APK.
 * Pass a custom `key` only in tests or to override the default.
 */
export class HmacSigner implements TuyaSigner {
  private readonly key: string;
  constructor(key?: string) {
    this.key = key ?? TUYA_HOME_HMAC_KEY;
  }
  sign(preimage: string): string {
    return createHmac("sha256", this.key).update(preimage, "utf-8").digest("hex");
  }
}

/**
 * Channel key sent on every request as `chKey`.
 * Extracted from the eufy Home/Clean APK (`com.oceanwing.battery.cam`); present in the sign
 * preimage — confirmed from the live-captured golden vector in `scripts/tuya/setup-sign-key.mjs`.
 */
export const TUYA_CHKEY = "7cbfe6d8";
