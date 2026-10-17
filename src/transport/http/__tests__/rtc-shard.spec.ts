import { describe, expect, it, vi } from "vitest";

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
 * The portal shard: `estimate_domain` asked as the portal's WEB identity, the identity the RTC sign is sent
 * with. A GB account is answered `mega-eu-pr` as PHONE and `mega-ie-pr` as WEB, and only the ie sign host
 * accepts its sign. Synthetic hosts; no network.
 */
describe("portalShard", () => {
  function portal(answer: () => Promise<unknown>) {
    const mega = new MegaHttpClient({
      email: "synthetic@example.invalid",
      password: "synthetic",
      countryCode: "GB",
      region: "eu-pr",
      store: new MemorySessionStore(),
    });
    const httpPost = vi.fn(answer);
    (mega as unknown as { httpPost: typeof httpPost }).httpPost = httpPost;
    return { mega, httpPost };
  }

  it("asks estimate_domain as the WEB identity and takes the shard its domain names", async () => {
    const { mega, httpPost } = portal(async () => ({
      data: { code: 0, data: { domain: "mega-ie-pr.example.invalid" } },
    }));

    expect(await mega.portalShard()).toBe("ie-pr");
    const [url, body, headers] = httpPost.mock.calls[0] as unknown as [string, unknown, Record<string, string>];
    expect(url).toBe("https://mega-eu-pr.eufy.com/passport/estimate_domain");
    expect(body).toEqual({ ab: "gb", mode: 1 });
    expect(headers).toEqual({ "content-type": "application/json", "Model-Type": "WEB", "App-Name": "eufy_mega" });
  });

  it("asks once and reuses the answer", async () => {
    const { mega, httpPost } = portal(async () => ({
      data: { code: 0, data: { domain: "mega-ie-pr.example.invalid" } },
    }));
    await mega.portalShard();
    expect(await mega.portalShard()).toBe("ie-pr");
    expect(httpPost).toHaveBeenCalledOnce();
  });

  it("answers rtcShard when the estimate fails, and asks again next time", async () => {
    const { mega, httpPost } = portal(async () => {
      throw new Error("synthetic network failure");
    });
    expect(await mega.portalShard()).toBe(mega.rtcShard);
    await mega.portalShard();
    expect(httpPost).toHaveBeenCalledTimes(2);
  });
});
