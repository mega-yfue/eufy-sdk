/**
 * The `algo_ecdh` passport steps the eufy and Solix clients share byte for byte. Hosts, header sets, key
 * caching, 2FA delivery and the `gtoken` id differ per app line and stay in each client.
 */
import { encryptLoginPassword, genId, nowSec, signRequest, type SessionEntry } from "../../core/index.js";

/** The credential fields every `/passport/login` body starts with; each client adds its own challenge fields. */
export function loginCredentials(email: string, password: string, country: string): Record<string, unknown> {
  const { clientPublicKeyHex, encryptedPassword } = encryptLoginPassword(password);
  return { email, password: encryptedPassword, ab: country, client_secret_info: { public_key: clientPublicKeyHex } };
}

/**
 * Read a decrypted `/passport/login` reply; `undefined` when it carries no id or no token. `twoFactorPending`
 * is true while `fa_info.info` is non-empty and false once 2FA is satisfied.
 */
export function readLoginReply(data: Record<string, unknown>) {
  const userId = (data.ap_cloud_user_id ?? data.user_id ?? data.userId) as string | undefined;
  const authToken = (data.auth_token ?? data.token) as string | undefined;
  if (!userId || !authToken) return undefined;
  return {
    userId,
    accountUserId: (data.user_id ?? data.userId) as string | undefined,
    authToken,
    geoKey: data.geo_key as string | undefined,
    /** The account's `nick_name`, the name the app writes into the commands it attributes to the user. */
    nickName: typeof data.nick_name === "string" ? data.nick_name : undefined,
    tokenExpiresAt: Number(data.token_expires_at ?? 0) || 0,
    twoFactorPending: !!((data.fa_info ?? {}) as { info?: string }).info,
  };
}

/** The headers that mark `encBody` as `algo_ecdh`-encrypted under `entry` and sign it. */
export function signedHeaders(entry: SessionEntry, encBody: string): Record<string, string> {
  const ts = nowSec();
  const once = genId();
  return {
    "x-encryption-info": "algo_ecdh",
    "x-key-ident": entry.keyIdent,
    "x-request-ts": ts,
    "x-request-once": once,
    "x-signature": signRequest(entry.shareKey, ts, once, encBody),
  };
}
