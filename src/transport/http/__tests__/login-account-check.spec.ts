import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const credentials = vi.hoisted(() => vi.fn());
vi.mock("../passport.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../passport.js")>();
  credentials.mockImplementation(real.loginCredentials);
  return { ...real, loginCredentials: credentials };
});

import { EufyCloudErrorCode, LoginStatus, MegaApiError, MegaHttpClient } from "../mega-client.js";

/**
 * The account check the app's `MegaAccountNetManager.login` runs before `/passport/login`: `validate_email`,
 * whose `enc_text: "sha2"` sends the password as its SHA-256 hex, and one `estimate_domain` retry on a domain
 * mismatch. Synthetic account; the wire is a stub.
 */
const OK = { user_id: "synthetic-user", auth_token: "synthetic-token", fa_info: { info: "" } };

function client(answer: (path: string) => unknown) {
  const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: " pw ", region: "us-pr" });
  const internals = mega as unknown as Record<string, unknown>;
  internals.ensureSessionKey = vi.fn(async () => (internals.sessionKey = { shareKey: "00".repeat(32), keyIdent: "k" }));
  const estimate = vi.fn(async () => {});
  internals.estimateDomain = estimate;
  const paths: string[] = [];
  internals.postSigned = vi.fn(async (_host: string, path: string) => {
    paths.push(path);
    const r = answer(path);
    if (r instanceof Error) throw r;
    return r;
  });
  credentials.mockClear();
  return { mega, paths, estimate };
}

describe("login account check", () => {
  it("hashes the password when validate_email answers enc_text sha2", async () => {
    const { mega, paths } = client((p) => (p === "/passport/validate_email" ? { enc_text: "sha2" } : OK));
    expect((await mega.login()).status).toBe(LoginStatus.Ok);
    expect(paths).toEqual(["/passport/validate_email", "/passport/login"]);
    expect(credentials.mock.calls[0]![1]).toBe(createHash("sha256").update("pw").digest("hex"));
  });

  it("sends the password as given otherwise", async () => {
    const { mega } = client((p) => (p === "/passport/validate_email" ? { status: "registered" } : OK));
    await mega.login();
    expect(credentials.mock.calls[0]![1]).toBe(" pw ");
  });

  it("re-estimates the domain once on a mismatch and retries", async () => {
    let mismatches = 1;
    const mismatch = () => new MegaApiError("mismatch", EufyCloudErrorCode.DOMAIN_MISMATCH, 200);
    const { mega, paths, estimate } = client((p) =>
      p === "/passport/login" && mismatches-- > 0 ? mismatch() : p === "/passport/login" ? OK : {},
    );
    expect((await mega.login()).status).toBe(LoginStatus.Ok);
    expect(estimate).toHaveBeenCalledOnce();
    expect(paths).toEqual([
      "/passport/validate_email",
      "/passport/login",
      "/passport/validate_email",
      "/passport/login",
    ]);

    const twice = client((p) => (p === "/passport/login" ? mismatch() : {}));
    await expect(twice.mega.login()).rejects.toBeInstanceOf(MegaApiError);
    expect(twice.estimate).toHaveBeenCalledOnce();
  });
});
