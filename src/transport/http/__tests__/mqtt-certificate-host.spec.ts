import { describe, expect, it } from "vitest";

import { signRequest } from "../../../core/crypto.js";
import { MemorySessionStore } from "../../../core/store.js";
import { MegaHttpClient } from "../mega-client.js";

/**
 * How the security certificate (`app/mqtt/register/iot`) is asked: on the app's Basic host, which is
 * `estimate_domain`'s `domain` as named — a `mega-` one included — and which the app caches across launches;
 * without a body, with `Category` mirrored from `app-tab`; and answered from the app's certificate cache first.
 * Synthetic hosts and credentials throughout.
 */
const DOMAIN = "mega-zz-pr.example.invalid";
const SHARE_KEY = "00".repeat(16);

interface Sent {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function client(store = new MemorySessionStore(), fail = false) {
  const mega = new MegaHttpClient({
    email: "synthetic@example.invalid",
    password: "synthetic",
    countryCode: "US",
    store,
  });
  const internals = mega as unknown as {
    auth_: { userId: string; authToken: string };
    sessionKey: { shareKey: string; keyIdent: string; createdAt: number };
    httpPost: (
      url: string,
      body: unknown,
      headers: Record<string, string>,
    ) => Promise<{ status: number; data: unknown }>;
    persist: () => void;
  };
  const sent: Sent[] = [];
  internals.httpPost = async (url, body, headers) => {
    sent.push({ url, body, headers });
    if (url.endsWith("/estimate_domain")) return { status: 200, data: { code: 0, data: { domain: DOMAIN } } };
    return fail
      ? { status: 404, data: "404 page not found" }
      : { status: 200, data: { code: 0, data: { endpoint_addr: "e" } } };
  };
  const signIn = () => {
    internals.auth_ = { userId: "synthetic-user", authToken: "synthetic-token" };
    internals.sessionKey = { shareKey: SHARE_KEY, keyIdent: "ident-0", createdAt: Date.now() };
  };
  const urls = () => sent.map((s) => s.url);
  return { mega, internals, sent, urls, store, signIn };
}

describe("security certificate request", () => {
  it("asks the `mega-` domain estimate_domain names, not one rebuilt from the region", async () => {
    const { mega, urls, signIn } = client();
    await mega.estimateDomain();
    signIn();
    await mega.getUserMqttInfo("eufy_security");
    expect(urls().at(-1)).toBe(`https://${DOMAIN}/app/mqtt/register/iot`);
  });

  it("keeps that domain across a restored session", async () => {
    const first = client();
    await first.mega.estimateDomain();
    first.signIn();
    first.internals.persist();

    const restored = client(first.store);
    await restored.mega.getUserMqttInfo("eufy_security");
    expect(restored.urls()).toEqual([`https://${DOMAIN}/app/mqtt/register/iot`]);
  });

  it("sends no body and no content-type, signed over the timestamp and nonce alone", async () => {
    const { mega, sent, signIn } = client();
    signIn();
    await mega.getUserMqttInfo("eufy_security");
    const { body, headers } = sent.at(-1)!;
    expect(body).toBeUndefined();
    expect(headers["content-type"]).toBeUndefined();
    expect(headers["x-signature"]).toBe(signRequest(SHARE_KEY, headers["x-request-ts"]!, headers["x-request-once"]!));
  });

  it("carries `Category` as the app mirrors it from `app-tab`", async () => {
    const { mega, sent, signIn } = client();
    signIn();
    await mega.getUserMqttInfo("eufy_security");
    expect(sent.at(-1)!.headers).toMatchObject({ "app-tab": "eufy_security", category: "eufy_security" });
  });

  it("answers the cached certificate first, across a restored session, and falls back to it when asking fails", async () => {
    const first = client();
    first.signIn();
    const issued = await first.mega.getUserMqttInfo("eufy_security");

    const restored = client(first.store, true);
    expect(await restored.mega.getUserMqttInfo("eufy_security")).toEqual(issued);
    expect(restored.urls()).toEqual([]);
    expect(await restored.mega.getUserMqttInfo("eufy_security", true)).toEqual(issued);
    expect(restored.urls()).toHaveLength(1);
  });
});
