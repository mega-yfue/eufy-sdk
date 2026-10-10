import { createCipheriv, generateKeyPairSync } from "node:crypto";
import { TuyaClient, genDeviceId } from "../client.js";
import { deriveBodyKey } from "../et3.js";
import type { TuyaSigner } from "../sign.js";
import type { TuyaHttpPost } from "../request.js";

/** Generate a minimal RSA public key and return its modulus/exponent as decimal strings. */
function makeTestRsaKey(): { n: string; e: string } {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 512 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const n = BigInt("0x" + Buffer.from(jwk.n, "base64url").toString("hex")).toString(10);
  const e = BigInt("0x" + Buffer.from(jwk.e, "base64url").toString("hex")).toString(10);
  return { n, e };
}

class FixedSigner implements TuyaSigner {
  sign(): string {
    return "f".repeat(64);
  }
}

/**
 * A minimal {@link TuyaHttpPost} stand-in: records each POST and replies from a queued list of envelopes.
 */
function stubHttp(replies: unknown[]): { http: TuyaHttpPost; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  let i = 0;
  const http: TuyaHttpPost = async (url, body) => {
    calls.push({ url, body });
    return replies[i++];
  };
  return { http, calls };
}

describe("genDeviceId", () => {
  it("returns a 44-hex-char id", () => {
    const id = genDeviceId();
    expect(id).toMatch(/^[0-9a-f]{44}$/);
    expect(genDeviceId()).not.toBe(id); // random
  });
});

describe("TuyaClient", () => {
  it("seeds the session from config (deviceId + chKey, empty sid pre-login)", () => {
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", deviceId: "a".repeat(44) });
    expect(c.getSession()).toEqual({ sid: "", deviceId: "a".repeat(44), chKey: "7cbfe6d8" });
    expect(c.loggedIn).toBe(false);
  });

  it("generates a deviceId when none is supplied", () => {
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8" });
    expect(c.getSession().deviceId).toMatch(/^[0-9a-f]{44}$/);
  });

  it("buildRequest embeds session fields and a sign", () => {
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", deviceId: "b".repeat(44) });
    const params = c.buildRequest({ a: "smartlife.p.time.get", v: "1.0" });
    expect(params.chKey).toBe("7cbfe6d8");
    expect(params.deviceId).toBe("b".repeat(44));
    expect(params.sign).toBe("f".repeat(64));
  });

  it("getDeviceDps posts the cache.dp.get action", async () => {
    const { http, calls } = stubHttp([{ success: true, result: { dps: {} } }]);
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", http });
    const res = await c.getDeviceDps("dev-1");
    expect(res.success).toBe(true);
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("a")).toBe("thing.m.device.cache.dp.get");
    expect(JSON.parse(body.get("postData")!)).toEqual({ devId: "dev-1", dpCacheType: 1 });
  });

  it("publishDps refuses to send by default (unverified write gate)", async () => {
    const { http, calls } = stubHttp([{ success: true }]);
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", http });
    await expect(c.publishDps("dev-1", "gw-1", { "101": true })).rejects.toThrow(/UNVERIFIED/);
    expect(calls).toHaveLength(0); // nothing was sent
  });

  it("publishDps posts the dp.publish action with nested dps when allowUnverified", async () => {
    const { http, calls } = stubHttp([{ success: true }]);
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", http });
    await c.publishDps("dev-1", "gw-1", { "101": true }, { allowUnverified: true });
    const body = new URLSearchParams(calls[0].body);
    expect(body.get("a")).toBe("thing.m.device.dp.publish");
    expect(JSON.parse(body.get("postData")!)).toEqual({
      gwId: "gw-1",
      devId: "dev-1",
      dps: JSON.stringify({ "101": true }),
    });
  });

  it("login runs username.token.get then password.login.reg and stores the sid", async () => {
    const { n, e } = makeTestRsaKey();
    const { http, calls } = stubHttp([
      { success: true, result: { token: "TOK-1", publicKey: n, exponent: e } },
      { success: true, result: { sid: "eu-sid-xyz", uid: "tuya-uid-9" } },
    ]);
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", http });
    const res = await c.login("12345", "44");

    expect(res).toEqual({ sid: "eu-sid-xyz", uid: "tuya-uid-9" });
    expect(c.loggedIn).toBe(true);
    expect(c.getSession().sid).toBe("eu-sid-xyz");

    // step 1 = username.token.get with the derived username
    const step1 = new URLSearchParams(calls[0].body);
    expect(step1.get("a")).toBe("smartlife.m.user.username.token.get");
    expect(JSON.parse(step1.get("postData")!)).toEqual({
      countryCode: "44",
      username: "eufyhome-12345",
      isUid: true,
    });

    // step 2 = password.login.reg carrying RSA-encrypted password + token
    const step2 = new URLSearchParams(calls[1].body);
    expect(step2.get("a")).toBe("smartlife.m.user.uid.password.login.reg");
    const pd = JSON.parse(step2.get("postData")!);
    expect(pd.token).toBe("TOK-1");
    expect(pd.uid).toBe("eufyhome-12345");
    expect(pd.ifencrypt).toBe(1);
    // passwd = RSA-PKCS1-encrypt(MD5hex(aesPassword)) — non-deterministic, check shape only
    expect(pd.passwd).toMatch(/^[0-9a-f]+$/);
  });

  it("login retries with fallback password '12345678' on USER_PASSWD_WRONG, then succeeds", async () => {
    const { n, e } = makeTestRsaKey();
    const tokenReply = { success: true, result: { token: "TOK-FB", publicKey: n, exponent: e } };
    const { http, calls } = stubHttp([
      tokenReply, // step 1: token.get for derived password
      { success: false, errorMsg: "USER_PASSWD_WRONG" }, // step 2: login with derived password fails
      tokenReply, // step 3: token.get again for fallback attempt
      { success: true, result: { sid: "fb-sid", uid: "fb-uid" } }, // step 4: login with "12345678"
    ]);
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", http });
    const res = await c.login("99999");
    expect(res).toEqual({ sid: "fb-sid", uid: "fb-uid" });
    expect(calls).toHaveLength(4);
    // The fallback attempt's login.reg carries a different encrypted password (MD5 of "12345678").
    // We don't check the exact ciphertext — just confirm a second login.reg was sent.
    expect(new URLSearchParams(calls[3].body).get("a")).toBe("smartlife.m.user.uid.password.login.reg");
  });

  it("login throws when both derived password and fallback fail with USER_PASSWD_WRONG", async () => {
    const { n, e } = makeTestRsaKey();
    const tokenReply = { success: true, result: { token: "TOK-X", publicKey: n, exponent: e } };
    const { http } = stubHttp([
      tokenReply,
      { success: false, errorMsg: "USER_PASSWD_WRONG" },
      tokenReply,
      { success: false, errorMsg: "USER_PASSWD_WRONG" },
    ]);
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", http });
    await expect(c.login("99999")).rejects.toThrow(/USER_PASSWD_WRONG.*derived.*fallback/i);
  });

  it("login throws when username.token.get yields no token", async () => {
    const { http } = stubHttp([{ success: false, errorMsg: "boom" }]);
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", http });
    await expect(c.login("12345")).rejects.toThrow(/username.token.get failed: boom/);
  });
});

describe("TuyaClient et=3 reply decryption", () => {
  /** Seal an inner envelope the way the server does, keyed off the request's own requestId + ecode. */
  function sealFor(requestId: string, ecode: string | null, inner: unknown): { result: string } {
    const key = deriveBodyKey(requestId, ecode);
    const nonce = Buffer.alloc(12, 7);
    const cipher = createCipheriv("aes-128-gcm", key, nonce);
    const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(inner))), cipher.final()]);
    return { result: Buffer.concat([nonce, ct, cipher.getAuthTag()]).toString("base64") };
  }

  it("decrypts an encrypted string result into an object the caller reads", async () => {
    const http: TuyaHttpPost = async (_url, body) => {
      const reqId = new URLSearchParams(body).get("requestId")!;
      return sealFor(reqId, null, { success: true, result: { dps: { "8": "100" } } });
    };
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", sid: "preset-sid", http });
    const res = await c.getDeviceDps<{ dps: Record<string, unknown> }>("dev-1");
    expect(res.success).toBe(true);
    expect(res.result).toEqual({ dps: { "8": "100" } });
  });

  it("login decrypts its replies (null variant), captures ecode, and keys later calls with it", async () => {
    const { n, e } = makeTestRsaKey();
    const http: TuyaHttpPost = async (_url, body) => {
      const p = new URLSearchParams(body);
      const reqId = p.get("requestId")!;
      const a = p.get("a");
      if (a === "smartlife.m.user.username.token.get") {
        return sealFor(reqId, null, { success: true, result: { token: "T", publicKey: n, exponent: e } });
      }
      if (a === "smartlife.m.user.uid.password.login.reg") {
        return sealFor(reqId, null, { success: true, result: { sid: "sid-1", uid: "uid-1", ecode: "EC-xyz" } });
      }
      // A post-login session call must decrypt with the captured ecode, not the null variant.
      return sealFor(reqId, "EC-xyz", { success: true, result: { dps: { "8": "50" } } });
    };
    const c = new TuyaClient({ signer: new FixedSigner(), chKey: "7cbfe6d8", http });
    const res = await c.login("12345", "44");
    expect(res).toEqual({ sid: "sid-1", uid: "uid-1" });
    expect(c.getSession().ecode).toBe("EC-xyz");

    const dps = await c.getDeviceDps<{ dps: Record<string, unknown> }>("dev-1");
    expect(dps.result).toEqual({ dps: { "8": "50" } });
  });
});
