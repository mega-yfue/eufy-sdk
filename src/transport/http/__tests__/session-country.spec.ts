import { describe, expect, it, vi } from "vitest";

import { MemorySessionStore, type PersistedSession } from "../../../core/store.js";
import { LoginStatus, MegaHttpClient, type LoginResult } from "../mega-client.js";

/**
 * Whether a stored session is restored under the configured account country.
 *
 * The record's shard is the one `estimate_domain` answered for the country it was logged in with, so a record
 * from another country must not be restored. `attemptLogin` is stubbed: the seam is "restored, or a fresh
 * login", not how a login itself works. Synthetic throughout.
 */
const storedSession = (extra: Partial<PersistedSession> = {}): PersistedSession => ({
  userId: "synthetic-user",
  accountUserId: "synthetic-user",
  authToken: "synthetic-token",
  region: "us-pr",
  openudid: "SYNTHETIC-UDID",
  shareKey: "00".repeat(16),
  keyIdent: "00".repeat(16),
  tokenExpiresAt: 0,
  savedAt: Date.now(),
  ...extra,
});

const FRESH: LoginResult = { status: LoginStatus.Ok, session: { userId: "fresh", authToken: "fresh", raw: {} } };

function client(saved: PersistedSession, countryCode: string) {
  const store = new MemorySessionStore();
  store.save(saved);
  const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic", countryCode, store });
  const attemptLogin = vi.fn(async () => FRESH);
  (mega as unknown as { attemptLogin: typeof attemptLogin }).attemptLogin = attemptLogin;
  return { mega, attemptLogin };
}

describe("stored session country", () => {
  it("does not restore a session logged in with another country, and logs in afresh", async () => {
    const { mega, attemptLogin } = client(storedSession({ countryCode: "US" }), "GB");
    expect(mega.auth).toBeUndefined();
    expect(await mega.login()).toBe(FRESH);
    expect(attemptLogin).toHaveBeenCalledOnce();
  });

  it("restores a session whose country differs only in case", async () => {
    const { mega, attemptLogin } = client(storedSession({ countryCode: "us" }), "US");
    expect(mega.auth?.authToken).toBe("synthetic-token");
    expect(await mega.login()).toMatchObject({ session: { raw: { restored: true } } });
    expect(attemptLogin).not.toHaveBeenCalled();
  });

  it("restores a record that carries no country", async () => {
    const { mega, attemptLogin } = client(storedSession(), "GB");
    expect(mega.auth?.authToken).toBe("synthetic-token");
    expect(await mega.login()).toMatchObject({ session: { raw: { restored: true } } });
    expect(attemptLogin).not.toHaveBeenCalled();
  });

  it("persists the configured country with the session", () => {
    const store = new MemorySessionStore();
    const mega = new MegaHttpClient({
      email: "synthetic@example.invalid",
      password: "synthetic",
      countryCode: "GB",
      store,
    }) as unknown as {
      auth_: { userId: string; authToken: string };
      sessionKey: { shareKey: string; keyIdent: string };
      persist: () => void;
    };
    mega.auth_ = { userId: "synthetic-user", authToken: "synthetic-token" };
    mega.sessionKey = { shareKey: "00".repeat(16), keyIdent: "00".repeat(16) };
    mega.persist();
    expect(store.load()?.countryCode).toBe("GB");
  });
});
