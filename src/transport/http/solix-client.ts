/**
 * A minimal client for the Anker Solix power-station cloud, driven by the SAME account login the
 * eufy client uses.
 *
 * Why this is separate from the eufy device client: Solix shares Anker's `algo_ecdh` passport (so
 * {@link prepareKeyExchange} / {@link encryptLoginPassword} / {@link signRequest} are reused verbatim
 * for the login handshake) but exposes a different device backend — its own `app-name`, host, and
 * bootstrap key (`SOLIX_APP_NAME`, `SOLIX_DEFAULT_API_HOST`, {@link SOLIX_LOCAL_KEY_HEX}) —
 * and its authenticated resource reads are PLAIN JSON, carrying only the auth token and a
 * `gtoken = md5(user_id)`, with no per-request encryption or signature. This client therefore does
 * the encrypted passport handshake to obtain a token, then makes plain authenticated reads.
 *
 * This is the wire client (transport layer): it returns the vendor's typed JSON as received. Building
 * those records into capability-driven `SolixDevice` models is the model layer's job — see
 * `discoverSolixDevices()` — so the two stay decorrelated (transport never imports model).
 */
import {
  decryptBody,
  encryptBody,
  encryptLoginPassword,
  finishKeyExchange,
  genId,
  gtoken,
  md5Hex,
  nowSec,
  prepareKeyExchange,
  signRequest,
  SOLIX_LOCAL_KEY_HEX,
  tokenNotExpired,
  type SessionEntry,
  type SessionStore,
  type SolixDeviceRecord,
  type SolixPowerCutoffOption,
  type SolixProductCategory,
  type SolixSiteRecord,
  type SolixSiteScene,
  type SolixSocParams,
} from "../../core/index.js";
import type { SecureMqttCredentials } from "../mqtt/secure-mqtt.js";

import { SOLIX_APP_NAME, SOLIX_DEFAULT_API_HOST, SOLIX_ENDPOINTS, SOLIX_ESTIMATE_HOST } from "./solix-constants.js";

/** The vendor envelope every Solix endpoint answers with (`data` shape varies per endpoint). */
interface SolixEnvelope<T = unknown> {
  code: number;
  msg: string;
  data?: T;
}

/** An authenticated Solix session — the token + the derived `gtoken` + the resolved API host. */
export interface SolixSession {
  authToken: string;
  userId: string;
  /** `md5(user_id)` — sent as the `gtoken` header on every authenticated read. */
  gtoken: string;
  /** The regional API host the account resolved to (e.g. the EU shard). */
  apiHost: string;
  /** Unix seconds; 0 when the server did not supply one. */
  tokenExpiresAt: number;
}

/**
 * Outcome of {@link SolixClient.login}. `2fa` mirrors the eufy passport: the server sent a code and
 * the client holds a limited token — call {@link SolixClient.submitVerifyCode} to finish.
 */
export type SolixLoginResult = { status: "ok"; session: SolixSession } | { status: "2fa"; method: string };

/** Options for {@link SolixClient}. */
export interface SolixClientOptions {
  email: string;
  password: string;
  /** ISO-3166 alpha-2; defaults to "US". Sent as `country` and `ab`. */
  countryCode?: string;
  /** Override the API host (skips domain-estimate). Defaults to estimate → `SOLIX_DEFAULT_API_HOST`. */
  apiHost?: string;
  /** App version reported to the cloud. */
  appVersion?: string;
  /**
   * Stable per-install device id (UUID). The auth token is bound to it, and a shifting id looks like
   * a new device each run and re-triggers 2FA. Defaults to a deterministic id derived from the email
   * (stable across runs); a store's saved id wins over this.
   */
  openudid?: string;
  /** Persist the token + device id so a dedicated account logs in once and reuses it until expiry. */
  store?: SolixSessionStore;
  /** Injected fetch (for tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** What {@link SolixSessionStore} holds: the stable device id and (once logged in) the session. */
export interface SolixPersisted {
  openudid: string;
  session?: SolixSession;
}

/**
 * A place to persist a Solix session across process runs — the core {@link SessionStore} parameterised on
 * the Solix record shape, so `FileSessionStore` serves it as-is. The device id survives token expiry (so
 * the account keeps seeing the same device and does not re-prompt 2FA), and a live session is reused
 * until it expires.
 */
export type SolixSessionStore = SessionStore<SolixPersisted>;

/** A Solix session is usable if it has a token that isn't (near-)expired (core's 300s skew rule). */
function solixSessionFresh(s: SolixSession | undefined): s is SolixSession {
  return !!s?.authToken && tokenNotExpired(s.tokenExpiresAt);
}

/**
 * Vendor code for a token displaced by another login on the account ("token does not exist because it
 * was kicked out"). Anker runs ~one session per account, so the app or a second client re-logging in
 * invalidates a running client's token; {@link SolixClient.authed} treats this code as recoverable and
 * re-logs in once. Distinct from expiry — a kicked token still has a future `tokenExpiresAt`.
 */
const SOLIX_TOKEN_KICKED_CODE = 26084;

/** Format 32 hex chars as a UUID (8-4-4-4-12) — used to derive a stable openudid from the email. */
const uuidFromHex = (hex: string): string =>
  `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;

/**
 * Login + read client for one Anker account's Solix devices. Construct with the account
 * credentials, `await login()`, then read {@link getDevices} / {@link getSites} / {@link
 * getUserMqttInfo}. Not tied to any host runtime.
 */
export class SolixClient {
  private readonly email: string;
  private readonly password: string;
  private readonly country: string;
  private readonly appVersion: string;
  private readonly doFetch: typeof fetch;
  private readonly store?: SolixSessionStore;
  private readonly openudid: string;
  private apiHost: string;
  private session_?: SolixSession;
  /** Carried between {@link login} and {@link submitVerifyCode} while a 2FA code is outstanding. */
  private pending2fa?: { limitedToken: string; userId: string; geoKey?: string };

  /**
   * Resolve the device id (explicit → stored → deterministic from the email, so it is stable and does
   * not re-trigger 2FA) and adopt a stored session that has not expired, so a warm start skips the
   * handshake. An explicit `opts.apiHost` outranks a stored session's host in both cases: it is an
   * override that also skips domain-estimate, and every read goes through `this.apiHost`.
   */
  constructor(opts: SolixClientOptions) {
    this.email = opts.email;
    this.password = opts.password;
    this.country = (opts.countryCode ?? "US").toUpperCase();
    this.appVersion = opts.appVersion ?? "3.23.0";
    this.doFetch = opts.fetchImpl ?? fetch;
    this.apiHost = opts.apiHost ?? SOLIX_DEFAULT_API_HOST;
    this.store = opts.store;
    const saved = this.store?.load();
    this.openudid = opts.openudid ?? saved?.openudid ?? uuidFromHex(md5Hex(`anker-solix:${opts.email}`));
    if (saved?.session && solixSessionFresh(saved.session)) {
      this.session_ = saved.session;
      this.apiHost = opts.apiHost ?? saved.session.apiHost;
    }
  }

  /** Persist the current device id (+ session, if any) when a store is configured. */
  private persist(): void {
    this.store?.save({ openudid: this.openudid, session: this.session_ });
  }

  /** The authenticated session, once {@link login} has resolved to `ok`. */
  get session(): SolixSession | undefined {
    return this.session_;
  }

  /**
   * Headers for the login/key-exchange path, which carry the device id. Authenticated resource reads
   * must NOT send `openudid` — the gateway rejects a token-bearing read that also carries a device id
   * (`401 token error`) — so those use {@link baseHeaders} directly.
   */
  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return this.baseHeaders({ openudid: this.openudid, "x-terminal-id": this.openudid, ...extra });
  }

  /** Base headers common to every Solix request. */
  private baseHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
      "content-type": "application/json",
      "app-name": SOLIX_APP_NAME,
      "model-type": "PHONE",
      "os-type": "android",
      "os-version": "36",
      "app-version": this.appVersion,
      country: this.country,
      timezone: "GMT+00:00",
      language: "en",
      "user-agent": "ktor-client",
      accept: "application/json",
      ...extra,
    };
  }

  /** One request path for every Solix call (GET or POST) — always parses through the non-JSON guard. */
  private async send(
    method: "GET" | "POST",
    host: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<SolixEnvelope> {
    const res = await this.doFetch(`https://${host}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    try {
      return JSON.parse(text) as SolixEnvelope;
    } catch {
      throw new Error(`Solix ${path} → HTTP ${res.status}, non-JSON: ${text.slice(0, 120)}`);
    }
  }

  /** POST helper for the login/key-exchange path (which builds its own bespoke headers per request). */
  private post(host: string, path: string, body: string, headers: Record<string, string>): Promise<SolixEnvelope> {
    return this.send("POST", host, path, headers, body);
  }

  /** Resolve the regional API host via domain-estimate (best-effort; keeps the default on failure). */
  private async estimateHost(): Promise<void> {
    try {
      const env = await this.post(
        SOLIX_ESTIMATE_HOST,
        SOLIX_ENDPOINTS.estimateDomain,
        JSON.stringify({ ab: this.country, mode: 1 }),
        this.baseHeaders(),
      );
      const domain = (env.data as { domain?: string } | undefined)?.domain;
      if (domain) this.apiHost = domain;
    } catch {
      /* keep the default host */
    }
  }

  /** Do the localKey-bootstrapped ECDH key exchange and return the negotiated session key. */
  private async keyExchange(): Promise<SessionEntry> {
    const prep = prepareKeyExchange(SOLIX_LOCAL_KEY_HEX);
    const env = await this.post(
      this.apiHost,
      SOLIX_ENDPOINTS.keyExchange,
      JSON.stringify({ client_public_key: prep.encryptedClientPublicKey }),
      this.authHeaders(prep.headers),
    );
    const spk = (env.data as { server_public_key?: string } | undefined)?.server_public_key;
    if (env.code !== 0 || !spk) throw new Error(`Solix key/exchange failed (${env.code}): ${env.msg}`);
    return finishKeyExchange(prep, spk);
  }

  /** Build the encrypted, signed `/passport/login` request body + headers for the negotiated key. */
  private async postLogin(kx: SessionEntry, verifyCode?: string, limitedToken?: string): Promise<SolixEnvelope> {
    const { clientPublicKeyHex, encryptedPassword } = encryptLoginPassword(this.password);
    const bodyObj: Record<string, unknown> = {
      email: this.email,
      password: encryptedPassword,
      ab: this.country,
      client_secret_info: { public_key: clientPublicKeyHex },
      answer: "",
      captcha_id: "",
      verify_code: verifyCode ?? "",
      login_id: "",
    };
    const encBody = encryptBody(JSON.stringify(bodyObj), kx.shareKey);
    const ts = nowSec();
    const once = genId();
    return this.post(
      this.apiHost,
      SOLIX_ENDPOINTS.login,
      encBody,
      this.authHeaders({
        "x-encryption-info": "algo_ecdh",
        "x-key-ident": kx.keyIdent,
        "x-request-ts": ts,
        "x-request-once": once,
        "x-signature": signRequest(kx.shareKey, ts, once, encBody),
        ...(limitedToken ? { "x-auth-token": limitedToken } : {}),
      }),
    );
  }

  /**
   * Turn a decrypted `/passport/login` payload into an `ok`/`2fa` result, establishing the session on
   * `ok`. The passport marks a pending 2FA with a non-empty `fa_info.info`, and empties it once the code
   * has been satisfied.
   *
   * `gtoken` is hashed from `ap_cloud_user_id` where the reply carries one, `user_id` otherwise. Whether
   * this gateway recomputes the header from `user_id` specifically — as the mega gateway does, rejecting a
   * disagreement with `"gtoken not equal userid error"` — is unverified here: no Solix response has been
   * observed refusing the header, which is consistent with the two ids agreeing on the accounts seen.
   */
  private classifyLogin(data: Record<string, unknown>, isVerify: boolean): SolixLoginResult {
    const userId = (data.ap_cloud_user_id ?? data.user_id) as string | undefined;
    const authToken = data.auth_token as string | undefined;
    if (!userId || !authToken)
      throw new Error(`Solix login returned no session: ${JSON.stringify(data).slice(0, 160)}`);
    const faInfo = (data.fa_info ?? {}) as { info?: string };
    if (!isVerify && faInfo.info) {
      this.pending2fa = { limitedToken: authToken, userId, geoKey: data.geo_key as string | undefined };
      return { status: "2fa", method: "code sent by the passport" };
    }
    this.pending2fa = undefined;
    this.session_ = {
      authToken,
      userId,
      gtoken: gtoken(userId),
      apiHost: this.apiHost,
      tokenExpiresAt: Number(data.token_expires_at ?? 0) || 0,
    };
    this.persist();
    return { status: "ok", session: this.session_ };
  }

  /** Decrypt a login envelope's `data` (base64 `IV(16)||AES-128-CBC`, keyed by the share key). */
  private decryptLogin(env: SolixEnvelope, kx: SessionEntry): Record<string, unknown> {
    if (typeof env.data !== "string") throw new Error(`Solix login (${env.code}): ${env.msg}`);
    return JSON.parse(decryptBody(env.data, kx.shareKey).toString("utf-8")) as Record<string, unknown>;
  }

  /**
   * Authenticate with the account credentials. Resolves to `ok` with a {@link SolixSession}, or `2fa`
   * when the passport sent a code — then call {@link submitVerifyCode}. A session that is already fresh
   * (adopted from a store) is answered without a handshake.
   */
  async login(): Promise<SolixLoginResult> {
    if (solixSessionFresh(this.session_)) {
      return { status: "ok", session: this.session_ };
    }
    await this.estimateHost();
    const kx = await this.keyExchange();
    const env = await this.postLogin(kx);
    this.assertLoginAccepted(env);
    return this.classifyLogin(this.decryptLogin(env, kx), false);
  }

  /**
   * On a rejected `/passport/login` (non-zero code, so `data` is an error envelope not the encrypted
   * payload), throw a diagnostic that names WHY the passport refused — the throttle (`26161`, "too
   * frequent") vs a challenge it wants the client to satisfy. The passport marks a required captcha with
   * a `captcha_id`/`item`; our headless client cannot answer one, so surfacing it distinguishes "wait
   * out the rate-limit" from "a captcha is required — clear it in the app". No secrets are logged, only
   * the code, message, and which challenge fields are present.
   */
  private assertLoginAccepted(env: SolixEnvelope): void {
    if (env.code === 0) return;
    const d = (env.data ?? {}) as Record<string, unknown>;
    const hints: string[] = [];
    if (typeof d === "object" && d) {
      if ("captcha_id" in d && d.captcha_id) hints.push("captcha_id present (captcha required)");
      if ("item" in d && d.item) hints.push(`item=${String(d.item).slice(0, 40)}`);
      const keys = Object.keys(d);
      if (keys.length && hints.length === 0) hints.push(`data keys: ${keys.join(",")}`);
    }
    const detail = hints.length ? ` [${hints.join("; ")}]` : "";
    throw new Error(`Solix login (${env.code}): ${env.msg}${detail}`);
  }

  /** Complete a `2fa` login with the code the passport sent. */
  async submitVerifyCode(code: string): Promise<SolixLoginResult> {
    if (!this.pending2fa) throw new Error("no 2FA login is pending");
    const kx = await this.keyExchange();
    const env = await this.postLogin(kx, code, this.pending2fa.limitedToken);
    return this.classifyLogin(this.decryptLogin(env, kx), true);
  }

  /**
   * One authenticated PLAIN read for both GET and POST endpoints (no per-request encryption; carries
   * the auth token + `gtoken` only). Routes through {@link send} so every read keeps the non-JSON guard.
   *
   * Self-heals a **displaced session**: Anker allows ~one session per account, so another login (the app,
   * or a second client) invalidates this token and reads then fail with {@link SOLIX_TOKEN_KICKED_CODE}
   * ("token does not exist because it was kicked out"). On that code this re-logs in once and retries, so
   * a running client recovers on its own instead of failing every read until its session store is cleared.
   */
  private async authed<T = unknown>(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, unknown>,
    reauthed = false,
  ): Promise<T> {
    if (!this.session_) throw new Error("not authenticated — call login() first");
    const env = await this.send(
      method,
      this.apiHost,
      path,
      this.baseHeaders({ gtoken: this.session_.gtoken, "x-auth-token": this.session_.authToken }),
      body ? JSON.stringify(body) : undefined,
    );
    if (env.code === 0) return (env.data ?? null) as T;
    // A kicked token is not "expired", so login() would otherwise reuse it — clear it first to force a
    // full handshake. One retry only (the `reauthed` guard), so a persistently-contested session (e.g. the
    // app held open on the account) fails cleanly rather than looping.
    if (env.code === SOLIX_TOKEN_KICKED_CODE && !reauthed) {
      this.session_ = undefined;
      const r = await this.login();
      if (r.status !== "ok")
        throw new Error(`Solix ${path}: session was kicked and re-login did not complete (${r.status})`);
      return this.authed<T>(method, path, body, true);
    }
    throw new Error(`Solix ${path} failed (${env.code}): ${env.msg}`);
  }

  /**
   * The account's bound Solix devices (flat list; may be empty when devices live under sites). The
   * gateway's JSON is asserted to {@link SolixDeviceRecord} here, at the one trust boundary — every field
   * beyond `device_sn`/`product_code` is optional on the record, so a caller reads them defensively.
   */
  async getDevices(): Promise<SolixDeviceRecord[]> {
    const data = await this.authed<{ data?: unknown[] } | unknown[]>(
      "POST",
      SOLIX_ENDPOINTS.getRelateAndBindDevices,
      {},
    );
    return (Array.isArray(data) ? data : (data?.data ?? [])) as SolixDeviceRecord[];
  }

  /**
   * The account's sites (systems); devices are grouped under a site. Each record carries its
   * `site_device_list` (the member devices), which {@link discoverSolixSites} resolves into a
   * capability-driven `SolixSite`. Asserted to {@link SolixSiteRecord} at this trust boundary — and
   * `site_id` (the one field the model layer keys a `SolixSite` on) is validated here, so a record the
   * cloud returns without a usable id is dropped rather than surfacing a `SolixSite` with `id ===
   * undefined`; every other field is optional and read defensively.
   */
  async getSites(): Promise<SolixSiteRecord[]> {
    const data = await this.authed<{ site_list?: unknown[] }>("POST", SOLIX_ENDPOINTS.getSiteList, {});
    const list = (data?.site_list ?? []) as SolixSiteRecord[];
    return list.filter((s) => typeof s?.site_id === "string" && s.site_id.length > 0);
  }

  /** Per-user AWS-IoT MQTT credentials (cert/key/endpoint/thing) for the real-time device plane. */
  async getUserMqttInfo(): Promise<SecureMqttCredentials> {
    return this.authed<SecureMqttCredentials>("POST", SOLIX_ENDPOINTS.getUserMqttInfo, {});
  }

  /**
   * Read a site's "scene" snapshot — the app's dashboard read for a system, a plain authed read. Its
   * battery detail (`solarbank_info.solarbank_list[]`) carries clean, correctly-named fields including
   * `bat_temperature`, which the realtime `ff09` MQTT push does NOT reliably carry (the fast frame's BMS
   * blob is empty, so the decoder withholds temperature). This is therefore a low-rate BACKSTOP for those
   * gap fields — NOT the realtime source: live power/SOC still come from the MQTT push (which is what the
   * app itself refreshes from every ~5 s; there is no clean-JSON scene PUSH). Verified live against the
   * `ff09` floats — the two agree to the watt at the same instant.
   */
  async getSiteScene(siteId: string): Promise<SolixSiteScene> {
    return this.authed<SolixSiteScene>("POST", SOLIX_ENDPOINTS.getSiteScene, { site_id: siteId });
  }

  /**
   * The pairable-product catalog (categories → products). This is Anker's product registry, not the
   * account's devices — fetch it to label a discovered device's model code with a marketing name and
   * category. Pair with {@link buildModelIndex}. It is a live endpoint, so it stays current without a
   * baked-in table.
   */
  async getProductCatalog(): Promise<SolixProductCategory[]> {
    return (await this.authed<SolixProductCategory[]>("GET", SOLIX_ENDPOINTS.productCategories)) ?? [];
  }

  /**
   * Write device attributes — a CONTROL write, e.g. the Solarbank ambient light
   * `{ ambient_light_switch: 0 | 1 }` (0 = on, 1 = off). Unlike the plain authenticated reads, a write
   * must be **encrypted + signed** with a freshly negotiated `algo_ecdh` key: the gateway accepts an
   * unsigned write with `code 0` but the device never applies it. The token-bearing request also must
   * NOT carry the device id (`openudid`), or the gateway answers `401 token error`. Both verified live
   * on an AE103 (the LED-enable bit in the `ba` telemetry flips exactly as commanded).
   */
  async setDeviceAttrs(deviceSn: string, attributes: Record<string, unknown>): Promise<void> {
    await this.encryptedWrite(SOLIX_ENDPOINTS.setDeviceAttrs, "set_device_attrs", {
      device_sn: deviceSn,
      attributes,
    });
  }

  /**
   * A CONTROL write: `algo_ecdh`-encrypted + signed, token-bearing but WITHOUT `openudid`. Every device
   * control the account performs (set_device_attrs, set_power_cutoff, …) goes through this — the gateway
   * accepts an unsigned/plain write with `code 0` but the device never applies it, and adding `openudid`
   * to the token-bearing request returns `401 token error`. Both verified live on an AE103.
   */
  private async encryptedWrite(path: string, label: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.session_) throw new Error("not authenticated — call login() first");
    const kx = await this.keyExchange();
    const encBody = encryptBody(JSON.stringify(payload), kx.shareKey);
    const ts = nowSec();
    const once = genId();
    const env = await this.post(
      this.apiHost,
      path,
      encBody,
      this.baseHeaders({
        "x-encryption-info": "algo_ecdh",
        "x-key-ident": kx.keyIdent,
        "x-request-ts": ts,
        "x-request-once": once,
        "x-signature": signRequest(kx.shareKey, ts, once, encBody),
        "x-auth-token": this.session_.authToken,
        gtoken: this.session_.gtoken,
      }),
    );
    if (env.code !== 0) throw new Error(`Solix ${label} failed (${env.code}): ${env.msg}`);
  }

  /** Turn the Solarbank's ambient LED on/off — a confirmed `set_device_attrs` write. */
  async setAmbientLight(deviceSn: string, on: boolean): Promise<void> {
    await this.setDeviceAttrs(deviceSn, { ambient_light_switch: on ? 0 : 1 });
  }

  /**
   * Read device attributes — a plain authenticated read (unlike the encrypted write). `attributes`
   * names the keys to fetch (e.g. `["screen_off_time"]`); an empty list asks for the device's default
   * set. Returns the gateway's attribute map as-is (values are device-typed — numbers, strings). Used
   * to reflect a control's live state, e.g. the display/light off-timeout.
   */
  async getDeviceAttrs(deviceSn: string, attributes: string[] = []): Promise<Record<string, unknown>> {
    const data = await this.authed<{ attributes?: Record<string, unknown> } | Record<string, unknown>>(
      "POST",
      SOLIX_ENDPOINTS.getDeviceAttrs,
      { device_sn: deviceSn, attributes },
    );
    // The gateway may wrap the map under `attributes` or return it flat — normalise to the flat map.
    if (data && typeof data === "object" && "attributes" in data && data.attributes) {
      return data.attributes as Record<string, unknown>;
    }
    return (data ?? {}) as Record<string, unknown>;
  }

  /**
   * Set the Solarbank display's screen-off timeout, in SECONDS (`screen_off_time`). The app's picker
   * offers 10/20/30 s and 1/5/30 min; the LCD backlight — and with it the ambient LED that the screen
   * gates — turns off after this idle period. This is the raw-seconds write; the caller maps its own UI
   * options to seconds. The "Never" (always-on) sentinel is device-defined and NOT assumed here — pass
   * the exact integer read back from {@link getDeviceAttrs} while the device is in that mode.
   */
  async setScreenOffTime(deviceSn: string, seconds: number): Promise<void> {
    await this.setDeviceAttrs(deviceSn, { screen_off_time: seconds });
  }

  /**
   * Read the Solarbank's battery discharge-cutoff (minimum-SOC) options — a plain authed read.
   * The gateway returns a preset list (`power_cutoff_data`): each entry is a selectable minimum
   * state-of-charge `output_cutoff_data` (percent) with its `id` and `is_selected` flag. The caller
   * presents these options and writes the chosen `id` back via {@link setPowerCutoff} — the values and
   * ids come from the device, never assumed. `siteId` is optional (the device knows its own cutoff).
   */
  async getPowerCutoff(deviceSn: string, siteId = ""): Promise<SolixPowerCutoffOption[]> {
    const data = await this.authed<{ power_cutoff_data?: SolixPowerCutoffOption[] }>(
      "POST",
      SOLIX_ENDPOINTS.getPowerCutoff,
      { site_id: siteId, device_sn: deviceSn },
    );
    return data?.power_cutoff_data ?? [];
  }

  /**
   * Select the Solarbank's battery discharge-cutoff (minimum SOC) by option id — a control write.
   * `cutoffDataId` MUST be an `id` returned by {@link getPowerCutoff} for this device (the preset the
   * user picked), never a raw percentage; the gateway maps the id to its cutoff percent.
   */
  async setPowerCutoff(deviceSn: string, cutoffDataId: number): Promise<void> {
    await this.encryptedWrite(SOLIX_ENDPOINTS.setPowerCutoff, "set_power_cutoff", {
      device_sn: deviceSn,
      cutoff_data_id: cutoffDataId,
    });
  }

  /** The `param_type` under which the Solarbank's SOC-limit block lives (verified live on an AE103). */
  private static readonly SOC_PARAM_TYPE = "27";
  /** `cmd` value that scopes the `site/*_site_device_param` family (from the app's request builder). */
  private static readonly SITE_DEVICE_PARAM_CMD = 246;

  /**
   * Read one of a site's "device param" blocks by `param_type` — a plain authenticated read whose
   * `data.param_data` is itself a JSON STRING (the vendor double-encodes it). Returns the parsed inner
   * object, or `{}` when the block is empty (the gateway answers `code 0` with an empty `param_data`
   * for a `param_type` that does not apply to the site's hardware). The caller owns the inner shape.
   */
  private async getSiteDeviceParam(siteId: string, paramType: string): Promise<Record<string, unknown>> {
    const data = await this.authed<{ param_data?: string }>("POST", SOLIX_ENDPOINTS.getSiteDeviceParam, {
      site_id: siteId,
      param_type: paramType,
      cmd: SolixClient.SITE_DEVICE_PARAM_CMD,
    });
    const raw = data?.param_data;
    if (!raw) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /**
   * Read the Solarbank's battery SOC-limit settings (`param_type "27"`) — a plain authenticated read.
   * Returns `undefined` when the site carries no SOC block (e.g. non-Solarbank hardware). The realtime
   * `dischargeLowerLimit` also arrives on the MQTT `b5` telemetry blob; this is the authoritative,
   * app-synced source for `chargeUpperLimit`. `backupReserve` (with its enable switch) also has a second
   * source under the same name, the realtime MQTT `b5` frame; whether the two agree while the switch is
   * OFF is not yet verified. Verified live against a known AE103 setting (discharge 20 / charge 80).
   */
  async getSafetySocParams(siteId: string): Promise<SolixSocParams | undefined> {
    const p = await this.getSiteDeviceParam(siteId, SolixClient.SOC_PARAM_TYPE);
    if (typeof p.charge_upper_limit !== "number" || typeof p.discharge_lower_limit !== "number") {
      return undefined;
    }
    return {
      chargeUpperLimit: p.charge_upper_limit,
      dischargeLowerLimit: p.discharge_lower_limit,
      backupReserve: typeof p.backup_reserve === "number" ? p.backup_reserve : 0,
      backupReserveSwitch: typeof p.backup_reserve_switch === "number" ? p.backup_reserve_switch : 0,
      socCalibrationEnable: typeof p.soc_calibration_enable === "number" ? p.soc_calibration_enable : 0,
    };
  }

  /**
   * Write the Solarbank's battery SOC limits — an `algo_ecdh`-encrypted + signed control write. This is
   * **read-modify-write**: it first reads the current `param_type "27"` block and overlays only the
   * fields the caller supplies, so changing the discharge limit alone never clobbers the charge limit,
   * backup reserve, or calibration toggle. `changes` values are whole-percent integers. The full block
   * (all five keys) is sent, matching the app's `SocSettingParam.toJson`. Throws if the site has no SOC
   * block to modify. Returns the merged parameters that were written (for an immediate optimistic echo).
   */
  async setSafetySocParams(siteId: string, changes: Partial<SolixSocParams>): Promise<SolixSocParams> {
    const current = await this.getSafetySocParams(siteId);
    if (!current) throw new Error(`Solix set SOC params: site has no param_type 27 block`);
    const merged: SolixSocParams = { ...current, ...changes };
    await this.encryptedWrite(SOLIX_ENDPOINTS.setSiteDeviceParam, "set_site_device_param", {
      site_id: siteId,
      cmd: SolixClient.SITE_DEVICE_PARAM_CMD,
      param_type: SolixClient.SOC_PARAM_TYPE,
      param_data: JSON.stringify({
        charge_upper_limit: merged.chargeUpperLimit,
        discharge_lower_limit: merged.dischargeLowerLimit,
        backup_reserve_switch: merged.backupReserveSwitch,
        backup_reserve: merged.backupReserve,
        soc_calibration_enable: merged.socCalibrationEnable,
      }),
    });
    return merged;
  }
}
