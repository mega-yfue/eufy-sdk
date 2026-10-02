import { beforeEach, describe, expect, it, vi } from "vitest";

import { LegacyPushClient, type LegacyPushSession } from "../legacy-push-client.js";
import { MemorySessionStore } from "../../../core/store.js";

const SESSION: LegacyPushSession = {
  authToken: "legacy-auth-token",
  userId: "legacy-user-id",
  openudid: "test-openudid",
  serialNumber: "test-serial",
  country: "ES",
  apiBase: "https://security-app-eu.eufylife.com",
  tokenExpiresAt: Date.now() + 60 * 60_000,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("LegacyPushClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("registers the supplied FCM token on the legacy push backend", async () => {
    const store = new MemorySessionStore<LegacyPushSession>();
    store.save({ ...SESSION });

    const fetchMock = vi.fn<typeof fetch>(async (_input, _init) => response({ code: 0, msg: "Succeed." }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new LegacyPushClient({
      email: "test@example.com",
      password: "test-password",
      country: "ES",
      openudid: "test-openudid",
      store,
    });

    await expect(client.registerPushToken("same-fcm-token")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://security-app-eu.eufylife.com/v1/apppush/register_push_token");

    expect(JSON.parse(String(options?.body))).toMatchObject({
      is_notification_enable: true,
      token: "same-fcm-token",
    });

    const headers = options?.headers as Record<string, string>;
    expect(headers["X-Auth-Token"]).toBe("legacy-auth-token");
    expect(headers.gtoken).toMatch(/^[a-f0-9]{32}$/);
    expect(headers.Openudid).toBe("test-openudid");
    expect(headers.Sn).toBe("test-serial");
  });

  it("discovers and persists the legacy API base when it is absent", async () => {
    const store = new MemorySessionStore<LegacyPushSession>();
    store.save({ ...SESSION, apiBase: undefined });

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          code: 0,
          data: { domain: "security-app-eu.eufylife.com" },
        }),
      )
      .mockResolvedValueOnce(response({ code: 0, msg: "Succeed." }));

    vi.stubGlobal("fetch", fetchMock);

    const client = new LegacyPushClient({
      email: "test@example.com",
      password: "test-password",
      country: "ES",
      openudid: "test-openudid",
      store,
    });

    await expect(client.registerPushToken("fcm-token")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://extend.eufylife.com/domain/ES", expect.any(Object));

    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://security-app-eu.eufylife.com/v1/apppush/register_push_token");

    expect(store.load()?.apiBase).toBe("https://security-app-eu.eufylife.com");
  });

  it("clears a rejected legacy session on HTTP 401", async () => {
    const store = new MemorySessionStore<LegacyPushSession>();
    store.save({ ...SESSION });

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_input, _init) => response({ code: 401, msg: "Unauthorized" }, 401)),
    );

    const client = new LegacyPushClient({
      email: "test@example.com",
      password: "test-password",
      country: "ES",
      openudid: "test-openudid",
      store,
    });

    await expect(client.registerPushToken("fcm-token")).resolves.toBe(false);
    expect(store.load()).toBeNull();
  });

  it("re-authenticates an expired session and then registers the FCM token", async () => {
    const store = new MemorySessionStore<LegacyPushSession>();

    store.save({
      ...SESSION,
      tokenExpiresAt: Date.now() - 1,
    });

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          code: 0,
          data: {
            domain: "security-app-eu.eufylife.com",
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          code: 0,
          msg: "Succeed.",
          data: {
            auth_token: "fresh-legacy-token",
            user_id: "fresh-user-id",
            token_expires_at: Math.floor(Date.now() / 1000) + 3600,
            server_secret_info: {},
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          code: 0,
          msg: "Succeed.",
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const client = new LegacyPushClient({
      email: "test@example.com",
      password: "test-password",
      country: "ES",
      openudid: "test-openudid",
      store,
    });

    await expect(client.registerPushToken("fresh-fcm-token")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(3);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://extend.eufylife.com/domain/ES");

    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://security-app-eu.eufylife.com/v2/passport/login_sec");

    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://security-app-eu.eufylife.com/v1/apppush/register_push_token");

    const persisted = store.load();

    expect(persisted?.authToken).toBe("fresh-legacy-token");
    expect(persisted?.userId).toBe("fresh-user-id");
    expect(persisted?.openudid).toBe("test-openudid");
    expect(persisted?.apiBase).toBe("https://security-app-eu.eufylife.com");
    expect(persisted?.tokenExpiresAt).toBeGreaterThan(Date.now());
  });
});
