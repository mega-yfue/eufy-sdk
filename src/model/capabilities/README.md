# Capability modules

Each **capability** (a composable feature a device exposes — `light`, `ptz`, `camera`,
`lock`, `battery`, …) is **one self-contained file** in this folder. A module owns everything
about its feature, as pure declarative data plus a little resolution logic:

| Concern                                                      | Field                              | Example                                                                  |
| ------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------ |
| **The capability's surface** (one entry per feature)         | `members`                          | `battery` → `level`, `setWorkingMode`, `getAutoLockState`                |
| Property schema (DERIVED from `members`)                     | `properties: propertiesOf(X)`      | `battery` → param 1101                                                   |
| **Detection** (does a device have it?)                       | `detection`                        | `light` ← spotlight params 1400/6080; `ptz` ← presets 6090/6210          |
| **Inbound events** (id → semantic event)                     | `events`                           | `motion` push 3101/14 → `"motion"`; `lock` push 257..771 → `"lockState"` |
| Inbound escape hatch (binary/bespoke)                        | `decodeEvent(signal)`              | `ptz` 1700 float frame → `ptzNotify`                                     |
| Inbound state recovery (realtime → params)                   | `decodeState(signal)`              | a DP report → `paramType → value`                                        |
| **Outbound commands** (action → transport-neutral `Command`) | `buildCommand(action, value, ctx)` | `light` on → the right switch wire for THIS device                       |
| Methods the table cannot state                               | `actions(ctx, sink, media?)`       | `device.light()?.setAutoSpotlight(true)`                                 |

The barrel (`index.ts`) collects every module and derives the fleet-wide helpers
(`detectCapabilities`, `decodeEvent`, `buildCommand`, `buildActions`, `codecBaseline`,
`mergeProperties`). **Adding a capability = a new file + one import line in the barrel. Deleting
one = removing that file + its import line.** Nothing else needs editing — `resolveDevice`, the
P2P `data` hook, push/poll/mqtt routing and command dispatch all adapt.

Tests live in `__tests__/` (one `<cap>.spec.ts` per module) — kept out of the module folder so
source and specs don't mix.

## Detection: dynamic first, static only when forced

`detection` is OR-ed evidence — a device has the capability if **any** field matches. Prefer the
most dynamic (self-reported) signal; fall back to a static table only when the device gives you
nothing else.

```ts
detection: {
  // 1. DYNAMIC — a reported param PROVES the feature (preferred). Namespace-agnostic: security
  //    param ids and vacuum Tuya-DP ids are declared the same way. (light ← 1400/1401/6080…)
  evidenceParams: [6090, 6210],
  // 2. Codec baseline — every device of these codecs has it (e.g. any camera has video).
  codecs: ["camera"],
  // 3. Model/category/name regexes — a naming signal when the params aren't emitted yet.
  modelHints: [/pan.?tilt/i],
  // 4. STATIC vendor table — DeviceType numbers that guarantee the feature. LAST RESORT, only
  //    when there is no honest self-reported signal (Indoor-PT reports no PT param).
  deviceTypes: [31, 35, 111],
  // 5. Escape hatch — arbitrary logic. Must never throw.
  detect(rec, codec) { return false; },
},
```

Static and dynamic **coexist**: `ptz` detects SoloCam dynamically (preset params) and
Indoor-PT statically (`deviceTypes`). All hardcoded id/type assignments live in the capability
files — not in `classify.ts`/`registry.ts`. (`classify.ts` keeps only codec _routing_ — which
wire protocol a `deviceType` speaks — a separate axis.)

## Inbound events — one semantic event from any transport

Device events arrive from four transports — FCM **push**, **P2P frames**, cloud **poll**, secure
**MQTT** — and a module normalizes ANY of them into one semantic event, so a consumer listens
without knowing the source:

```ts
eufy.on(
  "motion" | "doorbellPress" | "personDetected" | "lockState" | "contactState" | "batteryAlert" | "ptzNotify",
  (ev) => {
    /* ev.deviceSn identifies it */
  },
);
```

A **named** event is for a state that carries something a bare property change cannot: an inbound source
the property path does not reach, a threshold crossing, or a dedupe across transports. Every other
readable member is announced generically as `propertyChanged` — derived from the `members` table, so a
member needs no `events` row to be announced, and one that only restates "this param moved" does not earn
a name. There is no opt-out and no filter on `kind`: which of a device's truths a host acts on is the
host's call, so a member declares nothing to be announced and nothing to be silent.

The common case is the **declarative `events` table** (data, no code):

```ts
events: [
  { source: "push", match: 3101, emit: "motion" }, // exact id
  { source: "push", match: 14, emit: "motion" }, // sensor PIR (CusPushEvent)
  { source: "poll", match: 1550, emit: "contactState" }, // a param that changed on a poll
  { source: "push", match: [257, 771], emit: "lockState" }, // inclusive id range
  { source: "push", match: 6, emit: "batteryAlert", payload: { state: "low" } }, // static discriminator
];
```

The barrel folds every module's `events` into one index at load, so dispatch is a direct lookup.
`decodeEvent(signal)` is the **escape hatch** only for signals a flat table can't express — e.g.
`ptz` parsing binary float `(pan,tilt)` records out of a 1700 frame. Raw
`push`/`p2p`/`message` events remain for low-level use.

`InboundSignal` union (dual of `Command`): `push` (normalized FCM), `p2p-frame`, `poll`
(param from→to), `mqtt` (vacuum/non-P2P realtime).

## Wire ids: capability-owned, declared inline

A capability's **feature-command ids** (the P2P outer-commands it writes) and **state-param ids** (the
`param_type`s it reads) are its OWN vocabulary — declare them at the top of the module as a named const,
not as bare magic numbers at the call site and not in a shared file:

```ts
/** The P2P feature-command ids this capability drives. */
export const MYCAP_CMD = {
  /** What it does + provenance (✅ verified live on <model> / capture). */
  SOME_SWITCH: 1234,
} as const;
// state params (the read side) → export const MYCAP_PARAM = { … } as const;  (see battery.ts BATTERY_PARAM)
```

Rules:

- **One owner.** Every id is used by exactly ONE capability, so it lives next to the behaviour it
  drives (`camera.ts` `CAMERA_CMD`, `light.ts` `LIGHT_CMD`, `audio.ts` `AUDIO_CMD`, `motion.ts`
  `MOTION_CMD`, `doorbell.ts` `DOORBELL_CMD`, `pan-tilt.ts` `PTZ_CMD`, `battery.ts` `BATTERY_PARAM`).
  Don't hoist ids into a shared file — if two capabilities seem to need the same id, they don't (check
  which one truly owns the behaviour).
- **`push-events.ts` is the ONE exception** — event-code _semantics_ are shared (several capabilities
  match the same push codes), so those enums + `detectionName` live there, imported by the caps.
- **Internal, not public.** These consts are NOT re-exported from `model/index.ts` — a host drives the
  fluent API, never raw ids. The capability's spec imports the const by direct path
  (`import { MYCAP_CMD } from "../mycap"`) to assert the wire.
- **Name it, don't inline it.** Reference `MYCAP_CMD.SOME_SWITCH` in `buildCommand`/`actions`/`decodeEvent`
  and `properties[].paramType`, never a bare `1234` — greppable, no id/name drift.
- **Provenance = V6 APK, not ecs.** A citation of the old third-party client (`bropat`/
  `eufy-security-client`) is where a symbolic NAME came from — never authority for a value, polarity, or
  frame shape. **Do not name it in shipped `src/`**: describe it there as "a third-party
  reverse-engineering project" and keep the ⚠️-unverified marking, which is the part a reader needs. Ground every id in the disassembled
  V6 app itself or a confirmed exchange with it; if that evidence is missing the wire is UNVERIFIED and
  the write must `throw`/return `undefined`, never ship a guess. (See root `CLAUDE.md` Rules.)

## Outbound commands — one action, the right wire per device

A module resolves a semantic action into a **transport-neutral `Command`**; the `CommandSink`
(implemented by the client) routes it to the wire. The consumer never learns the param id or wire
form. A module emits **transport-neutral intents** (`setScalar` / `setJson` from `./access`) and
never names an encryption level or frame kind — the transport resolver in `index.ts` picks L1 vs L2
by session/topology. `Command` kinds:

- `set-param` — a scalar param (id + value + `ScalarForm`). `"auto"` lets the transport pick the
  level; `"int-string"` / `"direct-binary"` pin it when the firmware requires a specific level.
- `set-json` — a JSON control-payload param (`{commandType, data}` under wrapper 1700).
- `p2p-privacy-burst` — the multi-frame privacy sequence (a bespoke burst, not a set-param).
- `aiot-dp` — Anker AIoT MQTT data-point (vacuum/mower clean line).

`buildCommand` uses `ctx` (`{channel, codec, deviceType?, model?, serial?, paramIds}`) to pick the
right variant. Where the wire form is a vendor-family trait that **no param distinguishes** (e.g. two
cameras both report the floodlight param 1400 yet the app sends the switch differently), the module
keys off a small `DeviceType` table. **If a device is detected as having the capability but its
wire format is unknown, return `undefined` — never guess.** The barrel gates `buildCommand` on the
device's detected capabilities, and `EufyMega.setProperty` throws `CapabilityNotSupportedError`
rather than firing a command into the void (P2P writes are fire-and-forget, so a wrong/absent
command otherwise looks like success).

Media operations that RETURN data (stored/live snapshots, live / record) go through the injected
`media` provider, not the sink: they are `provided("media", …)` members, so each takes its signature
from `MediaProvider` itself and lands **optional**. `device.camera()?.snapshotStored?.()` is additionally
omitted when the client disables its passive stored-image cache; it returns retained push bytes and
does not fall back to the provider's explicit `snapshotLive()` path.

## Members — the capability's whole surface, declared once

A capability's surface is ONE declarative table: `export const X_MEMBERS = { … } as const satisfies
Members`. One entry per feature, and everything else is DERIVED from it — the normative reference is
[`members.ts`](./members.ts), whose JSDoc documents every kind and every flag; this section is the
walkthrough.

What the module writes:

```ts
export const CONTACT_MEMBERS = { … } as const satisfies Members;

/** Bound entry-sensor controls — the object returned by `dev.contact()`. */
export type ContactActions = Surface<typeof CONTACT_MEMBERS>;

export const CONTACT: CapabilityModule = {
  capability: "contact",
  members: CONTACT_MEMBERS,
  properties: propertiesOf(CONTACT_MEMBERS), // never a second, hand-written list
  …
};
```

What comes out of the table, with nothing else declared:

- the **`PropertySpec[]`** the rest of the model consumes (`propertiesOf`);
- the **evidence-gated getter** on `dev.<cap>()`, narrowed to the member's declared `type`;
- the **setter** beside it (`recordDuration` → `setRecordDuration`, or `writeAs` to name it);
- the **intent route** `setProperty(sn, "<property>", v)` resolves through — the SAME builder as the
  setter, so the two cannot diverge in what they accept, and one generated rejection message names the
  domain for both;
- the **`ActionSpec` description** a caller reads to offer the feature as a control, reflecting the
  member's own getter (only where that getter was installed);
- the **TypeScript surface type** — `Surface<typeof X_MEMBERS>`. There is no hand-written `*Actions`
  shape: a rename moves the getter, the setter, the route, the schema and the type at once.

### The member kinds

| Kind                 | Declared as                            | Gives                                                      |
| -------------------- | -------------------------------------- | ---------------------------------------------------------- |
| **`ValueMember`**    | `{ param, type, kind, description }`   | a getter; plus a setter when it declares `write`           |
| **`ActionMember`**   | `{ action: (ctx) => Command, … }`      | a momentary `() => Promise<void>` — no readable state      |
| **`MethodMember`**   | `method((deps) => fn, "…")`            | a method owning its whole signature (flows to the surface) |
| **`ProvidedMember`** | `provided("media"\|"ff09Settings", …)` | a method only a device bound to that provider has          |

`method()` is the escape hatch that keeps the table honest instead of pretending everything is a
property: a lock's `setAutoLock(enabled, delaySeconds?)` is neither a getter over one param nor a bare
momentary command. `provided()` takes its signature FROM the injected provider and lands **optional**,
because an unbound device genuinely does not have it (`dev.lock()?.getAutoLockState`). Its optional
fourth argument lists additional resolved capability evidence the method requires, keeping that gate in
the same member declaration used by binding and provider eligibility.

A method owning its signature cannot have its arguments derived, with one exception: **taking none is
derived from arity**, so `lock()` describes as `args: []` ("takes nothing", offerable as a plain button)
rather than staying silent, which means "not stated". A DEFAULT parameter is invisible to
`Function.length`, so a method with one names it (`args` beside `method()`, as `locate` does) instead of
being derived as nullary; `action-specs.spec.ts` holds every stated required argument against that arity.

A `ValueMember`'s key is the **accessor**; `property` renames it in the device's flat property namespace
when the key would collide there (`battery`'s `level` → property `battery`, since `level` is also
`suction`'s). Default is the key, which is right for the majority that do not collide.

### Three rules make the read side honest

- **Type is narrowed, never cast.** `bindMembers` reads the stored property through `access.ts`
  `readNum`/`readBool`/`readStr` according to the member's declared `type` (`bool`→`boolean`,
  `number`/`enum`→`number`, `string`→`string`) and answers `undefined` on a mismatch — the guarantee the
  derived surface type makes at compile time. A `decode` overrides this and its OWN return type wins,
  which is how `activity` surfaces a named union rather than the `string` it is stored as.
- **Evidence-gated presence.** A getter is installed **only when the device actually reported the
  backing param** (`ctx.paramIds`, or a `readAliases` id, which is the same value on another family's
  wire; `readAvailable` and each alias's `available` predicate restrict those ids to the families where
  they carry that meaning; `realtime: true` is the opt-out for state that only ever arrives over realtime). So a device
  advertises exactly the reads it has — never a phantom sub-feature of the capability it owns (a battery
  cam that reports its custom-recording settings exposes `recordDuration`; one that reports only a level
  won't have that key at all). This means **don't declare a `param` for a guessed id** — hold the read
  side to the same V6-truth bar as writes. A param the device reports whose MEANING is unevidenced is
  `unexposed: true`: in the schema, reachable through `getProperty`, no typed getter. `battery`'s 1103 is
  the cautionary tale — it is `GET_CAMERA_INFO` in the app's own table and reads a constant `5`, so a
  `batteryLow` bool coerced from it would read `false` on every device forever. The mirror case is
  `writeOnly: true`: a setting the device accepts but never reports back, so it contributes no schema
  entry and no getter, only its write.
- **Meaning comes from `kind`.** Every member says what its value MEANS, not only how it is stored —
  `percent`, `seconds`, `timestamp`, `enum`, … (`ValueKind` in `../types.ts`) — beside `unit`, which it
  must agree with. When the getter departs from the stored value — a `decode` lifting a field out of a
  payload, or turning a raw code into a named union — the kind belongs on `decodedKind` instead (plus
  `decodedValues` for an enum), which is the only place either is legal:

  ```ts
  activity: {
    param: VACUUM_DP.WORK_STATUS,
    type: "string",
    provenance: "mega",
    decode: (raw, codec) => decodeVacuumActivity(raw as ParamValue | undefined, codec),
    decodedKind: "enum",
    decodedValues: VACUUM_ACTIVITIES,
    description: "High-level activity from WorkStatus.state (DP 153 work status, Raw protobuf).",
  },
  ```

  `value-kinds.spec.ts` enforces the pairings and fails the build on a disagreement. Picking one is a
  question about the value, not about its storage: a unit the device reports it in names the kind, no
  unit at all makes it a bare number, a set we can publish makes it an enum and a set we cannot makes
  it an opaque id. `ValueKind`'s own doc carries the test for each of those near-misses.

### Gating a write, and refusing to guess one

- `requires: [param]` installs the write only on a device that reported one of those params — "has a
  battery" is much weaker evidence than "speaks this setting". `available: (ctx) => …` is the general
  form for a gate no param list can express (a topology or family fact). Either one lands the setter
  **optional** on the surface, because whether it exists is a runtime fact.
- `requiresRead: true` installs the write only when the member's family-valid primary param or read alias
  was reported. Use it when the readable state itself is the exact evidence for the control.
- `unverified: true` says the device accepts the setting but the frame shape has NOT been captured. The
  `write` beside it is **not installed** (a caller learns at compile time, from the optional setter) and
  the intent path throws `"<cap>: <member> write wire unverified"` rather than reporting a device that
  lacks the feature. A fire-and-forget write that is wrong looks exactly like success — promoting one is
  a single edit once a capture lands.
- `min`/`max`/`enumValues`/`decodedValues` are the PUBLISHED domain, enforced once in `memberWrite` for
  both entry points and named in the generated rejection message, so it cannot go stale as the set grows.
- **A write domain narrower than the read's** is stated as the first `args` entry's `values`, which then
  becomes the set the check, the rejection message and the offered control all use. Reach for it only for
  that asymmetry — a device that REPORTS a value it will not accept back — and only while the asymmetry
  lasts: a member whose two sides agree declares `enumValues` alone and the argument derives from it.
  No member states one today. `arming` was the last and is the shape to recognise: a station reports nine
  guard modes and, until each write was confirmed against real hardware, accepted only some of them.
- `aliases` route extra intent verbs to the same write with the value each stands for; `intentNames`
  route a second property name to it;
  `accepts<T>()` widens the setter past what the getter answers (a resolution NAME for a tier stored as
  an int).

### What still belongs in `actions()`

The table covers momentary commands, bespoke signatures and provider-backed methods, so `actions()` is
left with: an object that is not a projection of device params at all (`info`), a method needing per-bind
state the table cannot hold (a vacuum's model-specific level set, a mode-control sequence counter), and
`on`/`off` alias pairs beside a member's own setter. Describe such a method with `describedAction` if it
can honestly be described at all. A module may have both — `buildActions` merges the bound members over
the `actions()` bag.

A capability that is **all members** (`contact`, `leak`, `smoke`, `co`, …) omits `actions()`
entirely. It still gets a fluent accessor, so it still needs a `DeviceActionMap` entry.
`buildActions` / `ACTION_ACCESSOR_NAMES` include any module with `actions` **or** `members`; getters ride
the read-through cache automatically.

## Template for a new capability

1. Add the identifier to the `Capability` union in `../types.ts`.
2. Create `src/model/capabilities/<kebab-name>.ts`:

```ts
import { asBool } from "../../core/util.js";
import { setScalar } from "./access.js";
import { method, propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";

/** The P2P feature-command ids this capability drives — its OWN vocabulary (see "Wire ids" above).
 *  A borrowed name is a NAME source only; ground the value in the V6 APK / a live capture. */
export const MY_CAP_CMD = {
  /** What it toggles. ✅ verified live on <model> / <capture>. */
  MY_SWITCH: 1234,
  /** The momentary trigger. ✅ verified live on <model> / <capture>. */
  MY_TRIGGER: 1235,
} as const;

/**
 * Bound controls — the object returned by `dev.myCap()`.
 *
 * Everything (getters, setters, argument types, descriptions) is DERIVED from `MY_CAP_MEMBERS`, so
 * nothing is written out here. JSDoc on each member surfaces on IDE hover.
 */
export type MyCapActions = Surface<typeof MY_CAP_MEMBERS>;

/** Every `my_cap` feature, declared once. Order is schema order. */
export const MY_CAP_MEMBERS = {
  // A ValueMember: evidence-gated getter `dev.myCap()?.isOn`, plus the setter its `write` earns.
  // `writeAs` because `setIsOn` reads wrong; drop `write` entirely for a read-only value.
  // `requires` installs the write only on a device that reported the param — it then lands optional.
  isOn: {
    param: MY_CAP_CMD.MY_SWITCH,
    property: "myProp", // only when the key would collide in the flat property namespace
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    requires: [MY_CAP_CMD.MY_SWITCH],
    writeAs: "set",
    description: "Whether the feature is on (1234 MY_SWITCH). Write verified live on <model>.",
    write: (v, ctx) => setScalar(MY_CAP_CMD.MY_SWITCH, asBool(v) ? 1 : 0, ctx),
  },
  // An ActionMember: a momentary command with no readable state → `() => Promise<void>`.
  trigger: {
    action: (ctx) => setScalar(MY_CAP_CMD.MY_TRIGGER, 1, ctx),
    description: "Fire the momentary trigger — no state to read back.",
  },
  // A MethodMember: for what one param's value cannot express. Its signature flows to the surface.
  runIt: method(
    ({ ctx, sink }) =>
      (times: number): Promise<void> =>
        sink.dispatch(setScalar(MY_CAP_CMD.MY_TRIGGER, times, ctx)),
    "Do the thing the table cannot state as one param's value.",
  ),
  // A ProvidedMember (omitted here): `provided("media"|"ff09Settings", (p, deps) => fn, "…")` — lands
  // optional, since an unbound device does not have it.
} as const satisfies Members;

export const MY_CAP: CapabilityModule = {
  capability: "my_cap",
  description: "One-line summary for docs.",
  members: MY_CAP_MEMBERS,
  properties: propertiesOf(MY_CAP_MEMBERS), // never a second, hand-written list
  // Optional — omit any field you don't need.
  detection: { evidenceParams: [MY_CAP_CMD.MY_SWITCH] },
  // Inbound (declarative): push/poll id → semantic event name.
  events: [{ source: "push", match: 5000, emit: "myEvent" }],
  // Inbound escape hatch (only for binary/bespoke frames a table can't express).
  // decodeEvent(signal) { return signal.source === "p2p-frame" && signal.commandId === 9999
  //   ? { event: "myEvent", payload: {} } : null; },
  // `buildCommand` is only for an intent no member claims — the members already answer setProperty.
  // `actions()` only for what the table cannot state (see "What still belongs in actions()" above).
};
```

3. Register it in `index.ts` (the barrel):
   - add the `import { MY_CAP } from "./my-cap"` and put it in the `MODULES` array;
   - if it has `members` **or** `actions()`: add `import type { MyCapActions }` and one line to
     **`DeviceActionMap`** (`myCap: MyCapActions`) — this is what makes `dev.myCap()` typed (a capability
     that is all members still needs this entry). `ACTION_ACCESSOR_NAMES` (runtime) is derived
     automatically;
   - if it emits a **new** semantic event name: add one line to **`DeviceEventMap`**
     (`myEvent: PushSemanticEvent`) — this is what makes `eufy.on("myEvent", …)` typed.
     `device.ts` and `index.ts`'s class stay untouched — the fluent accessor + typed event are
     projections of these two maps.
4. Add `__tests__/<kebab-name>.spec.ts` (see `pan-tilt.spec.ts` / `light.spec.ts` for the reference:
   schema shape + detection + event mapping + command resolution + action dispatch).
5. `npm run verify` (typecheck + guards + build + `vitest`).
