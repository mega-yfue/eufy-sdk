/**
 * Tuya / Thingclips `api.json` request assembly + transport.
 *
 * Every call is a single `POST https://a1.tuyaeu.com/api.json` (EU) whose body is
 * **form-urlencoded plaintext params** (NOT an encrypted blob) plus a `sign`. This module builds
 * that param map for a given action, form-encodes it, POSTs it, and parses Tuya's response
 * envelope. The one non-plaintext piece — the `sign` digest — is delegated to a {@link TuyaSigner}.
 */
/** Injectable POST transport — takes (url, form-body), returns the parsed JSON envelope. Native `fetch` by default. */
export type TuyaHttpPost = (url: string, body: string) => Promise<unknown>;
import { buildSignPreimage, TUYA_HOME_HMAC_KEY, type TuyaSigner } from "./sign.js";
import { createDecipheriv, createHmac, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";

/** EU api.json endpoint. (Other regions swap the `tuyaeu` shard, e.g. `tuyaus`/`tuyacn`.) */
export const TUYA_API_ENDPOINT = "https://a1.tuyaeu.com/api.json";

/** Hardcoded public app key (a.k.a. clientId) shipped in the eufy app. */
export const TUYA_APP_KEY = "w8x4ppqkdxvqnd73ahj9";

/**
 * Hardcoded app secret. Public only in the sense that it ships in the APK; it feeds the NATIVE
 * sign digest (see {@link TuyaSigner}), so it is not used directly in this module.
 */
export const TUYA_APP_SECRET = "pt585qhmt75hwcynchnps9dnxh9suhwd";

/**
 * Derive the AES-128-GCM decryption key for an `et=3` api.json response.
 *
 * The Android SDK calls `getEncryptoKey(requestId, null)` (JNI in `libthing_security.so`).
 * Confirmed by binary RE of `libthing_security.so` and validated live (sign check + GCM tag auth
 * both pass):
 *   `HMAC-SHA256(key=requestId, data=G) → lowercase hex → first 16 chars as ASCII bytes`
 * where G is the assembled signing key {@link TUYA_HOME_HMAC_KEY} — the same key used for signing.
 * This produces a 16-byte ASCII-safe key, matching the `new String(encryptoKey)` call in
 * `Business.java` that re-interprets the raw bytes as UTF-8 for sign verification.
 *
 * @internal
 */
function deriveResponseKey(requestId: string): Buffer {
  const hex = createHmac("sha256", requestId).update(TUYA_HOME_HMAC_KEY).digest("hex");
  return Buffer.from(hex.slice(0, 16), "ascii");
}

/**
 * Decrypt a Tuya `et=3` response `result` field (base64-encoded AES-128-GCM ciphertext).
 *
 * Frame layout per `AesGcmUtil.decryptBytesAppendedNonce2Bytes` (Java):
 *   `nonce(12) ‖ ciphertext ‖ tag(16)`, no AAD.
 * The plaintext may be gzip-compressed (`ThingNetGzipHelper.unzipDecryptData`).
 *
 * Throws if GCM authentication fails (wrong key) or JSON parse fails.
 *
 * @internal
 */
function decryptGcmResult(resultB64: string, requestId: string): unknown {
  const blob = Buffer.from(resultB64, "base64");
  if (blob.length < 28) throw new Error("tuya: result blob too short to be AES-GCM");
  const key = deriveResponseKey(requestId);
  const nonce = blob.subarray(0, 12);
  const tag = blob.subarray(blob.length - 16);
  const ct = blob.subarray(12, blob.length - 16);
  const d = createDecipheriv("aes-128-gcm", key, nonce);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(ct), d.final()]);
  const text = (plain[0] === 0x1f && plain[1] === 0x8b ? gunzipSync(plain) : plain).toString("utf-8");
  return JSON.parse(text);
}

/** Thingclips SDK version the captured traffic used. */
export const TUYA_SDK_VERSION = "7.5.0";

/**
 * App version sent on every Tuya API request. Confirmed from
 * `com.thingclips.smart.device.core.sdk.BuildConfig.VERSION_NAME` in the decompiled eufy Security
 * APK (`com.oceanwing.battery.cam`) and from live-running app memory-dump sign preimages
 * (`appVersion=6.7.0`). The older `"6.0.51_26722"` value in the historical golden vector is from
 * a prior APK build; the server rejects older values with `APP_NEED_UPGRADE`.
 */
export const TUYA_APP_VERSION = "6.7.0";

/** A single action to call: the `a` (action) + `v` (version) + optional pre-serialized `postData`. */
export interface TuyaAction {
  /** Action name, e.g. `smartlife.m.device.dp.publish`. */
  a: string;
  /** Per-action version, e.g. `"1.0"` / `"2.0"`. */
  v: string;
  /** The `postData` param value — already a JSON STRING (Tuya carries the body as a string param). */
  postData?: string;
}

/** Per-install session identity carried on every request. */
export interface TuyaSession {
  /** Session id from a successful login; empty string pre-login. */
  sid: string;
  /** Per-install device id (44-hex in the capture). See {@link TuyaClient} for generation. */
  deviceId: string;
  /**
   * 8-hex `chKey`. ✅ SOLVED: disassembly of `getChKey` in `libthing_security.so` proved it's a pure
   * function of the **appId only** (never touches time/session/Context), so it's a per-appId CONSTANT —
   * `"7cbfe6d8"` for this app's appId. Hardcode it.
   */
  chKey: string;
}

/**
 * The constant / environment fields of a request. All are plaintext and (except the sign-relevant
 * `clientId`/`os`/`ttid`/`lang`/`et`/`appVersion`) do NOT feed the sign. Values marked TODO are
 * cosmetic os-info fields whose exact contents were not pinned from the capture; they do not affect
 * the sign and can be tuned freely.
 */
export interface TuyaEnv {
  /** appKey. */
  clientId: string;
  sdkVersion: string;
  appVersion: string;
  /** "Android". */
  os: string;
  /** "android". */
  ttid: string;
  /** "en_GB". */
  lang: string;
  /** "3". */
  et: string;
  /** "gzip". */
  cp: string;
  /** "sdk". */
  channel: string;
  /** "1". */
  nd: string;
  /** JSON string, e.g. `{"customDomainSupport":"1","sdkInt":"36","nd":"1","brand":"google"}`. */
  bizData: string;
  /** TODO(unknown): device platform string; cosmetic (not in sign). */
  platform: string;
  /** TODO(unknown): OS system version; cosmetic (not in sign). */
  osSystem: string;
  /** IANA time zone id, e.g. "Europe/London". */
  timeZoneId: string;
  /** TODO(unknown): Thingclips device-core version; cosmetic (not in sign). */
  deviceCoreVersion: string;
}

/** Default environment fields (see {@link TuyaEnv} for which are verified vs. TODO/cosmetic). */
export const DEFAULT_TUYA_ENV: TuyaEnv = {
  clientId: TUYA_APP_KEY,
  sdkVersion: TUYA_SDK_VERSION,
  appVersion: TUYA_APP_VERSION,
  os: "Android",
  ttid: "android",
  lang: "en_GB",
  et: "3",
  cp: "gzip",
  channel: "sdk",
  nd: "1",
  bizData: JSON.stringify({ customDomainSupport: "1", sdkInt: "36", nd: "1", brand: "google" }),
  platform: "google", // TODO(unknown): cosmetic
  osSystem: "14", // TODO(unknown): cosmetic
  timeZoneId: "Europe/London",
  deviceCoreVersion: "", // TODO(unknown): cosmetic
};

/** Inputs to {@link buildApiParams} beyond the action itself. */
export interface BuildRequestOptions {
  session: TuyaSession;
  signer: TuyaSigner;
  env?: TuyaEnv;
  /** Override the unix-second `time` (default: now) — for deterministic builds/tests. */
  time?: number;
  /** Override the `requestId` uuid (default: random v4) — for deterministic builds/tests. */
  requestId?: string;
}

/**
 * Build the full form param map for an action: fills the static env + per-install session fields +
 * generated `time`/`requestId`, computes the sign preimage over the allowlisted subset, and appends
 * the `sign` from the signer. Returns a flat `Record<string,string>` ready to form-encode.
 *
 * The sign is the only step that needs a working {@link TuyaSigner}; a {@link StubSigner} throws
 * here. Callers that only want to inspect the param shape can read {@link BuildRequestOptions} with
 * a fake signer.
 */
export function buildApiParams(action: TuyaAction, opts: BuildRequestOptions): Record<string, string> {
  const env = opts.env ?? DEFAULT_TUYA_ENV;
  const params: Record<string, string> = {
    a: action.a,
    v: action.v,
    time: String(opts.time ?? Math.floor(Date.now() / 1000)),
    requestId: opts.requestId ?? randomUUID(),
    sid: opts.session.sid,
    deviceId: opts.session.deviceId,
    chKey: opts.session.chKey,
    os: env.os,
    ttid: env.ttid,
    lang: env.lang,
    appVersion: env.appVersion,
    et: env.et,
    clientId: env.clientId,
    sdkVersion: env.sdkVersion,
    bizData: env.bizData,
    cp: env.cp,
    channel: env.channel,
    platform: env.platform,
    osSystem: env.osSystem,
    timeZoneId: env.timeZoneId,
    nd: env.nd,
    deviceCoreVersion: env.deviceCoreVersion,
  };
  if (action.postData !== undefined) params.postData = action.postData;

  const sign = opts.signer.sign(buildSignPreimage(params));
  return { ...params, sign };
}

/** Tuya's standard response envelope. */
export interface TuyaEnvelope<T = unknown> {
  success: boolean;
  /** Server unix-ms timestamp. */
  t?: number;
  /** Decoded result payload (present on success). */
  result?: T;
  errorCode?: string;
  errorMsg?: string;
  /** Occasionally present status string. */
  status?: string;
}

/** Transport knobs for {@link sendApiRequest}. */
export interface SendOptions {
  endpoint?: string;
  /** Inject a POST transport (default: native `fetch`). Used to stub the network in tests. */
  http?: TuyaHttpPost;
}

/** Default transport: native fetch, form-urlencoded body, 20s timeout, parse JSON regardless of status. */
const fetchPost: TuyaHttpPost = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  return res.json();
};

/**
 * Form-encode a param map and POST it to `api.json`, returning the parsed {@link TuyaEnvelope}.
 * The body is `application/x-www-form-urlencoded` (Tuya rejects JSON here).
 *
 * When `et=3` is active (the default), the server's outer HTTP response carries `result` as an
 * AES-128-GCM encrypted base64 string. The encrypted blob decodes to the **full business
 * {@link TuyaEnvelope}** (`{success, result?, errorCode?, …}`) — so on successful decryption that
 * inner envelope IS returned directly, not nested inside the outer wrapper. This matches the
 * server's double-envelope design: outer transport frame → decrypt → inner business envelope.
 *
 * Transport-level errors (bad sign, missing params) arrive as a plain `{success:false,
 * errorCode, errorMsg}` outer envelope with no `result` string, and are returned as-is.
 *
 * Stubs that inject a pre-decoded object (in either shape) bypass decryption because
 * `typeof result !== "string"`.
 */
export async function sendApiRequest<T = unknown>(
  params: Record<string, string>,
  opts: SendOptions = {},
): Promise<TuyaEnvelope<T>> {
  const post = opts.http ?? fetchPost;
  const body = new URLSearchParams(params).toString();
  const raw = (await post(opts.endpoint ?? TUYA_API_ENDPOINT, body)) as TuyaEnvelope<T>;

  if (typeof raw.result === "string") {
    const requestId = params.requestId;
    if (!requestId) return raw; // no requestId → can't derive key; return as-is
    try {
      // The decrypted blob IS the business TuyaEnvelope — return it directly.
      return decryptGcmResult(raw.result, requestId) as TuyaEnvelope<T>;
    } catch (e) {
      throw new Error(
        `tuya: failed to decrypt et=3 result for requestId=${requestId} ` +
          `— key derivation (HMAC-SHA256(requestId,G).hex().slice(0,16)) failed; ` +
          `underlying: ${(e as Error).message}`,
      );
    }
  }

  return raw;
}

/* ---- action builders (pure — no signer / network needed to construct) ---------------------- */

/**
 * CONTROL: publish device data-points. `dps` is `{ "<dpId>": <value> }`; note it is JSON-stringified
 * INSIDE the postData (Tuya nests the dps map as a string). Action `smartlife.m.device.dp.publish` v2.0.
 */
export function buildPublishDpsAction(devId: string, gwId: string, dps: Record<string, unknown>): TuyaAction {
  return {
    a: "smartlife.m.device.dp.publish",
    v: "2.0",
    postData: JSON.stringify({ gwId, devId, dps: JSON.stringify(dps) }),
  };
}

/**
 * READ/dump: fetch a device's cached data-points. Action `smartlife.m.device.cache.dp.get` v2.0.
 * TODO(verify): `dpCacheType` default (1) was not pinned from the capture.
 */
export function buildGetDeviceDpsAction(devId: string, dpCacheType = 1): TuyaAction {
  return {
    a: "smartlife.m.device.cache.dp.get",
    v: "2.0",
    postData: JSON.stringify({ devId, dpCacheType }),
  };
}

/**
 * LOGIN step 1: request a pre-login token for a uid-style username.
 *
 * Action confirmed by decompiling `pqdbppq.java` (ThingClips SDK 7.5.0) — the eufy app calls
 * `smartlife.m.user.username.token.get` at v=2.0 (ThingClips SDK rewrites `thing.*` → `smartlife.*`
 * before hitting the wire; direct calls must use the wire name). `isUid: true` flags that the
 * account is a uid-type (required — the server uses a different lookup path without it).
 */
export function buildUsernameTokenGetAction(countryCode: string, username: string): TuyaAction {
  return {
    a: "smartlife.m.user.username.token.get",
    v: "2.0",
    postData: JSON.stringify({ countryCode, username, isUid: true }),
  };
}

/**
 * LOGIN step 2: uid password login (auto-registers on first login).
 * `passwd` is the RSA-encrypted lowercase-hex-MD5 of the AES-derived password bytes;
 * `ifencrypt=1` signals the password is encrypted.
 *
 * Action confirmed from `pqdbppq.java` `pdqppqb` method (ThingClips SDK 7.5.0):
 * `smartlife.m.user.uid.password.login.reg` at v=1.0 (wire name after ThingClips SDK rewrite).
 * `uid` is the full username string (`"eufyhome-<userId>"`), `countryCode` as string.
 * `createGroup: true` auto-registers the account when it does not yet exist.
 * `options: '{"group": 1}'` is required — the ThingClips SDK (`pqdbppq.java`, `dpdbqdp = "options"`)
 * always includes it; omitting it causes `APP_NEED_UPGRADE` from the server.
 */
export function buildPasswordLoginAction(countryCode: string, uid: string, passwd: string, token: string): TuyaAction {
  return {
    a: "smartlife.m.user.uid.password.login.reg",
    v: "1.0",
    postData: JSON.stringify({
      countryCode,
      uid,
      passwd,
      token,
      ifencrypt: 1,
      createGroup: true,
      options: '{"group": 1}',
    }),
  };
}
