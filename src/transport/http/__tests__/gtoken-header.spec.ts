import { describe, expect, it, vi } from "vitest";

import { gtoken } from "../../../core/crypto.js";
import { MemorySessionStore, isSessionValid, type PersistedSession } from "../../../core/store.js";
import { MegaHttpClient } from "../mega-client.js";

/**
 * Which id the `gtoken` header is hashed from.
 *
 * The gateway recomputes the header from the user its token belongs to — the eufy account's `user_id` — and
 * rejects a disagreement with `"gtoken not equal userid error"`. A login reply can carry a second id,
 * `ap_cloud_user_id`, which the client prefers for everything else it does with an account. Where the two
 * differ, hashing the wrong one produces a header no valid token can satisfy.
 *
 * Synthetic ids throughout; no network and no account.
 */
const AP_CLOUD_ID = "ap-cloud-0000000001";
const ACCOUNT_ID = "eufy-account-0000002";
const TOKEN = "synthetic-auth-token";

/** A client with a fixed region whose login reply is `res`, with the key exchange and persistence seams stubbed. */
function clientWithLoginReply(res: Record<string, unknown>, store = new MemorySessionStore()) {
  const mega = new MegaHttpClient({
    email: "synthetic@example.invalid",
    password: "synthetic",
    region: "us-pr",
    store,
  });
  const internals = mega as unknown as {
    postSigned: (host: string, path: string) => Promise<unknown>;
    ensureSessionKey: () => Promise<unknown>;
    sessionKey?: unknown;
    attemptLogin: (body: unknown, messageType: number) => Promise<unknown>;
    authTokenHeaders: () => Record<string, string>;
  };
  internals.postSigned = vi.fn(async () => res);
  internals.ensureSessionKey = vi.fn(async () => {
    internals.sessionKey = { shareKey: "00".repeat(32), keyIdent: "00".repeat(16), createdAt: Date.now() };
    return internals.sessionKey;
  });
  return { mega, internals, store };
}

const okReply = (extra: Record<string, unknown>) => ({
  auth_token: TOKEN,
  token_expires_at: 0,
  fa_info: { info: "" },
  ...extra,
});

describe("gtoken header id", () => {
  it("hashes the account's user_id, not ap_cloud_user_id, when the reply carries both", async () => {
    const { internals } = clientWithLoginReply(okReply({ ap_cloud_user_id: AP_CLOUD_ID, user_id: ACCOUNT_ID }));

    await internals.attemptLogin({}, 2);

    expect(internals.authTokenHeaders().gtoken).toBe(gtoken(ACCOUNT_ID));
    expect(internals.authTokenHeaders().gtoken).not.toBe(gtoken(AP_CLOUD_ID));
  });

  /**
   * The claim that lets this ship ahead of a capture proving any account's two ids differ: where they agree,
   * the header is the string it has always been.
   */
  it("is unchanged from hashing userId when the two ids agree", async () => {
    const { internals } = clientWithLoginReply(okReply({ ap_cloud_user_id: ACCOUNT_ID, user_id: ACCOUNT_ID }));

    await internals.attemptLogin({}, 2);

    expect(internals.authTokenHeaders().gtoken).toBe(gtoken(ACCOUNT_ID));
  });

  it("hashes userId when the reply carries only the one id", async () => {
    const { internals } = clientWithLoginReply(okReply({ user_id: ACCOUNT_ID }));

    await internals.attemptLogin({}, 2);

    expect(internals.authTokenHeaders().gtoken).toBe(gtoken(ACCOUNT_ID));
  });

  it("carries the account id through persistence, so a restored session sends the same header", async () => {
    const { internals, store } = clientWithLoginReply(okReply({ ap_cloud_user_id: AP_CLOUD_ID, user_id: ACCOUNT_ID }));
    await internals.attemptLogin({}, 2);
    expect(store.load()?.accountUserId).toBe(ACCOUNT_ID);

    const restored = new MegaHttpClient({
      email: "synthetic@example.invalid",
      password: "synthetic",
      store,
    }) as unknown as { authTokenHeaders: () => Record<string, string> };

    expect(restored.authTokenHeaders().gtoken).toBe(gtoken(ACCOUNT_ID));
  });
});

/**
 * A record written before the account id was tracked cannot be restored.
 *
 * Restoring one would reinstate a session whose header is hashed from the other id, and nothing in a
 * restored session can recover the right one — it arrives with a login reply. Since a `gtoken` mismatch is
 * no longer classified as an expired token, such a session would never be replaced either: every
 * authenticated call would fail identically for the life of the install.
 */
describe("a session stored before the account id was tracked", () => {
  const legacy: PersistedSession = {
    userId: AP_CLOUD_ID,
    authToken: TOKEN,
    region: "us-pr",
    openudid: "0".repeat(16),
    shareKey: "00".repeat(32),
    keyIdent: "00".repeat(16),
    tokenExpiresAt: 0,
    savedAt: Date.now(),
  };

  it("is not a usable session", () => {
    expect(isSessionValid(legacy)).toBe(false);
    expect(isSessionValid({ ...legacy, accountUserId: ACCOUNT_ID })).toBe(true);
  });

  it("is not hydrated, so the client logs in again rather than holding a header it cannot fix", () => {
    const store = new MemorySessionStore();
    store.save(legacy);

    const mega = new MegaHttpClient({
      email: "synthetic@example.invalid",
      password: "synthetic",
      store,
    }) as unknown as { auth?: unknown; authTokenHeaders: () => Record<string, string> };

    expect(mega.auth).toBeUndefined();
    expect(mega.authTokenHeaders()).toEqual({});
  });

  /** The device identity is still reused — refusing the credential must not re-trigger a 2FA prompt. */
  it("still contributes its device identity, so the re-login is not a new device", () => {
    const store = new MemorySessionStore();
    store.save({ ...legacy, openudid: "STORED-UDID", phoneModel: "STORED-Model" });

    const mega = new MegaHttpClient({
      email: "synthetic@example.invalid",
      password: "synthetic",
      store,
    }) as unknown as { openudid: string; phoneModel: string };

    expect(mega.openudid).toBe("STORED-UDID");
    expect(mega.phoneModel).toBe("STORED-Model");
  });
});
