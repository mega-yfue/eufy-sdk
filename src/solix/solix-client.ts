/**
 * A minimal client for the Anker Solix power-station cloud, driven by the SAME account login the
 * eufy client uses.
 *
 * Why this is separate from the eufy device client: Solix shares Anker's `algo_ecdh` passport (so
 * {@link prepareKeyExchange} / {@link encryptLoginPassword} / {@link signRequest} are reused verbatim
 * for the login handshake) but exposes a different device backend — its own `app-name`, host, and
 * bootstrap key ({@link SOLIX_APP_NAME}, {@link SOLIX_DEFAULT_API_HOST}, {@link SOLIX_LOCAL_KEY_HEX}) —
 * and its authenticated resource reads are PLAIN JSON, carrying only the auth token and a
 * `gtoken = md5(user_id)`, with no per-request encryption or signature. This client therefore does
 * the encrypted passport handshake to obtain a token, then makes plain authenticated reads.
 *
 * It intentionally does NOT model Solix devices as capability objects (that is the eufy Device
 * model's job for eufy hardware); it returns the vendor's typed JSON so a caller can consume it.
 */
import { createHash } from "node:crypto";

import {
  decryptBody,
  encryptBody,
  encryptLoginPassword,
  finishKeyExchange,
  genId,
  nowSec,
  prepareKeyExchange,
  signRequest,
  type SessionEntry,
} from "../core/index.js";

import {
  SOLIX_APP_NAME,
  SOLIX_DEFAULT_API_HOST,
  SOLIX_ENDPOINTS,
  SOLIX_ESTIMATE_HOST,
  SOLIX_LOCAL_KEY_HEX,
} from "./constants.js";

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
  /** Override the API host (skips domain-estimate). Defaults to estimate → {@link SOLIX_DEFAULT_API_HOST}. */
  apiHost?: string;
  /** App version reported to the cloud. */
  appVersion?: string;
  /** Injected fetch (for tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

const md5Hex = (s: string): string => createHash("md5").update(s).digest("hex");

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
  private apiHost: string;
  private session_?: SolixSession;
  /** Carried between {@link login} and {@link submitVerifyCode} while a 2FA code is outstanding. */
  private pending2fa?: { limitedToken: string; userId: string; geoKey?: string };

  constructor(opts: SolixClientOptions) {
    this.email = opts.email;
    this.password = opts.password;
    this.country = (opts.countryCode ?? "US").toUpperCase();
    this.appVersion = opts.appVersion ?? "3.23.0";
    this.doFetch = opts.fetchImpl ?? fetch;
    this.apiHost = opts.apiHost ?? SOLIX_DEFAULT_API_HOST;
  }

  /** The authenticated session, once {@link login} has resolved to `ok`. */
  get session(): SolixSession | undefined {
    return this.session_;
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

  private async post(
    host: string,
    path: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<SolixEnvelope> {
    const res = await this.doFetch(`https://${host}${path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    let json: SolixEnvelope;
    try {
      json = JSON.parse(text) as SolixEnvelope;
    } catch {
      throw new Error(`Solix ${path} → HTTP ${res.status}, non-JSON: ${text.slice(0, 120)}`);
    }
    return json;
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
      this.baseHeaders(prep.headers),
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
      this.baseHeaders({
        "x-encryption-info": "algo_ecdh",
        "x-key-ident": kx.keyIdent,
        "x-request-ts": ts,
        "x-request-once": once,
        "x-signature": signRequest(kx.shareKey, ts, once, encBody),
        ...(limitedToken ? { "x-auth-token": limitedToken } : {}),
      }),
    );
  }

  /** Turn a decrypted `/passport/login` payload into an `ok`/`2fa` result, establishing the session on `ok`. */
  private classifyLogin(kx: SessionEntry, data: Record<string, unknown>, isVerify: boolean): SolixLoginResult {
    const userId = (data.ap_cloud_user_id ?? data.user_id) as string | undefined;
    const authToken = data.auth_token as string | undefined;
    if (!userId || !authToken)
      throw new Error(`Solix login returned no session: ${JSON.stringify(data).slice(0, 160)}`);
    // The passport marks a pending 2FA with a non-empty `fa_info.info`; empty once satisfied.
    const faInfo = (data.fa_info ?? {}) as { info?: string };
    if (!isVerify && faInfo.info) {
      this.pending2fa = { limitedToken: authToken, userId, geoKey: data.geo_key as string | undefined };
      void kx;
      return { status: "2fa", method: "code sent by the passport" };
    }
    this.pending2fa = undefined;
    this.session_ = {
      authToken,
      userId,
      gtoken: md5Hex(userId),
      apiHost: this.apiHost,
      tokenExpiresAt: Number(data.token_expires_at ?? 0) || 0,
    };
    return { status: "ok", session: this.session_ };
  }

  /** Decrypt a login envelope's `data` (base64 `IV(16)||AES-128-CBC`, keyed by the share key). */
  private decryptLogin(env: SolixEnvelope, kx: SessionEntry): Record<string, unknown> {
    if (typeof env.data !== "string") throw new Error(`Solix login (${env.code}): ${env.msg}`);
    return JSON.parse(decryptBody(env.data, kx.shareKey).toString("utf-8")) as Record<string, unknown>;
  }

  /**
   * Authenticate with the account credentials. Resolves to `ok` with a {@link SolixSession}, or `2fa`
   * when the passport sent a code — then call {@link submitVerifyCode}.
   */
  async login(): Promise<SolixLoginResult> {
    await this.estimateHost();
    const kx = await this.keyExchange();
    const env = await this.postLogin(kx);
    return this.classifyLogin(kx, this.decryptLogin(env, kx), false);
  }

  /** Complete a `2fa` login with the code the passport sent. */
  async submitVerifyCode(code: string): Promise<SolixLoginResult> {
    if (!this.pending2fa) throw new Error("no 2FA login is pending");
    const kx = await this.keyExchange();
    const env = await this.postLogin(kx, code, this.pending2fa.limitedToken);
    return this.classifyLogin(kx, this.decryptLogin(env, kx), true);
  }

  /** POST an authenticated PLAIN JSON read (no per-request encryption); returns the parsed envelope. */
  private async authedRead<T = unknown>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    if (!this.session_) throw new Error("not authenticated — call login() first");
    const env = await this.post(
      this.session_.apiHost,
      path,
      JSON.stringify(body),
      this.baseHeaders({
        gtoken: this.session_.gtoken,
        "x-auth-token": this.session_.authToken,
      }),
    );
    if (env.code !== 0) throw new Error(`Solix ${path} failed (${env.code}): ${env.msg}`);
    return (env.data ?? null) as T;
  }

  /** The account's bound Solix devices (flat list; may be empty when devices live under sites). */
  async getDevices(): Promise<unknown[]> {
    const data = await this.authedRead<{ data?: unknown[] } | unknown[]>(SOLIX_ENDPOINTS.getRelateAndBindDevices);
    return Array.isArray(data) ? data : (data?.data ?? []);
  }

  /** The account's sites (systems); devices are typically grouped under a site. */
  async getSites(): Promise<unknown[]> {
    const data = await this.authedRead<{ site_list?: unknown[] }>(SOLIX_ENDPOINTS.getSiteList);
    return data?.site_list ?? [];
  }

  /** Per-user AWS-IoT MQTT credentials (cert/key/endpoint/thing) for the real-time device plane. */
  async getUserMqttInfo(): Promise<Record<string, unknown>> {
    return this.authedRead<Record<string, unknown>>(SOLIX_ENDPOINTS.getUserMqttInfo);
  }
}
