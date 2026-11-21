import { createCipheriv, createDecipheriv, createECDH, randomBytes } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { EUFY_MEGA_LOCAL_KEY_HEX, type SessionEntry } from "../../../core/crypto.js";
import { MegaHttpClient } from "../mega-client.js";

/**
 * How many key exchanges a client spends when its session key is gone and several calls need it at once.
 *
 * A device-list refresh fires a call per device, and a stale key-ident fails every one of them in the same
 * instant. Each exchange mints its own key-ident, so N exchanges leave one key installed and N-1 orphaned on
 * the gateway. The transport here is a synthetic in-memory gateway that performs the real server side of the
 * exchange; no test touches a network or an account.
 */
type Response = { status: number; data: unknown };

const LOCALKEY = Buffer.from(EUFY_MEGA_LOCAL_KEY_HEX, "hex");

/** The server side of one key exchange: unwrap the client key, answer with a wrapped server key. */
function serverKeyExchange(clientPublicKeyB64: string): string {
  const raw = Buffer.from(clientPublicKeyB64, "base64");
  const dec = createDecipheriv("aes-128-cbc", LOCALKEY, raw.subarray(0, 16));
  Buffer.concat([dec.update(raw.subarray(16)), dec.final()]);
  const server = createECDH("prime256v1");
  server.generateKeys();
  const iv = randomBytes(16);
  const c = createCipheriv("aes-128-cbc", LOCALKEY, iv);
  return Buffer.concat([iv, c.update(server.getPublicKey("hex", "uncompressed"), "utf-8"), c.final()]).toString(
    "base64",
  );
}

/**
 * A client whose key exchanges are held until `release()`, so concurrent callers really overlap, and which fail
 * while `failing` is set.
 */
function client() {
  const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic", region: "us-pr" });
  const internals = mega as unknown as {
    httpPost: (url: string, body: { client_public_key: string }) => Promise<Response>;
    sessionKey?: SessionEntry;
  };
  const exchanges: string[] = [];
  const held: (() => void)[] = [];
  const state = { failing: false };
  internals.httpPost = vi.fn(async (url: string, body: { client_public_key: string }) => {
    exchanges.push(url);
    await new Promise<void>((resolve) => held.push(resolve));
    if (state.failing) return { status: 500, data: { code: 500, msg: "synthetic exchange failure" } };
    return { status: 200, data: { code: 0, data: { server_public_key: serverKeyExchange(body.client_public_key) } } };
  });
  const release = () => held.splice(0).forEach((resolve) => resolve());
  return { mega, internals, exchanges, release, state };
}

describe("mega session key exchange", () => {
  it("runs one exchange for every caller that finds the key gone at once", async () => {
    const { mega, internals, exchanges, release } = client();
    internals.sessionKey = undefined;

    const waiting = Promise.all(Array.from({ length: 8 }, () => mega.ensureSessionKey()));
    await vi.waitFor(() => expect(exchanges).toHaveLength(1));
    release();
    const keys = await waiting;

    expect(exchanges).toHaveLength(1);
    expect(new Set(keys.map((k) => k.keyIdent)).size).toBe(1);
    expect(keys.every((k) => k === internals.sessionKey)).toBe(true);
  });

  /** A failure is not remembered: the next caller gets a fresh attempt rather than the same rejection. */
  it("does not keep a failed exchange, so the next call tries again", async () => {
    const { mega, exchanges, release, state } = client();
    state.failing = true;

    const failed = Promise.all([mega.ensureSessionKey(), mega.ensureSessionKey()]);
    await vi.waitFor(() => expect(exchanges).toHaveLength(1));
    release();
    await expect(failed).rejects.toThrow(/key\/exchange failed/);

    state.failing = false;
    const retried = mega.ensureSessionKey();
    await vi.waitFor(() => expect(exchanges).toHaveLength(2));
    release();

    await expect(retried).resolves.toMatchObject({ keyIdent: expect.any(String) });
  });

  /**
   * A login re-exchanges with its fresh token so the gateway binds the key-ident to the user. Joining an
   * exchange that went out before the token was held would hand login a key bound to nobody.
   */
  it("does not join an exchange that carried a different token", async () => {
    const { mega, internals, exchanges, release } = client();

    const anonymous = mega.ensureSessionKey();
    await vi.waitFor(() => expect(exchanges).toHaveLength(1));
    (mega as unknown as { auth_: { userId: string; authToken: string } }).auth_ = {
      userId: "synthetic-user",
      authToken: "synthetic-token",
    };
    internals.sessionKey = undefined;
    const authed = mega.ensureSessionKey();
    await vi.waitFor(() => expect(exchanges).toHaveLength(2));
    release();

    const [a, b] = await Promise.all([anonymous, authed]);
    expect(a.keyIdent).not.toBe(b.keyIdent);
  });
});

/**
 * The fan-out as the issue saw it: every device refresh rejected with "get identity error" in the same
 * instant, each clearing the key and re-exchanging. They share one exchange, and the retry succeeds.
 */
describe("mega identity error from concurrent calls", () => {
  it("re-exchanges once for all of them", async () => {
    const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic", region: "us-pr" });
    const internals = mega as unknown as {
      httpPost: (url: string, body: unknown) => Promise<Response>;
      auth_: { userId: string; authToken: string };
      sessionKey?: SessionEntry;
      persist: () => void;
    };
    internals.auth_ = { userId: "synthetic-user", authToken: "synthetic-token" };
    internals.sessionKey = {
      keyIdent: "stale",
      shareKey: "00".repeat(16),
      clientPublicKeyHex: "",
      clientPrivateKeyHex: "",
      createdAt: Date.now(),
    };
    internals.persist = () => {};
    const exchanges: string[] = [];
    const rejectedOnce = new Set<string>();
    let releaseExchange!: () => void;
    const exchangeGate = new Promise<void>((resolve) => (releaseExchange = resolve));
    internals.httpPost = vi.fn(async (url: string, body: unknown) => {
      if (url.includes("/oauth/key/exchange")) {
        exchanges.push(url);
        await exchangeGate;
        const kx = body as { client_public_key: string };
        return { status: 200, data: { code: 0, data: { server_public_key: serverKeyExchange(kx.client_public_key) } } };
      }
      if (!rejectedOnce.has(url)) {
        rejectedOnce.add(url);
        return { status: 463, data: { code: 4406, msg: "get identity error" } };
      }
      return { status: 200, data: { code: 0, data: { ok: true } } };
    });

    const calls = Array.from({ length: 8 }, (_, i) =>
      mega.postSigned("app-mega-us-pr.eufy.com", `/synthetic/${i}`, {}, true),
    );
    await vi.waitFor(() => expect(rejectedOnce.size).toBe(8));
    releaseExchange();
    const results = await Promise.all(calls);

    expect(results.every((r) => (r as { ok: boolean }).ok)).toBe(true);
    expect(exchanges).toHaveLength(1);
  });
});

/** The app's `needExchanged`: an HTTP 463, or a 403 on a signed request, re-exchanges and sends once more, whatever the code. */
describe("a 463 or 403 on a signed request", () => {
  it.each([463, 403])("re-exchanges the key and sends once more on %i", async (status) => {
    const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic", region: "us-pr" });
    const internals = mega as unknown as {
      httpPost: (url: string, body: unknown) => Promise<Response>;
      auth_: { userId: string; authToken: string };
      sessionKey?: SessionEntry;
      persist: () => void;
    };
    internals.auth_ = { userId: "synthetic-user", authToken: "synthetic-token" };
    internals.sessionKey = {
      keyIdent: "stale",
      shareKey: "00".repeat(16),
      clientPublicKeyHex: "",
      clientPrivateKeyHex: "",
      createdAt: Date.now(),
    };
    internals.persist = () => {};
    let exchanges = 0;
    let rejected = false;
    internals.httpPost = vi.fn(async (url: string, body: unknown) => {
      if (url.includes("/oauth/key/exchange")) {
        exchanges++;
        const kx = body as { client_public_key: string };
        return { status: 200, data: { code: 0, data: { server_public_key: serverKeyExchange(kx.client_public_key) } } };
      }
      if (!rejected) {
        rejected = true;
        return { status, data: { code: 99999, msg: "synthetic" } };
      }
      return { status: 200, data: { code: 0, data: { ok: true } } };
    });

    await expect(mega.postSigned("app-mega-us-pr.eufy.com", "/synthetic", {}, true)).resolves.toEqual({ ok: true });
    expect(exchanges).toBe(1);
  });
});
