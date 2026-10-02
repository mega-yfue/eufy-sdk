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

    const fetchMock = vi.fn(async () => response({ code: 0, msg: "Succeed." }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new LegacyPushClient({ store });

    await expect(client.registerPushToken("same-fcm-token")).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledOnce();

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://security-app-eu.eufylife.com/v1/apppush/register_push_token");

    expect(JSON.parse(String(options?.body))).toMatchObject({
      is_notification_enable: true,
      token: "same-fcm-token",
    });

    const headers = options?.headers as Record<string, string>;
    expect(headers["x-auth-token"]).toBe("legacy-auth-token");
    expect(headers.gtoken).toMatch(/^[a-f0-9]{32}$/);
    expect(headers.Openudid).toBe("test-openudid");
    expect(headers.Sn).toBe("test-serial");
  });

  it("discovers and persists the legacy API base when it is absent", async () => {
    const store = new MemorySessionStore<LegacyPushSession>();
    store.save({ ...SESSION, apiBase: undefined });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response({
          code: 0,
          data: { domain: "security-app-eu.eufylife.com" },
        }),
      )
      .mockResolvedValueOnce(response({ code: 0, msg: "Succeed." }));

    vi.stubGlobal("fetch", fetchMock);

    const client = new LegacyPushClient({ store });

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
      vi.fn(async () => response({ code: 401, msg: "Unauthorized" }, 401)),
    );

    const client = new LegacyPushClient({ store });

    await expect(client.registerPushToken("fcm-token")).resolves.toBe(false);
    expect(store.load()).toBeNull();
  });

  it("checks push registration with the legacy app_push_check endpoint", async () => {
    const store = new MemorySessionStore<LegacyPushSession>();
    store.save({ ...SESSION });

    const fetchMock = vi.fn(async () => response({ code: 0, msg: "Succeed." }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new LegacyPushClient({ store });

    await expect(client.checkPushToken()).resolves.toBe(true);

    const [url, options] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://security-app-eu.eufylife.com/v1/app/review/app_push_check");

    expect(JSON.parse(String(options?.body))).toMatchObject({
      app_type: "eufySecurity",
    });
  });

  it("refuses an expired persisted session without making a request", async () => {
    const store = new MemorySessionStore<LegacyPushSession>();
    store.save({
      ...SESSION,
      tokenExpiresAt: Date.now() - 1,
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = new LegacyPushClient({ store });

    await expect(client.registerPushToken("fcm-token")).rejects.toThrow(
      "legacy push session is unavailable or expired",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
