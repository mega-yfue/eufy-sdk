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
import { buildSignPreimage, type TuyaSigner } from "./sign.js";
import { randomUUID } from "node:crypto";

/** EU api.json endpoint. (Other regions swap the `tuyaeu` shard, e.g. `tuyaus`/`tuyacn`.) */
export const TUYA_API_ENDPOINT = "https://a1.tuyaeu.com/api.json";

/** Hardcoded public app key (a.k.a. clientId) shipped in the eufy app. */
export const TUYA_APP_KEY = "w8x4ppqkdxvqnd73ahj9";

/**
 * Hardcoded app secret. Public only in the sense that it ships in the vendor app; it feeds the NATIVE
 * sign digest (see {@link TuyaSigner}), so it is not used directly in this module.
 */
export const TUYA_APP_SECRET = "pt585qhmt75hwcynchnps9dnxh9suhwd";

/** Thingclips SDK version the captured traffic used. */
export const TUYA_SDK_VERSION = "7.5.0";

/** App version the client reports (also feeds the sign via `appVersion`). */
export const TUYA_APP_VERSION = "6.0.51_26722";

/** A single action to call: the `a` (action) + `v` (version) + optional pre-serialized `postData`. */
export interface TuyaAction {
  /** Action name, e.g. `thing.m.device.dp.publish`. */
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
   * 8-hex `chKey`. ✅ SOLVED: `getChKey` in `libthing_security.so` is a pure
   * function of the **appId only** (never touches time/session/Context), so it's a per-appId CONSTANT —
   * `"7cbfe6d8"` for this app's appId. Hardcode it.
   */
  chKey: string;
  /**
   * Per-login encryption code (`User.ecode`), read from the decrypted `login.reg` reply. Absent until
   * login completes; it keys the et=3 reply decryption for every session call (see `et3.ts`).
   */
  ecode?: string;
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
  /** md5 reply-integrity sign over the encrypted `result` + `t` + body key (et=3 replies). */
  sign?: string;
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
 */
export async function sendApiRequest<T = unknown>(
  params: Record<string, string>,
  opts: SendOptions = {},
): Promise<TuyaEnvelope<T>> {
  const post = opts.http ?? fetchPost;
  const body = new URLSearchParams(params).toString();
  return (await post(opts.endpoint ?? TUYA_API_ENDPOINT, body)) as TuyaEnvelope<T>;
}

/* ---- action builders (pure — no signer / network needed to construct) ---------------------- */

/**
 * CONTROL: publish device data-points. `dps` is `{ "<dpId>": <value> }`; note it is JSON-stringified
 * INSIDE the postData (Tuya nests the dps map as a string). Action `thing.m.device.dp.publish` v2.0.
 */
export function buildPublishDpsAction(devId: string, gwId: string, dps: Record<string, unknown>): TuyaAction {
  return {
    a: "thing.m.device.dp.publish",
    v: "2.0",
    postData: JSON.stringify({ gwId, devId, dps: JSON.stringify(dps) }),
  };
}

/**
 * READ/dump: fetch a device's cached data-points. Action `thing.m.device.cache.dp.get` v2.0.
 * TODO(verify): `dpCacheType` default (1) was not pinned from the capture.
 */
export function buildGetDeviceDpsAction(devId: string, dpCacheType = 1): TuyaAction {
  return {
    a: "thing.m.device.cache.dp.get",
    v: "2.0",
    postData: JSON.stringify({ devId, dpCacheType }),
  };
}

/**
 * LOGIN step 1: fetch a pre-login RSA token for a Tuya uid.
 * Wire-confirmed from the eufy Security app (`com.oceanwing.battery.cam`):
 * wire action `smartlife.m.user.username.token.get`, v=2.0.
 * Returns `{ token, publicKey, exponent }` (RSA-2048 modulus + exponent as decimal strings).
 */
export function buildUsernameTokenGetAction(countryCode: string, username: string): TuyaAction {
  return {
    a: "smartlife.m.user.username.token.get",
    v: "2.0",
    postData: JSON.stringify({ countryCode, username, isUid: true }),
  };
}

/**
 * LOGIN step 2: uid password login + auto-register.
 * Wire-confirmed from the eufy Security app: wire action
 * `smartlife.m.user.uid.password.login.reg`, v=1.0. `passwd` = hex of RSA-PKCS1-encrypt(MD5hex(aesPassword)).
 * On success returns `{ sid, uid }`.
 */
export function buildPasswordLoginRegAction(
  countryCode: string,
  uid: string,
  passwd: string,
  token: string,
): TuyaAction {
  return {
    a: "smartlife.m.user.uid.password.login.reg",
    v: "1.0",
    postData: JSON.stringify({ countryCode, uid, passwd, token, ifencrypt: 1, createGroup: true }),
  };
}

/**
 * Older Tuya API path that auto-creates a shadow account if it does not yet exist.
 * Used only by `tuya-login-diag.mjs` as a last-resort re-provisioning probe — not part of the
 * normal login flow (`smartlife.m.user.username.token.get` is step 1).
 */
export function buildUidTokenCreateAction(countryCode: string, uid: string): TuyaAction {
  return {
    a: "tuya.m.user.uid.token.create",
    v: "1.0",
    postData: JSON.stringify({ countryCode, uid }),
  };
}
