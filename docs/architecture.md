# Under the hood — how the SDK fits together

A tour of the public shape of `eufy-sdk` for host developers: the objects you construct, how they
relate, and the lifecycle they move through. Everything here is the **public API** — the names you
import from the package. For the exhaustive, generated-from-source reference, see the
[API reference](/api/).

## The one entry point: `EufyMega`

You construct **one `EufyMega` per account**. It's the facade over everything else — login, the device
list, the realtime channels, and the unified event stream.

```ts
import { EufyMega } from "@mega-yfue/eufy-sdk";

const eufy = new EufyMega({ email, password, region: "eu-pr", store });
```

Its job is orchestration only. It exposes three groups of methods:

- **Login** — `login()`, `solveCaptcha()`, `submitVerifyCode()` (see [Getting started](/getting-started)).
- **Devices** — `getDevices()`, `getDevice(sn)` → capability-driven [`Device`](/devices) objects.
- **Realtime** — SDK-managed: `login()` auto-starts the event channels and P2P opens on demand (see
  [Transports](/realtime) and [Connectivity & battery](/connectivity)), all feeding one
  [event](/events) surface. `disconnect()` tears it back down.

## The lifecycle

The normal flow through the facade, start to finish:

```
new EufyMega(opts)
   │
   ▼
login()  ──► captcha? ──► solveCaptcha(answer)
   │                          │
   │        2fa? ──► submitVerifyCode(code)
   ▼
login()                      // on success, realtime starts automatically (push + MQTT + wired P2P)
   │
   ├── on("motion" | "contactState" | "doorbellPress" | …)   // typed semantic events, flowing
   ├── getDevices()                                           // resolve the account's devices
   └── getDevice(sn) → dev.camera?.()?.live()                   // opens P2P on demand, idle-detaches
   │
   ▼
disconnect()                 // tear the channels down; the login session stays valid
```

`getDevices()` also loads each product's **thing description**, the per-product model the vendor's
app builds its settings from: which properties a product has, their types, and for each setting the
values it offers. The SDK resolves it for each device the way the app does — the variant its firmware
uses, what its station allows — and its capabilities read their per-product options from it, so a new
product works from the cloud's description rather than from a list of model codes. `getThingDescription(sn)`
returns a device's resolved description. Descriptions are product data, not account data; pass a
`thingStore` (e.g. a `FileSessionStore`) to keep them across runs, so a start only asks whether each one
changed.

A restored session (via a `store`) skips straight past login. Connectivity is SDK-managed: the event
channels come up on login and a camera's P2P session opens only when a command / stream / doorbell ring
needs it, then idle-detaches so battery cameras sleep. See [Connectivity & battery](/connectivity).

## Devices are capability-driven, not subclassed

`getDevice(sn)` returns a single concrete [`Device`](/devices) — there are **no per-model
subclasses**. A device is entirely described by its resolved `{ codec, capabilities, properties }`,
so you ask what it can do rather than what it is:

```ts
dev.has("ptz"); // capability present?
dev.getProperty("battery"); // current state (or undefined)
dev.getProperties(); // full snapshot
```

Each capability the device HAS surfaces a **fluent, typed accessor** returning an action object —
`dev.camera?.()`, `dev.ptz?.()`, `dev.light?.()`, `dev.lock?.()`, … A device carries only the accessors
for capabilities it has, and each returns `undefined` until the device is bound to a live client — hence
the two optional links:

```ts
import { PtzDirection } from "@mega-yfue/eufy-sdk";

await dev.camera?.()?.on();
await dev.ptz?.()?.rotate(PtzDirection.left, 1.0);
```

Argument constants (`PtzDirection`, `ArmingMode`, `Watermark`, `VideoQuality`, …) are exported from the
package, so the choices autocomplete and can't drift. Writes whose behavior isn't yet verified on a
mega device throw a clear error rather than guessing — reads always work via `getProperty`.

## One event surface, many sources

Motion, person, doorbell, contact, lock, battery — however they arrive (push, P2P, or a poll
fallback), they land as **one typed event stream** on the facade:

```ts
eufy.on("motion", (e) => e.deviceSn);
eufy.on("event", (e) => e.eventName); // the catch-all, tagged with the true event name
```

The event names and payloads are typed, so `eufy.on("motion", …)` autocompletes and types `e`. See
[Events](/events) for the full list, and [Transports](/realtime) for which channel carries what.

## Consuming media

Camera media hangs off a bound camera's action object. Live egress is built around **one pull, many
consumers** — every live view, fresh snapshot, and recording on a camera shares a single session:

```ts
const cam = (await eufy.getDevice(sn)).camera?.();
const stored = await cam?.snapshotStored?.(); // passive retained push JPEG; no live pull
const fresh = await cam?.snapshotLive?.(); // explicit fresh capture from the shared live source
const stream = await cam?.live?.(); // raw frames
const r = await cam?.openReadable?.(); // a node Readable
for await (const frag of cam!.recordFragments!()) {
  /* CMAF for HLS/MSE */
}
```

The media surface (`snapshotStored`, `snapshotLive`, `live`, `openReadable`, `recordFragments`, `record`) is
the [`MediaProvider`](/api/interfaces/MediaProvider) contract. See
[Consuming a live stream](/live-media) for the full walkthrough (egress choices, keyframe priming,
power budgets).

## How the pieces layer up

Internally the SDK is organised as strict layers with one dependency direction — you consume the
top of the stack and never see the rest:

| Layer         | What it is (public view)                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **facade**    | `EufyMega` — the one object you construct and drive.                                                                                                                                                                                 |
| **model**     | `Device` + the capability action objects behind `dev.<cap>()`.                                                                                                                                                                       |
| **contracts** | The boundary types a device speaks — [`Command`](/api/type-aliases/Command), [`CommandSink`](/api/interfaces/CommandSink), [`MediaProvider`](/api/interfaces/MediaProvider), [`LiveStreamHandle`](/api/interfaces/LiveStreamHandle). |
| **transport** | The realtime channels (push / MQTT / P2P) the SDK brings up automatically. Internal — resolved by intent, not selected by name.                                                                                                      |

## Where to go next

- [Getting started](/getting-started) — install, log in, persist a session.
- [Devices & capabilities](/devices) — reading state and driving controls.
- [Events](/events) · [Transports](/realtime) — the realtime surface.
- [Consuming a live stream](/live-media) — the media pipeline in depth.
- [API reference](/api/) — every public symbol, generated from source.
