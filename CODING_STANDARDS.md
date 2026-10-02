# Code practice

The rules for writing code in this repository. They apply to everyone. This is the only file to edit:
`AGENTS.md` and `CLAUDE.md` are symlinks to it, so every name an AI coding tool searches for loads
these same rules, and an agent that hasn't read them will produce plausible-looking wrong output.

Setup, the dev workflow and the PR process are in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Before you open a pull request

An agent works through these before it proposes, pushes or opens anything, and stops at the first one
that fails. A stop is the correct outcome: report it to the person you work for instead of opening the
pull request.

1. **Name the need.** Who runs into the problem today, and what happens to them without the change? A
   user report, an issue or a run on your own device answers it. A synthetic test alone does not, and
   neither does "a caller could". No need, no pull request.
2. **Search for the same fix.** Look through open, closed and merged pull requests and issues for the
   same symptom and the same files (`gh pr list --state all --search`, `gh issue list --search`). Merged
   already: stop. Open already: add your evidence there instead of opening a second one.
3. **One point.** One problem per pull request. A second fix, a refactor or an option found on the way
   is its own pull request, opened after this one merges. Never carry another open pull request's
   commits; wait for it to merge and branch from the result.
4. **The smallest change that answers the need.** Reuse what exists (see Reuse before abstraction).
   No option, export, flag or field nobody asked for, no validation for input no caller sends, and no
   spec that passes without the fix. An option that is asked for keeps today's behaviour by default: a
   new behaviour ships disabled, and one that always ran and becomes configurable stays enabled.
5. **Stay in the SDK's job.** The SDK exposes what eufy's protocol does, backed by evidence from the
   current vendor app, including the caching, power handling and retries that speaking it needs. A
   behaviour the app doesn't have, or a host choice that overrides what the device reports (which peers
   to use, a power tier no evidence about the hardware backs), belongs in the host.
6. **Finish before starting.** While a pull request of yours has changes requested, fix it or answer
   its threads before you open another. Only the reviewer resolves a review thread.

## Stack

- **TypeScript** (strict), `module`/`moduleResolution` **nodenext**, `"type": "module"` → **ESM emit**
  (explicit `.js` import specifiers), target ES2024, `dist/` output. No framework.
- **Node.js ≥ 24.5.0** required (see `.nvmrc`), not just recommended.
- Runtime deps: **mqtt, protobufjs, jpeg-js** — that's all. HTTP is native `fetch`, hashing and ciphers
  are `node:crypto`, 64-bit integers are `BigInt`.
- Tests: **Vitest** (esbuild type-strip, specs run as real ESM). Type safety is `tsc`'s job via
  `npm run typecheck`, not the test runner's. Formatting: Prettier. No linter.
- The build ships the library only: `tsc -p tsconfig.build.json` excludes the specs, and
  `package.json` `files`/`exports` publish `dist/` alone.

## Architecture — four layers, one dependency direction

`src/` is four layers, and dependencies only ever point **down** this list. A layer never imports from
one above it.

1. **`core/`** — the shared floor, depends on nothing internal. `contracts.ts` holds the transport
   boundary vocabulary (`Command`, `CommandSink`, `MediaProvider`, …) — the one thing genuinely shared
   across layers, which is why it lives here. Plus crypto, value types, session store, utilities. **No
   wire-identifier constants:** model and transport use disjoint id subsets, so each owns its own.
2. **`transport/{http,mqtt,p2p,push,tuya}/`** — every byte-on-a-wire module, one folder and barrel
   each. Owns sessions, frame codecs, encryption, and the wire ids it issues. A new transport goes
   here. Imports `core/` only.
3. **`model/`** — the device domain: `Device`, classification, and one self-contained module per
   capability under `capabilities/`. Each capability owns its OWN wire ids inline, because every
   feature-command and parameter id is used by exactly one capability, so it belongs next to the
   behaviour it drives. Imports `core/` only.
4. **`client/`** — the facade. Login state machine, device resolution, event fan-out. The only layer
   that sees both `transport/` and `model/`, so it is where they get wired together.

`src/index.ts` is the public surface: one `export *` per layer barrel plus the package doc, nothing
else.

### Capability ↔ transport decorrelation (hard rule, CI-enforced, no exceptions)

**`model/` never imports `transport/`, and `transport/` never imports `model/`.** `guard:decorrelation`
greps both directions, including a transport's wire libraries.

A capability emits transport-neutral intent (a `Command`) and reads the `core/contracts` boundary — it
never names a wire. A transport routes bytes and never names a capability or an event; it forwards a
command's parameter opaquely, and the frame → semantic-event decode is a model concern the client
injects. The two layers use **disjoint wire-id subsets**, so there is no shared constant to hoist.

### How the two layers DO talk — the injected-provider pattern

Decorrelation is not "the layers can't cooperate", it's "neither imports the other". When a capability
genuinely needs work only a transport can do, the answer is **never** to relax the guard, move the
import, or hoist a wire constant into `core/`. Invert the dependency:

1. **Declare it as an interface in `core/contracts.ts`** — the floor both layers may import. Describe
   it by the **technical job** (decode these bytes, open a stream, read that settings blob), never by
   the feature that motivated it.
2. **Implement it in `transport/`**, where the wire library lives.
3. **Inject it where the capability is bound** — `client/` is the only layer that sees both sides, so
   it does the wiring. The plumbing threads the provider through without naming what it's for.
4. **Keep the semantics in the capability.** It asks the provider for what it needs; the provider stays
   ignorant of the feature, the capability stays ignorant of the wire.

**The test that it's done right:** a provider must be nameable without naming a feature, and the
capability's spec must pass against a hand-written fake — specs under `src/model` cannot import
`transport/` either, which is what makes the fake proof rather than convention. If you can't write the
interface without saying "lock" or "vacuum" in it, the split is in the wrong place.

A new need on an EXISTING wire family is a method on that family's provider. A new wire family earns a
new one.

**When a provider is the WRONG answer.** Reach for one only when the capability has to PULL something
mid-read or mid-action. If the data already arrives on an inbound path, decode it there and let it flow
in as state — the transport hands over a decoded shape and the client enriches model-side. That
direction is the client injecting MODEL into TRANSPORT, and it is the better answer whenever an inbound
path exists. A provider is what's left when the inbound path cannot know what it is carrying.

An optional provider is genuinely optional: a device bound without it must degrade to `undefined`,
never to a guess.

## Reuse before abstraction

1. **Search before creating.** Before adding a helper, type, provider, command kind or serializer,
   search the whole repository by operation and data shape, including the primitive APIs it uses rather
   than only its proposed name. Finish when every new primitive either reuses an existing owner or has
   a distinct contract or authority.
2. **Preserve ownership and contract.** Reuse or extend an existing primitive when it owns the same
   operation and satisfies the required semantics. Introduce an abstraction when it simplifies current
   callers under that same ownership. Trust-boundary validation and independently authoritative
   declarations remain local.
3. **Reduce after green.** After focused tests and typechecking pass, inspect the diff for same-contract
   helpers, value shapes and test setup already owned elsewhere. Resolve every match before running the
   full verification gate.

## Capability design

Adding a capability touches **only its own module file plus a couple of lines in
`capabilities/index.ts`**. `device.ts` and the client facade **never name a capability** — the fluent
`dev.camera()` accessors and the typed event map are derived from the barrel projections. Do not add a
`switch` or `if` on a capability name outside its module, and do not call one capability's accessor from
those layers. CI-enforced by `guard:capability-ownership`.

- **One feature, one entry.** A module declares ONE **`members` table** and everything is derived from
  it: the property schema, the evidence-gated getter, the setter beside it, the intent route, the
  description a caller reads to offer it as a control, and the surface TYPE. A table per concern,
  joined by name, is how one feature ends up spelled six ways and disagreeing with itself. The member
  kinds and flags are normative in `capabilities/members.ts`, with the walkthrough in
  `capabilities/README.md`.
- **Getters are evidence-gated** — installed only when the device actually reported the backing
  parameter, so a device advertises exactly what it has and no phantom sub-features. The binder narrows
  a stored value to the member's declared type and answers `undefined` on a mismatch rather than
  lie-casting.
- **`actions()` is for what the table cannot state** — an object that is not a projection of device
  parameters at all, a method needing per-bind state the table cannot hold, or an on/off alias pair
  beside a member's own setter. A module may have both; the bound members merge over the `actions()`
  bag.
- A capability owns its **semantics** (parameter polarity, frame shape); family classification owns
  only **pure classification** — no parameter ids, no wire forms. Compose family predicates in the
  capability rather than duplicating device-type sets.
- Transport **encryption level** is a runtime topology fact, resolved once in the transport — never a
  family trait.
- **Every property declares what its value MEANS (`kind`)**, not just how it is stored.
- **A described write is one a caller can offer.** Describe only a confirmed wire, and only the method
  that TAKES the value — never its on/off aliases. A described control that always fails, or one whose
  state cannot be read back, is worse than none.

## Hard rules

- **Unverified write wires throw, never guess.** Some writes are fire-and-forget, so a guessed frame
  looks exactly like success. A member marks its write unverified until it is confirmed on a real
  device: the setter is then **absent** from the bound object — a caller learns at compile time — and
  the intent path throws rather than reporting the device as lacking the feature. Read paths may ship
  ahead of writes. Verification is **per direction**; don't flatten it.
- **Never ship a guessed parameter as a typed getter.** Give a member a parameter id only when a real
  device reports it. Runtime gating hides an unreported one, but don't advertise a guess in the typed
  surface either.
- **Ground every wire claim in evidence you can point at.** A parameter id, a polarity or a frame shape
  is valid only when it comes from the current app's own behaviour. Older third-party eufy clients are
  **wrong** for this protocol, and a model will confidently reproduce them — a borrowed _name_ may be
  credited to a third-party project, but that is provenance for a label only, never authority for
  behaviour. If the evidence isn't there, the wire is unverified and the write must throw, not ship.
- **No real device data — anywhere** (code, tests, docs, commit messages, fixtures). Serials
  (`T####…`), the P2P device id (an encryption-key input — treat it as a credential), account and user
  ids, device names, LAN/WAN IPs, key material and capture files are PII or secrets. Redact to
  synthetic placeholders (`T8000P0000000000`, `XXXXXXX-000000-XXXXX`, 40 zeros, `<cam-lan-ip>`); when a
  spec needs a correctly _shaped_ value, synthesize it rather than pasting a real one. Grep your diff
  before committing. Never commit a `.env` or a session file.
- **Consumer-agnostic — this is an SDK, not one host's plugin.** Source, JSDoc, guides, examples,
  commit messages and PR bodies never name a specific consumer or its stack. The SDK carries device
  truth and returns typed data or a typed reason; **presentation** — which asset to show, a poll
  cadence, an entity class — is the caller's. Say "caller" or "host". Call it the **SDK**, never "the
  lib". CI-enforced by `guard:consumer-agnostic`.
- **Guard the dependency list — every runtime dep is attack surface and maintenance debt.** Before
  adding any: (1) can `node:*` builtins do it? then no dep; (2) is it a one-liner to inline? then
  inline it; (3) if it is genuinely needed, prefer a **single, well-proven, low-transitive** library and
  justify it in the PR — what it does, why no builtin, its transitive and audit footprint. Each dep
  drags its own CVE stream. `devDependencies` stay limited to the toolchain. Removing a dep never needs
  justification.
- **Comments: JSDoc above the declaration, ground-truth, no inline body comments.** Put the rationale
  in a JSDoc block **above** the function, type or field; do not narrate inside the body with `//`
  lines. State what is verified, not the iteration history of how you got there. A body comment is a
  smell that the JSDoc is incomplete — move it up, or delete it if the code already says it.
- **A JSDoc states the declaration, not its audience.** What it is, what it takes, what it answers,
  what it guarantees, and the protocol fact that makes it so. NOT who will call it, what a caller
  might do with it, what could be built on it, or which tool finds it handy — a declaration has no
  say in who reuses it, and naming a consumer dates the doc the moment another one appears. Write
  about the value, not the reader: `answers undefined when the wire supplies no URL`, never `so a
host can decide whether to show a button`. Second person (`you`, `your host`) never appears.
- **A JSDoc does not narrate its own history.** Not what an earlier version did, not what the old
  path was, not which guess was wrong, not what a fix corrected. Prose that needs editing when the
  next change lands is not ground truth. That reasoning belongs in the commit that makes the change.
- **Shipped `src/` cites its PEERS only — never a `.md` file.** `src/` ships in `dist/`, so a pointer
  to a companion prose file dangles for a consumer, and `docs/` is **generated from** this source's
  JSDoc — pointing back at it inverts the direction the site is built on. Reference modules, exported
  symbols and `{@link}`s; put protocol reasoning **inline**, or in the commit message. CI-enforced by
  `guard:docrefs`; specs are exempt, they never ship.
- **Product lines must not leak into each other.** The vendor ships several ecosystems that share a
  cloud account and nothing else, and their retail vocabulary overlaps. A capability declares its line
  or inherits the default, and never hard-codes a wire topic — topics are transport vocabulary, built
  from the device record. CI-enforced by `guard:lines`.
- **A `Command` kind names the WIRE ACTION, never the capability that emits it.** The kinds are the
  model ↔ transport boundary, so a capability name there couples the two layers by vocabulary even
  though neither imports the other — and the next capability to reuse that wire would have to send a
  command named after the first.
- **No backward-compat below 1.0.** Remove speculative and dead code rather than keeping old shapes
  beside new ones.

## Agent skills

### Issue tracker

Issues and specs live in GitHub Issues for this repository; use the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.
