# Troubleshooting & debugging

When something misbehaves, work in this order: **turn on logging → listen for `error` → match the
symptom below.**

## 1. Turn on logging

The client is **silent by default** — it emits diagnostics only through a `logger` you pass. Attach
the built-in `ConsoleLogger` to send verbose logs to the console across every channel (login, secure
MQTT, P2P, push, live media), each line prefixed by subsystem (`[mega]` / `[smqtt]` / `[p2p]` /
`[push]` / `[fcm]` / `[live]`):

```ts
import { EufyMega, ConsoleLogger } from "@mega-yfue/eufy-sdk";

const eufy = new EufyMega({ email, password, region: "eu-pr", logger: new ConsoleLogger() });
// or gate by severity — warnings and errors only:
const quiet = new EufyMega({ email, password, region: "eu-pr", logger: new ConsoleLogger("warn") });
```

Any logger with `debug` / `info` / `warn` / `error` methods works too (tslog and winston fit
directly; pino via a one-line adapter) — see [Getting started](/getting-started#logging).

## 2. Listen for `error`

The realtime channels are independent — one channel's failure surfaces on the facade's catch-all
`error` event **without aborting the others**. Always attach a handler; an unhandled `error` on an
`EventEmitter` throws.

```ts
eufy.on("error", (err) => console.error("[eufy]", err));
```

Media streams have their own `error` (including a start stall — see below) and a `stop`:

```ts
const stream = await cam?.live?.();
stream?.on("error", (err) => console.error("stream", err));
stream?.on("stop", () => console.log("source ended — re-attach to rebuild"));
```

**Auth loss is a separate signal.** A kicked/expired cloud session (another client logged into the
account, or the token lapsed) does **not** come through `error` — it fires `sessionExpired`. The SDK
has already cleared the session, so handle it by re-driving `login()` (usually a fresh 2FA):

```ts
eufy.on("sessionExpired", async (err) => {
  // The error carries the wait the SDK has already worked out; your own backoff takes the longer of
  // the two. err.contended means something else is signing in on this account.
  setTimeout(() => void eufy.login(), Math.max(err.retryAfterMs, 5_000)); // then submit the 2FA code
});
```

## 3. Common symptoms

| Symptom / error                                                                   | Likely cause                                                                                                                                                                                                                         | What to do                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `login() first`                                                                   | a method was called before authentication finished                                                                                                                                                                                   | `await eufy.login()` and step through captcha/2FA until `ok`, then continue                                                                                                                                               |
| `no pending captcha — call login() first`                                         | `solveCaptcha()` called without an active challenge                                                                                                                                                                                  | drive the `login()` result: only call `solveCaptcha` when `status === "captcha"`                                                                                                                                          |
| Captcha keeps appearing / logins briefly blocked                                  | repeated failed-password logins on one device fingerprint trip an abuse cooldown                                                                                                                                                     | give the client its own distinct `phoneModel` / `openudid`, then back off before retrying (see [Getting started](/getting-started))                                                                                       |
| 2FA prompt on every run                                                           | the device fingerprint changed, so it looks like a new device                                                                                                                                                                        | keep `openudid` stable and use a `store` so the session persists                                                                                                                                                          |
| `sessionExpired` again and again, the message mentioning displacement             | something else is signed in on this account — the cloud holds about one session per account and device identity, so each login ends the other's                                                                                      | honour `err.retryAfterMs` (it doubles per replacement, your own logins included) and give each client its own `openudid`; where the other client is a phone app on the same account, a session of its own is the only fix |
| `dev.camera is not a function` (or any other capability)                          | a device carries only the accessors for capabilities it has, so the accessor is absent — not a function returning `undefined`. A capability the device hadn't yet reported evidence for is added when it does (`deviceCapabilities`) | call it optionally: `dev.camera?.()?.on()`. Branch on `dev.has("camera")` or read `dev.capabilities` to decide what a device can do; the presence of an accessor is not a check you should write yourself                 |
| A write method is missing from `dev.<cap>()` (e.g. no `lock().setOneTouchLock()`) | that write isn't confirmed on a mega device yet, so it's absent rather than present-and-throwing (currently a few `lock` settings)                                                                                                   | expected — a method being present means its wire is verified; the read getter still works. (The untyped `setProperty` escape hatch still throws "wire unverified" for such a write.)                                      |
| A command fails only on a standalone camera                                       | some controls need a HomeBase-attached device and aren't available standalone                                                                                                                                                        | expected — drive that control on a HomeBase-attached device, or use the property that adapts automatically                                                                                                                |
| `live stream failed to start (no frames within warm-up window)`                   | the source never produced a frame in time                                                                                                                                                                                            | handle the stream `error`, then call `cam.live()` again to rebuild                                                                                                                                                        |
| `timeout waiting for a clean keyframe`                                            | a snapshot/record couldn't get a keyframe in the window                                                                                                                                                                              | retry, or widen the timeout via the call's options                                                                                                                                                                        |
| `the P2P session closed … into the clip` / `the stream failed during the clip`    | `record()`'s own pull went away before the clip's window elapsed                                                                                                                                                                     | retry once the session is back; a clip shorter than requested is returned rather than failed when the camera simply goes quiet                                                                                            |
| `ffmpeg not runnable` / snapshot or record fails                                  | no runnable `ffmpeg` (needed for JPEG snapshot / mp4 record)                                                                                                                                                                         | point the SDK at the binary you ship with `ffmpegPath`, install `ffmpeg`, or use the ffmpeg-free paths (`openReadable()`, `recordFragments()`); see [§5](#_5-media-snapshot-record-ffmpeg)                                |
| `p2p down` / `smqtt reconnecting` on `error`                                      | a transient transport drop                                                                                                                                                                                                           | the channels reconnect on their own; re-attach live streams when a consumer gets `stop`                                                                                                                                   |

## 4. Streams that hang or stop

- **No silent hang.** `live()` keeps nudging the start until the first frame arrives; if none comes in
  the warm-up window it emits `error` rather than hanging. Handle `error`.
- **Reconnect.** On a dropped session the source stops and consumers get `stop` / `error`. Call
  `cam.live()` again to rebuild the pull. See [Consuming a live stream](/live-media) for the full
  lifecycle (one pull / many consumers, keyframe priming, power budgets).
- **Trace the lifecycle.** With a logger attached (§1), `[live …]` lines trace a stream warming, going
  live, a warm-up timeout, an upstream drop, and the linger-before-teardown — the detail you want when
  a live view won't start or drops unexpectedly.
- **Match startup traces on the published vocabulary, not on strings.** Every startup trace is logged
  under `LIVE_TRACE_MESSAGE` with a `LiveTrace` payload, and **both are exported from the package root**:

  ```ts
  import { LIVE_TRACE_MESSAGE, type LiveTrace } from "@mega-yfue/eufy-sdk";
  ```

  A host that bounds or redacts what it retains should key its phase allowlist off the union, so a phase
  added here fails to compile rather than being discarded:

  <!-- typecheck: skip — the tail of a larger expression, shown alone to make the `satisfies` clause the point -->

  ```ts
  } satisfies Record<LiveTrace["phase"], true>;
  ```

  Copying the message literal or the phase names by hand is the one thing that cannot survive a new phase
  being added — the SDK widens that union without needing any coordination from you.

## 5. Media (snapshot / record / ffmpeg)

The JPEG snapshot (`snapshotLive`) and one-shot `record` paths shell out to `ffmpeg`.

**No `ffmpeg` on `PATH`?** That is ordinary on a managed host, and it does not mean these paths are
unavailable — name the binary you ship instead of editing the process `PATH`:

```ts
const eufy = new EufyMega({ email, password, ffmpegPath: "/opt/your-host/bin/ffmpeg" });
```

An absolute path is spawned directly, with no `PATH` lookup. It is not probed at construction, so a
wrong path surfaces as the media call's own `ffmpeg not runnable` rejection; check it up front with
`ffmpegAvailable(path)`, which resolves the same executable the media paths will run.

When one of them fails, surface ffmpeg's **own** diagnostics through your logger: raise
`ffmpegLogLevel` on the client and the SDK forwards ffmpeg's stderr as `[ffmpeg]`-prefixed **debug**
lines.

```ts
const eufy = new EufyMega({ email, password, ffmpegLogLevel: "trace", logger: new ConsoleLogger("debug") });
```

Accepted values (quiet → loud): `quiet` `panic` `fatal` `error` (default) `warning` `info` `verbose`
`debug` `trace`. An unset/invalid value stays at `error`.

This is ffmpeg's own verbosity — **orthogonal** to the `Logger`'s min-level, which still gates whether
the `[ffmpeg]` lines are shown. So to see them you need **both**: a level above `error` **and** a
logger that shows `debug` (e.g. `new ConsoleLogger("debug")`).

Note the ffmpeg-free egress paths don't need any of this: `openReadable()` (raw Annex-B bytes) and
`recordFragments()` (fMP4 / CMAF) mux without `ffmpeg` on `PATH`.

## 6. Login & session issues

Captcha and 2FA are **expected flow, not errors** — `login()` returns a status to switch on, it does
not throw. Rapid or repeated failed logins can trigger a captcha or a short cooldown even for valid
credentials. Full flow and persistence rules are in [Getting started](/getting-started).

A session that keeps being rejected is the one to slow down on rather than retry through: the rejection
carries `retryAfterMs`, and every login you spend — not only the SDK's own — doubles it. `contended` on
the error says the token is being displaced by another client rather than expiring, which no re-login
fixes.

## Still stuck?

Re-run with `new ConsoleLogger("debug")`, capture the `error` output, and check the behavior against
the [API reference](/api/) for the method you're calling — signatures and the events each one emits are
documented there.
