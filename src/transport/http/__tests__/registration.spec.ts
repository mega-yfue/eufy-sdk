import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MegaHttpClient } from "../mega-client.js";

const HOST = "app-passport-us-pr.eufy.com";
const EMAIL = "new@example.invalid";

function client() {
  const mega = new MegaHttpClient({ email: EMAIL, password: "x", region: "us-pr", countryCode: "DE" });
  return { mega, post: vi.spyOn(mega, "postSigned").mockResolvedValue({}) };
}

describe("MegaHttpClient account registration", () => {
  it("drives the app's sign-up calls unauthenticated on the passport host", async () => {
    const { mega, post } = client();
    post.mockResolvedValueOnce({ status: "unregistered" });
    expect(await mega.accountRegistered(EMAIL)).toBe(false);
    expect(post).toHaveBeenLastCalledWith(HOST, "/passport/validate_email", { email: EMAIL }, false, {}, {});
    post.mockResolvedValueOnce({ status: "registered" });
    expect(await mega.accountRegistered(EMAIL)).toBe(true);

    await mega.sendRegisterCode(EMAIL);
    expect(post).toHaveBeenLastCalledWith(
      HOST,
      "/passport/verification_sending",
      { email: EMAIL, answer: "", captcha_id: "" },
      false,
      {},
      {},
    );
    await mega.sendRegisterCode(EMAIL, { answer: "ab12", captchaId: "cap-0" });
    expect(post.mock.lastCall![2]).toEqual({ email: EMAIL, answer: "ab12", captcha_id: "cap-0" });

    await mega.checkRegisterCode(EMAIL, "123456");
    expect(post.mock.lastCall!.slice(1, 3)).toEqual([
      "/passport/verification_check",
      { email: EMAIL, verify_code: "123456", type: "regist" },
    ]);

    await mega.registerAccount({ email: EMAIL, password: " secret-pw ", verifyCode: "123456", subscribe: true });
    const [host, path, body, authed, , headers] = post.mock.lastCall!;
    expect([host, path, authed]).toEqual([HOST, "/passport/register_create_account", false]);
    expect(body).toEqual({
      email: EMAIL,
      password: createHash("sha256").update("secret-pw").digest("hex"),
      verify_code: "123456",
      answer: "",
      captcha_id: "",
      is_subscribe: true,
      country_code: "DE",
    });
    expect(headers).toEqual({ country: "DE" });
  });

  it("sends the host's time zone on every call, as the app's global headers do", () => {
    const { mega } = client();
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect((mega as unknown as { baseHeaders: () => Record<string, string> }).baseHeaders().timezone).toBe(zone);
  });

  it("activates an inactive account with the token the resend answers", async () => {
    const { mega, post } = client();
    post.mockResolvedValueOnce({ active_token: "tok-0" });
    expect(await mega.sendActivationCode(EMAIL)).toBe("tok-0");
    expect(post.mock.lastCall!.slice(1, 4)).toEqual([
      "/passport/resend_active_email",
      { email: EMAIL, answer: "", captcha_id: "" },
      false,
    ]);
    await mega.activateAccount("tok-0", "654321");
    expect(post.mock.lastCall!.slice(1, 4)).toEqual([
      "/passport/activate_register",
      { activation_code: "tok-0", verify_code: "654321" },
      false,
    ]);
  });
});

describe("MegaHttpClient passport body", () => {
  it("goes out as application/json, as every esiotkit body does", async () => {
    const mega = new MegaHttpClient({ email: EMAIL, password: "x", region: "us-pr" });
    const internals = mega as unknown as Record<string, unknown>;
    internals.ensureSessionKey = async () => ({ shareKey: "00".repeat(32), keyIdent: "k" });
    const types: string[] = [];
    internals.httpPost = vi.fn(async (_url: string, _body: unknown, headers: Record<string, string>) => {
      types.push(headers["content-type"]!);
      return { status: 200, data: { code: 0, data: {} } };
    });
    await mega.accountRegistered(EMAIL);
    expect(types).toEqual(["application/json"]);
  });
});

describe("MegaHttpClient estimate_domain", () => {
  it("asks mega-us-pr with the configured country code, whatever the region", async () => {
    const mega = new MegaHttpClient({ email: EMAIL, password: "x", region: "eu-pr", countryCode: "FR" });
    const post = vi.fn(async () => ({ status: 200, data: { code: 0, data: {} } }));
    (mega as unknown as { httpPost: typeof post }).httpPost = post;
    await mega.estimateDomain();
    expect(post.mock.calls[0]!.slice(0, 2)).toEqual([
      "https://mega-us-pr.eufy.com/passport/estimate_domain",
      { ab: "FR", mode: 1 },
    ]);
  });
});
