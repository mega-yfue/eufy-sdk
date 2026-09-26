/**
 * The parts of Anker's `algo_ecdh` passport that the eufy and Solix clients share byte for byte: the
 * credential block of a `/passport/login` body, the reading of its reply, and the headers that sign an
 * encrypted request. Everything around them (hosts, header sets, key caching, 2FA delivery, which id
 * `gtoken` hashes) differs per app line and stays in each client.
 */
import { encryptLoginPassword, genId, nowSec, signRequest, type SessionEntry } from "../../core/index.js";

/** The credential fields every `/passport/login` body starts with; each client adds its own challenge fields. */
export function loginCredentials(email: string, password: string, country: string): Record<string, unknown> {
  const { clientPublicKeyHex, encryptedPassword } = encryptLoginPassword(password);
  return { email, password: encryptedPassword, ab: country, client_secret_info: { public_key: clientPublicKeyHex } };
}

/** What a decrypted `/passport/login` reply establishes. */
export interface PassportLogin {
  /** `ap_cloud_user_id` where the reply carries one, else the account's `user_id`. */
  userId: string;
  /** The account's own `user_id`. */
  accountUserId?: string;
  authToken: string;
  geoKey?: string;
  /** Unix seconds; 0 when the reply carries none. */
  tokenExpiresAt: number;
  /** The passport still wants a 2FA code: `fa_info.info` is non-empty, and it empties once satisfied. */
  twoFactorPending: boolean;
}

/** Read a decrypted `/passport/login` reply; `undefined` when it carries no id or no token. */
export function readLoginReply(data: Record<string, unknown>): PassportLogin | undefined {
  const userId = (data.ap_cloud_user_id ?? data.user_id ?? data.userId) as string | undefined;
  const authToken = (data.auth_token ?? data.token) as string | undefined;
  if (!userId || !authToken) return undefined;
  return {
    userId,
    accountUserId: (data.user_id ?? data.userId) as string | undefined,
    authToken,
    geoKey: data.geo_key as string | undefined,
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
