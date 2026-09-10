/**
 * Offline round-trip tests for {@link SolixClient}. A synthetic in-memory "server" performs the real
 * server side of the algo_ecdh handshake (decrypt the client public key with the bootstrap localKey,
 * ECDH, encrypt its own public key back) so the client's key-exchange, encrypted-login decryption,
 * `gtoken` derivation and plain authenticated reads are all exercised end-to-end — no network, no
 * account data, deterministic.
 */
import { createCipheriv, createDecipheriv, createECDH, createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encryptBody } from "../../core/index.js";
import { SolixClient, buildModelIndex, type SolixPersisted, type SolixSessionStore } from "../solix-client.js";
import { SOLIX_LOCAL_KEY_HEX } from "../constants.js";

const LOCALKEY = Buffer.from(SOLIX_LOCAL_KEY_HEX, "hex");
const USER_ID = "3eed26fb3e31504ca4b103cedc279b4a1406c39c";
const md5 = (s: string): string => createHash("md5").update(s).digest("hex");

/** Server side of one key exchange: returns the wrapped server public key + the negotiated share key. */
function serverKeyExchange(clientPublicKeyB64: string): { serverPublicKey: string; shareKey: string } {
  const raw = Buffer.from(clientPublicKeyB64, "base64");
  const dec = createDecipheriv("aes-128-cbc", LOCALKEY, raw.subarray(0, 16));
  const clientPubHex = Buffer.concat([dec.update(raw.subarray(16)), dec.final()]).toString("utf-8");
  const s = createECDH("prime256v1");
  s.generateKeys();
  const serverPubHex = s.getPublicKey("hex", "uncompressed");
  const shareKey = s.computeSecret(Buffer.from(clientPubHex, "hex")).toString("hex").padStart(64, "0").slice(0, 32);
  const iv = randomBytes(16);
  const c = createCipheriv("aes-128-cbc", LOCALKEY, iv);
  const wrapped = Buffer.concat([iv, c.update(serverPubHex, "utf-8"), c.final()]).toString("base64");
  return { serverPublicKey: wrapped, shareKey };
}

/**
 * Build a fetch double for the Solix cloud. `faInfo` drives the 2FA branch: non-empty on the first
 * login, empty (satisfied) once a verify_code is present.
 */
function makeServer(opts: { devices?: unknown[]; twoFactor?: boolean } = {}): {
  fetchImpl: typeof fetch;
  calls: { path: string; headers: Record<string, string> }[];
} {
  const calls: { path: string; headers: Record<string, string> }[] = [];
  let shareKey = "";
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    calls.push({ path: u.pathname, headers });
    const body = String(init?.body ?? "");
    const reply = (obj: unknown): Response => new Response(JSON.stringify(obj), { status: 200 });

    if (u.pathname.endsWith("/passport/estimate_domain"))
      return reply({ code: 0, msg: "success!", data: { domain: u.hostname } });
    if (u.pathname.endsWith("/oauth/key/exchange")) {
      const { serverPublicKey, shareKey: sk } = serverKeyExchange(JSON.parse(body).client_public_key);
      shareKey = sk;
      return reply({ code: 0, msg: "success!", data: { server_public_key: serverPublicKey } });
    }
    if (u.pathname.endsWith("/passport/login")) {
      const hasVerify = new Headers(init?.headers).has("x-request-ts"); // login is always signed; use body to detect verify
      void hasVerify;
      const isVerify = body.length > 0 && JSON.parse(safeDecrypt(body, shareKey)).verify_code;
      const faInfo = opts.twoFactor && !isVerify ? { info: "pending", step: 1 } : { info: "", step: 0 };
      const loginData = {
        user_id: USER_ID,
        auth_token: "TOKEN48".padEnd(48, "x"),
        geo_key: "g".repeat(32),
        token_expires_at: 1_900_000_000,
        fa_info: faInfo,
      };
      return reply({ code: 0, msg: "success!", data: encryptBody(JSON.stringify(loginData), shareKey) });
    }
    if (u.pathname.endsWith("/get_relate_and_bind_devices"))
      return reply({ code: 0, msg: "success!", data: { data: opts.devices ?? [] } });
    if (u.pathname.endsWith("/get_site_list")) return reply({ code: 0, msg: "success!", data: { site_list: [] } });
    if (u.pathname.endsWith("/product_categories"))
      return reply({
        code: 0,
        msg: "success!",
        data: [
          {
            name: "Portable Power Station",
            products: [{ product_code: "A1782", name: "SOLIX F3000", p_codes: ["2301", { product_code: "2302" }] }],
          },
        ],
      });
    return reply({ code: 404, msg: "unknown" });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** Decrypt an encrypted request body (server side) — only needed to read the verify_code flag. */
function safeDecrypt(b64: string, shareKeyHex: string): string {
  try {
    const raw = Buffer.from(b64, "base64");
    const d = createDecipheriv("aes-128-cbc", Buffer.from(shareKeyHex, "hex").subarray(0, 16), raw.subarray(0, 16));
    return Buffer.concat([d.update(raw.subarray(16)), d.final()]).toString("utf-8");
  } catch {
    return "{}";
  }
}

describe("SolixClient", () => {
  it("logs in over the algo_ecdh handshake and establishes a session with gtoken = md5(user_id)", async () => {
    const { fetchImpl } = makeServer();
    const client = new SolixClient({ email: "a@b.co", password: "pw", countryCode: "GB", fetchImpl });
    const r = await client.login();
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.session.userId).toBe(USER_ID);
    expect(r.session.gtoken).toBe(md5(USER_ID));
    expect(r.session.tokenExpiresAt).toBe(1_900_000_000);
  });

  it("reads the account's devices with a plain authenticated request carrying gtoken + x-auth-token", async () => {
    const { fetchImpl, calls } = makeServer({ devices: [{ device_sn: "A17C0ABC", device_pn: "A17C0" }] });
    const client = new SolixClient({ email: "a@b.co", password: "pw", fetchImpl });
    await client.login();
    const devices = (await client.getDevices()) as { device_sn: string }[];
    expect(devices).toHaveLength(1);
    expect(devices[0].device_sn).toBe("A17C0ABC");
    const read = calls.find((c) => c.path.endsWith("/get_relate_and_bind_devices"))!;
    expect(read.headers["x-auth-token"]).toBeTruthy();
    expect(read.headers["gtoken"]).toBe(md5(USER_ID));
    expect(read.headers["x-encryption-info"]).toBeUndefined(); // reads are PLAIN
  });

  it("surfaces a 2FA challenge and completes it with submitVerifyCode", async () => {
    const { fetchImpl } = makeServer({ twoFactor: true });
    const client = new SolixClient({ email: "a@b.co", password: "pw", fetchImpl });
    const first = await client.login();
    expect(first.status).toBe("2fa");
    const done = await client.submitVerifyCode("123456");
    expect(done.status).toBe("ok");
    expect(client.session?.gtoken).toBe(md5(USER_ID));
  });

  it("throws a typed error when reading before login", async () => {
    const { fetchImpl } = makeServer();
    const client = new SolixClient({ email: "a@b.co", password: "pw", fetchImpl });
    await expect(client.getDevices()).rejects.toThrow(/not authenticated/);
  });

  it("sends a stable openudid derived from the email (so the account does not re-prompt 2FA)", async () => {
    const { fetchImpl, calls } = makeServer();
    const a = new SolixClient({ email: "same@b.co", password: "pw", fetchImpl });
    await a.login();
    const b = new SolixClient({ email: "same@b.co", password: "pw", fetchImpl });
    await b.login();
    const udids = calls.filter((c) => c.headers["openudid"]).map((c) => c.headers["openudid"]);
    expect(new Set(udids).size).toBe(1); // identical across separate instances of the same account
  });

  it("persists the session to a store and reuses it on a warm start without re-logging in", async () => {
    const mem: { v?: SolixPersisted } = {};
    const store: SolixSessionStore = { load: () => mem.v, save: (d) => (mem.v = d) };
    const s1 = makeServer();
    await new SolixClient({ email: "a@b.co", password: "pw", store, fetchImpl: s1.fetchImpl }).login();
    expect(mem.v?.session?.authToken).toBeTruthy();

    // Warm start: a fresh client with the same store must NOT hit the login endpoint.
    const s2 = makeServer();
    const warm = new SolixClient({ email: "a@b.co", password: "pw", store, fetchImpl: s2.fetchImpl });
    const r = await warm.login();
    expect(r.status).toBe("ok");
    expect(s2.calls.some((c) => c.path.endsWith("/passport/login"))).toBe(false);
    expect(warm.session?.gtoken).toBe(md5(USER_ID));
  });

  it("fetches the product catalog and indexes model codes (incl. variants) to name + category", async () => {
    const { fetchImpl } = makeServer();
    const client = new SolixClient({ email: "a@b.co", password: "pw", fetchImpl });
    await client.login();
    const catalog = await client.getProductCatalog();
    const index = buildModelIndex(catalog);
    expect(index.get("A1782")).toEqual({ name: "SOLIX F3000", category: "Portable Power Station" });
    // both the string and object variant codes resolve to the parent product
    expect(index.get("2301")?.name).toBe("SOLIX F3000");
    expect(index.get("2302")?.name).toBe("SOLIX F3000");
  });
});
