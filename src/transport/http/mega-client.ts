/**
 * Mega (Anker AIoT) HTTP client — algo_ecdh signed transport.
 *
 * Login flow (verified shape against the iOS Mega app):
 *   1. estimate_domain (no auth) on mega-{region}.eufy.com → real region shard.
 *   2. ONE ECDH key exchange per region on app-openapi-{region}.eufy.com — the
 *      resulting shareKey + X-Key-Ident sign EVERY later call (openapi/passport/app-*).
 *   3. /passport/login on app-passport-{region}.eufy.com with an ECDH-encrypted
 *      password (one-shot vs the static server key).
 *   4. Authed data calls on app-{service}-{region}.eufy.com.
 *
 * Bodies are AES-128-CBC(shareKey) base64; x-signature = HMAC over ts+once+encBody.
 */
import { createHash } from "node:crypto";
import {
  type SessionEntry,
  EUFYLIFE_LOCAL_KEY_HEX,
  decryptBody,
  encryptBody,
  encryptLoginPassword,
  finishKeyExchange,
  genId,
  gtoken,
  nowSec,
  prepareKeyExchange,
  signRequest,
} from "../../core/crypto.js";
import { MemorySessionStore, isSessionValid, type SessionStore } from "../../core/store.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import type { SecureMqttCredentials } from "../mqtt/secure-mqtt.js";
import { downloadMediaResource, MediaDownloadAuthenticationError } from "./media-download.js";
import { normalizePushImage } from "./decodeImageV1.js";

export type RegionShard = "eu-pr" | "us-pr";

/**
 * Construction options for the internal HTTP client.
 * @internal
 */
export interface MegaClientConfig {
  email: string;
  password: string;
  /** Two-letter account country code (e.g. "GB", "US", "DE"). Routes the region. */
  countryCode?: string;
  /** Force a region shard, skipping estimate_domain. */
  region?: RegionShard;
  appName?: string;
  appVersion?: string;
  /**
   * Phone model reported to the cloud. Give this client its OWN distinct value
   * (e.g. "eufy-mega-client") so it appears as a separate device in your eufy
   * account + 2FA/trust list, instead of impersonating a real phone.
   */
  phoneModel?: string;
  /** OS version string reported in headers. */
  osVersion?: string;
  /** Stable per-install device id (the auth token binds to it). Derived from email if absent. */
  openudid?: string;
  /** Persist + reuse the session (token + session key) across runs. Default: in-memory. */
  store?: SessionStore;
  /** Diagnostics sink. Omit for silence; pass a `Logger` (or `new ConsoleLogger()`) to see logs. */
  logger?: Logger;
}

interface ApiEnvelope<T> {
  code: number;
  msg?: string;
  data: T;
}

/** Parse a response body as JSON, falling back to the raw text (mirrors axios' default transform). */
function parseMaybeJson(text: string): unknown {
  if (text.length === 0) return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * A mega API call the server answered with a non-zero envelope code, carrying that code rather than only a
 * message.
 *
 * The retry/auth logic here already decides what to do by NUMBER (4416, 10000, 4404, 26084), so the number is
 * the authoritative fact about which condition was hit. Formatting it into a message and throwing a bare
 * `Error` left every caller that needs to tell one condition from another parsing this module's message
 * format back apart — a decision that belongs to the layer that owns the wire, not to whoever reads it.
 */
export class MegaApiError extends Error {
  constructor(
    message: string,
    /** The envelope's `code`, or undefined when the failure produced no envelope. */
    readonly code: number | undefined,
    /** The HTTP status the envelope arrived with. */
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = "MegaApiError";
  }
}

/**
 * `get_device_param_list` refuses a shared or member account: only the device's owner may read it. The
 * refusal is permanent for the life of that account's session, so a caller should fall back to the
 * device-list params rather than retry.
 */
export const OWNER_ONLY_CODE = 20004;

/** Thrown when a persisted/expired session is rejected (401). Re-login to recover. */
export class SessionExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/**
 * The raw login reply shape — internal; a host reads the `LoginResult` union.
 * @internal
 */
export interface MegaLoginResult {
  userId: string;
  authToken: string;
  geoKey?: string;
  raw: Record<string, unknown>;
}

/**
 * The status discriminant of a {@link LoginResult}. Compare `result.status` against these constants
 * (e.g. `if (r.status === LoginStatus.Captcha)`).
 */
export const LoginStatus = {
  /** Authenticated — `result.session` carries the token. */
  Ok: "ok",
  /** Solve `result.image` and call `solveCaptcha(answer)`. */
  Captcha: "captcha",
  /** A code was sent; call `submitVerifyCode(code)`. */
  TwoFactor: "2fa",
} as const;
export type LoginStatus = (typeof LoginStatus)[keyof typeof LoginStatus];

/**
 * Outcome of `login` / continuation steps — a discriminated union so the
 * caller switches on `status` instead of catching thrown errors for the expected captcha/2FA flow.
 * Compare `status` against {@link LoginStatus}:
 *  - `Ok` — authenticated; `session` carries the token.
 *  - `Captcha` — solve `image` (a `data:image/png;base64` 4-char challenge) and call
 *    `solveCaptcha(answer)`. `retry` is true when a prior answer was wrong.
 *  - `TwoFactor` — a code was sent (`method` says how); call `submitVerifyCode(code)`.
 * The `captchaId` / pending-2FA token are held internally, so continuation methods take only the
 * user-supplied answer/code.
 */
export type LoginResult =
  | { status: typeof LoginStatus.Ok; session: MegaLoginResult }
  | { status: typeof LoginStatus.Captcha; image: string; retry: boolean }
  | { status: typeof LoginStatus.TwoFactor; method: string };

/**
 * The cloud HTTP client. Internal transport, reachable as an escape hatch via `EufyMega.api`.
 * @internal
 */
export class MegaHttpClient {
  private readonly cfg: Required<Pick<MegaClientConfig, "appName" | "appVersion" | "countryCode">> & MegaClientConfig;
  private region: RegionShard;
  private bootstrapDomain?: string;
  private sessionKey?: SessionEntry;
  /** Per-host ECDH session keys for non-mega gateways (e.g. eufylife) keyed by host. */
  private readonly sessionKeys = new Map<string, SessionEntry>();
  private auth_?: { userId: string; authToken: string; geoKey?: string };
  /** captcha_id of an in-flight challenge, held between login() and solveCaptcha(). */
  private pendingCaptchaId?: string;
  /** True while a 2FA code is outstanding: `auth_` holds only the limited pre-verify token, so the
   *  restored-session short-circuit must NOT treat it as a usable session. Cleared on Ok/reset. */
  private pending2fa = false;
  private tokenExpiresAt = 0;
  /** Stable per-install device id — the auth token is bound to it. */
  private openudid: string;
  private readonly store: SessionStore;
  private readonly logger: Logger;
  /** Remembered working Content-Type per host (the gateway is picky + inconsistent). */
  private readonly contentTypeByHost = new Map<string, string>();

  constructor(cfg: MegaClientConfig) {
    this.cfg = {
      appName: "eufy_mega",
      appVersion: "6.0.41_26142",
      countryCode: "US",
      phoneModel: "eufy-mega-client",
      osVersion: "36",
      ...cfg,
    };
    this.region = cfg.region ?? "us-pr";
    this.openudid = cfg.openudid ?? createHash("md5").update(`eufy-mega:${cfg.email}`).digest("hex").slice(0, 16);
    this.store = cfg.store ?? new MemorySessionStore();
    this.logger = cfg.logger ?? noopLogger;

    // Hydrate a persisted session: reuse the token + bound ECDH key, skipping
    // estimate/key-exchange/login/2FA entirely.
    const saved = this.store.load();
    if (isSessionValid(saved) && saved) {
      this.region = saved.region;
      this.openudid = saved.openudid;
      this.auth_ = { userId: saved.userId, authToken: saved.authToken, geoKey: saved.geoKey };
      this.tokenExpiresAt = saved.tokenExpiresAt;
      this.sessionKey = {
        keyIdent: saved.keyIdent,
        shareKey: saved.shareKey,
        clientPublicKeyHex: "",
        clientPrivateKeyHex: "",
        createdAt: Date.now(),
      };
      this.logger.debug("[mega] restored persisted session for", saved.userId);
    }
  }

  get auth(): { userId: string; authToken: string } | undefined {
    return this.auth_ ? { userId: this.auth_.userId, authToken: this.auth_.authToken } : undefined;
  }

  /** The active region shard (e.g. `"eu-pr"`, `"us-pr"`), set after {@link login} or a region override. */
  get regionShard(): RegionShard {
    return this.region;
  }

  /**
   * The logged-in account's display name — the login email's local-part (e.g. `someone+tag` for
   * `someone+tag@example.com`). This is the string the app writes into the ff09 command's acting
   * "username" field (verified against a captured T8531 unlock frame). Falls back to the whole email
   * if it has no `@`.
   */
  get accountName(): string {
    const email = this.cfg.email ?? "";
    const at = email.indexOf("@");
    return at > 0 ? email.slice(0, at) : email;
  }

  /**
   * Headers the gateway expects on every call. Note the deliberate
   * dash/underscore duplicates (os-type + os_type, app-version + app_version,
   * …) — the app sends both forms and the gateway reads a mix. `openudid` is
   * REQUIRED: the auth token is bound to it, so login + data calls must use the
   * same value or the gateway 401s with "secret or user_id is empty".
   */
  private baseHeaders(): Record<string, string> {
    const v = this.cfg.appVersion;
    const osv = this.cfg.osVersion ?? "36";
    const model = this.cfg.phoneModel ?? "eufy-mega-client";
    return {
      "app-name": this.cfg.appName,
      "app-version": v,
      app_version: v,
      "os-type": "android",
      os_type: "android",
      "os-version": osv,
      os_version: osv,
      "phone-model": model,
      phone_model: model,
      "model-type": "PHONE",
      country: this.cfg.countryCode,
      ab_code: this.cfg.countryCode,
      openudid: this.openudid,
      language: "en",
      "test-flag": "false",
      "user-agent": "ktor-client",
      accept: "application/json",
      "accept-charset": "UTF-8",
    };
  }

  /**
   * The account-credential headers every authed call carries — `x-auth-token` + `gtoken` (`md5(userId)`).
   * One place so the signed path, the key-exchange and the bearer path can't drift on what "authed" means.
   */
  private authTokenHeaders(): Record<string, string> {
    if (!this.auth_) return {};
    return {
      "x-auth-token": this.auth_.authToken,
      authorization: this.auth_.authToken,
      gtoken: gtoken(this.auth_.userId),
    };
  }

  /**
   * POST returning an axios-shaped `{status, data}` — `data` is JSON-parsed when possible, else the
   * raw text. Never throws on HTTP status (the callers classify the envelope themselves). 20s timeout.
   */
  private async httpPost(
    url: string,
    body: string | object,
    headers: Record<string, string>,
  ): Promise<{ status: number; data: unknown }> {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: typeof body === "string" ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, data: parseMaybeJson(await res.text()) };
  }

  /** Step 1: discover the account's region shard (and the bootstrap host). */
  async estimateDomain(): Promise<void> {
    const url = `https://mega-${this.region}.eufy.com/passport/estimate_domain`;
    const res = await this.httpPost(
      url,
      { ab: this.cfg.countryCode.toLowerCase(), mode: 1 },
      {
        ...this.baseHeaders(),
        "content-type": "application/json",
      },
    );
    this.logger.debug("[mega] estimate_domain raw:", JSON.stringify(res.data).slice(0, 400));
    const env = res.data as ApiEnvelope<Record<string, unknown>>;
    const d = env?.data ?? {};
    const domain = (d.domain ?? d.host ?? d.server_secret_info ?? "") as string;
    const blob = JSON.stringify(d);
    if (blob.includes("-eu-") || domain.includes("-eu-")) this.region = "eu-pr";
    else if (blob.includes("-us-") || domain.includes("-us-")) this.region = "us-pr";
    if (domain && !domain.startsWith("mega-")) this.bootstrapDomain = domain;
    this.logger.debug("[mega] region:", this.region, "domain:", domain);
  }

  /**
   * Step 2: ensure a key-exchange SessionEntry for the current region. ONE
   * exchange per region; the same shareKey + key-ident signs login AND every
   * data call. The gateway binds user_id to this key-ident when login succeeds,
   * so it MUST be reused (don't re-exchange after login).
   */
  async ensureSessionKey(targetHost?: string): Promise<SessionEntry> {
    // The eufylife data host (security-app-*.eufylife.com) runs its OWN key exchange with a
    // different bootstrap localKey + `/v3/` path, and rejects the mega key. Keep a per-host
    // cache for it; the mega key (this.sessionKey) is shared across the whole *.eufy.com stack
    // and is the one bound to user_id at login — don't conflate them.
    const isEufylife = !!targetHost && targetHost.includes(".eufylife.com");
    if (!isEufylife) {
      if (this.sessionKey && Date.now() - this.sessionKey.createdAt < 12 * 3600_000) return this.sessionKey;
    } else {
      const cached = this.sessionKeys.get(targetHost!);
      if (cached && Date.now() - cached.createdAt < 12 * 3600_000) return cached;
    }
    const host = isEufylife ? targetHost! : (this.bootstrapDomain ?? `app-openapi-${this.region}.eufy.com`);
    const kxPath = isEufylife ? "/v3/openapi/oauth/key/exchange" : "/openapi/oauth/key/exchange";
    const prep = prepareKeyExchange(isEufylife ? EUFYLIFE_LOCAL_KEY_HEX : undefined);
    const res = await this.httpPost(
      `https://${host}${kxPath}`,
      { client_public_key: prep.encryptedClientPublicKey },
      {
        ...this.baseHeaders(),
        ...prep.headers,
        ...this.authTokenHeaders(),
        "content-type": "application/json",
      },
    );
    this.logger.debug(
      `[mega] key/exchange ${isEufylife ? "eufylife " : ""}(${this.auth_ ? "authed" : "anon"}) ->`,
      res.status,
      JSON.stringify(res.data).slice(0, 160),
    );
    const env = res.data as ApiEnvelope<{ server_public_key: string }>;
    if (res.status !== 200 || env?.code !== 0 || !env?.data?.server_public_key) {
      throw new Error(
        `key/exchange failed (${res.status}/${env?.code}): ${env?.msg ?? JSON.stringify(res.data).slice(0, 160)}`,
      );
    }
    const entry = finishKeyExchange(prep, env.data.server_public_key);
    if (isEufylife) this.sessionKeys.set(targetHost!, entry);
    else this.sessionKey = entry;
    return entry;
  }

  /** Signed + encrypted POST. Content-type auto-falls-back (text/plain ↔ json). */
  async postSigned<T = unknown>(
    host: string,
    path: string,
    body: unknown = {},
    authed = true,
    _identityRetried = false,
    headerOverrides: Record<string, string> = {},
  ): Promise<T> {
    const entry = await this.ensureSessionKey(host);
    const encBody = encryptBody(JSON.stringify(body ?? {}), entry.shareKey);
    // The gateway wants a specific Content-Type per host and 4416s ("signature
    // invalid") on the wrong one — so we probe, then REMEMBER the winner per host
    // to avoid re-probing (and the resulting noise/double-requests) next time.
    // eufylife data calls want text/plain (application/json → 403 at the proxy); mega hosts take
    // json (except /passport/). Prefer the right one first so the HTML 403 doesn't end the probe.
    const cached = this.contentTypeByHost.get(host);
    const wantsText = path.includes("/passport/") || host.includes(".eufylife.com");
    const preferred = cached ?? (wantsText ? "text/plain" : "application/json");
    const order = preferred === "text/plain" ? ["text/plain", "application/json"] : ["application/json", "text/plain"];

    let last: { code?: number; msg?: string; status?: number } | undefined;
    for (const contentType of order) {
      const ts = nowSec();
      const once = genId();
      const headers: Record<string, string> = {
        ...this.baseHeaders(),
        "content-type": contentType,
        "x-encryption-info": "algo_ecdh",
        "x-replay-info": "replay",
        "x-key-ident": entry.keyIdent,
        "x-request-ts": ts,
        "x-request-once": once,
        "x-signature": signRequest(entry.shareKey, ts, once, encBody),
        // Per-call header overrides (e.g. app-name=eufy_security to request a security-scoped
        // MQTT cert on an existing eufy_mega session — see EufyMega.getUserMqttInfo).
        ...headerOverrides,
      };
      if (authed) Object.assign(headers, this.authTokenHeaders());
      const res = await this.httpPost(`https://${host}${path}`, encBody, headers);
      const env = res.data as ApiEnvelope<unknown>;
      if (res.status === 200 && env?.code === 0) {
        this.contentTypeByHost.set(host, contentType); // remember what worked
        if (typeof env.data === "string" && env.data.length > 0) {
          const pt = decryptBody(env.data, entry.shareKey).toString("utf-8");
          try {
            return JSON.parse(pt) as T;
          } catch {
            return pt as unknown as T;
          }
        }
        return env.data as T;
      }
      // Surface a decrypted error payload when present (e.g. a captcha challenge
      // arrives as an encrypted `data` field alongside a non-zero code).
      let detail = env?.msg ?? JSON.stringify(res.data).slice(0, 200);
      if (typeof env?.data === "string" && env.data.length > 0) {
        try {
          detail = `${detail} | data=${decryptBody(env.data, entry.shareKey).toString("utf-8").slice(0, 300)}`;
        } catch {
          /* not decryptable */
        }
      }
      last = { code: env?.code, msg: detail, status: res.status };
      const retryable = (res.status === 403 && env?.code === 4416) || env?.code === 10000 || res.status === 400;
      // 4416/10000 on the first content-type is expected probing — don't log it as
      // an error; only surface genuinely unexpected envelopes in debug.
      if (env?.code !== 0 && !retryable)
        this.logger.debug("[mega] err envelope:", JSON.stringify(res.data).slice(0, 500));
      if (!retryable) break;
    }
    // "get identity error" (4404, usually HTTP 463): the server no longer knows
    // our x-key-ident — the ECDH session key was rotated/expired server-side
    // (common after a restored session sits idle for days). The token may still
    // be fine, so first re-run the key exchange ONCE and retry; only if that
    // fails too do we treat it as a dead session.
    const identityError = authed && (last?.code === 4404 || /get identity error|identity error/i.test(last?.msg ?? ""));
    if (identityError && !_identityRetried && this.auth_) {
      this.logger.debug("[mega] identity error → re-exchanging session key and retrying");
      if (host.includes(".eufylife.com")) this.sessionKeys.delete(host);
      else this.sessionKey = undefined;
      try {
        await this.ensureSessionKey(host);
      } catch {
        this.clearSession();
        throw new SessionExpiredError(`${path} failed (key re-exchange rejected): ${last?.msg}`);
      }
      this.persist(); // remember the fresh key-ident
      return this.postSigned<T>(host, path, body, authed, true, headerOverrides);
    }
    if (identityError && _identityRetried) {
      // Fresh key-ident still rejected → the token itself is dead; force re-login.
      this.clearSession();
      throw new SessionExpiredError(`${path} failed (${last?.status}/${last?.code}): ${last?.msg}`);
    }
    // Only drop the persisted session on a genuine auth failure (stale/invalid
    // token), NOT on transient 401s (rate-limit / captcha cooldown) — otherwise a
    // temporary hiccup would needlessly wipe a good session and force re-2FA.
    const authFailure =
      authed &&
      last?.status === 401 &&
      (last.code === 26084 || /user_id is empty|invalid.*token|token.*(expired|error)|unauthor/i.test(last?.msg ?? ""));
    if (authFailure) {
      this.clearSession();
      throw new SessionExpiredError(`${path} failed (401): ${last?.msg}`);
    }
    throw new MegaApiError(`${path} failed (${last?.status}/${last?.code}): ${last?.msg}`, last?.code, last?.status);
  }

  /** Authed call to a mega service host: app-{service}-{region}.eufy.com. */
  post<T = unknown>(
    service: string,
    path: string,
    body: unknown = {},
    headerOverrides: Record<string, string> = {},
  ): Promise<T> {
    return this.postSigned<T>(`app-${service}-${this.region}.eufy.com`, path, body, true, false, headerOverrides);
  }

  /**
   * Fetch the per-station DSK key used in the P2P cloud-lookup payload. Mirrors
   * the legacy `get_dsk_keys` body shape on the mega devicerelation service.
   * The P2P *local* lookup path does not need this; only the cloud path does.
   */
  async getDskKeys(
    stationSns: string[],
    priorDsks: Record<string, string> = {},
  ): Promise<Record<string, { dskKey: string; expiration: number }>> {
    // Captured v6 shape (app-devicerelation): the server keys off a `device_dsks`
    // ARRAY — omitting it yields `type mismatch for field "device_dsks"`. Each
    // entry is { invalid_dsk, device_sn, category }; `invalid_dsk` is the prior
    // (now-stale) key being rotated out, empty string on a first fetch. The flat
    // `invalid_dsks` map mirrors the same data. No `transaction` field.
    const invalid: Record<string, string> = {};
    const deviceDsks: Array<{ invalid_dsk: string; device_sn: string; category: string }> = [];
    for (const sn of stationSns) {
      const prev = priorDsks[sn] ?? "";
      invalid[sn] = prev;
      deviceDsks.push({ invalid_dsk: prev, device_sn: sn, category: "eufy_security" });
    }
    // Response echoes a `device_dsks` array keyed by `device_sn` (each entry:
    // { device_sn, dsk_key, expiration, enabled, about_to_be_replaced }).
    const res = await this.post<{
      device_dsks?: Array<{ device_sn: string; dsk_key: string; expiration: number }>;
    }>("devicerelation", "/app/devicerelation/get_dsk_keys", {
      device_dsks: deviceDsks,
      invalid_dsks: invalid,
      station_sns: stationSns,
    });
    const out: Record<string, { dskKey: string; expiration: number }> = {};
    for (const k of res.device_dsks ?? []) out[k.device_sn] = { dskKey: k.dsk_key, expiration: k.expiration };
    return out;
  }

  /**
   * Register an FCM push token with the eufy cloud so it pushes this account's
   * events (motion/doorbell/thumbnail) to us. v6 exposes this on the mega push
   * service; body mirrors the legacy `register_push_token` shape.
   */
  /**
   * Fetch the per-SKU **data-point (param) schema** from the mega `things` service. This is
   * the authoritative source for what each `param_type` means on a given product code — the
   * same call the v6 app uses, so its ids are guaranteed accepted by the mega API (unlike the
   * possibly-stale third-party catalogue). Works for ANY SKU code, not just owned devices.
   *
   * Body shape is `{ code: <SKU> }` (e.g. "T8210", "90C0"). Returns the raw response so callers
   * can adapt to the (not-yet-pinned) field layout.
   */
  getProductDataPoint<T = unknown>(code: string): Promise<T> {
    return this.post<T>("things", "/app/things/get_product_data_point", { code });
  }

  /**
   * Fetch the **live param list** from the mega `devicemanage` service. Body keys off a
   * `device_sns` ARRAY (a bare `device_sn` 400s with "type mismatch"). Each returned entry is
   * `{ param_type, param_value, update_time }` — VALUES ONLY, no name/meaning (the param→meaning
   * mapping is hardcoded in the app, never returned by the API).
   *
   * NOTE: this endpoint is **owner-gated** — a shared/member account gets {@link OWNER_ONLY_CODE}
   * (`"Only the owner can change settings"`), permanently. For those accounts use the `get_devs_list`
   * params instead, which also carry `{param_type, param_value, update_time}` and are not owner-gated.
   */
  getDeviceParamList<T = unknown>(deviceSn: string): Promise<T> {
    return this.post<T>("devicemanage", "/app/devicemanage/get_device_param_list", {
      device_sns: [deviceSn],
    });
  }

  /**
   * Generic authed escape hatch for scripts/experiments: a signed POST to
   * `app-{service}-{region}.eufy.com{path}` with an arbitrary body. Use the typed wrappers
   * above in SDK code; this exists so tooling can probe endpoints / body shapes live.
   */
  request<T = unknown>(service: string, path: string, body: unknown = {}): Promise<T> {
    return this.post<T>(service, path, body);
  }

  /**
   * Fetch the per-user secure-MQTT credentials. Pass `appName` to request a specific capability scope
   * on the current session without re-logging in — security devices (locks/garage) need the
   * `eufy_security` scope, which the default scope can't reach.
   */
  // The credential's publish scope is set by the `app-name` header; `eufy_security` returns a distinct
  // security-scoped credential (verified: distinct from the default `eufy_mega` one, same session).
  getUserMqttInfo(appName?: string): Promise<SecureMqttCredentials> {
    return this.post<SecureMqttCredentials>(
      "devicemanage",
      "/app/devicemanage/get_user_mqtt_info",
      {},
      appName ? { "app-name": appName } : {},
    );
  }

  async registerPushToken(token: string): Promise<void> {
    // Real endpoint (com.eufy.security.push_functional.PushManager) is
    // `register_push_token` — `/app/push/register` 404s. Fields match the
    // app's PushManager: is_notification_enable + token (+ empty voip_token).
    await this.post("push", "/app/push/register_push_token", {
      is_notification_enable: true,
      token,
      voip_token: "",
    });
  }

  /** Download raw bytes from a push-media URL using the active account session. */
  async downloadMedia(url: string): Promise<Buffer> {
    if (!this.auth_) throw new Error("login() first");
    try {
      return await downloadMediaResource(url, {
        "x-auth-token": this.auth_.authToken,
        gtoken: gtoken(this.auth_.userId),
        "app-name": "eufy_mega",
        "model-type": "PHONE",
        "user-agent": "Dalvik/2.1.0 (Linux; U; Android 16; Pixel 6a Build/CP1A.260405.005)",
      });
    } catch (error) {
      if (error instanceof MediaDownloadAuthenticationError) {
        throw new SessionExpiredError("media download rejected the active session");
      }
      throw error;
    }
  }

  /** Download push image bytes and decrypt a recognized v1 wrapper when its device key input is available. */
  async downloadImage(url: string, p2pDid?: string): Promise<Buffer> {
    return normalizePushImage(await this.downloadMedia(url), p2pDid);
  }

  /** The security-app data host for this region (face recognition, media, etc.). */
  private securityAppHost(): string {
    const shard = this.region.split("-")[0]; // "eu-pr" → "eu", "us-pr" → "us"
    // US is the DEFAULT host with NO region suffix; `security-app-us.eufylife.com` does not exist
    // (ENOTFOUND). Other regions get a suffix (eu → security-app-eu). Verified via DNS.
    return shard === "us" ? "security-app.eufylife.com" : `security-app-${shard}.eufylife.com`;
  }

  /**
   * Signed+encrypted POST to the security-app data host (face recognition, etc.).
   * Despite the different host, these endpoints use the SAME algo_ecdh pipeline as
   * the mega hosts (captured header set: `x-encryption-info: algo_ecdh` +
   * x-request-ts/once + ecdh-encrypted body) — NOT a plain JSON POST (that 403s).
   * So we reuse {@link postSigned}, which handles the key exchange, body encryption,
   * signature and response decryption.
   *
   * The `*.eufylife.com` gateway uses a SEPARATE ecdh key from the mega `*.eufy.com` gateway
   * (own bootstrap localKey `118c12c8…`, own `/v3/openapi/oauth/key/exchange` path, and data
   * calls want `Content-Type: text/plain`). {@link ensureSessionKey} now keeps a PER-HOST key
   * for eufylife hosts and exchanges against the eufylife host, so `getFaces()`/`getCiphers()`
   * work (the old HTTP 463 is fixed). Note `getFaces` returns an empty roster for accounts whose
   * faces live on the HomeBase — use the P2P path for the real roster.
   */
  async securityAppPost<T = any>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    return this.postSigned<T>(this.securityAppHost(), path, body, true);
  }

  /**
   * List the account's enrolled AI faces (the recognition roster). Each entry is
   * keyed by `ai_user_id` — the id that shows up as `person_id` on an
   * `IDENTITY_PERSON_DETECTION` push, so this is the lookup table for naming a
   * recognised person. Endpoint: `/v3/aiassis/get_faces` on the security-app host.
   */
  async getFaces(opts: { aiGroupId?: number; num?: number; page?: number } = {}): Promise<any> {
    return this.securityAppPost("/v3/aiassis/get_faces", {
      ai_group_id: opts.aiGroupId ?? 0,
      num: opts.num ?? 2000,
      page: opts.page ?? 0,
      orderby: "-ai_user_id",
    });
  }

  /** Resolve specific AI face ids (e.g. a push `person_id`) → face records. */
  async getFacesByIds(aiUserIds: number[]): Promise<any> {
    return this.securityAppPost("/v3/aiassis/get_faces_by_ids", { ai_user_ids: aiUserIds });
  }

  /**
   * Fetch E2E cipher material for a station's `cipher_id`(s). Returns
   * `[{ cipher_id, ecc_private_key, private_key }]` in cleartext (the algo_ecdh transport
   * is the only wrapping). The `ecc_private_key` is the root of trust for the P2P **level-2**
   * session key: `CMD_GATEWAYINFO(1100)` ships an ECIES envelope decrypted with it
   * (see `deriveLevel2KeyFromGatewayInfo` in `p2p/codec`). `userId` must be the station
   * `member.admin_user_id`. Endpoint: `/v3/app/cipher/get_ciphers` on the eufylife host.
   */
  async getCiphers(
    cipherIds: number[],
    userId: string,
    stationSn: string,
  ): Promise<Array<{ cipher_id: number; ecc_private_key?: string; private_key?: string }>> {
    const out = await this.securityAppPost<any>("/v3/app/cipher/get_ciphers", {
      cipher_ids: cipherIds,
      user_id: userId,
      station_sn: stationSn,
    });
    // server may return the array directly or under {ciphers|data}
    return (Array.isArray(out) ? out : (out?.ciphers ?? out?.data ?? [])) as Array<{
      cipher_id: number;
      ecc_private_key?: string;
      private_key?: string;
    }>;
  }

  /** Build the /passport/login body (verify_code empty unless 2FA). */
  private loginBody(opts: { verifyCode?: string; captchaId?: string; answer?: string }): Record<string, unknown> {
    const { clientPublicKeyHex, encryptedPassword } = encryptLoginPassword(this.cfg.password);
    const base = {
      email: this.cfg.email,
      password: encryptedPassword,
      ab: this.cfg.countryCode,
      client_secret_info: { public_key: clientPublicKeyHex },
    };
    // Captured shapes: 2FA verify-login is minimal (verify_code + login_id);
    // captcha-solve carries answer + captcha_id; the initial login has empties.
    if (opts.verifyCode) return { ...base, verify_code: opts.verifyCode, login_id: "" };
    if (opts.captchaId)
      return { ...base, answer: opts.answer ?? "", captcha_id: opts.captchaId, verify_code: "", login_id: "" };
    return { ...base, answer: "", captcha_id: "", verify_code: "", login_id: "" };
  }

  /** Fetch a fresh captcha challenge: { captchaId, image (data:image/png;base64) }. */
  async generateCaptcha(): Promise<{ captchaId: string; image: string }> {
    const r = await this.postSigned<{ captcha_id: string; item: string }>(
      `app-passport-${this.region}.eufy.com`,
      "/passport/generate/captcha",
      {},
      false,
    );
    return { captchaId: r.captcha_id, image: r.item };
  }

  /**
   * Trigger the 2FA verify code. POST app-push-{region}/app/sendmsg/verify_code
   * with biz_type 1004 (login 2FA). message_type 2 = email, 1 = SMS.
   * Requires the (limited) token from the first login attempt.
   */
  async sendVerifyCode(messageType = 2): Promise<void> {
    await this.postSigned(
      `app-push-${this.region}.eufy.com`,
      "/app/sendmsg/verify_code",
      { biz_type: 1004, message_type: messageType, transaction: Date.now().toString() },
      true,
    );
  }

  /**
   * Begin (or resume) login. Returns a {@link LoginResult} discriminated union rather than throwing
   * for the expected captcha/2FA flow — the caller switches on `status`:
   *  - `ok` → authenticated.
   *  - `captcha` → show `image`, then {@link solveCaptcha}(answer).
   *  - `2fa` → a code was sent; {@link submitVerifyCode}(code).
   *
   * A restored session short-circuits to `ok` with no network. `messageType` picks the 2FA channel
   * (2 = email, 1 = SMS) for the code that gets sent when 2FA is required.
   */
  async login(opts: { messageType?: number } = {}): Promise<LoginResult> {
    // Reuse a restored session — no network, no 2FA — until it expires. NOT while a 2FA code is
    // outstanding: `auth_` then holds only the limited pre-verify token, which would 401 on real
    // calls — the caller must continue via submitVerifyCode(), not re-enter login().
    if (this.auth_ && this.sessionKey && !this.pending2fa) {
      return {
        status: LoginStatus.Ok,
        session: {
          userId: this.auth_.userId,
          authToken: this.auth_.authToken,
          geoKey: this.auth_.geoKey,
          raw: { restored: true },
        },
      };
    }
    return this.attemptLogin(this.loginBody({}), opts.messageType ?? 2);
  }

  /**
   * Continue a login that returned `{status:"captcha"}` — submit the human's answer to the pending
   * challenge. Returns the next {@link LoginResult} (`ok`, another `captcha` if wrong, or `2fa`).
   */
  async solveCaptcha(answer: string, opts: { messageType?: number } = {}): Promise<LoginResult> {
    if (!this.pendingCaptchaId) throw new Error("no pending captcha — call login() first");
    return this.attemptLogin(this.loginBody({ captchaId: this.pendingCaptchaId, answer }), opts.messageType ?? 2);
  }

  /**
   * Continue a login that returned `{status:"2fa"}` — submit the verify code that was sent. Returns
   * the next {@link LoginResult} (normally `ok`).
   */
  async submitVerifyCode(code: string): Promise<LoginResult> {
    return this.attemptLogin(this.loginBody({ verifyCode: code }), 2);
  }

  /**
   * One `/passport/login` round-trip + outcome classification. Shared by {@link login} /
   * {@link solveCaptcha} / {@link submitVerifyCode}; the caller-facing methods only build the body.
   */
  private async attemptLogin(body: Record<string, unknown>, messageType: number): Promise<LoginResult> {
    if (!this.cfg.region) await this.estimateDomain();
    await this.ensureSessionKey();
    const passportHost = `app-passport-${this.region}.eufy.com`;
    const isVerify = "verify_code" in body && !!body.verify_code;

    let res: Record<string, unknown>;
    try {
      res = await this.postSigned<Record<string, unknown>>(passportHost, "/passport/login", body, !!this.auth_);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // 100032 = captcha required; 100033 = captcha answer wrong. Fetch a fresh challenge and hand
      // it back for (re)solving — hold the id for solveCaptcha().
      if (/\b100032\b|\b100033\b/.test(msg)) {
        const cap = await this.generateCaptcha();
        this.pendingCaptchaId = cap.captchaId;
        return { status: LoginStatus.Captcha, image: cap.image, retry: /\b100033\b/.test(msg) };
      }
      throw e;
    }
    {
      const cap = Object.keys(res).filter((k) => /captcha|answer|picture|image|fa_/i.test(k));
      this.logger.debug("[mega] login resp keys:", Object.keys(res).join(","));
      if (cap.length)
        this.logger.debug("[mega] captcha/fa:", JSON.stringify(Object.fromEntries(cap.map((k) => [k, res[k]]))));
    }
    const userId = (res.ap_cloud_user_id ?? res.user_id ?? res.userId) as string | undefined;
    const authToken = (res.auth_token ?? res.token) as string | undefined;
    if (!userId || !authToken) throw new Error(`login returned no session: ${JSON.stringify(res).slice(0, 200)}`);

    // fa_info.info is non-empty while 2FA is pending; empty once satisfied.
    const faInfo = (res.fa_info ?? {}) as { info?: string };
    const needs2fa = !isVerify && !!faInfo.info;
    if (needs2fa) {
      // Keep the limited token: sendVerifyCode() AND the follow-up verify-login must both be authed
      // with it (captured: attempts 4 & 5 carry this token), so the gateway links the code to this
      // pending 2FA session.
      this.auth_ = { userId, authToken, geoKey: res.geo_key as string | undefined };
      // Captcha (if any) is satisfied once we reach the 2FA step — drop its id so a later retry
      // doesn't resubmit an already-consumed challenge. Mark 2FA outstanding (see login()).
      this.pendingCaptchaId = undefined;
      this.pending2fa = true;
      await this.sendVerifyCode(messageType);
      return { status: LoginStatus.TwoFactor, method: "code sent via app-push/sendmsg/verify_code" };
    }

    this.pendingCaptchaId = undefined;
    this.pending2fa = false;
    this.auth_ = { userId, authToken, geoKey: res.geo_key as string | undefined };
    this.tokenExpiresAt = Number(res.token_expires_at ?? 0) || 0;
    // Re-exchange WITH the auth token so the gateway binds the key-ident to the user.
    this.sessionKey = undefined;
    await this.ensureSessionKey();
    this.persist();
    return { status: LoginStatus.Ok, session: { userId, authToken, geoKey: this.auth_.geoKey, raw: res } };
  }

  /** Save the current token + session key for reuse across runs. */
  private persist(): void {
    if (!this.auth_ || !this.sessionKey) return;
    this.store.save({
      userId: this.auth_.userId,
      authToken: this.auth_.authToken,
      geoKey: this.auth_.geoKey,
      region: this.region,
      openudid: this.openudid,
      shareKey: this.sessionKey.shareKey,
      keyIdent: this.sessionKey.keyIdent,
      tokenExpiresAt: this.tokenExpiresAt,
      savedAt: Date.now(),
    });
  }

  /** Forget the persisted session (e.g. after the token is rejected). */
  clearSession(): void {
    this.auth_ = undefined;
    this.sessionKey = undefined;
    this.pendingCaptchaId = undefined;
    this.pending2fa = false;
    this.store.clear();
  }

  /** True if a usable (restored or fresh) session is held. */
  get loggedIn(): boolean {
    return !!this.auth_ && !!this.sessionKey;
  }
}
