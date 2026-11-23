/**
 * Shared setup for the examples: construct the client and drive the login state machine.
 *
 * `login()` returns a discriminated result (no exceptions for the expected flow); step through it:
 *  - `captcha` → solve `result.image` and call `solveCaptcha(answer)`,
 *  - `2fa` → a code was sent; `submitVerifyCode(code)`.
 * Both are asked for on the terminal and answered in THIS process: a code or captcha belongs to the login
 * that requested it, and a re-run starts a new login, which issues a new one and invalidates the old.
 * A cached session (../.eufy-session.json) resolves straight to `ok`, so only the first run asks.
 *
 * Run with `node examples/01-login-list-devices.ts` (Node 24 strips types). Requires `npm run build`
 * first — the examples import the built lib from ../dist for real, typechecked types.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { EufyMega, FileSessionStore, LoginStatus, type EufyMegaOptions } from "../dist/index.js";

/**
 * Construct a client and drive login to completion, returning the authenticated client. `overrides`
 * are merged over the env-based defaults so an example can pass tuning knobs (e.g. `p2pIdleMs`)
 * without repeating the login boilerplate.
 */
export async function loginClient(overrides: Partial<EufyMegaOptions> = {}): Promise<EufyMega> {
  const eufy = new EufyMega({
    email: process.env.EUFY_EMAIL!,
    password: process.env.EUFY_PASSWORD!,
    countryCode: process.env.EUFY_COUNTRY || "GB",
    // Persist the token + ECDH key so re-runs skip login/2FA.
    store: new FileSessionStore(path.join(import.meta.dirname, "..", ".eufy-session.json")),
    ...overrides,
  });

  let r = await eufy.login();
  while (r.status !== LoginStatus.Ok) {
    if (r.status === LoginStatus.Captcha) {
      // r.image is a data:image/png;base64 captcha; save it so it can be opened and read.
      const file = path.join(import.meta.dirname, "..", ".eufy-captcha.png");
      writeFileSync(file, Buffer.from(r.image.replace(/^data:image\/\w+;base64,/, ""), "base64"));
      r = await eufy.solveCaptcha(await ask(`captcha required — open ${file} and type the characters`));
    } else if (r.status === LoginStatus.TwoFactor) {
      r = await eufy.submitVerifyCode(await ask(`2FA code sent (${r.method}) — enter it`));
    } else {
      throw new Error(`unexpected login status: ${JSON.stringify(r)}`); // exhaustive: never busy-loop
    }
  }
  return eufy;
}

/** Read one trimmed line from the terminal; throws when stdin is not a TTY. */
async function ask(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(`${prompt}: run this example in an interactive terminal (later runs reuse the cached session)`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${prompt}: `)).trim();
  } finally {
    rl.close();
  }
}
