import { describe, expect, it, vi, type Mock } from "vitest";

import { MemorySessionStore } from "../../../core/store.js";
import { MegaHttpClient } from "../mega-client.js";

/**
 * The shard the RTC signalling signs on survives a session restore.
 *
 * `estimate_domain` is the only source that names a shard the eu/us classification cannot (`ie`), and a
 * restored session skips it. Synthetic ids and hosts throughout; no network and no account.
 */
const IE_DOMAIN = "app-openapi-ie-pr.example.invalid";

function client(store: MemorySessionStore) {
  const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic", store });
  const internals = mega as unknown as {
    httpPost: (url: string) => Promise<unknown>;
    postSigned: (host: string, path: string) => Promise<unknown>;
    ensureSessionKey: () => Promise<unknown>;
    sessionKey?: unknown;
    attemptLogin: (body: unknown, messageType: number) => Promise<unknown>;
    loginBody: (o: Record<string, unknown>) => unknown;
  };
  internals.httpPost = vi.fn(async () => ({ data: { code: 0, data: { domain: IE_DOMAIN } } }));
  internals.postSigned = vi.fn(async () => ({
    auth_token: "synthetic-auth-token",
    token_expires_at: 0,
    user_id: "eufy-account-0000002",
    fa_info: { info: "" },
  }));
  internals.ensureSessionKey = vi.fn(async () => {
    internals.sessionKey = { shareKey: "00".repeat(32), keyIdent: "00".repeat(16), createdAt: Date.now() };
    return internals.sessionKey;
  });
  return { mega, internals };
}

describe("rtcShard", () => {
  it("names the shard the estimated domain carries", async () => {
    const { mega } = client(new MemorySessionStore());
    await mega.estimateDomain();
    expect(mega.rtcShard).toBe("ie-pr");
  });

  it("is the same shard after the session is restored from the store", async () => {
    const store = new MemorySessionStore();
    const first = client(store);
    await first.mega.estimateDomain();
    await first.internals.attemptLogin(first.internals.loginBody({}), 2);

    const restored = client(store).mega;

    expect(restored.rtcShard).toBe("ie-pr");
  });
});

/**
 * The shard the RTC signalling actually signs on, asked with the portal's WEB identity — which can
 * name a different shard than the PHONE identity does for the same account, so it is a separate
 * `estimate_domain` call from {@link rtcShard}'s. Synthetic throughout; no network and no account.
 */
describe("portalShard", () => {
  it("resolves the shard from estimate_domain asked with the portal's WEB identity", async () => {
    const { mega, internals } = client(new MemorySessionStore());
    const post = internals.httpPost as unknown as Mock;

    expect(await mega.portalShard()).toBe("ie-pr");

    const [url, body, headers] = post.mock.calls.at(-1)!;
    expect(url).toContain("/passport/estimate_domain");
    expect(headers).toMatchObject({ "Model-Type": "WEB", "App-Name": "eufy_mega" });
    expect(body).toMatchObject({ mode: 1 });
  });

  it("shares one request between concurrent first callers, then caches the result", async () => {
    const { mega, internals } = client(new MemorySessionStore());
    const post = internals.httpPost as unknown as Mock;

    const [a, b] = await Promise.all([mega.portalShard(), mega.portalShard()]);
    expect(a).toBe("ie-pr");
    expect(b).toBe("ie-pr");
    expect(post).toHaveBeenCalledTimes(1);

    expect(await mega.portalShard()).toBe("ie-pr");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("falls back to rtcShard when the estimate names no shard, and asks again next time", async () => {
    const { mega, internals } = client(new MemorySessionStore());
    const post = internals.httpPost as unknown as Mock;
    post.mockResolvedValueOnce({ data: { code: 0, data: {} } });

    expect(await mega.portalShard()).toBe(mega.rtcShard);
    expect(post).toHaveBeenCalledTimes(1);

    expect(await mega.portalShard()).toBe("ie-pr");
    expect(post).toHaveBeenCalledTimes(2);
  });
});
