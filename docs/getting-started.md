# Getting started

Install, build, log in, list devices.

::: info Independent and unofficial
eufy-sdk is not affiliated with, endorsed by, or sponsored by Anker Innovations, Anker eufy, or eufy.
"Anker eufy", "eufy" and "Anker" are trademarks of their respective owners. Use it with devices on
your own account.
:::

## Requirements

- **Node.js ≥ 24.5.0** — the client uses `node --env-file` and native fetch-era APIs, and needs the
  OpenSSL 3.5.1 that 24.5.0 bundles to decode E2E camera video. See `.nvmrc`.
- **Runtime dependencies — three:** `mqtt`, `protobufjs`, and `jpeg-js` (a pure-JS,
  zero-transitive-dependency, BSD-3-Clause baseline JPEG codec — required to reconstruct v2 push
  thumbnails; there is no Node built-in JPEG codec). Everything else is Node built-ins (`fetch`,
  `node:crypto`, `BigInt`). `jpeg-js` is synchronous, so a v2 reconstruction blocks the Node.js event
  loop while it runs — but it now decodes exactly ONE frame and re-encodes nothing: the frame geometry
  is read out of the thumbnail's entropy-coded scan, and the picture handed back is the camera's own
  scan under a rebuilt header. The synthetic 176×144 and 264×200 fixtures each take about 6 ms and
  about 0.4 MB of resident memory on one Node 24 test host (down from ~180 ms and ~45 MB when the
  search decoded candidate frames); timing varies by image and hardware.
- **`ffmpeg` — optional.** Needed only for the convenience decode/mux sinks: JPEG
  `snapshotLive()` and the one-shot `record(seconds)` buffer. The core paths — `live()`, `openReadable()`, `recordFragments()`
  (CMAF fMP4), and the passive stored `snapshotStored()` — need no ffmpeg. Resolved on `PATH` by
  default; a host that ships or manages its own build names it with `new EufyMega({ ffmpegPath })`
  instead of editing `PATH`, and `ffmpegAvailable(ffmpegPath)` answers whether that one is runnable.

## Install

```bash
npm install
npm run build
```

## Connect

The client logs into the Anker eufy "mega" (v6) cloud, keeps a **persistent session**, and models every
device as a capability-driven `Device`. `login()` returns a discriminated result — no exceptions for
the expected captcha / 2FA flow; step through it until authenticated. A restored session resolves
straight to `LoginStatus.Ok` with no network.

```ts
import { EufyMega, FileSessionStore, LoginStatus } from "@mega-yfue/eufy-sdk";

const eufy = new EufyMega({
  email: "you@example.com",
  password: "…",
  countryCode: "GB", // region auto-discovers (GB → eu-pr)
  // phoneModel: "…",  // optional — defaults to a stable random model (see below)
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
  straight to ready (no re-login / 2FA).
- **A rejected token recovers itself.** A stored session can be invalidated while you are not using it —
  it expires, or another login on the same account displaces it. `login()` resolving `ok` from the store
  says a session was _restored_, not that the cloud still honours it; the first call that uses it finds
  out. When the cloud rejects it, the client logs in again with the credentials it already has and
  finishes the call, so you see nothing. What surfaces (as a rejected promise carrying
  `SessionExpiredError`) is a recovery the client cannot complete alone: one needing **you** for a captcha
  or 2FA code, one with no credentials to use, one attempted mid-login, or a login that failed.
  `getDevices()` **rejects** in that case rather than resolving with an empty list, so an unauthenticated
  client never reads as an account with no devices.
- **Two clients on one account need two identities.** `openudid` defaults to a value derived from your
  credentials, so two clients built the same way look like the **same device** to the cloud — which keeps
  one session per device and evicts the other. Each then finds its token rejected and replaces it,
  displacing the other in turn. Give every client its own `openudid` and they coexist. Two clients that
  share one `store` are fine too: a client whose token is rejected adopts whatever the store now holds
  before it considers logging in.
- **Contention is bounded, not silent.** A token replaced once is ordinary; a second replacement soon
  after is treated as contention, so the client waits (a minute, doubling, capped at half an hour)
  instead of trading logins — repeated logins are what makes an account start demanding captchas. The
  rejection you get then names the likely cause and **carries the wait**: `SessionExpiredError.retryAfterMs`
  is how long to hold off before calling `login()` yourself, and `contended` says the session is being
  displaced rather than expiring. Honour it — a host that re-logs in every few seconds spends the same
  login war from outside the client, and your logins count against the same wait. A replacement that keeps
  working for ten minutes clears it.
- **Device identity:** `phoneModel` defaults to a **realistic random model**, seeded by `openudid` so it
  stays stable across runs (many installs no longer all report one identical model), and is persisted
  with the session. `openudid` itself defaults to a per-account value — give each client on the same
  account its own (see above). Set either explicitly to pin your own identity — e.g. a fixed `phoneModel`
  if you want this client to appear as one specific device in your account.

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

<!-- typecheck: skip — imports tslog, a package the reader has and this repo does not depend on -->

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

A **kicked/expired session** (another client logged into the account, or the token lapsed) is a
separate signal: it fires the dedicated `sessionExpired` event rather than `error`. The SDK has already
cleared the session, so handle it by re-driving `login()`:

```ts
eufy.on("sessionExpired", () => {
  // re-authenticate — a fresh login usually needs a 2FA code
});
```

## Full example

The minimal end-to-end — log in and print each device with its resolved capabilities:

<<< @/../examples/01-login-list-devices.ts

> The examples share a `_client.ts` helper that drives the login state machine from `EUFY_EMAIL` /
> `EUFY_PASSWORD` (and `EUFY_CAPTCHA` / `EUFY_2FA` when needed). Run after `npm run build`.

Next: [Devices & capabilities](/devices) · [Events](/events) · [Live media](/live-media).
