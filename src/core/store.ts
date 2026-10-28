/**
 * Session persistence — so we log in (and clear 2FA) ONCE, then reuse the token
 * + ECDH key across runs, exactly like the app reuses its cached EcdhKey.
 *
 * Persisted: the auth token + user, the region shard, the device openudid, and
 * the negotiated ECDH key (shareKey + key-ident). On the next run we hydrate all
 * of it and go straight to data calls — no estimate_domain, no key/exchange, no
 * login, no 2FA — until the token expires (or a call 401s, which clears it).
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RegionShard } from "../transport/http/mega-client.js";

/**
 * The persisted session record. Internal shape — a host supplies a `SessionStore`, never builds this.
 * @internal
 */
export interface PersistedSession {
  userId: string;
  /**
   * The eufy account's own `user_id` — the id the `gtoken` header is hashed from, which is not always the
   * `ap_cloud_user_id` that `userId` prefers.
   *
   * Always written, equal to `userId` when the login reply carried only the one id. Absent therefore means a
   * record from before this was tracked, which {@link isSessionValid} refuses rather than restore.
   */
  accountUserId?: string;
  authToken: string;
  geoKey?: string;
  region: RegionShard;
  /** The `countryCode` the session was logged in with; a different configured one logs in again. */
  countryCode?: string;
  /** The host `estimate_domain` answered; it names shards the region classification cannot (`ie`). */
  estimatedDomain?: string;
  openudid: string;
  /** This install's reported device model + media user-agent, generated once and reused. */
  phoneModel?: string;
  mediaUserAgent?: string;
  /** ECDH session: shareKey hex (32 chars) + the bound key-ident. */
  shareKey: string;
  keyIdent: string;
  /** Unix seconds when the auth token expires (0 = unknown). */
  tokenExpiresAt: number;
  savedAt: number;
}

/**
 * A place to persist a session record across runs. Parameterised on the record shape so other Anker
 * lines (e.g. Solix, whose record is not a `PersistedSession`) can reuse the same file/memory
 * stores rather than re-implementing them. Defaults to `PersistedSession` for the eufy path.
 */
export interface SessionStore<T = PersistedSession> {
  load(): T | null;
  save(s: T): void;
  clear(): void;
}

/** In-memory store (no persistence) — the default. */
export class MemorySessionStore<T = PersistedSession> implements SessionStore<T> {
  private s: T | null = null;
  load(): T | null {
    return this.s;
  }
  save(s: T): void {
    this.s = s;
  }
  clear(): void {
    this.s = null;
  }
}

/** Errors from creating or renaming the temp file that mean the directory, not the file, refuses the write. */
const IN_PLACE_CODES = new Set(["EACCES", "EPERM", "EBUSY", "EXDEV", "EROFS"]);

/** The real file behind `path`, following symlinks; `path` itself when it does not exist yet. */
function realTarget(path: string): string {
  try {
    return realpathSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw e;
  }
}

/**
 * JSON-file store, e.g. new FileSessionStore("./.eufy-session.json").
 *
 * `save` resolves a symlinked path to its real file, writes a fresh owner-only (`0o600`) temp file under a
 * random name beside that file and renames it over it, so where the directory allows it the file on disk
 * is always a complete record — the old one until the rename, the new one after — and the symlink itself
 * stays in place. When the directory refuses the temp file or the rename (`EACCES`, `EPERM`, `EBUSY`,
 * `EXDEV`, `EROFS`: a read-only directory around a writable file, a single-file bind mount), `save`
 * rewrites the file in place instead, which is not atomic, and tightens it to mode `0o600` when the
 * process may change its mode, leaving the mode as it was otherwise. The atomic path always leaves
 * `0o600`, whatever mode an existing file had. Any other failure removes the temp file and throws.
 */
export class FileSessionStore<T = PersistedSession> implements SessionStore<T> {
  constructor(private readonly path: string) {}
  load(): T | null {
    try {
      return JSON.parse(readFileSync(this.path, "utf-8")) as T;
    } catch {
      return null;
    }
  }
  save(s: T): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
    } catch {
      /* dir exists */
    }
    const target = realTarget(this.path);
    const data = JSON.stringify(s, null, 2);
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
      renameSync(tmp, target);
    } catch (e) {
      rmSync(tmp, { force: true });
      if (!IN_PLACE_CODES.has((e as NodeJS.ErrnoException).code ?? "")) throw e;
      writeFileSync(target, data, { mode: 0o600 });
      try {
        chmodSync(target, 0o600);
      } catch {
        /* not the file's owner */
      }
    }
  }
  clear(): void {
    try {
      rmSync(this.path);
    } catch {
      /* already gone */
    }
  }
}

/**
 * A token is still usable if it has no known expiry, or expires more than `skewSec` from now. The one
 * place the expiry/skew rule lives — reused by {@link isSessionValid} and by other lines' session checks
 * (e.g. Solix) whose session shape differs but whose freshness rule is identical.
 */
export function tokenNotExpired(tokenExpiresAt: number | undefined, skewSec = 300): boolean {
  if (tokenExpiresAt && tokenExpiresAt > 0) {
    return Math.floor(Date.now() / 1000) < tokenExpiresAt - skewSec;
  }
  return true;
}

/**
 * A persisted session is usable if it carries a complete credential — token, bound ECDH key, and the account
 * id the `gtoken` header is hashed from — whose token isn't (near-)expired.
 *
 * `accountUserId` is part of the credential, not an optional extra: a record without it was written before
 * that id was tracked, so it can only be restored as the other id, which is what the gateway rejects the
 * header on. Nothing in a restored session can recover it either — the id arrives with a login reply. So such
 * a record is refused and one login re-establishes it, rather than reinstating a session whose every
 * authenticated call fails identically.
 */
export function isSessionValid(s: PersistedSession | null, skewSec = 300): boolean {
  if (!s?.authToken || !s.shareKey || !s.keyIdent || !s.accountUserId) return false;
  return tokenNotExpired(s.tokenExpiresAt, skewSec);
}
