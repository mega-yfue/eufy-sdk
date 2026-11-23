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
    expect(headers).toEqual({ country: "DE", timezone: expect.any(String) });
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
