# Connectivity & battery

The SDK owns connectivity — there's no transport to open by hand. The SDK decides when a transport
is worth bringing up for the request at hand, keeps battery cameras asleep when nobody is looking, and
serves repeat reads from a cache instead of re-hitting the device or the cloud. This page explains what
happens automatically and the few knobs you can turn.

## What happens on login

A successful `login()` starts the **always-on, battery-safe** channels:

- **FCM push** — the account-wide event stream (motion, doorbell, contact, lock, …). Events flow over
  push independently of P2P.
- **Secure MQTT** — started only if the account has appliances (vacuum / light / plug / display).

Neither touches your cameras, so neither drains a battery. **P2P is not opened on login** for a
standalone battery camera — it comes up on demand (below). HomeBases, mains-only cameras, and standalone
devices with an explicit `always-on` claim are exceptions: their P2P sessions are warmed at login and
kept persistent.

```ts
const eufy = new EufyMega({ email, password, countryCode });
await eufy.login(); // push + MQTT (if needed) + wired-P2P warm-up, automatically
```

To manage nothing automatically (advanced / tests), construct with `{ autoRealtime: false }`.

## Battery cameras: open on demand, detach when idle

A standalone **battery** camera is only reached over P2P when something actually needs it — a control
command, a live stream or fresh `snapshotLive()`, or a pre-warm you opted into. After the last of those
finishes, the session lingers for the idle window and then closes, so the camera can return to sleep. A
persistent P2P session would keep it awake with a heartbeat every few seconds; opening on demand avoids
that.

- **Reads don't wake the camera.** `dev.getProperty(...)` is served from cache / the cloud, never a
  P2P pull — so a host polling a device every ~15 s does not drain the battery.
- **Stored snapshots don't wake the camera.** `snapshotStored()` only reads a push thumbnail already
  retained in memory; it performs no network or P2P work when called.
- **Mains-only cameras / HomeBases** stay connected, so their realtime state is always live.

The tier is decided per **station** (`parentSn`), and there is **one P2P session per station**, not per
device — only a genuinely standalone battery device idle-detaches.

```ts
new EufyMega({
  email,
  password,
  countryCode,
  p2pIdleMs: 5 * 60_000, // idle window before a battery station detaches (default 5 min)
});
```

Battery drain has two windows, one per state — the same power model, enforced at two layers:

- **Idle** (nobody using it) → the session idle-detach above closes the P2P session so the camera sleeps.
- **Actively streaming** (you're watching) → the stream can't idle-detach because a viewer is attached,
  so a separate **power budget** bounds a long continuous stream: after the budget it asks you to keep
  watching (`extend()`), else it auto-stops the stream — which then releases the session and lets the
  idle-detach take over. Configure/consume it on the stream itself — see
  [Live media → Power budget](/live-media).

### Local operating-power override

Every bound device with the `battery()` capability can carry a local operating-power claim. It changes
the SDK's session and live-stream policy; it sends no command to the device and does not alter battery
level or charging readings.

```ts
const deviceSn = "T8000P0000000000"; // synthetic example
const dev = await eufy.getDevice(deviceSn);
dev.battery?.()?.setPowerOverride?.("always-on"); // persistent standalone P2P, unbounded live stream
dev.battery?.()?.powerOverride?.(); // "always-on"
dev.battery?.()?.setPowerOverride?.("battery"); // restore battery limits immediately
dev.battery?.()?.setPowerOverride?.("auto"); // clear the local claim
```

`auto` budgets a device with a physical battery even if it reports charging. Charging proves input is
present, but does not prove that input can sustain a continuous stream. An `always-on` claim is an
explicit choice for a device whose installation can support a persistent session and stream. Changing
the claim updates an open shared stream and an idle standalone station session immediately. An attached
camera's claim affects its stream; its HomeBase owns the station session.

To restore claims when constructing a new client, pass `powerOverrides: { [deviceSn]: "always-on" }`.
Runtime changes are held in the client instance and are not saved in the login session.

### Battery cameras behind a wired HomeBase

A common worry: if a battery camera is attached to a wired HomeBase (whose session stays persistent),
is the camera held awake and draining? **No.** The persistent session is the **HomeBase ↔ app** link —
the base is wired, so its heartbeat drains nothing, and there is no separate always-on P2P link to the
child camera. The HomeBase manages its children's sleep/wake itself, whether or not an app session is
open.

- The child camera only draws power when you actually **start** a stream / command on its channel; when
  the stream ends its shared pull lingers briefly and stops, and the camera sleeps again. Its drain is
  bounded by the **stream** lifecycle, not the session's.
- While you're watching an attached battery child, the battery budget still applies (the `powered` hint
  comes from the child's own capabilities, not the station), so a long continuous stream auto-stops the
  same way a standalone one does — see [Live media](/live-media).
- Events keep flowing over push regardless. So a HomeBase setup is battery-friendly by design: the
  wired base absorbs the always-on cost, the children sleep. Keying the tier on the station (not the
  child) is what makes that work — the base session is never torn down to "save" a child that isn't
  draining from it.

## Event pre-warm → instant live view (opt-in)

When an event arrives, a user often taps to watch a few seconds later. The SDK can **speculatively open**
that camera's P2P session the moment the event lands and hold it for a short window, so the tap attaches
to a warm session instead of paying a cold open — a key lookup plus the P2P connect handshake before the
first frame.

It is **opt-in**: `prewarmEvents` defaults to `[]`, an empty list being what disables it.

```ts
new EufyMega({
  email,
  password,
  countryCode,
  prewarmEvents: ["doorbellPress"], // default: [] — nothing pre-warms
  prewarmTiers: ["wired", "battery"], // default: both; ["wired"] keeps batteries asleep
  prewarmMs: 28_000, // default: how long the pre-warm holds the session it opened
});
```

Name any semantic event — the option is typed to them, so your editor lists them and a typo won't
compile. A pre-warm rides the **push** channel, so only an event push carries can trigger one; a
poll-carried event is inert however it is listed. [Events](/events) is where the events, the channel each
arrives on, and their payloads are described; `dev.describe()` answers which of them a given device
emits.

### What you take on by enabling it

**One camera pays for it, and it is the one you least want to.** A pre-warm opens a session nobody asked
for, and an open session heartbeats the device it is open to — but which device is that?

| what fired the event          | station whose session opens | effect of a pre-warm                        |
| ----------------------------- | --------------------------- | ------------------------------------------- |
| camera attached to a HomeBase | the **base**                | none — already open, wired, drains nothing  |
| standalone **wired** camera   | itself                      | none — warmed at login, never idle-detaches |
| standalone **battery** camera | itself                      | **opens it and heartbeats it**              |

So the only station a pre-warm genuinely opens is a standalone battery camera — the device class the
on-demand lifecycle above exists to let sleep. `prewarmTiers: ["wired"]` keeps the opt-in and spares
them, at the price of being close to a no-op: wired stations are warm already, so it only bites after a
session drops.

**One unwatched pre-warm costs `prewarmMs` _plus_ the station's idle window.** When the window expires the
hold is released, which arms the idle-detach rather than closing the session — with the defaults that is
28 s then 5 min, ≈ 5.5 min of heartbeat for an event nobody watched. A second qualifying event inside that
tail cancels the timer and starts again, so a camera detecting more often than that never sleeps.

**Frequency is a property of your installation, not of the event name.** A camera configured to report
human detection only fires `personDetected` as often as a busier one fires raw `motion`. Pick the events
a user actually looks at within the window, and read the rate off your own fleet.

## Read-through cache

Reads are served from an in-memory cache and only re-fetched when stale. A `getProperty` /
`getProperties` on a value older than the freshness window schedules **one** coalesced background
refresh (via the cheapest available path) and returns the last-known value immediately — reads never
block, and a burst of reads collapses to a single refresh.

- **Realtime keeps values fresh.** Push and P2P updates land in the same cache, so a device kept fresh
  by realtime is never considered stale and never triggers a fetch — a wired camera with a live P2P
  session serves reads with zero cloud calls.
- **Reuse the `Device`.** The cache lives on the `Device` object, so hold onto the one from
  `getDevice(sn)` and read from it repeatedly; calling `getDevice(sn)` afresh each time re-fetches.

```ts
new EufyMega({
  email,
  password,
  countryCode,
  cacheTtlMs: 15_000, // freshness window for cached reads (default 15 s)
});
```

## Is a device reachable?

The SDK reports **facts** about a device's liveness and leaves the verdict to you:

```ts
const s = eufy.deviceState(sn);
// { sn, stationSn, lastSeenMs? }

eufy.on("deviceState", (s) => {
  // fires when a device reports to the cloud
});
```

`lastSeenMs` is when the device last reported to the cloud, in ms, comparable to `Date.now()`. It works
the same way for every device class — cameras, sensors and MQTT appliances alike — as a portable
liveness fact.

**There is deliberately no `online: boolean`.** "Unreachable" is a threshold, and the right threshold
differs per device: a mains camera reports constantly, while a battery contact sensor can be silent for
days by design and be perfectly healthy. If the SDK picked one number it would be wrong for somebody —
so you decide:

<!-- typecheck: host myThresholdFor, deviceKind -->

```ts
const stale = Date.now() - (s.lastSeenMs ?? 0) > myThresholdFor(deviceKind);
```

**`lastSeenMs` moves slowly** — it comes from the cloud's own device heartbeat, minutes rather than
seconds (see below). It answers "is this device alive at all", not "what is it doing right now".

### Explicit availability observations

Where the current vendor wire provides an attributable availability state, the SDK exposes it
separately from `lastSeenMs`:

```ts
const current = eufy.deviceAvailability(sn);
// { entity, availability, source: { transport, signal }, receivedAt, ... } | undefined

eufy.on("availability", (observation) => {
  // fires on an explicit state transition; repeated identical states are coalesced
});
```

The currently verified source is the `eufy_life` MQTT `synq/.../state_info` channel. In the current app,
`IotNotifyLightImpl.handleStateInfoTopic` parses `MqttBaseProtocol.payload`, reads its boolean `status`,
and updates the `LightDevice` selected from the topic's serial. That establishes both polarity and
device scope. Envelope time and sequence values are preserved when supplied. An older ordered message
cannot replace a newer observation, and only a later explicit `available` observation clears an explicit
`unavailable` one.

Availability state is harmonized above the transports: each transport may decode only a verified wire
signal, then the client normalizes it into this contract and retains one latest observation per device.
Vendor timestamps are compared across sources; sequence values are compared only within the same source
because independent transports do not share a counter. When comparable vendor ordering is absent, SDK
receipt order decides the latest observation. Same-state evidence refreshes the retained observation
without emitting a duplicate transition.

The push payload's short `m` field is not exposed as availability: no current-app reader establishes its
values, polarity, or whether it describes the named device, its parent station, or a transport. The SDK
likewise does not turn MQTT/P2P disconnects, silence, operation failures, or a caller timeout into device
unavailability. `deviceAvailability(sn)` therefore returns `undefined` when there is no verified
observation rather than guessing.

An account containing both smart lights and robot vacuums uses separate MQTT credential scopes:
`eufy_life` for the light and default for an `eufy_home` vacuum. An idle vacuum may legitimately produce
no DP report for an extended period. Light `state_info` evidence is not projected onto the vacuum, and
vacuum report silence is not an availability observation.

### Don't use the P2P session as a reachability check

It looks like one and isn't. Sessions are opened only when something needs one and
[closed when idle](#battery-cameras-open-on-demand-detach-when-idle), so a healthy device has **no
session open** most of the time — keying "offline" off that would mark most of an account unreachable.
That's why `deviceState` carries no session flag.

If you want transport visibility for diagnostics, it's still there, station-scoped where the session
actually lives:

```ts
eufy.getP2pSessions(); // Map<stationSn, session> — currently open
eufy.on("p2pConnect", (stationSn) => …);
eufy.on("p2pClose", (stationSn) => …);
```

## Cloud-param polling

Some state has no realtime push of its own — a battery level, or a sensor that only reports to the
cloud. For those the SDK re-reads the account's device list on an interval and emits a semantic event
for each value that changed, so a host subscribes to one event stream and doesn't poll anything itself.

```ts
new EufyMega({
  email,
  password,
  countryCode,
  pollMs: 600_000, // how often to re-read cloud params (default 10 min; 0 disables)
});
```

**The default is paced to the data, not to how often you'd like updates.** The cloud only refreshes a
device's params on that device's own slow heartbeat — on a live account the freshest param on an active
device was around 12 minutes old, and asking for one device's params returns the same staleness as
asking for the whole list. Polling every 30 seconds therefore costs 20× the requests and sees nothing
sooner. Lower it only if you have measured that your devices report faster.

This is a **slow** channel by nature. Motion, doorbell presses, contact changes and lock state arrive
over push/P2P/MQTT within seconds and are unaffected by `pollMs`.

## Tear-down

`disconnect()` closes every channel (push, MQTT, all P2P sessions) and clears the timers — including
the poll loop. The login session is untouched — call `login()` again to bring realtime back up without
re-authenticating.

## Options summary

| Option                | Default               | Effect                                                                                                        |
| --------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `autoRealtime`        | `true`                | Auto-start push/MQTT on login + on-demand P2P. `false` opts out.                                              |
| `p2pIdleMs`           | `300000` (5 min)      | Idle window before a **battery** station detaches.                                                            |
| `cacheTtlMs`          | `15000` (15 s)        | Freshness window for cached reads.                                                                            |
| `prewarmEvents`       | `[]` (off)            | Which semantic events speculatively open P2P. Empty disables pre-warm.                                        |
| `prewarmTiers`        | `["wired","battery"]` | Which station power tiers `prewarmEvents` may open. `["wired"]` spares batteries.                             |
| `prewarmMs`           | `28000` (28 s)        | How long a pre-warm holds the session it opened; the tier's idle window follows.                              |
| `pollMs`              | `600000` (10 min)     | How often cloud params are re-read for changes. `0` disables. Paced to the cloud's own refresh rate.          |
| `storedSnapshotCache` | `true`                | Eagerly retain qualifying push JPEGs for passive `snapshotStored()`. `false` omits that method.               |
| `localAddresses`      | —                     | LAN address override per station (`sn` → `host[:port]`) for direct P2P when the record's IP is wrong/blocked. |

Next: [Live media](/live-media).
