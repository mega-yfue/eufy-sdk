import { afterEach, describe, expect, it, vi } from "vitest";

import type { PersistedSession, SessionStore } from "../../../core/store.js";
import {
  EufyCloudErrorCode,
  LoginStatus,
  MegaHttpClient,
  SessionExpiredError,
  type LoginResult,
} from "../mega-client.js";

/**
 * What a client does when the cloud rejects the token it is holding.
 *
 * A rejected token is the one failure a client can act on by itself: it holds the credentials that produced
 * the session, so it can log in again and carry on. Everything here drives {@link MegaHttpClient.postSigned}
 * with `httpPost` and `ensureSessionKey` stubbed, so no test touches a network or a real account.
 */
type Response = { status: number; data: unknown };

/** A 401 the client must read as "this token is finished", by vendor code alone. */
const KICKED: Response = {
  status: 401,
  data: { code: EufyCloudErrorCode.SESSION_KICKED, msg: "synthetic wording that carries no keywords" },
};
/**
 * The same rejection as the gateway actually words it when a stored token has been displaced — carrying the
 * generic 401 code, and echoing the rejected token back at us. Observed live; the token here is synthetic.
 */
const TOKEN_NOT_EXIST: Response = {
  status: 401,
  data: { code: 401, msg: "token not exist, token = 0123456789abcdef0123" },
};
/**
 * A 401 that is NOT the credential failing — the `gtoken` header disagreeing with the token's user, which
 * no re-login can repair. Both traps live in this one string: the `token` at position 0 comes from the
 * echoed credential, and the `error` a wildcard reaches for belongs to `gtoken`, a different header.
 */
const GTOKEN_MISMATCH: Response = {
  status: 401,
  data: { code: 401, msg: "token = 0123456789abcdef0123, gtoken not equal userid error" },
};
const OK: Response = { status: 200, data: { code: 0, data: { ok: true } } };

/**
 * A client whose transport answers from `answers` in order (the last one repeating), and whose login state
 * machine answers `loginResult` — the seam that matters here is "was the login state machine re-run and the
 * call retried", not how a login itself works.
 */
function client(
  answers: Response[],
  loginResult: LoginResult | Error = { status: LoginStatus.Ok, session: {} as never },
) {
  const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic" });
  const internals = mega as unknown as {
    ensureSessionKey: (host: string) => Promise<{ shareKey: string; keyIdent: string }>;
    httpPost: (url: string) => Promise<Response>;
    login: () => Promise<LoginResult>;
    clearSession: () => void;
  };
  internals.ensureSessionKey = vi.fn(async () => ({ shareKey: "00".repeat(32), keyIdent: "00".repeat(16) }));
  const posts: string[] = [];
  internals.httpPost = vi.fn(async (url: string) => {
    posts.push(url);
    return answers[Math.min(posts.length - 1, answers.length - 1)];
  });
  const login = vi.fn(async () => {
    if (loginResult instanceof Error) throw loginResult;
    return loginResult;
  });
  internals.login = login;
  return { mega, login, posts, clearSession: vi.spyOn(internals, "clearSession") };
}

const call = (mega: MegaHttpClient, path = "/synthetic") => mega.postSigned("app-mega-us-pr.eufy.com", path, {}, true);

/** A persisted session, as a store hands one back. Synthetic throughout. */
function storedSession(authToken: string): PersistedSession {
  return {
    userId: "synthetic-user",
    accountUserId: "synthetic-user",
    authToken,
    region: "us-pr",
    openudid: "0".repeat(16),
    shareKey: "00".repeat(32),
    keyIdent: "00".repeat(16),
    tokenExpiresAt: 0,
    savedAt: Date.now(),
  } as PersistedSession;
}

/** A store two clients can share, so one can see what the other persisted. */
function sharedStore(initial: string): SessionStore & { held: PersistedSession | null } {
  return {
    held: storedSession(initial),
    load() {
      return this.held;
    },
    save(session: PersistedSession) {
      this.held = session;
    },
    clear() {
      this.held = null;
    },
  };
}

describe("mega authenticated session rejection", () => {
  afterEach(() => vi.useRealTimers());

  it("classifies vendor code 26084 as an expired session without message parsing", async () => {
    const { mega, clearSession } = client([KICKED], new Error("synthetic: re-login unavailable"));

    await expect(call(mega)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(clearSession).toHaveBeenCalled();
  });

  /**
   * The vendor words this rejection more than one way, and only one of them carries a distinctive code. A
   * client that recognises the code alone treats "token not exist" as an ordinary API error and never
   * recovers — which is what a displaced stored token actually produces.
   */
  it("classifies the gateway's own 'token not exist' wording as an expired session", async () => {
    const { mega, clearSession } = client([TOKEN_NOT_EXIST], new Error("synthetic: re-login unavailable"));

    await expect(call(mega)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(clearSession).toHaveBeenCalled();
  });

  it("recovers from that wording too, rather than only from the coded one", async () => {
    const { mega, login } = client([TOKEN_NOT_EXIST, OK]);

    await expect(call(mega)).resolves.toEqual({ ok: true });
    expect(login).toHaveBeenCalledTimes(1);
  });

  /**
   * The counterpart to the two above: a 401 that says the HEADER is wrong, not the credential. Keeping the
   * session is the whole point — a login cannot change a gtoken, so treating this as an expiry burns a
   * verification code and leaves the next call failing exactly the same way.
   */
  it("keeps the session on a gtoken mismatch, which a re-login cannot fix", async () => {
    const { mega, login, clearSession } = client([GTOKEN_MISMATCH]);

    await expect(call(mega)).rejects.not.toBeInstanceOf(SessionExpiredError);
    expect(login).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
  });

  /**
   * The false negative the bound protects: a reason stated beside the echo rather than in its own clause.
   * Removing the echo before matching would take the anchor with it and leave a dead session uncleared.
   */
  it("classifies an expiry whose reason sits beside the echoed token", async () => {
    const { mega, clearSession } = client(
      [{ status: 401, data: { code: 401, msg: "token = 0123456789abcdef0123 expired" } }],
      new Error("synthetic: re-login unavailable"),
    );

    await expect(call(mega)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(clearSession).toHaveBeenCalled();
  });

  /**
   * The gateway echoes the token it just rejected into its message, and that message travels into the error a
   * host logs and pastes into a bug report. A credential is not diagnostics.
   */
  it("does not carry the rejected token into the error it throws", async () => {
    const { mega } = client([TOKEN_NOT_EXIST], new Error("synthetic: re-login unavailable"));

    const error: Error = await call(mega).then(
      () => new Error("expected a rejection"),
      (e: Error) => e,
    );

    expect(error.message).not.toContain("0123456789abcdef0123");
    expect(error.message).toContain("<redacted>");
  });

  /**
   * The recovery the rejection exists to enable: log in again with the credentials already held, then finish
   * the call the caller made. Without it a client holding a displaced token answers every later call the same
   * way for the rest of its life, and a caller that asked for its devices is told the account has none.
   */
  it("logs in again and completes the call the caller made", async () => {
    const { mega, login, posts } = client([KICKED, OK]);

    await expect(call(mega)).resolves.toEqual({ ok: true });
    expect(login).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(2);
  });

  /** One attempt. A token the cloud rejects twice is not a token a third login will fix. */
  it("gives up after one re-login rather than looping", async () => {
    const { mega, login, posts } = client([KICKED]);

    await expect(call(mega)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(login).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(2);
  });

  /**
   * A re-login that needs a human cannot be completed silently, and pretending otherwise would either loop or
   * strand the caller. The rejection is surfaced so the host can drive the captcha/2FA flow it already owns.
   */
  it("surfaces the rejection when the re-login needs a human", async () => {
    const { mega, login, posts } = client([KICKED], { status: LoginStatus.Captcha, image: "data:,", retry: false });

    await expect(call(mega)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(login).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(1); // the call is not retried against a session that was never restored
  });

  /** A login that fails outright (offline, wrong password) leaves the caller with the honest reason. */
  it("surfaces the rejection when the re-login itself fails", async () => {
    const { mega, login } = client([KICKED], new Error("synthetic login failure"));

    await expect(call(mega)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(login).toHaveBeenCalledTimes(1);
  });

  /**
   * A device-list refresh fires several calls at once, and every one of them holds the same dead token. Each
   * triggering its own login would spend N logins to learn one thing — and on an account that limits
   * concurrent sessions, later logins displace the token the earlier ones just obtained.
   */
  it("collapses concurrent rejections into one login", async () => {
    const { mega, login } = client([KICKED, KICKED, OK]);

    const [first, second] = await Promise.all([call(mega, "/a"), call(mega, "/b")]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(login).toHaveBeenCalledTimes(1);
  });

  /**
   * The login round trip is itself an authenticated call while a limited token is held, so a client that
   * re-logged in from inside one would recurse. The guard is structural — "a login is in flight" — rather than
   * a list of paths that would have to be maintained alongside the login flow.
   */
  it("never re-logs in from inside a login attempt", async () => {
    const { mega, login } = client([KICKED]);
    (mega as unknown as { loggingIn: boolean }).loggingIn = true;

    await expect(call(mega, "/passport/login")).rejects.toBeInstanceOf(SessionExpiredError);
    expect(login).not.toHaveBeenCalled();
  });

  /** A pending 2FA code is a login a human is mid-way through; restarting it silently would discard it. */
  it("never re-logs in while a 2FA code is outstanding", async () => {
    const { mega, login } = client([KICKED]);
    (mega as unknown as { pending2fa: boolean }).pending2fa = true;

    await expect(call(mega)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(login).not.toHaveBeenCalled();
  });

  /** With no credentials to log in with — a host running purely off a restored session — there is nothing to try. */
  it("does not attempt a re-login it has no credentials for", async () => {
    const mega = new MegaHttpClient({ email: "", password: "" });
    const internals = mega as unknown as {
      ensureSessionKey: () => Promise<{ shareKey: string; keyIdent: string }>;
      httpPost: () => Promise<Response>;
      login: () => Promise<LoginResult>;
    };
    internals.ensureSessionKey = vi.fn(async () => ({ shareKey: "00".repeat(32), keyIdent: "00".repeat(16) }));
    internals.httpPost = vi.fn(async () => KICKED);
    const login = vi.fn(async () => ({ status: LoginStatus.Ok, session: {} as never }) as LoginResult);
    internals.login = login;

    await expect(call(mega)).rejects.toBeInstanceOf(SessionExpiredError);
    expect(login).not.toHaveBeenCalled();
  });

  /**
   * Two clients on one account, and the hazard this recovery introduces if it is not bounded.
   *
   * A client's device identity defaults to one derived from its credentials, so two of them look like the SAME
   * device to the cloud — which keeps one session per device and evicts the other. Each then finds its token
   * rejected, replaces it, and evicts the first: a silent login war, and repeated logins are exactly what makes
   * the account start demanding captchas.
   */
  describe("two clients on one account", () => {
    /** The cheap way out: if the other client shares this one's store, its token is already there to use. */
    it("adopts a token another client persisted instead of spending a login", async () => {
      const store = sharedStore("token-a");
      const { mega, login } = client([KICKED, OK]);
      (mega as unknown as { store: SessionStore }).store = store;
      (mega as unknown as { auth_: { userId: string; authToken: string } }).auth_ = {
        userId: "synthetic-user",
        authToken: "token-a",
      };
      store.held = storedSession("token-b"); // the other client logged in and persisted its own

      await expect(call(mega)).resolves.toEqual({ ok: true });
      expect(login).not.toHaveBeenCalled();
      expect(store.held?.authToken).toBe("token-b"); // and the other client's session was not wiped
    });

    /** With separate stores there is nothing to adopt, so the rate is what has to be bounded. */
    it("replaces a token once, then holds off rather than trading logins", async () => {
      const { mega, login } = client([KICKED], { status: LoginStatus.Ok, session: {} as never });

      await expect(call(mega)).rejects.toBeInstanceOf(SessionExpiredError); // recovered, then rejected again
      const held = await call(mega).catch((e: Error) => e);

      expect(login).toHaveBeenCalledTimes(1);
      expect((held as Error).message).toMatch(/same account and device identity|openudid/);
    });

    /** A token that has been working for a while earns the right to be replaced quickly again. */
    it("forgets the hold-off once a replaced token has been working", async () => {
      vi.useFakeTimers();
      const { mega, login } = client([KICKED, OK, KICKED, OK]);

      await expect(call(mega)).resolves.toEqual({ ok: true }); // first recovery
      await vi.advanceTimersByTimeAsync(20 * 60_000); // the replacement keeps working for 20 minutes
      await expect(call(mega)).resolves.toEqual({ ok: true }); // proves it, then a later rejection recovers

      expect(login).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * What a host is told to do about a rejection it is left to handle.
   *
   * The message alone leaves a host to invent a delay, and the one it invents is the seconds-scale ladder a
   * login state machine already has for a FAILED login — which turns a displaced session into a login every
   * few seconds, from outside the hold-off that exists to stop exactly that. So the wait rides on the error.
   */
  describe("the wait it hands the host", () => {
    it("carries the hold-off remaining, and says the session is being displaced", async () => {
      vi.useFakeTimers();
      const { mega } = client([KICKED], { status: LoginStatus.Ok, session: {} as never });

      await expect(call(mega)).rejects.toBeInstanceOf(SessionExpiredError); // replaced once, rejected again
      const held = (await call(mega).catch((e: unknown) => e)) as SessionExpiredError;

      expect(held.contended).toBe(true);
      expect(held.retryAfterMs).toBe(60_000);
    });

    /** A replacement that was SPENT and failed is still a replacement: the next one waits, and the host is told. */
    it("carries a wait for a replacement that was spent and failed", async () => {
      vi.useFakeTimers();
      const { mega } = client([KICKED], new Error("synthetic: re-login unavailable"));

      const failed = (await call(mega).catch((e: unknown) => e)) as SessionExpiredError;

      expect(failed.contended).toBe(false); // nothing was held off — the login ran and failed
      expect(failed.retryAfterMs).toBe(60_000);
    });

    /** Nothing spent, nothing to wait for: a host with no session to replace may act at once. */
    it("carries no wait when no replacement has been spent", async () => {
      const mega = new MegaHttpClient({ email: "", password: "" });
      const internals = mega as unknown as {
        ensureSessionKey: () => Promise<{ shareKey: string; keyIdent: string }>;
        httpPost: () => Promise<Response>;
      };
      internals.ensureSessionKey = vi.fn(async () => ({ shareKey: "00".repeat(32), keyIdent: "00".repeat(16) }));
      internals.httpPost = vi.fn(async () => KICKED);

      const err = (await call(mega).catch((e: unknown) => e)) as SessionExpiredError;

      expect(err.retryAfterMs).toBe(0);
      expect(err.contended).toBe(false);
    });

    /**
     * The hold-off has to count the host's logins too, or it is not a bound.
     *
     * Every replacement this client spends doubles the wait; a host that re-logs in off the surfaced error
     * spends one the same way, and if only the internal path counted, the wait reported back would sit at
     * its first value while the account was in fact being logged into over and over. Here the whole loop is
     * real — a rejected call, a host-driven `login()`, another rejected call — and the wait has to have
     * grown.
     */
    it("counts a host-driven login against the hold-off, so the wait it reports grows", async () => {
      vi.useFakeTimers();
      const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic", region: "us-pr" });
      const internals = mega as unknown as {
        ensureSessionKey: () => Promise<{ shareKey: string; keyIdent: string }>;
        httpPost: (url: string) => Promise<Response>;
      };
      internals.ensureSessionKey = vi.fn(async () => ({ shareKey: "00".repeat(32), keyIdent: "00".repeat(16) }));
      const logins: string[] = [];
      internals.httpPost = vi.fn(async (url: string) => {
        if (!url.includes("/passport/login")) return KICKED;
        logins.push(url);
        return {
          status: 200,
          data: {
            code: 0,
            data: {
              user_id: "synthetic-user",
              ap_cloud_user_id: "synthetic-user",
              auth_token: `synthetic-token-${logins.length}`,
              token_expires_at: 0,
            },
          },
        };
      });

      const first = (await call(mega).catch((e: unknown) => e)) as SessionExpiredError;
      expect(logins).toHaveLength(1); // this client's own recovery, counted
      expect(first.retryAfterMs).toBe(60_000);

      await mega.login(); // the host, doing what the error left it to do
      const second = (await call(mega).catch((e: unknown) => e)) as SessionExpiredError;

      expect(logins).toHaveLength(2);
      expect(second.contended).toBe(true);
      expect(second.retryAfterMs).toBe(120_000); // counted, not ignored
    });
  });

  /** An unauthenticated call has no session to recover — nothing about it says the token is dead. */
  it("leaves an unauthenticated call alone", async () => {
    const { mega, login } = client([KICKED]);

    await expect(mega.postSigned("app-mega-us-pr.eufy.com", "/synthetic", {}, false)).rejects.not.toBeInstanceOf(
      SessionExpiredError,
    );
    expect(login).not.toHaveBeenCalled();
  });
});
