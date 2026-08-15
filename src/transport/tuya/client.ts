/**
 * {@link TuyaClient} — the foundation glue that ties account derivation, request assembly, signing,
 * and transport into a small typed API: `login()`, `getDeviceDps()`, `publishDps()`.
 *
 * FOUNDATION status: request assembly, the `sign` (✅ cracked — {@link HmacSigner} reproduces a live
 * capture), `chKey` (✅ solved per-appId constant `"7cbfe6d8"`), and the full LOGIN round-trip are all
 * wired. `login()` does `token.get` → RSA-encrypt password (from the server key in the response) →
 * `password.login.reg` → sid (reversed from `dqdbbqp.java` in the ThingClips SDK).
 */
import { randomBytes, createHash, createPublicKey, publicEncrypt, constants } from "node:crypto";
import { deriveTuyaAccount, type TuyaAccount } from "./account.js";
import { type TuyaSigner } from "./sign.js";
import {
  buildApiParams,
  buildGetDeviceDpsAction,
  buildPasswordLoginAction,
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
  /** The native sign seam. Required for any real call; use a fake in tests. */
  signer: TuyaSigner;
  /**
   * 8-hex `chKey`. ✅ SOLVED (see {@link TuyaSession.chKey}): a pure function of the appId only, so a
   * per-appId CONSTANT — `"7cbfe6d8"` for this build. Pass that literal.
   */
  chKey: string;
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

/** Convert a positive BigInt to a minimal big-endian Buffer (no leading zero byte). */
function bigintToBuffer(n: bigint): Buffer {
  const hex = n.toString(16);
  return Buffer.from(hex.length % 2 === 0 ? hex : "0" + hex, "hex");
}

/**
 * Encrypt the Tuya login password per ThingClips SDK `dqdbbqp.java`:
 *   MD5(password) → lowercase hex → RSA/NONE/PKCS1Padding encrypt → hex-encode.
 * The RSA public key is built from the decimal-string modulus and exponent that
 * `smartlife.m.user.username.token.get` returns in the `publicKey` and `exponent` fields
 * (Java `RSAUtil.generateRSAPublicKey("", pubKey + "\n" + exp)` with two `new BigInteger(line)` reads).
 */
function encryptTuyaPassword(password: string, publicKeyDecimal: string, exponentDecimal: string): string {
  const md5Hex = createHash("md5").update(password).digest("hex");
  const rsaKey = createPublicKey({
    key: {
      kty: "RSA",
      n: bigintToBuffer(BigInt(publicKeyDecimal)).toString("base64url"),
      e: bigintToBuffer(BigInt(exponentDecimal)).toString("base64url"),
    },
    format: "jwk",
  });
  return publicEncrypt({ key: rsaKey, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(md5Hex)).toString("hex");
}

/**
 * Generate a per-install `deviceId`. The capture shows a 44-hex-char id
 * (`7932c5202387dffd14f2e2d75e0fbb8efa1cf7f28be5`); the app derives it deterministically per
 * install, but the scheme is not reversed, so we mint a random 44-hex id and keep it stable for the
 * client's lifetime.
 * TODO(scheme): replace with the app's real derivation once known.
 */
export function genDeviceId(): string {
  return randomBytes(22).toString("hex"); // 22 bytes → 44 hex chars
}

export class TuyaClient {
  private readonly signer: TuyaSigner;
  private readonly env: TuyaEnv;
  private readonly endpoint?: string;
  private readonly http?: TuyaHttpPost;
  private session: TuyaSession;

  constructor(config: TuyaClientConfig) {
    this.signer = config.signer;
    this.env = config.env ?? DEFAULT_TUYA_ENV;
    this.endpoint = config.endpoint;
    this.http = config.http;
    this.session = {
      sid: config.sid ?? "",
      deviceId: config.deviceId ?? genDeviceId(),
      chKey: config.chKey,
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
   * Useful for inspection/tooling; requires a working signer (the sign step).
   */
  buildRequest(action: TuyaAction): Record<string, string> {
    return buildApiParams(action, { session: this.session, signer: this.signer, env: this.env });
  }

  /** Build + POST an action, returning the parsed envelope. Requires a working signer. */
  async call<T = unknown>(action: TuyaAction): Promise<TuyaEnvelope<T>> {
    return sendApiRequest<T>(this.buildRequest(action), { endpoint: this.endpoint, http: this.http });
  }

  /**
   * Log into the Tuya cloud from a eufy user id:
   *   1. Derive the Tuya account ({@link deriveTuyaAccount}).
   *   2. `smartlife.m.user.username.token.get` v=2.0 — confirmed from `pqdbppq.java`, ThingClips SDK 7.5.0.
   *   3. Encrypt the derived password (MD5 → RSA) with the server's RSA public key from the token.
   *   4. `smartlife.m.user.uid.password.login.reg` — login and receive `sid` + `uid`.
   *   5. On `USER_PASSWD_WRONG`, retry once with hardcoded `"12345678"` — confirmed from
   *      `TuyaUserManager.loginOrRegisterWithUid$lambda$1` + `retryWithDefaultPassword()` in the
   *      eufy Security APK (`com.oceanwing.battery.cam`). Accounts first provisioned before the AES
   *      derivation was wired have `"12345678"` stored as their Tuya password.
   * On success the session id is stored and returned with the Tuya uid.
   */
  async login(eufyUserId: string, phoneCode?: string): Promise<TuyaLoginResult> {
    const account: TuyaAccount = deriveTuyaAccount(eufyUserId, phoneCode);

    const tokenRes = await this.call<{ token?: string; publicKey?: string; exponent?: string }>(
      buildUsernameTokenGetAction(account.countryCode, account.username),
    );
    if (!tokenRes.success) {
      throw new Error(`tuya username.token.get failed: ${tokenRes.errorMsg ?? tokenRes.errorCode ?? "server error"}`);
    }
    const { token, publicKey, exponent } = tokenRes.result ?? {};
    if (!token || !publicKey || !exponent) {
      throw new Error(
        `tuya token.create: unexpected result shape (token=${!!token} publicKey=${!!publicKey} exponent=${!!exponent})`,
      );
    }

    const encryptedPasswd = encryptTuyaPassword(account.password, publicKey, exponent);
    const loginRes = await this.call<{ sid?: string; uid?: string }>(
      buildPasswordLoginAction(account.countryCode, account.username, encryptedPasswd, token),
    );

    if (loginRes.result?.sid && loginRes.result?.uid) {
      this.session = { ...this.session, sid: loginRes.result.sid };
      return { sid: loginRes.result.sid, uid: loginRes.result.uid };
    }

    // AES-derived password rejected — retry with hardcoded "12345678" per
    // TuyaUserManager.retryWithDefaultPassword() in the eufy Security APK.
    const isPasswdWrong = loginRes.errorCode === "USER_PASSWD_WRONG";
    if (isPasswdWrong) {
      const fallbackTokenRes = await this.call<{ token?: string; publicKey?: string; exponent?: string }>(
        buildUsernameTokenGetAction(account.countryCode, account.username),
      );
      if (
        fallbackTokenRes.success &&
        fallbackTokenRes.result?.token &&
        fallbackTokenRes.result?.publicKey &&
        fallbackTokenRes.result?.exponent
      ) {
        const { token: fToken, publicKey: fPubKey, exponent: fExp } = fallbackTokenRes.result;
        const fallbackEncPasswd = encryptTuyaPassword("12345678", fPubKey, fExp);
        const fallbackRes = await this.call<{ sid?: string; uid?: string }>(
          buildPasswordLoginAction(account.countryCode, account.username, fallbackEncPasswd, fToken),
        );
        if (fallbackRes.result?.sid && fallbackRes.result?.uid) {
          this.session = { ...this.session, sid: fallbackRes.result.sid };
          return { sid: fallbackRes.result.sid, uid: fallbackRes.result.uid };
        }
        throw new Error(
          `tuya password.login failed: ${fallbackRes.errorMsg ?? fallbackRes.errorCode ?? "no sid/uid in result"}`,
        );
      }
    }

    throw new Error(`tuya password.login failed: ${loginRes.errorMsg ?? loginRes.errorCode ?? "no sid/uid in result"}`);
  }

  /**
   * READ/dump a device's cached data-points (`smartlife.m.device.cache.dp.get`).
   * Builds the request without needing a working signer; the signer is only exercised on send.
   */
  async getDeviceDps<T = unknown>(devId: string, dpCacheType?: number): Promise<TuyaEnvelope<T>> {
    return this.call<T>(buildGetDeviceDpsAction(devId, dpCacheType));
  }

  /**
   * CONTROL: publish data-points to a device (`smartlife.m.device.dp.publish`). `dps` is
   * `{ "<dpId>": <value> }`. `gwId` is the gateway/parent id (equals `devId` for a standalone gw).
   *
   * ⚠️ UNVERIFIED write — refuses to send by default. The `dp.publish` param shape
   * ({@link buildPublishDpsAction}) was reversed from the decompile, NOT pinned from a live capture,
   * and the login round-trip that yields a real `sid` is unproven too. A wrong shape comes back as a
   * generic Tuya error indistinguishable from a real device rejection, so blindly sending would hide
   * that ambiguity. Pass `{ allowUnverified: true }` to opt in once you accept it; drop the gate when
   * the write is captured + confirmed against a device.
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
