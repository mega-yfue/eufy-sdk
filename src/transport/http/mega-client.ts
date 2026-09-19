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
import { downloadMediaResource, mediaFailureError, MediaDownloadAuthenticationError } from "./media-download.js";
import { randomPhoneModel, randomUserAgent } from "./phone-model.js";
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
   * Phone model reported to the cloud as this install's device. Defaults to a realistic, RANDOM model
   * (see {@link randomPhoneModel}) seeded by `openudid` so it is stable across runs — this keeps many
   * SDK installs from all reporting one identical model. An explicit value pins a fixed identity.
   */
  phoneModel?: string;
  /** OS version string reported in headers. */
  osVersion?: string;
  /** Stable per-install device id (the auth token binds to it). Derived from email if absent. */
  openudid?: string;
  /**
   * `user-agent` sent on the push-media download path (`downloadMedia`/`downloadImage`). Defaults to a
   * realistic Android string consistent with `phoneModel` and seeded by `openudid` (stable across runs);
   * an explicit value pins a fixed one. Not the account identity — that's `phoneModel`.
   */
  mediaUserAgent?: string;
  /**
   * Acting name written into the commands that carry an actor field — guard mode and HomeBase alarm
   * output (`user_name`), a lock's acting username. Trimmed, and blank counts as unset: the default
   * is the login email's local-part (the whole string when it has no `@`). Attribution only — the
   * device stores it for its own activity record, and no captured frame shows it being validated
   * against the account.
   */
  accountName?: string;
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
 * refusal is permanent for the life of that account's session, so a retry cannot change it — the
 * device-list params carry the same `{param_type, param_value, update_time}` and are not owner-gated.
 */
export const OWNER_ONLY_CODE = 20004;

/**
 * Thrown when a persisted/expired session is rejected (401). Re-login to recover.
 *
 * It carries the rate the client has already worked out for replacing a rejected token, because the
 * rejection is where that rate stops being the client's alone: a login driven from here spends the same
 * session the client's own recovery would have, and repeated logins are what makes an account start
 * demanding captchas. {@link retryAfterMs} is how long the next replacement is barred for, and
 * {@link contended} whether this rejection landed inside that bar — the shape repeated displacement has.
 */
export class SessionExpiredError extends Error {
  /**
   * How long the next session replacement is barred for, in milliseconds; `0` when nothing bars one now.
   *
   * The remainder of the client's own hold-off, which doubles per consecutive replacement and is capped —
   * and which every replacement extends, whether the client spent it or a login made on this error did.
   */
  readonly retryAfterMs: number;
  /**
   * Whether this rejection landed inside that bar — a token replaced recently and rejected again since.
   *
   * It says the session is being DISPLACED rather than expiring: something else is signing in on this
   * account, and replacing the token again only trades one login for another.
   */
  readonly contended: boolean;

  constructor(message: string, opts: { retryAfterMs?: number; contended?: boolean } = {}) {
    super(message);
    this.name = "SessionExpiredError";
    this.retryAfterMs = opts.retryAfterMs ?? 0;
    this.contended = opts.contended ?? false;
  }
}

/**
 * eufy cloud gateway error codes — the numeric `code` carried in a response envelope alongside the
 * HTTP status.
 *
 * PROVENANCE — backend-only. These numbers are NOT hardcoded anywhere in the app: verified absent from
 * the v6 APK's Java sources, resources, every native `.so` (including the Flutter `libapp.so`) and the
 * Hermes bundles. The app reacts to the *condition* via generic logout handling + user-facing strings
 * (e.g. `account_login_log_out_notice` — "logged in on another device"), not by matching the code. So a
 * code here is known only from an observed live response; add new ones the same way.
 *
 * Internal: these are gateway mechanics, not a surface a host acts on — the transport already turns the
 * conditions that matter into a typed outcome (`SessionExpiredError`, `LoginStatus.Captcha`). Exported
 * only so the transport's own specs can name a code instead of repeating the number.
 * @internal
 */
export const EufyCloudErrorCode = {
  /**
   * Session kicked out — the account logged in on another device (eufy enforces ~one active session
   * per account). Arrives as HTTP 401 with this `code`; the human message wording varies across
   * endpoints ("...kicked out", "token error", ...), which is why the classifier keys off this code
   * and only falls back to message parsing.
   */
  SESSION_KICKED: 26084,
  /**
   * "get identity error" (usually HTTP 463) — the gateway no longer knows our `x-key-ident`; the ECDH
   * session key was rotated/expired server-side (common after a restored session sits idle for days).
   * The auth token may still be fine, so this triggers a one-shot key re-exchange before the request
   * is treated as a dead session.
   */
  IDENTITY_KEY_STALE: 4404,
  /** Signature invalid — the wrong per-host `content-type` was tried; expected during the content-type
   *  probe and retried on the alternate type (not a real failure). */
  SIGNATURE_INVALID: 4416,
  /** Generic gateway "try again" seen during the same content-type probe; retried, not surfaced. */
  PROBE_RETRY: 10000,
  /** Captcha required before login can proceed — fetch a challenge and solve it. */
  CAPTCHA_REQUIRED: 100032,
  /** Captcha answer was wrong — fetch a fresh challenge and re-solve. */
  CAPTCHA_WRONG: 100033,
} as const;
/**
 * Any one of the gateway error codes above.
 * @internal
 */
export type EufyCloudErrorCode = (typeof EufyCloudErrorCode)[keyof typeof EufyCloudErrorCode];

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

/** What can be done about a rejection that means the token is finished. */
type SessionRecovery = "retry" | "unrecoverable" | "held-off";

/** First wait before replacing a token that was replaced recently; doubles per consecutive replacement. */
const REAUTH_HOLD_OFF_MS = 60_000;
const REAUTH_HOLD_OFF_CAP_MS = 30 * 60_000;
/** How long a replaced token must keep serving calls before the wait is forgotten. */
const REAUTH_STABLE_MS = 10 * 60_000;

/**
 * What a token being displaced repeatedly means, and what can be done about it. Carried on the surfaced
 * error because the alternative — a client silently trading logins with another — is worse than a caller
 * being told.
 *
 * The mechanism comes first and the `openudid` remedy second: the remedy applies only where the other
 * client is another SDK install, and a caller that already sets its own device id is left with the
 * mechanism alone. {@link SessionExpiredError.contended} is that same fact without the prose.
 */
const CONTENDED_SESSION_HINT =
  "another client signed in on this account keeps displacing this session — the cloud holds about one " +
  "session per account and device identity, so each login ends the other's; where the other client is " +
  "another SDK install, give each its own openudid";

/**
 * Whether a rejection's CODE or WORDING says the token is finished, rather than that this request was refused
 * for some other reason (rate limit, captcha cooldown) — the difference between dropping a good session and
 * keeping it. The caller pairs this with the 401 status; neither alone is the signal.
 *
 * The vendor words the same rejection several ways, and only one carries a distinctive code. All of these were
 * observed on one account: {@link EufyCloudErrorCode.SESSION_KICKED} with `"token does not exist because it was
 * kicked out"` when another login displaced it, and the generic `401` with `"token error"` or `"token not
 * exist, token = …"` for the same thing. Matching the code alone leaves a displaced stored token looking like
 * an ordinary API error, which nothing recovers from.
 *
 * The subject-less wordings are anchored to a token or a session: a bare `does not exist` also occurs in the
 * serialised detail of rejections that have nothing to do with the credential, and clearing a healthy session
 * on one of those costs a re-2FA.
 *
 * Two properties of the match keep those anchors on their own subject, and
 * `"token = …, gtoken not equal userid error"` — a HEADER fault on a token that is fine, which no re-login can
 * repair — needs both:
 *  - a wildcard cannot cross a comma, so it stays inside the clause its anchor sits in and cannot borrow a
 *    word from the next one;
 *  - `token` matches as a whole word, so `gtoken` — a different header with a different meaning — is not read
 *    as the credential.
 *
 * Both are bounds on the match rather than edits to the message: the echoed credential still carries the
 * anchor for wordings that state their reason beside it (`"token = … expired"`), so removing the echo before
 * matching would lose a real expiry and leave a dead session uncleared.
 */
function tokenRejected(code: number | undefined, msg: string | undefined): boolean {
  return (
    code === EufyCloudErrorCode.SESSION_KICKED ||
    /user_id is empty|invalid[^,]*\btoken\b|\btoken\b[^,]*(expired|error|not exist)|kicked|(?:\btoken\b|\bsession\b)[^,]*does not exist|unauthor/i.test(
      msg ?? "",
    )
  );
}

/**
 * Strip a token the gateway echoed back into its own error message.
 *
 * `"token not exist, token = <the rejected token>"` is the vendor's wording, and that message travels into the
 * error the SDK surfaces. A credential that has just been rejected is still a credential, and it is
 * never the part of the message that explains anything.
 */
function withoutTokenEcho(text: string): string {
  return text.replace(/token\s*[=:]\s*"?[A-Za-z0-9._-]{8,}"?/gi, "token = <redacted>");
}

/**
 * {@link MegaHttpClient.postSigned}'s bookkeeping for the two recoveries it performs on itself, so each is
 * attempted once per call rather than once per rejection.
 * @internal
 */
export interface SignedRetry {
  /** The session key has already been re-exchanged for this call. */
  identity?: boolean;
  /** The token has already been replaced by a fresh login for this call. */
  reauth?: boolean;
}

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
  /**
   * The held credential. `userId` is the login reply's `ap_cloud_user_id` where it has one — the Anker
   * Passport cloud's id — while `accountUserId` is the eufy account's own `user_id`.
   *
   * The `gtoken` header is hashed from `accountUserId`: that is the id the gateway recomputes the header
   * from, rejecting a disagreement with `"gtoken not equal userid error"`.
   */
  private auth_?: { userId: string; authToken: string; geoKey?: string; accountUserId?: string };
  /** captcha_id of an in-flight challenge, held between login() and solveCaptcha(). */
  private pendingCaptchaId?: string;
  /** True while a 2FA code is outstanding: `auth_` holds only the limited pre-verify token, so the
   *  restored-session short-circuit must NOT treat it as a usable session. Cleared on Ok/reset. */
  private pending2fa = false;
  private tokenExpiresAt = 0;
  /**
   * Stable per-install device id: `openudid` as configured, as restored from the session store, or as
   * derived from the ACCOUNT when neither supplied one — two clients that configure none therefore
   * share it, and are one install as far as everything keyed on this is concerned.
   *
   * Two things are keyed on it, and both fail the same way when it is shared: the auth token is bound
   * to it, so each login displaces the other's session, and the secure-MQTT client id is built from it,
   * so each connection evicts the other's channel.
   */
  readonly openudid: string;
  /** The device model reported to the cloud (explicit `phoneModel`, else a stable random one). */
  private readonly phoneModel: string;
  /** The `user-agent` for the media-download path (explicit `mediaUserAgent`, else derived from the model). */
  private readonly mediaUserAgent: string;
  private readonly store: SessionStore;
  private readonly logger: Logger;
  /** Remembered working Content-Type per host (the gateway is picky + inconsistent). */
  private readonly contentTypeByHost = new Map<string, string>();
  /** True while a `/passport/login` round trip is in flight — see {@link canReauthenticate}. */
  private loggingIn = false;
  /** The one in-flight re-login every call rejected on the same dead token waits on. */
  private reauthAttempt?: Promise<boolean>;
  /** Replacements since the held session last proved stable, and when the last one ran — see {@link holdOffRemainingMs}. */
  private recoveries = 0;
  private lastRecoveryAt = 0;
  /** A token of ours has been rejected and not yet replaced — see {@link noteTokenReplacement}. */
  private rejectedTokenPending = false;

  constructor(cfg: MegaClientConfig) {
    this.cfg = {
      appName: "eufy_mega",
      appVersion: "6.0.41_26142",
      countryCode: "US",
      osVersion: "36",
      ...cfg,
    };
    this.region = cfg.region ?? "us-pr";
    this.store = cfg.store ?? new MemorySessionStore();
    this.logger = cfg.logger ?? noopLogger;

    // The device identity (openudid + phone model + media UA) is generated ONCE and persisted, so it
    // survives a token expiry AND a change to the generator — a shifting identity would look like a new
    // device every run and re-trigger 2FA. Prefer an explicit config, then the stored value, then a
    // fresh (deterministic, openudid-seeded) generate that persist() saves. Identity is reused even when
    // the stored token itself has expired.
    const saved = this.store.load();
    this.openudid =
      cfg.openudid ?? saved?.openudid ?? createHash("md5").update(`eufy-mega:${cfg.email}`).digest("hex").slice(0, 16);
    this.phoneModel = cfg.phoneModel ?? saved?.phoneModel ?? randomPhoneModel(this.openudid);
    this.mediaUserAgent =
      cfg.mediaUserAgent ?? saved?.mediaUserAgent ?? randomUserAgent(this.openudid, this.phoneModel);

    this.hydrateFromStore();
  }

  /**
   * Install the session the store holds, if it holds a usable one: the token + its bound ECDH key, skipping
   * estimate/key-exchange/login/2FA entirely. Answers the token adopted, or `undefined`.
   *
   * Read at construction, and again when a rejection is being recovered from — a store SHARED with another
   * client may already hold the session that client obtained, which is cheaper to adopt than to compete with.
   *
   * Note: the device identity (openudid + phone model + media UA) is NOT restored here — it is resolved once
   * in the constructor, where an explicit config wins over the stored value, and must not be re-derived from a
   * session this may adopt from a shared store during recovery.
   */
  private hydrateFromStore(): string | undefined {
    const saved = this.store.load();
    if (!isSessionValid(saved) || !saved) return undefined;
    this.region = saved.region;
    this.auth_ = {
      userId: saved.userId,
      accountUserId: saved.accountUserId,
      authToken: saved.authToken,
      geoKey: saved.geoKey,
    };
    this.tokenExpiresAt = saved.tokenExpiresAt;
    this.sessionKey = {
      keyIdent: saved.keyIdent,
      shareKey: saved.shareKey,
      clientPublicKeyHex: "",
      clientPrivateKeyHex: "",
      createdAt: Date.now(),
    };
    this.logger.debug("[mega] restored persisted session for", saved.userId);
    return saved.authToken;
  }

  get auth(): { userId: string; authToken: string } | undefined {
    return this.auth_ ? { userId: this.auth_.userId, authToken: this.auth_.authToken } : undefined;
  }

  /** The active region shard (e.g. `"eu-pr"`, `"us-pr"`), set after {@link login} or a region override. */
  get regionShard(): RegionShard {
    return this.region;
  }

  /**
   * The name commands attribute themselves to — {@link MegaClientConfig.accountName} when the config
   * pins one (trimmed; blank counts as unset), otherwise the logged-in account's display name, which
   * is the login email's local-part (e.g. `someone+tag` for `someone+tag@example.com`) and falls back
   * to the whole email if it has no `@`.
   *
   * The local-part is the string the app writes into the ff09 command's acting "username" field
   * (verified against a captured T8531 unlock frame), so it is the faithful default. An override is a
   * different LABEL for the same account, not a different identity: the session authenticates on the
   * token and the device record's member ids, neither of which this touches.
   */
  get accountName(): string {
    const pinned = this.cfg.accountName?.trim();
    if (pinned) return pinned;
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
    const model = this.phoneModel;
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
   * The id `gtoken` is hashed from — the account's own `user_id`, which is what the gateway recomputes the
   * header from. One place so the two header paths cannot drift on which of the session's ids that is.
   *
   * Call only where `auth_` is already established; every header path guards it.
   */
  private gtokenUserId(): string {
    return this.auth_!.accountUserId ?? this.auth_!.userId;
  }

  /**
   * The account-credential headers every authed call carries — `x-auth-token` + `gtoken`.
   * One place so the signed path, the key-exchange and the bearer path can't drift on what "authed" means.
   */
  private authTokenHeaders(): Record<string, string> {
    if (!this.auth_) return {};
    return {
      "x-auth-token": this.auth_.authToken,
      authorization: this.auth_.authToken,
      gtoken: gtoken(this.gtokenUserId()),
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

  /**
   * Signed + encrypted POST. Content-type auto-falls-back (text/plain ↔ json).
   *
   * `retry` is this method's own bookkeeping across the two recoveries it performs on itself — a re-exchanged
   * session key, and a re-login — so each is attempted once per call. A caller leaves it out.
   */
  async postSigned<T = unknown>(
    host: string,
    path: string,
    body: unknown = {},
    authed = true,
    retry: SignedRetry = {},
    headerOverrides: Record<string, string> = {},
  ): Promise<T> {
    const entry = await this.ensureSessionKey(host);
    // Remembered because a rejection can arrive after another call has already replaced the session, and the
    // two cases need opposite handling: replace a token that is still held, use one that is already fresh.
    const sentToken = authed ? this.auth_?.authToken : undefined;
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
        if (authed) this.noteSessionWorking();
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
      last = { code: env?.code, msg: withoutTokenEcho(detail), status: res.status };
      const retryable =
        (res.status === 403 && env?.code === EufyCloudErrorCode.SIGNATURE_INVALID) ||
        env?.code === EufyCloudErrorCode.PROBE_RETRY ||
        res.status === 400;
      // 4416/10000 on the first content-type is expected probing — don't log it as
      // an error; only surface genuinely unexpected envelopes in debug.
      if (env?.code !== 0 && !retryable)
        this.logger.debug("[mega] err envelope:", withoutTokenEcho(JSON.stringify(res.data).slice(0, 500)));
      if (!retryable) break;
    }
    // "get identity error" (4404, usually HTTP 463): the server no longer knows
    // our x-key-ident — the ECDH session key was rotated/expired server-side
    // (common after a restored session sits idle for days). The token may still
    // be fine, so first re-run the key exchange ONCE and retry; only if that
    // fails too do we treat it as a dead session.
    const identityError =
      authed &&
      (last?.code === EufyCloudErrorCode.IDENTITY_KEY_STALE ||
        /get identity error|identity error/i.test(last?.msg ?? ""));
    if (identityError && !retry.identity && this.auth_) {
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
      return this.postSigned<T>(host, path, body, authed, { ...retry, identity: true }, headerOverrides);
    }
    // Two ways to conclude the TOKEN is finished rather than this request refused: a fresh key-ident that
    // was still rejected, or a 401 whose code/wording says so. Only these drop the persisted session — a
    // transient 401 (rate limit, captcha cooldown) must not wipe a good one and force re-2FA.
    const tokenFinished =
      (identityError && retry.identity) || (authed && last?.status === 401 && tokenRejected(last.code, last.msg));
    if (tokenFinished) {
      const reason = `${path} failed (${last?.status}/${last?.code}): ${last?.msg}`;
      this.rejectedTokenPending = true;
      const recovery = retry.reauth ? "unrecoverable" : await this.recoverRejectedSession(sentToken);
      if (recovery === "retry")
        return this.postSigned<T>(host, path, body, authed, { ...retry, reauth: true }, headerOverrides);
      if (!this.sessionReplacedSince(sentToken)) this.clearSession();
      const contended = recovery === "held-off";
      throw new SessionExpiredError(contended ? `${reason} — ${CONTENDED_SESSION_HINT}` : reason, {
        retryAfterMs: this.holdOffRemainingMs(),
        contended,
      });
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
    return this.postSigned<T>(`app-${service}-${this.region}.eufy.com`, path, body, true, {}, headerOverrides);
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
   * Fetch one page of a device's **cleaning history** from the mega `clean` service.
   *
   * Body is `{ device_sn, num, page }` — `num` is the page SIZE and `page` is 1-based. Returns the raw
   * response so the caller owns the shape; `parseCleanRecords` in `model/` is what reads it.
   *
   * Each record carries a `download_url` to a binary detail blob. That blob is NOT fetched here: the
   * host it points at is unconfirmed, and this client's binary path (`downloadMediaResource`) is
   * host-allowlisted by design.
   */
  getCleanRecords<T = unknown>(deviceSn: string, num = 20, page = 1): Promise<T> {
    return this.post<T>("clean", "/app/clean/get_device_clean_record_list", {
      device_sn: deviceSn,
      num,
      page,
    });
  }

  /**
   * Fetch one page of a device's stored **map data** from the mega `clean` service.
   *
   * Paginated by both `page` and a byte `last_offset`, because one map is larger than one response: the
   * answer carries `offset`, `last_offset`, `len`, `total` and `is_next_page`.
   *
   * Returns the raw response, `content` included. **The content is not decoded anywhere in this SDK and
   * deliberately so** — the decoder is the vendor's clean-native library, which is absent from the base
   * APK, and the extracted `.so` set contains no clean-native module. Handing over bytes a caller can
   * take elsewhere is the honest surface; a decode here would be invention.
   */
  getDeviceMapList<T = unknown>(deviceSn: string, channelId = 0, num = 1, page = 1, lastOffset = 0): Promise<T> {
    return this.post<T>("clean", "/app/clean/get_device_map_list", {
      device_sn: deviceSn,
      channel_id: channelId,
      num,
      page,
      last_offset: lastOffset,
    });
  }

  /**
   * Fetch the stored map content for several channels of one device in a single call.
   *
   * The batch counterpart of {@link getDeviceMapList}, answering `content` keyed by channel id. Same
   * standing on the bytes: returned as they arrive, never decoded here.
   */
  getManyDeviceMapContent<T = unknown>(deviceSn: string, channelIds: readonly number[]): Promise<T> {
    return this.post<T>("clean", "/app/clean/get_many_device_map_content", {
      device_sn: deviceSn,
      channel_ids: [...channelIds],
    });
  }

  /**
   * Generic authed signed POST to `app-{service}-{region}.eufy.com{path}` with an arbitrary body.
   * The typed wrappers above cover the known endpoints; this is the generic escape hatch for one that
   * has none yet — {@link fetchLightCatalog} drives the `things` service through it.
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
        gtoken: gtoken(this.gtokenUserId()),
        "app-name": "eufy_mega",
        "model-type": "PHONE",
        "user-agent": this.mediaUserAgent,
      });
    } catch (error) {
      if (error instanceof MediaDownloadAuthenticationError) {
        throw new SessionExpiredError("media download rejected the active session");
      }
      throw error;
    }
  }

  /**
   * Download push image bytes and decrypt a recognized v1 wrapper when its device key input is available.
   *
   * A decoder throw is tagged `decode-failed`: to anything downstream, the difference between "the
   * bytes never arrived" and "the bytes arrived and the wrapper would not decrypt" is the difference
   * between a network problem and a key problem, and one of them is this SDK's to fix.
   */
  async downloadImage(url: string, p2pDid?: string): Promise<Buffer> {
    const data = await this.downloadMedia(url);
    try {
      return normalizePushImage(data, p2pDid);
    } catch (error) {
      throw mediaFailureError("Push image could not be decoded", "decode-failed", error);
    }
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
   * calls want `Content-Type: text/plain`). {@link ensureSessionKey} keeps a PER-HOST key
   * for eufylife hosts and exchanges against the eufylife host, so `getFaces()`/`getCiphers()` work.
   * Note `getFaces` returns an empty roster for accounts whose faces live on the HomeBase — the P2P
   * database path carries the real roster.
   */
  async securityAppPost<T = any>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    return this.postSigned<T>(this.securityAppHost(), path, body, true);
  }

  /**
   * List the account's enrolled AI faces (the recognition roster). Each entry is keyed by `ai_user_id` —
   * the id an `IDENTITY_PERSON_DETECTION` push carries as `person_id` — so this is the lookup table for
   * naming a recognised person. Endpoint: `/v3/aiassis/get_faces` on the security-app host.
   *
   * Answers an empty roster for an account whose faces live on the HomeBase; that roster is read over
   * the P2P database path instead.
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
   * A restored session short-circuits to `ok` with no network, so `ok` there states that a session was
   * RESTORED, not that the cloud still honours it — `session.raw.restored` marks that case. Nothing is spent
   * proving it here: the first authenticated call is where the cloud says, and a token it rejects is replaced
   * by a fresh login and the call retried, without the caller seeing anything (see {@link postSigned}). What
   * reaches the caller, as {@link SessionExpiredError}, is a replacement this client cannot complete by
   * itself — one needing a captcha or a 2FA code, one with no credentials to use, one attempted while a login
   * is already part-way through, or a login that failed outright.
   *
   * `messageType` picks the 2FA channel (2 = email, 1 = SMS) for the code that gets sent when 2FA is required.
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
   * Whether the session this call was made against has already been replaced.
   *
   * A rejection can arrive after another call's recovery has finished — the request was in flight with the old
   * token, and the answer to it is late news. Such a call needs no recovery of its own, and must not clear the
   * session: doing so discards the token that was just obtained and logs the client out while it is being
   * fixed.
   */
  private sessionReplacedSince(sentToken: string | undefined): boolean {
    const held = this.auth_?.authToken;
    return !!held && held !== sentToken;
  }

  /**
   * Deal with a rejection that means the token is finished; answers what the caller may do about it.
   *
   * The cheap answers first. A session already replaced by another call's recovery just needs using, and a
   * recovery already in flight is JOINED rather than duplicated — a device-list refresh fires several calls at
   * once, and each starting its own login would spend N of them to learn one thing. A store SHARED with
   * another client may already hold that client's token, which is both cheaper than a login and the difference
   * between adopting a working session and destroying it.
   *
   * Only then is a login spent, and its rate is bounded — see {@link recoveryDue}. Dropping the dead session
   * first is what keeps the login state machine from short-circuiting on it.
   */
  private async recoverRejectedSession(sentToken: string | undefined): Promise<SessionRecovery> {
    if (this.sessionReplacedSince(sentToken)) return "retry";
    const joining = this.reauthAttempt;
    if (joining) return (await joining) ? "retry" : "unrecoverable";
    if (this.hydrateFromStore() && this.sessionReplacedSince(sentToken)) return "retry";
    if (!this.canReauthenticate()) return "unrecoverable";
    if (!this.recoveryDue()) return "held-off";
    this.noteTokenReplacement();
    this.clearSession();
    return (await this.reauthenticate()) ? "retry" : "unrecoverable";
  }

  /**
   * Whether a token may be replaced now, given how recently the last one was.
   *
   * A client's device identity defaults to one derived from its credentials, so two clients on one account look
   * like the same device — and the cloud keeps one session per device. Each finds its token rejected, replaces
   * it, and evicts the other: an unbounded login war, silent, and repeated logins are exactly what makes an
   * account start demanding captchas. The first replacement is immediate, because a token displaced once is
   * the ordinary case; a second one soon after is evidence of contention rather than expiry, so the wait grows
   * and a caller is told the honest reason instead of being served a fight.
   */
  private recoveryDue(): boolean {
    const remaining = this.holdOffRemainingMs();
    if (remaining === 0) return true;
    this.logger.warn(
      `[mega] token rejected ${Math.round((Date.now() - this.lastRecoveryAt) / 1000)}s after the last ` +
        `replacement — holding off ${Math.round(remaining / 1000)}s more. ${CONTENDED_SESSION_HINT}`,
    );
    return false;
  }

  /**
   * How much longer a token replacement must wait, in milliseconds; `0` when one may run now.
   *
   * The wait doubles per consecutive replacement and is capped, and it is what {@link recoveryDue} gates
   * this client's own recovery on — and what {@link SessionExpiredError.retryAfterMs} hands a host that
   * drives its own. One function so the two cannot disagree about the rate, which they would have to for
   * a host to be told it may retry while this client is still holding off.
   */
  private holdOffRemainingMs(): number {
    if (this.recoveries === 0) return 0;
    const wait = Math.min(REAUTH_HOLD_OFF_MS * 2 ** (this.recoveries - 1), REAUTH_HOLD_OFF_CAP_MS);
    return Math.max(0, wait - (Date.now() - this.lastRecoveryAt));
  }

  /**
   * Count one token replacement against the hold-off, and clear the rejection it answered.
   *
   * Every replacement passes through here, wherever it was spent from: {@link recoverRejectedSession}, and
   * a {@link login} that follows a rejection this client surfaced. A hold-off that counted only its own
   * would be no bound at all — the wait would sit at its first value however many sessions had been spent,
   * and {@link SessionExpiredError.retryAfterMs} would report a minute while logins ran every few seconds.
   * Which of the two counted a given replacement is the flag: the recovery path clears it before logging
   * in, so the login cannot count the same one again.
   */
  private noteTokenReplacement(): void {
    this.recoveries++;
    this.lastRecoveryAt = Date.now();
    this.rejectedTokenPending = false;
  }

  /**
   * Note that the held session is working. A replacement that keeps serving calls for long enough is not
   * contention, so the hold-off is forgotten and the next genuine expiry recovers immediately.
   */
  private noteSessionWorking(): void {
    this.rejectedTokenPending = false;
    if (this.recoveries > 0 && Date.now() - this.lastRecoveryAt > REAUTH_STABLE_MS) this.recoveries = 0;
  }

  /**
   * Whether a rejected token is worth trying to replace without asking the host anything.
   *
   * Structural rather than a list of paths: a login round trip is itself an authenticated call while a limited
   * token is held, so re-logging in from inside one would recurse — and a path list would have to be
   * maintained alongside every request the login flow makes. A 2FA code already outstanding is a login a human
   * is part-way through, and restarting it silently would discard it. No credentials means nothing to try,
   * so the rejection surfaces instead.
   */
  private canReauthenticate(): boolean {
    return !!this.cfg.email && !!this.cfg.password && !this.loggingIn && !this.pending2fa;
  }

  /**
   * Replace a rejected token by running the login state machine again, at most once at a time.
   *
   * Answers whether a usable session was obtained; a login that needs a captcha or a 2FA code answers `false`,
   * because neither can be satisfied from here — the caller then surfaces the rejection so the host can drive
   * the flow it owns. A login that fails outright answers `false` too, with the reason logged.
   *
   * One attempt is SHARED by every call that was in flight against the dead token. A device-list refresh fires
   * several at once, and each starting its own login would spend N of them to learn one thing — worse, on an
   * account that limits concurrent sessions, each login displaces the token the previous one just obtained.
   */
  private reauthenticate(): Promise<boolean> {
    this.reauthAttempt ??= this.login()
      .then((result) => {
        if (result.status === LoginStatus.Ok) this.logger.debug("[mega] token was rejected — logged in again");
        else this.logger.warn(`[mega] token was rejected and the re-login needs ${result.status} — cannot recover`);
        return result.status === LoginStatus.Ok;
      })
      .catch((e: unknown) => {
        this.logger.warn(`[mega] re-login failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      })
      .finally(() => (this.reauthAttempt = undefined));
    return this.reauthAttempt;
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
    this.loggingIn = true;
    try {
      return await this.loginRoundTrip(body, messageType);
    } finally {
      this.loggingIn = false;
    }
  }

  /** The round trip itself. Wrapped by {@link attemptLogin}, which marks it in flight. */
  private async loginRoundTrip(body: Record<string, unknown>, messageType: number): Promise<LoginResult> {
    if (!this.cfg.region) await this.estimateDomain();
    await this.ensureSessionKey();
    const passportHost = `app-passport-${this.region}.eufy.com`;
    const isVerify = "verify_code" in body && !!body.verify_code;

    let res: Record<string, unknown>;
    try {
      res = await this.postSigned<Record<string, unknown>>(passportHost, "/passport/login", body, !!this.auth_);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Captcha required / wrong answer — the code is matched in the thrown message (postSigned embeds
      // `(status/code)`), so the patterns are built from the consts. Hold the id for solveCaptcha().
      const captchaWrong = new RegExp(`\\b${EufyCloudErrorCode.CAPTCHA_WRONG}\\b`);
      const captchaAny = new RegExp(
        `\\b${EufyCloudErrorCode.CAPTCHA_REQUIRED}\\b|\\b${EufyCloudErrorCode.CAPTCHA_WRONG}\\b`,
      );
      if (captchaAny.test(msg)) {
        const cap = await this.generateCaptcha();
        this.pendingCaptchaId = cap.captchaId;
        return { status: LoginStatus.Captcha, image: cap.image, retry: captchaWrong.test(msg) };
      }
      throw e;
    }
    {
      const cap = Object.keys(res).filter((k) => /captcha|answer|picture|image|fa_/i.test(k));
      this.logger.debug("[mega] login resp keys:", Object.keys(res).join(","));
      this.logger.debug("[mega] ids agree:", res.ap_cloud_user_id === res.user_id);
      if (cap.length)
        this.logger.debug("[mega] captcha/fa:", JSON.stringify(Object.fromEntries(cap.map((k) => [k, res[k]]))));
    }
    const userId = (res.ap_cloud_user_id ?? res.user_id ?? res.userId) as string | undefined;
    const accountUserId = (res.user_id ?? res.userId) as string | undefined;
    const authToken = (res.auth_token ?? res.token) as string | undefined;
    if (!userId || !authToken) throw new Error(`login returned no session: ${JSON.stringify(res).slice(0, 200)}`);

    // fa_info.info is non-empty while 2FA is pending; empty once satisfied.
    const faInfo = (res.fa_info ?? {}) as { info?: string };
    const needs2fa = !isVerify && !!faInfo.info;
    if (needs2fa) {
      // Keep the limited token: sendVerifyCode() AND the follow-up verify-login must both be authed
      // with it (captured: attempts 4 & 5 carry this token), so the gateway links the code to this
      // pending 2FA session.
      this.auth_ = { userId, accountUserId, authToken, geoKey: res.geo_key as string | undefined };
      // Captcha (if any) is satisfied once we reach the 2FA step — drop its id so a later retry
      // doesn't resubmit an already-consumed challenge. Mark 2FA outstanding (see login()).
      this.pendingCaptchaId = undefined;
      this.pending2fa = true;
      await this.sendVerifyCode(messageType);
      return { status: LoginStatus.TwoFactor, method: "code sent via app-push/sendmsg/verify_code" };
    }

    this.pendingCaptchaId = undefined;
    this.pending2fa = false;
    this.auth_ = { userId, accountUserId, authToken, geoKey: res.geo_key as string | undefined };
    this.tokenExpiresAt = Number(res.token_expires_at ?? 0) || 0;
    // Re-exchange WITH the auth token so the gateway binds the key-ident to the user.
    this.sessionKey = undefined;
    await this.ensureSessionKey();
    this.persist();
    if (this.rejectedTokenPending) this.noteTokenReplacement();
    return { status: LoginStatus.Ok, session: { userId, authToken, geoKey: this.auth_.geoKey, raw: res } };
  }

  /** Save the current token + session key for reuse across runs. */
  private persist(): void {
    if (!this.auth_ || !this.sessionKey) return;
    this.store.save({
      userId: this.auth_.userId,
      accountUserId: this.auth_.accountUserId ?? this.auth_.userId,
      authToken: this.auth_.authToken,
      geoKey: this.auth_.geoKey,
      region: this.region,
      openudid: this.openudid,
      phoneModel: this.phoneModel,
      mediaUserAgent: this.mediaUserAgent,
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
