# Vacuums & mowers

The eufy **Clean** line covers robot **vacuums** (RoboVac / X-series, e.g. the **Clean X10 Pro Omni**)
and robot **mowers**. Vacuums are driven through the `vacuumClean` and `suction` capabilities. Like
every capability they resolve dynamically, so any robot on the Clean line exposes the same fluent API;
nothing is hardcoded per model.

> **Mowers** are part of the same Clean family but a distinct device type with their own data points,
> read through the `mower` capability — see [Mowers](#mowers) below. The other sections cover vacuums.

```ts
const dev = await eufy.getDevice(sn);
const robo = dev.vacuumClean?.(); // present only on a Clean-line device
```

The accessor returns `undefined` on a device without the capability, so guard it
(`dev.vacuumClean?.()?.…`) or assert once up front. Each individual getter is **present only when the
device reports that value**, so read them defensively.

::: warning A robot's state appears only after it reports
The **cloud device record does not carry a robot's live state** — its reported parameters hold none of
the activity/suction/battery values. Confirmed on two unrelated models, so treat it as how the line
behaves rather than a quirk of one robot. Those values arrive only over the robot's **realtime feed**,
which the SDK subscribes for you.

The consequence for a host: a robot reports **on change**, not on request, and an idle docked one may
stay silent for a long time. Because every getter is evidence-gated, `vacuumClean()` / `suction()`
resolve with **no state getters at all** until the first report lands — `activity`, `battery`, `power`,
`volume` and `suction` are absent, not stale. They appear once the robot has something to say.

So don't treat a missing getter as an error, and don't block startup waiting for one. Listen for
`deviceState` and re-read `dev.vacuumClean?.()` when it fires, rather than sampling once at bind time.
There is no way to ask a robot for its state on demand — the vendor cloud exposes no such read.

Re-read **through the accessor** (`dev.vacuumClean?.()?.activity`), not through an object you kept from
an earlier call: the report that first creates the reads installs them on a fresh object, and a cached
one never grows them. `deviceState` fires again once they exist, so a handler that re-reads each time
sees them on the first report.
:::

## State

```ts
dev.vacuumClean?.()?.activity; // what the robot is doing (see below)
dev.vacuumClean?.()?.battery; // 0–100
dev.vacuumClean?.()?.power; // boolean — powered on
dev.vacuumClean?.()?.volume; // speaker volume, 0–100
dev.vacuumClean?.()?.cleanType; // "sweep" | "mop" | "sweepAndMop" | "sweepThenMop"
```

`activity` is readable **only** through this typed getter. The robot reports it inside a structured
payload rather than as a plain value, and the getter is what unpacks it, so the low-level
`dev.getProperty("activity")` escape hatch hands back that raw payload rather than `"docked"`. Use the
typed getter.

`activity` is the robot's high-level state:

| `activity`  | meaning                            |
| ----------- | ---------------------------------- |
| `cleaning`  | actively cleaning (see caveat)     |
| `returning` | heading back to the dock           |
| `docked`    | on the dock (idle or charging)     |
| `paused`    | a task is paused (see caveat)      |
| `idle`      | standby / asleep                   |
| `error`     | a fault is active                  |
| `unknown`   | a state the SDK can't classify yet |

> **Caveat:** `cleaning` is currently broader than "actively vacuuming" — a robot that is **paused
> mid-clean**, or **parked on the dock running a wash/dry cycle**, also reports `cleaning` today. As a
> result the standalone `paused` state may not appear in practice. Treat `cleaning` as "a job is in
> progress" rather than "the brushes are spinning right now". This narrows as more states are decoded.

## Cleaning type

```ts
dev.vacuumClean?.()?.cleanType; // "sweep" | "mop" | "sweepAndMop" | "sweepThenMop"
```

What the robot is **set** to do with a surface, not what the job in progress is doing — the two differ
while a setting is changing, and this is the one the app's own screen shows. `mop` and `sweepAndMop`
are verified against a real robot; `sweepThenMop` comes from the vendor's enum and has not been seen on
a device yet.

::: warning `sweep` also means "not stated"
The protocol omits zero-valued fields, so a robot that states no cleaning type is byte-identical to one
set to sweep-only. Both read as `"sweep"`. If your host distinguishes "sweeping" from "unconfigured",
it can't rely on this getter to do it.
:::

## Suction

```ts
import { suctionLevelName } from "@mega-yfue/eufy-sdk";

const level = dev.suction?.()?.level; // raw integer, or undefined until the robot reports one
if (level !== undefined) suctionLevelName(level); // "Quiet" | "Standard" | … | undefined for an unknown int
dev.suction?.()?.boostIq; // boolean — BoostIQ auto-suction
```

`level` is the **raw** suction level the device reports. The level → name mapping is **fixed across models**
(`0` Quiet · `1` Standard · `2` Turbo · `3` Max · `4` BoostIQ · `5` MaxPro) — name it with
`suctionLevelName()`. What differs per model is only **which** levels a device supports (some expose a
narrower range), which is why the SDK returns the integer rather than constraining it. `BoostIQ` is a
level here; the separate `boostIq` boolean is the independent auto-suction toggle, and a device can
report both.

## Refreshing state + controls

The robot's state does not come down on the cloud device record; it arrives on the realtime feed, which
the SDK subscribes and merges into device state for you. A getter built once stays current — the same
object reflects each new report, so there is nothing to re-fetch and no poll to schedule.

What you cannot do is **pull** state: a robot reports on change, and the vendor cloud offers no
read that returns its current values. So the honest pattern is event-driven — react to `deviceState`
rather than sampling. A robot that has not reported since you connected simply has no getters yet.

A report also announces each value it moved as [`propertyChanged`](/events), naming the property rather
than the whole device — so you update one reading instead of re-reading the object. That includes the
session and lifetime counters (`clearTime`, `clearArea`, `lifetimeCleanTime`, `lifetimeCleanArea`), which
advance throughout a run: since the realtime feed is the only place a robot's state comes from, this is
also the only way to follow a clean in progress. They are payload-backed on the AIoT line, so those
announcements name the property with no value — re-read it through the accessor.

## Controls

Every write below is **AIoT-only**. The legacy Tuya clean line dispatches nothing at all — that
direction has no live capture behind it — so a Tuya robot binds the reads and none of the verbs, and
the missing method is the signal.

Each verb is also optional on the surface, because whether a device has it is a runtime fact. The `?.`
is not defensive style — it is the type telling you to check.

**Every mode-control verb below was run on a T2351 and did what it says** — the whole-floor four, and
the three that take an argument. The two suction setters rest on something different: a data-point write
the SKU's own catalog confirms, rather than a watched run. `setCleanParam` rests on a third thing again:
the message it sends is the one the robot reports its own settings in, decoded off that same T2351, and
the write direction has not been watched separately.

Worth separating, because a mode-control write carries a command NUMBER, and a wrong number is a
different command rather than a failure. A settings write has no number to get wrong, and it answers for
itself: the three reads it changes are on the data point it is sent to, so a frame the robot rejects
leaves them where they were.

### Whole-floor verbs

```ts
const clean = dev.vacuumClean?.();

await clean?.startCleaning?.(); // whole-floor auto clean
await clean?.pauseCleaning?.();
await clean?.resumeCleaning?.(); // resumes where it stopped, unlike a fresh start
await clean?.returnToDock?.();

await dev.suction?.()?.setSuctionLevel?.(2); // raw level, see above
await dev.suction?.()?.setBoostIq?.(true);
```

### What a run does with a surface

The cleaning type, how far past the mapped edge a job reaches, and how much water the mop lays down all
travel in one `CleanParam`, so one verb states all three — and the three reads beside it are how you see
what took:

```ts
await clean?.setCleanParam?.("sweepAndMop", "normal", "high");

clean?.cleanType; // "sweepAndMop"
clean?.cleanExtent; // "normal"
clean?.mopLevel; // "high"
```

`cleanExtent` follows the WIRE's order, which is not the order the vendor's app lists these in. Suction
is not part of this message even though a `fan` field sits in it — it has its own data point, and
`setSuctionLevel` above is where it is set.

### Cleaning part of a floor

Three verbs take an argument, and each argument comes from a read the robot already publishes rather than
from anything you have to invent. Running a **saved scene** is the simplest: the argument is the robot's
own scene id.

```ts
const scenes = clean?.scenes?.(); // decoded off the robot's own scene report
const first = scenes?.find((s) => s.valid);
if (first) await clean?.startScene?.(first.id);
```

A scene the robot reports invalid is still reportable and still a well-formed request;
`VacuumScene.invalidReason` says why it will be refused.

Room and zone cleans name the area themselves:

<!-- typecheck: host mapId, p0, p1, p2, p3 -->

```ts
await clean?.cleanRooms?.(
  mapId,
  [
    { id: 4, order: 1 },
    { id: 5, order: 2 },
  ],
  2,
);
await clean?.cleanZones?.(mapId, [{ corners: [p0, p1, p2, p3] }]);
```

`mapId` has no default and that is deliberate: room ids are per map, so assuming the map a
single-floor home would have sends a two-floor home's ids against the wrong floor. A scene carries the
map it belongs to, and a scheduled rooms-clean carries one too — those are the two real map ids a robot
reports.

Zone corners are **signed centimetres** in the map's own frame, whose origin sits wherever the robot
first mapped from. Negative coordinates are ordinary and are encoded as such; passing them as unsigned
values sends the robot somewhere real and wrong.

### What is still missing

The **clean parameters** — clean type, mop level, water level, clean extent, cleaning strength — are
read-only. They decode out of one payload the robot reports, and no capture pins a write for any of
them, so there is no setter to offer. Reading them back after changing them in the vendor's app works
as it always did.

**Driving to a point** (`START_GOTO_CLEAN`, method 4) has no encoder either, and for a different
reason: its argument is a coordinate, and no read published here hands you one. A scene id and a map id
both arrive on the scene report; a goto point would have to come from map data this SDK does not decode.

See [Devices & capabilities](/devices) for how capability resolution works, and the
[device gallery](/devices-gallery) for the Clean line.

## Mowers

A robot mower (E15, E18, C15) carries the `mower` capability. It is **read-only**: no write has been
captured against a mower, so it exposes no setter.

```ts
const mower = dev.mower?.();
mower?.battery; // 0-100 %
mower?.cutHeight; // 25-75 mm
mower?.network; // "None" | "Wifi" | "Cellular"
```

| read                     | data point | kind          | meaning                             |
| ------------------------ | ---------- | ------------- | ----------------------------------- |
| `battery`                | 8          | `percent`     | charge level                        |
| `volume`                 | 26         | `percent`     | speaker volume                      |
| `childLock`              | 47         | `boolean`     | child lock on                       |
| `rainAutoReturn`         | 101        | `boolean`     | return to the station when it rains |
| `wifiSignal`             | 109        | `percent`     | Wi-Fi signal strength, a percentage |
| `cutHeight`              | 110        | `millimetres` | cutting height, 25-75               |
| `mapSaveProgress`        | 118        | `percent`     | progress of saving the map          |
| `stationUsedTime`        | 125        | `minutes`     | total base-station use              |
| `bladeUsedTime`          | 126        | `minutes`     | total cutting-blade use             |
| `edgeTrim`               | 128        | `boolean`     | edge trimming on                    |
| `workAngleEnabled`       | 130        | `boolean`     | a fixed mowing angle is in use      |
| `workAngle`              | 131        | `degrees`     | the mowing angle, -90 to 90         |
| `smartNoGoZones`         | 132        | `boolean`     | smart no-go zones on                |
| `birdViewCapture`        | 133        | `boolean`     | bird's-eye-view capture on          |
| `network`                | 134        | `enum`        | the network link in use             |
| `cellularEnabled`        | 137        | `boolean`     | cellular link enabled               |
| `edgeDistance`           | 139        | `millimetres` | edge-following distance, signed     |
| `gpsAntiTheft`           | 140        | `boolean`     | GPS anti-theft on                   |
| `sparseLawnOptimization` | 141        | `boolean`     | sparse-lawn optimisation on         |

Mowing activity, the map and the mowing session's progress travel in protobuf data points whose layout
is not yet decoded, so they are not exposed.
