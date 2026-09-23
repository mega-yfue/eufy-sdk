# Devices & capabilities

`getDevice(sn)` returns a live `Device` — the primitive a host app reads and controls. There are **no
subclasses**: a device is entirely described by its resolved `{ codec, capabilities, properties }`.
You ask what it _can do_, never `instanceof`.

```ts
const dev = await eufy.getDevice(sn);

dev.has("ptz"); // → boolean — does this device have the capability?
dev.battery?.()?.level; // → number | undefined — typed read (see Typed reads below)
dev.camera?.()?.on(); // → fluent typed action (see Fluent actions below)
```

Read and control a device through its **fluent capability accessors** — `dev.<cap>()?.…` — for both
reads (typed getters) and writes (action methods). That's the whole surface a host needs.

Reads are cheap and never wake the device: they return in-memory state kept fresh by realtime, with a
read-through cache refreshing stale values in the background — so polling a `Device` is safe. Reuse the
object from `getDevice(sn)` rather than re-fetching each read: it stays current, and its capability set
widens in place if the device later reports evidence for more. See
[Connectivity & battery → Read-through cache](/connectivity).

## Fluent, typed actions

Each capability the device HAS exposes a **fluent accessor** returning a fully-typed action object —
IDE autocomplete on the accessor, the methods, and their arguments. The accessor is absent when the
device lacks the capability, and returns `undefined` until the device is bound, so call it `dev.<cap>?.()`
and read through with `?.`:

::: info A device carries only the accessors it can answer for
`dev.camera` exists on a camera and is **absent** on a smart light — the accessor set is a truthful
description of the device, so `"camera" in dev` and `dev.capabilities` agree.

That means two optional calls: `dev.camera?.()?.on()`. The first asks "does this device have a camera",
the second "is it bound to a live transport yet". `dev.has("camera")` is the explicit form if you'd
rather branch than chain.

A capability is granted on evidence the device reports, so a device that hasn't reported a given param
yet doesn't have the capability that param proves. When it later does, the SDK **widens the object you
are already holding** — the accessor appears, bound, and a `deviceCapabilities` event fires. Capabilities
are never retracted, so the set only grows:

```ts
eufy.on("deviceCapabilities", ({ deviceSn, gained }) => console.log(deviceSn, "gained", gained));
```

:::

```ts
import { PtzDirection, ArmingMode } from "@mega-yfue/eufy-sdk";

await dev.camera?.()?.on(); // power on
const stored = await dev.camera?.()?.snapshotStored?.(); // → Buffer; latest retained push JPEG
const fresh = await dev.camera?.()?.snapshotLive?.(); // → { jpeg, width, height }; fresh live capture
await dev.ptz?.()?.rotate(PtzDirection.left, 1.0); // PTZ step — see the PTZ guide
await dev.light?.()?.setBrightness(50); // spotlight 1–100
await dev.arming?.()?.setMode(ArmingMode.home); // guard mode
await dev.lock?.()?.lock();
await dev.lock?.()?.setAutoLock?.(true, 60); // enable, 60s delay
await dev.lock?.()?.setRainMode?.(true); // P2P video lock only — optional accessor
```

Argument constants (`PtzDirection`, `ArmingMode`, …) are exported from the package — pass the named
member so the choices autocomplete and can't drift.

Available today: `camera` (on/off/privacy/statusLed + stored/live snapshots, live/record when bound), `light`
(camera floodlight/spotlight: on/off/brightness/colorTemp/enable), `smartLight` (the eufy_life
permanent-outdoor-light line: on/off/brightness/custom colour/effect — see the
[Smart lights guide](/smart-lights)),
`ptz` (rotate + left/right/up/down, zoom, and a `preset()` sub-API — see the [PTZ guide](/ptz)), plus
`arming`, `lock` (lock/unlock/setAutoLock on both the P2P video lock and the MQTT garage door; lock/unlock
also on the classic Wi-Fi lock over its own keyed envelope, both directions hardware-confirmed, where
`setAutoLock` is absent — optional accessor, `?.()`; plus setRainMode on the video lock only), and `siren` (volume, alarm duration, and test/stop triggers — see below).

> **Unverified writes are absent, they don't guess.** A write method present on a `dev.<cap>()` object
> means its wire is verified — so you know at compile time what's settable. Where a write isn't yet
> verified on a mega device the method is simply absent from the object (an optional `?.()` that reads
> back `undefined`), not present-and-throwing: a few lock settings (`setOneTouchLock` and its siblings)
> are absent until confirmed on-device. The read getter still works in every case.

> **A value outside what a control accepts is refused, not adjusted.** Every setter states the values
> it takes — an option set, or a numeric range — and a value outside it rejects before anything is
> sent, naming the set it had to come from. Nothing is quietly rounded into range and nothing falls
> back to a default, because these writes are fire-and-forget: a value that was silently altered on
> the way out is indistinguishable from one the device accepted. Read the range off the control's own
> description rather than assuming one, and treat a rejection as a bug in the caller.

## Typed reads

The same fluent `dev.<cap>()` object exposes **typed read getters** alongside its actions — the read
twin of the write methods. They fix the read/write asymmetry: instead of the loose
`getProperty("battery")?.value` (`boolean | number | string`), a getter returns the value already
narrowed to its type:

```ts
const bat = dev.battery?.();
bat?.level; // number | undefined  (0–100)
bat?.charging; // boolean | undefined
bat?.powerSource; // number | undefined

dev.contact?.()?.open; // boolean | undefined — door/window open
dev.lock?.()?.locked; // boolean | undefined
dev.camera?.()?.nightVision; // number | undefined
dev.motion?.()?.detectionEnabled; // boolean | undefined
dev.arming?.()?.mode; // number | undefined — current guard mode
```

Read getters live on every capability that has readable state (`battery`, `contact`, `lock`, `camera`,
`light`, `motion`, `arming`, `siren`, the `leak`/`smoke`/`co`/`keypad` sensors, `storage`, `audio`,
`doorbell`, `ptz`, RoboVac `vacuumClean`/`suction`, `personDetection`).

A getter narrows the value's **type**; what the value **means** — a percentage, a temperature, an
instant, one of a named set — is declared beside it and is what a host needs to render a reading. See
[What a reading means](/value-kinds).

**Getters are evidence-gated.** A getter is present only when the device actually reported the backing
value — so a device advertises exactly the reads it has, never a phantom sub-feature of the capability
it happens to own. A battery camera that reports its custom-recording settings exposes
`battery()?.recordDuration`; one that reports only a level and a temperature won't have that key at all:

```ts
const bat = dev.battery?.();
"recordDuration" in bat!; // false on a device that doesn't report it
bat?.recordDuration; // undefined
```

**Setters are gated too, on the same evidence.** A device that never reported a setting does not get the
method that writes it — an entry sensor reports a battery level and nothing else, so it carries
`battery()?.level` and no setters at all. That matters because these writes are fire-and-forget: a method
that exists but is ignored by the hardware is indistinguishable from one that worked. Optional setters
are therefore genuinely optional — guard them (`bat?.setRecordDuration?.(60)`) or check first.

Like every fluent accessor these are **bound-only** (the `dev.<cap>()` object exists once the device is
bound to a live client, which is the normal case after `getDevice`).

_(A low-level `getProperty(name)` / `getProperties()` escape hatch exists for unbound model objects,
diagnostics, or a param not yet surfaced on a capability — but reach for the typed capability getters
above in application code.)_

## When a setting means something different per device

A few settings are not one scale. Motion sensitivity is the clearest: across the device families this
has been captured on, it rides **four different command ids in three different frame shapes**, and on
two of them the number counts DOWN as the device gets more sensitive. A raw value means the opposite
thing depending on what it reaches, and two families report the very same set of ids while accepting
different ones — so nothing a device exposes lets a caller work out which applies.

So the SDK does not hand over the number. It reports how many steps the device offers, which one is
current, and takes a step back:

<!-- typecheck: host slider, onChange -->

```ts
const m = dev.motion?.();
const steps = m?.sensitivitySteps(); // 5, 7 … or undefined

if (!m || steps === undefined) {
  // Not drivable on this device — don't offer the control.
} else {
  slider({ min: 1, max: steps, value: m.sensitivityStep() ?? 1 });
  onChange = (step: number) => m.setSensitivityStep(step);
}
```

Step 1 is always the least sensitive, whatever the device's own numbering does. The same three lines
drive a sensor whose ladder runs 80 down to 8 and a camera whose picker runs 1 up to 5.

`undefined` is an answer, not a gap: it means no capture places this model's scale, and the SDK would
rather say so than send an id it is guessing at — a write it ignores would otherwise look like it
worked. A step outside the device's range is rejected rather than clamped.

What you don't get is labels. Whether five steps read as "low/medium/high" is presentation, and the
detection distances the vendor app shows are only known for the PIR sensor — so a host renders a
position, not a name.

## Device info (metadata)

Every device exposes a universal, read-only `info()` accessor returning its identity metadata — handy
for a host's device registry or device-info surface:

```ts
const i = dev.info?.(); // defined for every bound device
i?.manufacturer; // → "eufy" (always)
i?.model; // → "T8410" (model / T-code), when known
i?.serialNumber; // → the device serial, when known
i?.name; // → the display name, when known
i?.deviceType; // → numeric device type (diagnostic), when known
i?.firmwareVersion; // → firmware / main software version (e.g. "3.8.2.8"), when reported
i?.hardwareVersion; // → hardware version (e.g. "V05"), when reported
i?.firmwareSubVersion; // → secondary firmware version, when reported
i?.macAddress; // → Wi-Fi MAC address, when reported
i?.updateAvailable; // → true when the device reports a firmware update is available
```

`manufacturer` is always `"eufy"`. Like every fluent accessor, `info()` is `undefined` only on an
unbound model object — call it with `?.`.

> `firmwareVersion`/`hardwareVersion` come straight off the device record and are populated whenever
> the device reports them; they are `undefined` (optional) for a device that doesn't. They are never
> a guessed value.

## Examples

Snapshot + camera/light control:

<<< @/../examples/03-snapshot-and-control.ts

Pan-tilt-zoom is its own guide — see [PTZ](/ptz).

Camera spotlight / floodlight — a light built into a camera:

<<< @/../examples/05-camera-light.ts

Standalone smart light — the eufy Life lighting line, a different product line with its own accessor
and its own state model (see [Smart lights](/smart-lights)):

<<< @/../examples/09-smart-light.ts

Lock:

<<< @/../examples/06-lock.ts

## Devices joining or leaving

The account roster is re-checked on the same interval as [cloud params](/connectivity#cloud-param-polling):

<!-- typecheck: host registerAccessory, dropAccessory -->

```ts
eufy.on("deviceAdded", (d) => registerAccessory(d));
eufy.on("deviceRemoved", (d) => dropAccessory(d.sn));
```

Two things to rely on:

- **The first enumeration after login is not a stream of additions.** `deviceAdded` fires only for a
  device the SDK has previously seen the account _without_, so you can register your initial accessories
  from `getDevices()` and treat the event purely as a delta.
- **`deviceRemoved` is conservative.** The device list is assembled from several queries, and one can
  fail while the others succeed. Rather than report the missing devices as removed — which would have you
  delete live accessories during a transient outage — a partly-resolved refresh reports **no** removals
  at all. `deviceAdded` is gated the same way in the other direction: nothing is announced as a join
  against a baseline that only partly resolved, so a recovering outage doesn't read as a pairing burst.

Because it rides the poll interval, a pairing shows up within that window rather than instantly.

Next: [Events](/events) · [Live media](/live-media).
