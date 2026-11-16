/**
 * Eufy "mega" (Anker AIoT) cloud crypto — algo_ecdh.
 *
 * The full request scheme, reverse-engineered from the app. Three layers:
 *
 *  A. Key exchange (bootstrap, per region):
 *       client_public_key = base64( IV(16) || AES-128-CBC(pubkeyHex, localKey) )
 *       signed with HMAC-SHA256(localKey-hex-utf8, `${ts}+${once}+${encPubKey}`),
 *       sending a client-generated X-Key-Ident. The server replies with its
 *       public key, AES-CBC-encrypted the same way; ECDH(P-256) → shareKey
 *       (first 32 hex chars of the shared secret).
 *
 *  B. Per-request body: base64( IV(16) || AES-128-CBC-PKCS7(plaintext) ),
 *       key = shareKey[:16 bytes]. Response `data` decrypts the same way.
 *
 *  C. x-signature = HMAC-SHA256( shareKey-hex-utf8,
 *                               [ts, once, encBody?].join("+") )  (hex).
 *
 * Layers B and C are verified byte-exact against a captured request
 * (src/__tests__/crypto.spec.ts).
 */
import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  randomBytes,
  type ECDH,
} from "node:crypto";

export const P256 = "prime256v1";

/**
 * The eufy_mega app localKey — a single AES-128 key (hex) used to bootstrap the
 * ECDH key exchange across the whole mega host stack (openapi + passport + app-*).
 * Extracted from the iOS Mega app bundle.
 */
export const EUFY_MEGA_LOCAL_KEY_HEX = "2500a7d5617812f9d52515b2c8f20a3d";

/**
 * The **eufylife** data-host localKey — a SEPARATE AES-128 bootstrap key for the
 * `security-app-{shard}.eufylife.com` gateway (faces, get_ciphers, commerce, geofence).
 * That host runs its own ECDH key exchange at `/v3/openapi/oauth/key/exchange` and rejects
 * the mega localKey. Identified by HMAC-matching a captured eufylife key-exchange signature.
 */
export const EUFYLIFE_LOCAL_KEY_HEX = "118c12c81e211149304bd70a0c071d01";

/**
 * The **Anker Solix** passport localKey — the AES-128 bootstrap key for the `anker_power` app-line
 * (power stations / smart meter). Solix runs the SAME `algo_ecdh` passport as the eufy_mega stack,
 * re-skinned under a different `app-name` + API host, so the login key-exchange wraps the ephemeral
 * client public key with this key; distinct from {@link EUFY_MEGA_LOCAL_KEY_HEX}. Authenticated Solix
 * reads carry only the token + `gtoken` (no per-request encryption).
 */
export const SOLIX_LOCAL_KEY_HEX = "e8ad18f61bbd3fbd52d5ed12d14d3b9c";

/**
 * Hardcoded server P-256 public key (uncompressed 0x04||X||Y) used to encrypt
 * the LOGIN password via a one-shot ECDH (separate from the per-session key).
 */
export const SERVER_STATIC_PUBLIC_KEY_HEX =
  "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";

/* ---- small helpers ------------------------------------------------ */

/** 32-hex random id (uuid-without-dashes), for X-Key-Ident / X-Request-Once. */
export function genId(): string {
  return randomBytes(16).toString("hex");
}

/** Unix seconds as a string (X-Request-Ts). */
export function nowSec(): string {
  return Math.floor(Date.now() / 1000).toString();
}

/** md5 hex digest — the one place this derivation lives (gtoken, openudid seeds, …). */
export function md5Hex(input: string): string {
  return createHash("md5").update(input, "utf-8").digest("hex");
}

/** gtoken header = md5(user_id) hex. */
export function gtoken(userId: string): string {
  return md5Hex(userId);
}

/* ---- (B) body encryption + (C) signing — VERIFIED ----------------- */

/** 16-byte AES key = first half of the shared secret hex (shareKey[:16 bytes]). */
export function aesKey(shareKeyHex: string): Buffer {
  return Buffer.from(shareKeyHex, "hex").subarray(0, 16);
}

/** HMAC sign key = the shareKey hex string itself, as UTF-8 bytes. */
export function signKey(shareKeyHex: string): Buffer {
  return Buffer.from(shareKeyHex.slice(0, 32), "utf-8");
}

/** Encrypt a body: base64( IV(16) || AES-128-CBC-PKCS7(plaintext) ). */
export function encryptBody(plaintext: string | Buffer, shareKeyHex: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", aesKey(shareKeyHex), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext as never)), cipher.final()]);
  return Buffer.concat([iv, ct]).toString("base64");
}

/** Decrypt a base64( IV(16) || AES-128-CBC-PKCS7 ) body. */
export function decryptBody(b64: string, shareKeyHex: string): Buffer {
  const raw = Buffer.from(b64, "base64");
  const decipher = createDecipheriv("aes-128-cbc", aesKey(shareKeyHex), raw.subarray(0, 16));
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]);
}

/**
 * x-signature = HMAC-SHA256(signKey(shareKey), [ts, once, encBody?].join("+")).
 * `encBody` is the ENCRYPTED body actually sent; omit for empty-body requests.
 */
export function signRequest(shareKeyHex: string, ts: string, once: string, encBodyB64?: string): string {
  const parts = [ts, once];
  if (encBodyB64) parts.push(encBodyB64);
  return createHmac("sha256", signKey(shareKeyHex)).update(parts.join("+"), "utf-8").digest("hex");
}

/* ---- (A) key exchange --------------------------------------------- */

/** A negotiated session: shareKey + the X-Key-Ident the client minted for it. */
export interface SessionEntry {
  keyIdent: string;
  shareKey: string;
  clientPublicKeyHex: string;
  clientPrivateKeyHex: string;
  createdAt: number;
}

export interface KeyExchangePrep {
  ecdh: ECDH;
  localKey: Buffer;
  keyIdent: string;
  /** base64 body to POST as { client_public_key }. */
  encryptedClientPublicKey: string;
  /** algo_ecdh headers for the key-exchange POST. */
  headers: Record<string, string>;
  clientPublicKeyHex: string;
}

/**
 * Build a key-exchange request: an ephemeral P-256 keypair whose public hex is
 * AES-128-CBC(localKey)-encrypted, signed with the localKey-hex as UTF-8.
 */
export function prepareKeyExchange(localKeyHex: string = EUFY_MEGA_LOCAL_KEY_HEX): KeyExchangePrep {
  const localKey = Buffer.from(localKeyHex, "hex");
  const ecdh = createECDH(P256);
  ecdh.generateKeys();
  const clientPublicKeyHex = ecdh.getPublicKey("hex", "uncompressed");

  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", localKey, iv);
  const ct = Buffer.concat([cipher.update(clientPublicKeyHex, "utf-8"), cipher.final()]);
  const encryptedClientPublicKey = Buffer.concat([iv, ct]).toString("base64");

  const ts = nowSec();
  const once = genId();
  const keyIdent = genId();
  const sig = createHmac("sha256", Buffer.from(localKeyHex, "utf-8"))
    .update(`${ts}+${once}+${encryptedClientPublicKey}`, "utf-8")
    .digest("hex");

  return {
    ecdh,
    localKey,
    keyIdent,
    encryptedClientPublicKey,
    clientPublicKeyHex,
    headers: {
      "x-encryption-info": "algo_ecdh",
      "x-replay-info": "replay",
      "x-key-ident": keyIdent,
      "x-request-ts": ts,
      "x-request-once": once,
      "x-signature": sig,
    },
  };
}

/**
 * Finish the exchange: decrypt the server's AES-CBC-wrapped public key with the
 * localKey, ECDH-derive, and take the first 32 hex chars as the shareKey.
 */
export function finishKeyExchange(prep: KeyExchangePrep, serverPublicKeyB64: string): SessionEntry {
  const blob = Buffer.from(serverPublicKeyB64, "base64");
  const decipher = createDecipheriv("aes-128-cbc", prep.localKey, blob.subarray(0, 16));
  const serverPubHex = Buffer.concat([decipher.update(blob.subarray(16)), decipher.final()]).toString("utf-8");
  const shared = prep.ecdh.computeSecret(Buffer.from(serverPubHex, "hex"));
  const shareKey = shared.toString("hex").padStart(64, "0").slice(0, 32);
  return {
    keyIdent: prep.keyIdent,
    shareKey,
    clientPublicKeyHex: prep.clientPublicKeyHex,
    clientPrivateKeyHex: prep.ecdh.getPrivateKey("hex"),
    createdAt: Date.now(),
  };
}

/* ---- login password (one-shot ECDH vs static server key) ---------- */

/**
 * Encrypt the login password against the hardcoded server static public key.
 * AES-256-CBC, key = full 32-byte ECDH secret, IV = its first 16 bytes.
 * Returns the client pubkey hex (for client_secret_info.public_key) + b64 ct.
 */
export function encryptLoginPassword(password: string): {
  clientPublicKeyHex: string;
  encryptedPassword: string;
} {
  const ecdh = createECDH(P256);
  ecdh.generateKeys();
  const clientPublicKeyHex = ecdh.getPublicKey("hex", "uncompressed");
  const shared = ecdh.computeSecret(Buffer.from(SERVER_STATIC_PUBLIC_KEY_HEX, "hex"));
  const cipher = createCipheriv("aes-256-cbc", shared, shared.subarray(0, 16));
  const ct = Buffer.concat([cipher.update(password, "utf-8"), cipher.final()]);
  return { clientPublicKeyHex, encryptedPassword: ct.toString("base64") };
}
