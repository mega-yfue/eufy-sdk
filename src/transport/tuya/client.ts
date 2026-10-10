/**
 * {@link TuyaClient} — the foundation glue that ties account derivation, request assembly, signing,
 * and transport into a small typed API: `login()`, `getDeviceDps()`, `publishDps()`.
 *
 * No configuration is required for signing: {@link HmacSigner} uses the built-in app key
 * ({@link TUYA_SIGN_K}) by default. `new TuyaClient({})` is a valid zero-config construction.
 * Pass a `sid` to skip login and read DPs directly with a previously obtained session.
 */
import { randomBytes, createHash, createPublicKey, publicEncrypt, constants } from "node:crypto";
import { deriveTuyaAccount, type TuyaAccount } from "./account.js";
import { TUYA_CHKEY, HmacSigner, type TuyaSigner } from "./sign.js";
import { deriveBodyKey, decryptReply, verifyReplySign } from "./et3.js";
import {
  buildApiParams,
  buildGetDeviceDpsAction,
  buildPasswordLoginRegAction,
  buildPublishDpsAction,
  buildUsernameTokenGetAction,
  sendApiRequest,
  DEFAULT_TUYA_ENV,
  type TuyaAction,
  type TuyaEnv,
  type TuyaEnvelope,
  type TuyaSession,
  type TuyaHttpPost,
} from "./request.js";

/** Result of a successful {@link TuyaClient.login}. */
export interface TuyaLoginResult {
  sid: string;
  /** Tuya user id (`uid`) from the login response. */
  uid: string;
}

export interface TuyaClientConfig {
  /**
   * The native sign seam. Defaults to {@link HmacSigner} with the built-in app key — no config
   * needed. Override only for tests (pass a {@link StubSigner} or custom impl).
   */
  signer?: TuyaSigner;
  /**
   * Channel key — defaults to {@link TUYA_CHKEY} (`"7cbfe6d8"`), the constant extracted from
   * the eufy Security/Mega app. Override only for non-standard builds.
   */
  chKey?: string;
  /** Per-install device id; a random 44-hex one is generated if omitted (see {@link genDeviceId}). */
  deviceId?: string;
  /** Restore a prior session id (skip login). */
  sid?: string;
  /** Override the environment/static fields (see {@link TuyaEnv}). */
  env?: TuyaEnv;
  /** api.json endpoint override (region shard). */
  endpoint?: string;
  /** Inject a POST transport (test stub); default = native fetch. */
  http?: TuyaHttpPost;
}

/**
 * Generate a per-install `deviceId` (44 hex chars). The app derives it deterministically per
 * install from device fingerprints, but the scheme is not reversed — we mint a random id instead.
 * TODO(scheme): replace with the app's real derivation once known.
 */
export function genDeviceId(): string {
  return randomBytes(22).toString("hex"); // 22 bytes → 44 hex chars
}

/**
 * RSA-PKCS1-encrypt a Tuya login password using the server-supplied key parameters.
 * Wire-confirmed: RSA/ECB/PKCS1Padding, modulus + exponent as decimal strings.
 * Returns the hex-encoded ciphertext (the `passwd` field in the login.reg request).
 */
function rsaEncryptPassword(password: string, publicKeyDecimal: string, exponentDecimal: string): string {
  const bigintToBuffer = (n: bigint): Buffer => {
    const hex = n.toString(16);
    return Buffer.from(hex.length % 2 === 0 ? hex : "0" + hex, "hex");
  };
  const rsaKey = createPublicKey({
    key: {
      kty: "RSA",
      n: bigintToBuffer(BigInt(publicKeyDecimal)).toString("base64url"),
      e: bigintToBuffer(BigInt(exponentDecimal)).toString("base64url"),
    },
    format: "jwk",
  });
  const md5Hex = createHash("md5").update(password).digest("hex");
  return publicEncrypt({ key: rsaKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(md5Hex)).toString("hex");
}

export class TuyaClient {
  private readonly signer: TuyaSigner;
  private readonly env: TuyaEnv;
  private readonly endpoint?: string;
  private readonly http?: TuyaHttpPost;
  private session: TuyaSession;

  constructor(config: TuyaClientConfig = {}) {
    this.signer = config.signer ?? new HmacSigner();
    this.env = config.env ?? DEFAULT_TUYA_ENV;
    this.endpoint = config.endpoint;
    this.http = config.http;
    this.session = {
      sid: config.sid ?? "",
      deviceId: config.deviceId ?? genDeviceId(),
      chKey: config.chKey ?? TUYA_CHKEY,
    };
  }

  /** The current per-install session identity (sid empty until {@link login}). */
  getSession(): Readonly<TuyaSession> {
    return this.session;
  }

  /** True once a login has populated a session id. */
  get loggedIn(): boolean {
    return this.session.sid !== "";
  }

  /**
   * Build the full signed param map for an action against the current session. Does not send.
   * Requires a working signer (the sign step).
   */
  buildRequest(action: TuyaAction): Record<string, string> {
    return buildApiParams(action, { session: this.session, signer: this.signer, env: this.env });
  }

  /**
   * Build + POST an action, returning the parsed envelope. Requires a working signer.
   *
   * On an `et=3` reply the envelope's `result` is a base64 AES-128-GCM blob, not an object; this
   * decrypts it (keyed off the request's `requestId` and the session's `ecode`) and returns the
   * decrypted inner envelope, so callers read `result` as an object regardless. A non-string `result`
   * (an error, or an already-plain reply) passes through untouched. See `et3.ts`.
   */
  async call<T = unknown>(action: TuyaAction): Promise<TuyaEnvelope<T>> {
    const params = this.buildRequest(action);
    const env = await sendApiRequest<unknown>(params, { endpoint: this.endpoint, http: this.http });
    return this.decodeReply<T>(env, params.requestId);
  }

  /**
   * Decode an et=3 reply in place. When `result` is a non-empty string it is the encrypted blob:
   * verify the reply sign (when present), decrypt, and parse. The plaintext is itself a standard
   * `{success, t, result}` envelope, which becomes the returned envelope; anything else is wrapped
   * so `result` carries the decoded payload.
   */
  private decodeReply<T>(env: TuyaEnvelope<unknown>, requestId: string): TuyaEnvelope<T> {
    if (typeof env.result !== "string" || env.result === "") return env as TuyaEnvelope<T>;
    const key = deriveBodyKey(requestId, this.session.ecode ?? null);
    if (
      typeof env.sign === "string" &&
      env.t !== undefined &&
      !verifyReplySign(key, env.result, String(env.t), env.sign)
    ) {
      throw new Error("tuya et=3 reply sign mismatch — wrong body key (check ecode) or tampered reply");
    }
    const inner = JSON.parse(decryptReply(key, env.result)) as unknown;
    if (inner !== null && typeof inner === "object" && ("result" in inner || "success" in inner)) {
      return inner as TuyaEnvelope<T>;
    }
    return { ...env, result: inner as T };
  }

  /**
   * Log into the Tuya cloud from a eufy user id (wire-confirmed from the eufy Security app).
   *
   * Flow:
   *  1. `smartlife.m.user.username.token.get` → `{ token, publicKey, exponent }` (RSA-2048 key).
   *     If this returns USER_NOT_EXIST the shadow account has never been provisioned — the vacuum
   *     must be added via the eufy Security app (`com.oceanwing.battery.cam`) at least once.
   *  2. Derive password: RSA/PKCS1-encrypt( MD5hex(aesPassword), serverKey ) → hex.
   *  3. `smartlife.m.user.uid.password.login.reg` → `{ sid, uid }`.
   *     On USER_PASSWD_WRONG: re-fetch a token and retry once with the hardcoded fallback
   *     password `"12345678"` (wire-confirmed from the eufy Security app).
   *     ⚠️ Two failed attempts in a row can contribute to Tuya-side rate-limiting or lockout — do not
   *     add further retry loops on top of this one.
   */
  async login(eufyUserId: string, phoneCode?: string): Promise<TuyaLoginResult> {
    const account: TuyaAccount = deriveTuyaAccount(eufyUserId, phoneCode);

    const attempt = async (password: string): Promise<(TuyaLoginResult & { ecode?: string }) | "PASSWD_WRONG"> => {
      const tokenRes = await this.call<{ token?: string; publicKey?: string; exponent?: string }>(
        buildUsernameTokenGetAction(account.countryCode, account.username),
      );
      if (!tokenRes.success || !tokenRes.result?.token) {
        const code = tokenRes.errorCode ?? tokenRes.errorMsg ?? "unknown";
        if (code === "USER_NOT_EXIST") {
          throw new Error(
            "Tuya shadow account not provisioned (USER_NOT_EXIST). Open the eufy Security app " +
              "(com.oceanwing.battery.cam), add the vacuum, then retry.",
          );
        }
        throw new Error(`tuya username.token.get failed: ${code}`);
      }
      const { token, publicKey, exponent } = tokenRes.result;
      if (!publicKey || !exponent) throw new Error("tuya token.get: missing publicKey/exponent");

      const encPasswd = rsaEncryptPassword(password, publicKey, exponent);
      const loginRes = await this.call<{ sid?: string; uid?: string; ecode?: string }>(
        buildPasswordLoginRegAction(account.countryCode, account.username, encPasswd, token),
      );
      if (loginRes.success && loginRes.result?.sid && loginRes.result?.uid) {
        return { sid: loginRes.result.sid, uid: loginRes.result.uid, ecode: loginRes.result.ecode };
      }
      if ((loginRes.errorCode ?? loginRes.errorMsg) === "USER_PASSWD_WRONG") return "PASSWD_WRONG";
      throw new Error(`tuya password.login.reg failed: ${loginRes.errorMsg ?? loginRes.errorCode ?? "no sid/uid"}`);
    };

    let result = await attempt(account.password);
    if (result === "PASSWD_WRONG") result = await attempt("12345678");
    if (result === "PASSWD_WRONG") {
      throw new Error("tuya login: USER_PASSWD_WRONG on both derived password and fallback '12345678'");
    }

    this.session = { ...this.session, sid: result.sid, ecode: result.ecode };
    return { sid: result.sid, uid: result.uid };
  }

  /**
   * READ/dump a device's cached data-points (`thing.m.device.cache.dp.get`).
   * Builds the request without needing a working signer; the signer is only exercised on send.
   */
  async getDeviceDps<T = unknown>(devId: string, dpCacheType?: number): Promise<TuyaEnvelope<T>> {
    return this.call<T>(buildGetDeviceDpsAction(devId, dpCacheType));
  }

  /**
   * CONTROL: publish data-points to a device (`thing.m.device.dp.publish`). `dps` is
   * `{ "<dpId>": <value> }`. `gwId` is the gateway/parent id (equals `devId` for a standalone gw).
   *
   * ⚠️ UNVERIFIED write — refuses to send by default. The `dp.publish` param shape
   * ({@link buildPublishDpsAction}) is derived, NOT pinned against a confirmed exchange,
   * and the login round-trip that yields a real `sid` is unproven too. A wrong shape comes back as a
   * generic Tuya error indistinguishable from a real device rejection, so blindly sending would hide
   * that ambiguity. Pass `{ allowUnverified: true }` to send anyway; the gate drops when the write is
   * captured + confirmed against a device.
   */
  async publishDps<T = unknown>(
    devId: string,
    gwId: string,
    dps: Record<string, unknown>,
    opts: { allowUnverified?: boolean } = {},
  ): Promise<TuyaEnvelope<T>> {
    if (!opts.allowUnverified) {
      throw new Error(
        "tuya publishDps is UNVERIFIED: the dp.publish request shape is reversed-not-captured and the " +
          "login→sid round-trip is unproven, so a Tuya error cannot be told apart from a real device " +
          "rejection. Pass { allowUnverified: true } to send anyway.",
      );
    }
    return this.call<T>(buildPublishDpsAction(devId, gwId, dps));
  }
}
