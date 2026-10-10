/**
 * Tuya / Thingclips `api.json` request signing.
 *
 * The signature is computed in two stages:
 *
 *  1. **preimage** (pure-Java, fully reversed + encoded here): take the request param map, keep
 *     ONLY the allowlisted keys with a non-empty value, sort those keys ascending, and join them
 *     as `key=value` with `||`. The `postData` value is first replaced by an md5-then-swap
 *     transform ({@link swapMd5}) so the (potentially large) body is folded to a fixed 32 chars.
 *
 *  2. **digest** (SOLVED — command 1 in `libthing_security.so` → `mbedtls_md_hmac`, SHA-256):
 *     `sign = HMAC-SHA256(K, preimage)` as lowercase hex, where K is the app-wide constant
 *     {@link TUYA_SIGN_K}, baked in from the four public components (see its doc). Behind the
 *     {@link TuyaSigner} seam: {@link HmacSigner} is the real implementation (no config needed);
 *     {@link StubSigner} (throws) is available for test stubs.
 */
import { createHash, createHmac } from "node:crypto";

/**
 * Keys that participate in the signature, in no particular order (the preimage builder sorts).
 * Everything else in the request (bizData, sdkVersion, os-info fields, cp/channel/nd, …) is
 * DELIBERATELY excluded from the sign. Verified against a live preimage (see the spec test).
 */
export const SIGN_ALLOWLIST: ReadonlySet<string> = new Set([
  "a",
  "v",
  "lat",
  "lon",
  "lang",
  "deviceId",
  "appVersion",
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
  "chKey",
  "sp",
]);

/**
 * The `postData` sign transform: md5 the body to 32 hex chars, then rotate the four 8-char blocks
 * `[b0 b1 b2 b3]` → `[b1 b0 b3 b2]`. This is the Thingclips SDK 7.5.0 transform; it is applied to
 * the `postData` value before it is joined into the preimage.
 *
 * ✅ Confirmed: the `thing.m.user.uid.token.create` call carries a `postData`, and its
 * sign (computed over this transform) was accepted by `a1.tuyaeu.com` with no SIGN_INVALID — so a
 * postData-bearing preimage IS exercised end-to-end. (The static `smartlife.p.time.get` golden vector
 * separately carries no postData; the two together cover both paths.)
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
    .sort(); // default lexicographic sort = ASCII ascending, matching the native ordering
  return keys.map((k) => `${k}=${k === "postData" ? swapMd5(params[k] as string) : params[k]}`).join("||");
}

/**
 * The native signing seam. Given the {@link buildSignPreimage} output, return the final `sign`
 * value (SHA-256-length hex). Implementations mix in the app secret natively.
 */
export interface TuyaSigner {
  sign(preimage: string): string;
}

/** Test-only {@link TuyaSigner} that throws on every call. */
export class StubSigner implements TuyaSigner {
  sign(_preimage: string): string {
    throw new Error(
      "native sign not yet implemented: the api.json `sign` digest is computed in " +
        "libthing_security.so (command 1) and has not been reversed — inject a real TuyaSigner",
    );
  }
}

/**
 * App-wide HMAC-SHA256 signing key **K** (`package_cert_stego_appSecret`), assembled from four
 * public per-build constants (wire-confirmed from the eufy Security/Mega app + native memory dump):
 *   - package name: `com.oceanwing.battery.cam`
 *   - developer signing-cert SHA-256 (colon-hex UPPER, verified from running app memory)
 *   - stego value: extracted from `libthing_security.so + 0x384f0` (keyed BMP steganography)
 *   - manifest app secret (also in {@link TUYA_APP_SECRET} in `request.ts`)
 *
 * All four components are public per-build constants.
 * The env var `TUYA_SIGN_KEY` can override this for non-standard builds.
 */
export const TUYA_SIGN_K =
  "com.oceanwing.battery.cam_" +
  "16:6C:23:45:57:B7:76:CA:D8:AC:94:C9:79:37:9E:48:DF:38:7D:4D:8F:96:A3:43:DF:40:FC:D9:05:BF:F6:86_" +
  "dn9erpyp7nmeuvah8ktghqsgpay87maa_" +
  "pt585qhmt75hwcynchnps9dnxh9suhwd";

/**
 * Resolve the app-wide HMAC key {@link TUYA_SIGN_K}: an explicit `override` wins, then the
 * `TUYA_SIGN_KEY` env var (for custom builds), then the built-in constant. Shared by the request
 * signer ({@link HmacSigner}) and the et=3 reply body-key derivation (`et3.ts`), which key off the
 * same `K`.
 */
export function resolveSignKey(override?: string): string {
  return override ?? process.env.TUYA_SIGN_KEY ?? TUYA_SIGN_K;
}

/**
 * The real {@link TuyaSigner}: `sign = HMAC-SHA256(K, preimage)` as lowercase hex.
 *
 * Uses {@link TUYA_SIGN_K} by default — no configuration required. The env var `TUYA_SIGN_KEY`
 * overrides the built-in key (for custom builds); an explicit constructor argument takes precedence
 * over both. Verified: reproduces the captured `smartlife.p.time.get` sign `97a78b35…a7f8c84`.
 */
export class HmacSigner implements TuyaSigner {
  private readonly key: string;
  constructor(key?: string) {
    this.key = resolveSignKey(key);
  }
  sign(preimage: string): string {
    return createHmac("sha256", this.key).update(preimage, "utf-8").digest("hex");
  }
}

/**
 * Channel key sent on every request as `chKey`.
 * Extracted from the eufy Security/Mega app (`com.oceanwing.battery.cam`); present in the sign
 * preimage — confirmed from the live-captured golden vector (`smartlife.p.time.get`).
 */
export const TUYA_CHKEY = "7cbfe6d8";
