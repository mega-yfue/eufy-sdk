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

::: warning AIoT state appears only after the robot reports
For AIoT vacuums, the **cloud device record does not carry a robot's live state** — its reported parameters hold none of
the activity/suction/battery values. Confirmed on two unrelated models, so treat it as how the line
behaves rather than a quirk of one robot. Those values arrive only over the robot's **realtime feed**,
which the SDK subscribes for you.

The consequence for a host: a robot reports **on change**, not on request, and an idle docked one may
stay silent for a long time. Because every getter is evidence-gated, `vacuumClean()` / `suction()`
resolve with **no state getters at all** until the first report lands — `activity`, `battery`, `power`,
`volume` and `suction` are absent, not stale. They appear once the robot has something to say.

So don't treat a missing getter as an error, and don't block startup waiting for one. Listen for
`deviceState` and re-read `dev.vacuumClean?.()` when it fires, rather than sampling once at bind time.
The AIoT cloud does not provide an on-demand read of those values. Tuya vacuums also have cloud
state polling, described below.

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

AIoT vacuums expose suction through `dev.suction()`. Tuya vacuums use
`dev.vacuumClean?.()?.cleaningStrength`, a string such as `"Quiet"` or `"Max"`; see
[Tuya controls](#tuya-controls) for writes.

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

AIoT state arrives on the realtime feed. Tuya state can also arrive through the SDK's cloud polling.
With SDK-managed connectivity enabled, `pollMs` configures the polling interval and
`setPollInterval(ms)` changes it at runtime; `0` disables polling. `autoRealtime: false` disables
SDK-managed background connectivity, including the polling loop.

Listen for `deviceState` and re-read capability accessors when it fires. An object obtained before a
parameter was first reported will not gain the new getter or control, so do not retain it as a fixed
list of available features. For Tuya activity, read `dev.vacuumClean?.()?.workStatus`.

A report also announces changed properties through [`propertyChanged`](/events). Payload-backed
AIoT readings need to be re-read through their typed getter.

Command acceptance does not confirm physical execution or an immediate state update. The SDK does
not currently schedule extra Tuya refreshes after commands. In X8 Pro / T2276 testing, cancelling a
return to the dock physically worked while `workStatus` still indicated returning for at least
15 seconds. Do not use that value alone to decide whether cancellation succeeded.

## Controls

Controls depend on the device family and reported parameters. Each method is optional; check for its
presence before offering it. Optional chaining in the examples skips a missing method rather than
reporting an unsupported operation.

### Tuya controls

These controls are offered to `eufy_home_tuya` vacuums once the required parameters have been reported.
There is no model allowlist. **Physical testing has been performed on an X8 Pro**; support on other Tuya
models has not been verified.

| Control                 | API                                        | Required reported parameters |
| ----------------------- | ------------------------------------------ | ---------------------------- |
| Start auto-clean        | `vacuumClean().startCleaning()`            | Mode and play/pause          |
| Pause                   | `vacuumClean().pauseCleaning()`            | Play/pause                   |
| Return to dock          | `vacuumClean().returnToDock()`             | Return-to-dock               |
| Cancel return to dock   | `vacuumClean().setStopReturnToDock(true)`  | Return-to-dock               |
| Suction level           | `vacuumClean().setCleaningStrength(level)` | Cleaning strength            |
| Clean current-map rooms | `vacuumClean().cleanCurrentMapRooms(ids)`  | Map operations               |
| Locate / stop locating  | `locate().locate(true / false)`            | Locate                       |

```ts
const tuyaClean = dev.vacuumClean?.();
await tuyaClean?.startCleaning?.();
await tuyaClean?.pauseCleaning?.();
await tuyaClean?.returnToDock?.();
await tuyaClean?.setStopReturnToDock?.(true); // cancel while returning

await tuyaClean?.setCleaningStrength?.("Quiet"); // also Standard, Turbo, Max
dev.vacuumClean?.()?.cleaningStrength; // reported value; may also be Off

await dev.locate?.()?.locate?.(true);
await dev.locate?.()?.locate?.(false); // stop locating
```

All four suction settings and both locate directions were physically observed on T2276. `Off` is a
reported suction state, not a supported write. The AIoT `suction().setSuctionLevel()` API does not set
Tuya suction.

**Resume is unavailable on Tuya.** Its standalone play command was accepted but did not move the
X8 Pro, and the reported state remained unchanged at 3, 8 and 15 seconds. Starting auto-clean after a
pause worked, but that does not establish that the existing job resumes. Zone and scene cleaning
remain unavailable on Tuya.

`cleanCurrentMapRooms([0, 3])` cleans those room IDs once on the currently selected map. Zero is a
valid room ID. The command does not switch maps, discover room IDs, or change per-room settings.
Select the correct map in the vendor app first. This current-map control is separate from AIoT
`cleanRooms(mapId, rooms, cleanTimes)`, which explicitly addresses a map. Room cleaning was
physically verified on T2276; other Tuya models remain untested.

Tuya publishing no longer requires an experimental opt-in: `tuyaAllowUnverified` and the low-level
`allowUnverified` options have been removed. API rejections throw through the command router; successful
acceptance still does not guarantee a physical result.

### AIoT controls

**Every mode-control verb below was run on a T2351 and did what it says** — the whole-floor four, and
the three that take an argument. The two suction setters rest on something different: a data-point write
the SKU's own catalog confirms, rather than a watched run. `setCleanParam` rests on a third thing again:
the message it sends is the one the robot reports its own settings in, decoded off that same T2351, and
the write direction has not been watched separately.

Worth separating, because a mode-control write carries a command NUMBER, and a wrong number is a
different command rather than a failure. A settings write has no number to get wrong, and it answers for
itself: the three reads it changes are on the data point it is sent to, so a frame the robot rejects
leaves them where they were.

#### Whole-floor verbs

```ts
const clean = dev.vacuumClean?.();

await clean?.startCleaning?.(); // whole-floor auto clean
await clean?.pauseCleaning?.();
await clean?.resumeCleaning?.(); // resumes where it stopped, unlike a fresh start
await clean?.returnToDock?.();

await dev.suction?.()?.setSuctionLevel?.(2); // raw level, see above
await dev.suction?.()?.setBoostIq?.(true);
```

#### What a run does with a surface

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

#### Cleaning part of a floor

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

Room ids and names come from the robot's map, which arrives on the map stream as the `map` event. A
docked robot sends no map of its own accord; `requestMap` asks for it the way the vendor app does when
its map view opens, and the map arrives on the stream within about a second:

```ts
eufy.on("map", ({ map }) => map.rooms?.rooms);
await clean?.requestMap?.();
```

#### What is still missing

The available AIoT settings writes are described above. Tuya's supported controls and remaining
limitations are listed separately under [Tuya controls](#tuya-controls).

**Driving to a point** (`START_GOTO_CLEAN`, method 4) has no encoder either, and for a different
reason: its argument is a coordinate, and no read published here hands you one. A scene id and a map id
both arrive on the scene report; a goto point would have to come from map data this SDK does not decode.

See [Devices & capabilities](/devices) for how capability resolution works, and the
[device gallery](/devices-gallery) for the Clean line.

## Mowers

The E15 robot mower (T2880) carries the `mower` capability. It is **read-only**: no write has been
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
