# Getting started

Install, build, log in, list devices.

::: info Independent and unofficial
eufy-sdk is not affiliated with, endorsed by, or sponsored by Anker Innovations or eufy. "eufy" and
"Anker" are trademarks of their respective owners. Use it with devices on your own account.
:::

## Requirements

- **Node.js ≥ 24.5.0** — the client uses `node --env-file` and native fetch-era APIs, and needs the
  OpenSSL 3.5.1 that 24.5.0 bundles to decode E2E camera video. See `.nvmrc`.
- **Runtime dependencies — four:** `mqtt`, `protobufjs`, `werift`, and `jpeg-js` (a pure-JS,
  zero-transitive-dependency, BSD-3-Clause baseline JPEG codec — required to reconstruct v2 push
  thumbnails, which must be decoded and re-encoded; there is no Node built-in JPEG codec). Everything
  else is Node built-ins (`fetch`, `node:crypto`, `BigInt`). `jpeg-js` is synchronous: reconstructing a
  v2 thumbnail performs repeated candidate decodes and blocks the Node.js event loop until that image
  finishes. The synthetic 176×144 and 264×200 fixtures each took about one second on one Node 24 test
  host; timing varies by image and hardware.
- **`ffmpeg` — optional.** Needed only for the convenience decode/mux sinks: JPEG
  `snapshotLive()`, the one-shot `record(seconds)` buffer, and WebRTC container output (`.mp4`/`.mkv`;
  falls back to raw when absent). The core paths — `live()`, `openReadable()`, `recordFragments()`
  (CMAF fMP4), and the passive stored `snapshotStored()` — need no ffmpeg. Resolved on `PATH` by
  default; a host that ships or manages its own build names it with `new EufyMega({ ffmpegPath })`
  instead of editing `PATH`, and `ffmpegAvailable(ffmpegPath)` answers whether that one is runnable.

## Install

```bash
npm install
npm run build
```

## Connect

The client logs into the eufy "mega" (v6) cloud, keeps a **persistent session**, and models every
device as a capability-driven `Device`. `login()` returns a discriminated result — no exceptions for
the expected captcha / 2FA flow; step through it until authenticated. A restored session resolves
straight to `LoginStatus.Ok` with no network.

```ts
import { EufyMega, FileSessionStore, LoginStatus } from "@mega-yfue/eufy-sdk";

const eufy = new EufyMega({
  email: "you@example.com",
  password: "…",
  countryCode: "GB", // region auto-discovers (GB → eu-pr)
  phoneModel: "eufy-mega-client", // this client's device identity in your account
  store: new FileSessionStore("./.eufy-session.json"), // persist + reuse session
});

let r = await eufy.login();
while (r.status !== LoginStatus.Ok) {
  if (r.status === LoginStatus.Captcha) {
    r = await eufy.solveCaptcha(await promptUser(r.image)); // r.retry === true after a wrong answer
  } else if (r.status === LoginStatus.TwoFactor) {
    r = await eufy.submitVerifyCode(await promptUser()); // code sent automatically; r.method says how
  } else {
    throw new Error(`unexpected login status: ${JSON.stringify(r)}`);
  }
}

const devices = await eufy.getDevices();
```

Realtime is automatic: a successful `login()` brings up the event channels (push + MQTT) on its own,
and P2P to a camera opens on demand when a command / stream / doorbell ring needs it — no extra setup.
See [Connectivity & battery](/connectivity) and [Realtime transports](/realtime).

Notes:

- **Order:** login → (captcha if demanded) → (2FA if new/changed device) → token.
- **Captcha** triggers after repeated failed logins on an untrusted device; the result carries a PNG
  `image` data URL. Solve and call `solveCaptcha(answer)`.
- **Persistence:** with a `store`, the token + session key are saved and reused — later runs skip
  straight to ready (no re-login / 2FA) until the token expires (a 401 clears it).
- **Device identity:** set a distinct `phoneModel` / `openudid` so this client appears as its own
  trusted device rather than impersonating your phone.

## Logging

The client is **silent by default** — it emits diagnostics only through a `logger` you pass. To send
them to the console (the equivalent of a verbose "debug" mode), attach the built-in `ConsoleLogger`:

```ts
import { EufyMega, ConsoleLogger } from "@mega-yfue/eufy-sdk";

const eufy = new EufyMega({ email, password, logger: new ConsoleLogger() }); // verbose
// or gate by severity:
const quiet = new EufyMega({ email, password, logger: new ConsoleLogger("warn") }); // warn + error only
```

To route logs into your own stack, pass anything that implements the `Logger` shape
(`debug`/`info`/`warn`/`error` methods) — **tslog and winston satisfy it directly**:

```ts
import { Logger as TsLogger } from "tslog";
const eufy = new EufyMega({ email, password, logger: new TsLogger() });
```

A plain object works too (and is all pino needs, via a one-line adapter):

```ts
const eufy = new EufyMega({
  email,
  password,
  logger: {
    debug: (m, ...a) => myLog.debug(m, ...a),
    info: (m, ...a) => myLog.info(m, ...a),
    warn: (m, ...a) => myLog.warn(m, ...a),
    error: (m, ...a) => myLog.error(m, ...a),
  },
});
```

Diagnostics are separate from **operational errors** — always also handle the `error` event
(`eufy.on("error", …)`), which fires regardless of the logger.

## Full example

The minimal end-to-end — log in and print each device with its resolved capabilities:

<<< @/../examples/01-login-list-devices.ts

> The examples share a `_client.ts` helper that drives the login state machine from `EUFY_EMAIL` /
> `EUFY_PASSWORD` (and `EUFY_CAPTCHA` / `EUFY_2FA` when needed). Run after `npm run build`.

Next: [Devices & capabilities](/devices) · [Events](/events) · [Live media](/live-media).
