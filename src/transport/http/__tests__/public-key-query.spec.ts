import { afterEach, describe, expect, it, vi } from "vitest";

import { MegaHttpClient } from "../mega-client.js";

/** The app's `SecurityNetApi.getPublicKey`: `GET v3/app/public_key/query`, `app-tab: eufy_security`, signed. */
describe("MegaHttpClient.getDevicePublicKey", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks v3 on the security host with app-tab and the session's signature", async () => {
    const mega = new MegaHttpClient({
      email: "synthetic@example.invalid",
      password: "synthetic",
      countryCode: "US",
      region: "us-pr",
    });
    const entry = { keyIdent: "ident-0", shareKey: Buffer.alloc(32, 1).toString("hex") };
    (mega as unknown as { ensureSessionKey: () => Promise<unknown> }).ensureSessionKey = async () => entry;
    const fetchMock = vi.fn(
      async (_url: string, _init: { headers: Record<string, string> }) =>
        new Response(JSON.stringify({ code: 0, data: { public_key: "ab".repeat(64) } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    expect(await mega.getDevicePublicKey("T8520P0000000000")).toBe("ab".repeat(64));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://security-app.eufylife.com/v3/app/public_key/query?device_sn=T8520P0000000000&type=2");
    expect(init.headers).toMatchObject({ "app-tab": "eufy_security", "x-key-ident": "ident-0" });
    expect(init.headers["x-signature"]).toMatch(/^[0-9a-f]+$/);
  });

  it("goes to the security host estimate_domain names, as the app's Security category host", async () => {
    const mega = new MegaHttpClient({
      email: "synthetic@example.invalid",
      password: "synthetic",
      countryCode: "US",
      region: "us-pr",
    });
    const internals = mega as unknown as {
      ensureSessionKey: () => Promise<unknown>;
      httpPost: (url: string) => Promise<{ status: number; data: unknown }>;
    };
    internals.httpPost = async () => ({
      status: 200,
      data: {
        code: 0,
        data: { domain: "mega-us-pr.eufy.com", product_domains: { eufy_security: "security-app-x.example.invalid" } },
      },
    });
    await mega.estimateDomain();
    internals.ensureSessionKey = async () => ({ keyIdent: "ident-0", shareKey: Buffer.alloc(32, 1).toString("hex") });
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ code: 0, data: { public_key: "cd".repeat(64) } }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await mega.getDevicePublicKey("T8520P0000000001");
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toMatch(
      /^https:\/\/security-app-x\.example\.invalid\/v3\//,
    );
  });
});
