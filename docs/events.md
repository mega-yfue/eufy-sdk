# Events

Device events arrive from up to four transports (FCM **push**, **P2P frames**, cloud **poll**, secure
**MQTT**) and are normalized into one **typed semantic event** each — you listen without caring which
transport delivered it. Event names autocomplete and payloads are typed:

<!-- typecheck: host bus -->

```ts
eufy.on("motion", (e) => console.log(e.deviceSn, e.thumbnailUrl));
eufy.on("doorbellPress", (e) => …);
eufy.on("personDetected", (e) => …);
eufy.on("lockState", (e) => …);
eufy.on("contactState", (e) => e.open); // entry sensor: true = open (station notify, push or poll)
eufy.on("propertyChanged", (e) => e.property); // ANY readable property moved — `e.value` is the new one
eufy.on("strangerDetected", (e) => …); // a person the device does NOT recognise
eufy.on("soundDetected", (e) => …); // also cryingDetected, vehicleDetected, dogDetected
eufy.on("armingModeChanged", (e) => …); // guard mode switched — re-read the mode
eufy.on("alarm", (e) => e.phase); // "triggered" | "delayed"
eufy.on("ptzNotify", (e) => e.kind); // "rotate" | "zoom" | "position"

// Catch-all: one listener for EVERY semantic event — payload tagged with `name` (a discriminated
// union, so `switch (e.eventName)` narrows the type). Ideal for fanning to a bus.
eufy.on("event", (e) => bus.emit(e.eventName, e));
```

## Any property moving is announced

Most of what a device reports has no push of its own. A camera's status LED and night-vision mode, a
floodlight's brightness, a device's speaker volume, a battery level — these arrive only as cloud params,
so re-reading was the only way to learn one had moved, and re-reading cannot say _when_. A host that
only reads while its UI is open therefore showed the previous value indefinitely after someone changed
the setting in the vendor app.

**`propertyChanged` fires for every readable property whose value moves**, whatever it is and whatever
transport carried it:

```ts
eufy.on("propertyChanged", ({ deviceSn, property, value }) => {
  console.log(`${deviceSn}: ${property} is now ${value}`);
});
```

- **`property`** is the name [`dev.getProperty(name)`](/devices) takes and the one the capability getter
  answers. To reach the fluent accessor behind it, join once against
  [`dev.describe()`](/capability-manifest), which publishes the `{ accessor, property }` pair.
- **`value`** is what `getProperty` now serves, narrowed the way the capability getter narrows it — read
  from the same live state, never a second conversion of the wire value, so the two cannot disagree. It is
  **absent** where no scalar can honestly be given: a property whose stored form is a config payload
  (`videoQuality`, `snoozeTime`), or one whose stored value does not match its declared type. Absent
  means "this moved, re-read it". A handful of properties are in the schema with no typed getter at all,
  because their value space is not evidenced yet — those announce the stored value, which is exactly what
  `getProperty` already serves for them and no more.
- **No wire id travels with it.** Several ids resolve to one property — a camera's enablement rides 1035
  on one family and 2001 on another, with opposite polarity — and that resolution is the point. The ids
  stay available through `inspectDevice()` and `dev.describe()`.
- **Keep a reference to the devices you want announcements for.** The value comes out of a device's own
  live state, and the SDK holds the `Device` objects it hands out **weakly** — so `getDevice(sn)` and then
  discarding the result stops the announcements for that serial once the collector takes it. The SDK
  warns once on your `logger` when it notices, naming the serial, rather than leaving you a silence to
  investigate; `getDevice(sn)` resumes them. Liveness reaches you as `deviceState` either way.
- **Echoes are announced too.** The SDK cannot tell a change it caused from one made in the app, and
  guessing would lose a real external change in exchange for one redundant re-read.
- **Latency is the transport's.** Seconds for a property a device reports over its realtime wire. For one
  that only ever arrives as a cloud param — which is most of them — it is whichever comes first of the
  poll (`pollMs` at construction, or `setPollInterval(ms)` at runtime; default 10 minutes) and the
  read-through cache's own background re-read, which fires when you read a value older than `cacheTtlMs`.

**Nothing is filtered out for being uninteresting.** Which of a device's truths you act on is yours to
decide, so every schema property that moves is announced — including the chatty ones. A sensor's own
`lastSeen` fires on every check-in, and a robot's session and lifetime counters tick throughout a clean.
If you want liveness, read `deviceState`, which carries the same fact; if you want clean progress, those
counters are the only place it comes from. Either way it costs you one comparison on `property` to ignore
a name, and the SDK never decides on your behalf that you did not want a reading.

**When a property change is not enough, the event has its own name.** A named event carries something a
bare property change cannot — an inbound source the property path does not reach, a threshold crossing,
or a dedupe across transports. `batteryAlert` is a threshold push with no level in it. `contactState`
arrives on three transports and is deduped across them, and its FCM push carries no param at all. On the
cloud poll an entry sensor's movement is therefore announced twice, idempotently: use `contactState` for
the door, `propertyChanged` for everything else.

## One change, announced once

A state can reach the SDK on more than one transport at a time. An entry sensor's contact is the clear
case: the station volunteers it over P2P roughly two seconds before the same value arrives as an FCM
push, and the cloud record catches up after that. All three are real reports of one door movement, and
a host wants to be told once.

So events that carry a **settled state** are edge-triggered: a realtime signal repeating the value the
SDK last announced for that device is dropped. A genuine open → close → open burst passes intact,
because every step differs from the one before — the suppression is on the value, not on a time window.

Two deliberate exceptions:

- **Events that are pulses are never suppressed.** `motion`, `doorbellPress` and the detections carry
  no settled state; two identical ones in a row are two real detections.
- **The cloud poll still re-announces an unchanged state**, so a host that missed a frame, or that
  reconnects after a drop, is resynchronised instead of waiting for the state to physically change.
  Tearing the connection down clears what the SDK remembers announcing, for the same reason.

For an entry sensor behind a station this means `contactState` now lands about two seconds earlier
than before, over the LAN, with no cloud involved — and still exactly once per movement.

## Detection level on a motion sensor

A sensor's detection level is a step, not a number: `dev.motion?.()?.setSensitivityStep(n)`, read back as
`dev.motion?.()?.sensitivityStep()`. Its five steps are detection distances — 3-5 m at the lowest up to
9-11 m at the highest — and the value behind them counts DOWN as the sensor gets more sensitive, so a
raw number would invite picking the wrong end. Cameras run their own scales, some rising and some
falling, which is why a step is what crosses them all — see
[When a setting means something different per device](/devices#when-a-setting-means-something-different-per-device).

A change lands after about a minute, or immediately if the sensor is triggered by walking in front of
it. So a read straight after a write returns the previous level until it catches up.

## A motion sensor reports only in test mode

A standalone PIR sensor is the exception to the paragraph above: outside the vendor app's **user test
mode** it is never notified over P2P at all. Its detections reach you as a push, or as a last-event
timestamp on the next cloud poll — there is no local path.

`dev.motion?.()?.setTestMode(true)` opens one, and `dev.motion?.()?.testMode` reads back what the station
reports. It is a diagnostic mode meant for aiming a sensor while installing it, not a transport — and
**while it is on that sensor's detections do not raise the alarm**, so leaving it on quietly disarms
it. Turn it back off. A sleeping sensor cannot enter it either: the station accepts the command while
the sensor only learns on its next wake, so trigger the sensor as you call.

Events start flowing on their own — a successful `login()` brings up the account-wide push channel
(and MQTT for appliances) automatically, so you register listeners and receive events without any extra
setup. Subscribe **before** logging in if you don't want to miss an early event. Which transport
carries each event, and how P2P opens on demand, is covered in [Realtime transports](/realtime) and
[Connectivity & battery](/connectivity).

Low-level escape hatches remain (`message`, `p2p`, `pushRaw`, connect/disconnect lifecycle, `error`)
for when you want the raw frame.

A write the device accepted on the wire and then never applied surfaces as its own
**`commandUnconfirmed`** event, not on `error`. Every setter resolves once the transport has carried the
command — that is delivery, not convergence — and the observation a member declares decides separately
whether the device did what it was told. Where that observation times out, this event names the device, the
property, what was asked for and what the param actually read, so a host can tell its user the camera
ignored the request instead of believing it landed:

```ts
eufy.on("commandUnconfirmed", ({ sn, property, expected, observed }) => {
  console.warn(`${sn} still reports ${property}=${observed}, not ${expected}`);
});
```

It is an outcome rather than a fault, which is why it does not reach `error`: nothing went wrong in this
library, and the same write may still land later on a battery device that was asleep. A camera whose power
write is acknowledged and simply ignored is the case this exists for.

A kicked or expired cloud session — another client logged into the account, or the token lapsed —
surfaces as its own **`sessionExpired`** event, not on `error`. The SDK has already cleared the
persisted session by the time it fires; listen for it to re-drive `login()` (usually a fresh 2FA).
Wait `err.retryAfterMs` first, and read `err.contended` for whether the session is being displaced by
another client rather than expiring — a re-login answers that no better, and firing one immediately is
the login war the SDK's own hold-off avoids.

Detection kinds are **separate events**, not one `motion` with a flag — a host usually maps them to
distinct sensors. Note `personDetected` means a face or a _recognised_ person; someone the device does
not recognise arrives as `strangerDetected`.

**Not every event arrives at the same speed.** Push- and P2P-carried events (`motion`,
`doorbellPress`, `personDetected`, `lockState`, `contactState`) land within seconds of the device
acting. Anything the cloud reports instead of the device is bounded by the cloud's own refresh of that
device's params — minutes, not seconds. Treat those as a slowly-updating level, not a trigger.

> **MQTT semantic events are pending.** The `mqtt` source is wired end-to-end (messages already flow
> through the normalizer) but no capability maps it to a semantic event yet — the realtime state
> payload for vacuum / eufy_home appliances isn't decoded yet. Until then, consume MQTT via the raw
> `message` event; the semantic layer picks it up once a capability adds an `mqtt` mapping.

## Example

<<< @/../examples/02-listen-events.ts

Next: [Realtime transports](/realtime) · [Live media](/live-media).
