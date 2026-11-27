# core/ — shared primitives

**Owns:** the shared floor every layer may import.

- `contracts.ts` — the transport boundary vocabulary (`Command`, `CommandSink`, `MediaProvider`,
  structural `LiveStreamHandle`/`LiveVideoFrame`). Produced by capabilities, consumed by
  transport — belongs to neither, so it lives here. It also holds the **injected-provider** interfaces
  that run the other way (`MediaProvider`, `RawDpCodec`, `DpInboundFrame`): transport implements them,
  the facade injects them at `bindActions`, a capability consumes them. That inversion is how the two
  layers cooperate without importing each other — see the root `CLAUDE.md` decorrelation section for
  the full pattern and the test for whether a new one belongs here.
- `crypto.ts` (algo_ecdh body encrypt/decrypt + x-signature + ECDH), `types.ts` (EufyDevice,
  classifyDevice, realtime tags), `store.ts` (session persistence), `util.ts`.

Wire _identifier_ constants are NOT here — they belong to the layer that speaks them, and model &
transport use disjoint subsets: feature-command ids + state param ids live in `model/`, declared
inline in each capability (`camera.ts` `CAMERA_CMD`, `battery.ts` `BATTERY_PARAM`, …) with push-event
semantics in the shared `model/push-events.ts`; the router's envelope ids (`P2P_ENVELOPE`) + MCS
`MessageTag` live in `transport/`. The only truly cross-layer vocabulary is the `contracts.ts`
boundary, which is why that's all that sits on this floor.

**Invariant:** leaf layer — depends on nothing internal (the one type exception: `store.ts` imports a
`RegionShard` type from transport/http that the persisted session needs). Because the `contracts`
boundary lives here, `model/` and `transport/` exchange a `Command` WITHOUT importing each other.

**Imports:** node builtins + npm deps only. NEVER `../transport` (bar the `store.ts` type note),
`../model`, `../client`. Do NOT hoist a wire constant here to "share" it — check which layers actually
use it first; single-sided constants belong to the layer that speaks them.

**Surface:** `core/index.ts` (`export *`).
