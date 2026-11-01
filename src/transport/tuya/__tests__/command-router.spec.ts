import { generateKeyPairSync } from "node:crypto";
import { TuyaCommandRouter } from "../command-router.js";
import { TuyaClient } from "../client.js";
import type { TuyaHttpPost } from "../request.js";

function makeTestRsaKey(): { n: string; e: string } {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 512 });
  const jwk = publicKey.export({ format: "jwk" }) as { n: string; e: string };
  const n = BigInt("0x" + Buffer.from(jwk.n, "base64url").toString("hex")).toString(10);
  const e = BigInt("0x" + Buffer.from(jwk.e, "base64url").toString("hex")).toString(10);
  return { n, e };
}

describe("TuyaCommandRouter", () => {
  it("bind resets loginOnce so a re-login triggers a fresh attempt", () => {
    const router = new TuyaCommandRouter();
    router.bind("uid-1");
    // @ts-expect-error — accessing private field for test
    router.loginOnce = Promise.resolve();
    router.bind("uid-2");
    // @ts-expect-error — accessing private field for test
    expect(router.loginOnce).toBeNull();
  });

  it("clears loginOnce on login failure so the next dispatch retries rather than re-throwing the stale error", async () => {
    const { n, e } = makeTestRsaKey();
    const tokenReply = { success: true, result: { token: "TOK", publicKey: n, exponent: e } };

    let loginAttempt = 0;
    const http: TuyaHttpPost = async (_url, body) => {
      const a = new URLSearchParams(body).get("a");
      if (a === "smartlife.m.user.username.token.get") return tokenReply;
      loginAttempt++;
      if (loginAttempt === 1) return { success: false, errorMsg: "TRANSIENT_FAILURE" };
      return { success: true, result: { sid: "good-sid", uid: "good-uid" } };
    };

    const router = new TuyaCommandRouter({ http });
    router.bind("uid-1");
    router.registerDevice("sn-1", "dev-1");

    const cmd = { kind: "aiot-dp" as const, dp: 101, value: true };

    // First dispatch: login fails with a transient error.
    await expect(router.dispatchCommand("sn-1", cmd)).rejects.toThrow(/TRANSIENT_FAILURE/);

    // loginOnce must be cleared after failure.
    // @ts-expect-error — accessing private field for test
    expect(router.loginOnce).toBeNull();

    // Second dispatch: login succeeds on the retry. publishDps may still fail (the stub doesn't handle
    // smartlife.m.device.dp.publish) — but the error must NOT be the stale TRANSIENT_FAILURE, proving
    // the login was retried rather than the rejected promise reused.
    const secondErr = await router.dispatchCommand("sn-1", cmd).catch((err: Error) => err.message);
    // second dispatch must not re-throw the stale TRANSIENT_FAILURE (it either succeeds or fails differently)
    expect(secondErr ?? "").not.toMatch(/TRANSIENT_FAILURE/);
  });

  it.each([true, false])("propagates publish acceptance=%s without an experimental opt-in", async (success) => {
    const http: TuyaHttpPost = async () => ({ success, errorCode: success ? undefined : "REJECTED" });
    const router = new TuyaCommandRouter({ http });
    router.registerDevice("sn-1", "dev-1");
    // @ts-expect-error — a preset session isolates publishing from login
    router.loginOnce = Promise.resolve();
    // @ts-expect-error — a preset session isolates publishing from login
    router.client = new TuyaClient({ signer: { sign: () => "0".repeat(64) }, chKey: "7cbfe6d8", sid: "s", http });
    const result = router.dispatchCommand("sn-1", { kind: "aiot-dp", dp: 101, value: true });
    if (success) await expect(result).resolves.toBeUndefined();
    else await expect(result).rejects.toThrow("REJECTED");
  });

  describe("fetchDps", () => {
    /** A router with a preset session whose dp.get answers `reply`; records the actions it sent. */
    function routerAnswering(reply: unknown): { router: TuyaCommandRouter; actions: string[] } {
      const actions: string[] = [];
      const http: TuyaHttpPost = async (_url, body) => {
        actions.push(new URLSearchParams(body).get("a")!);
        return reply;
      };
      const router = new TuyaCommandRouter({ http });
      router.registerDevice("sn-1", "dev-1");
      // @ts-expect-error — a logged-in client stands in for the login round-trip
      router.loginOnce = Promise.resolve();
      // @ts-expect-error — accessing private field for test
      router.client = new TuyaClient({ signer: { sign: () => "0".repeat(64) }, chKey: "7cbfe6d8", sid: "s", http });
      return { router, actions };
    }

    it("reads dp.get and answers its flat result, kept to integer DP keys with scalar values", async () => {
      const { router, actions } = routerAnswering({
        success: true,
        result: { "8": 37, "5": "standby", "47": true, x: 1, "113": { nested: 1 } },
      });
      expect(await router.fetchDps("sn-1")).toEqual({ 5: "standby", 8: 37, 47: true });
      expect(actions).toEqual(["smartlife.m.device.dp.get"]);
    });
  });
});
