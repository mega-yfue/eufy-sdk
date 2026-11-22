# Contributing

Thanks for helping out. This file covers setup, the dev workflow and the PR process. **How to write
the code — the architecture invariants and the rules CI enforces — is in
[AGENTS.md](./AGENTS.md)** (same file as `CODING_STANDARDS.md`); read it before your first PR. If you
drive an AI coding agent, also read [Working with AI agents](#working-with-ai-agents).

The usage guides live at <https://mega-yfue.github.io/>.

## License

The project is licensed under [Apache-2.0](./LICENSE). By opening a pull request you agree that your
Contributions are provided under that same license (inbound = outbound).

## Setup

```bash
nvm use                 # Node 24.5.0 (see .nvmrc) — required, not just recommended
npm install
npm run build           # tsc → dist/ (ESM)
npm test                # vitest (offline, synthetic fixtures)
```

`ffmpeg` is optional — only the JPEG-snapshot and one-shot mp4 record paths
use it.

## How the code is written

Four layers with one dependency direction (`core` → `transport` → `model` → `client`), capability ↔
transport decorrelation, the capability `members` table, and the rules CI enforces — all in
**[AGENTS.md](./AGENTS.md)**. It is not optional reading: several of those rules fail the build rather
than a review.

## Dev workflow

One command reproduces the whole CI gate — run it green before opening a PR:

```bash
npm run verify
```

It chains, in CI order: `format:check` → `typecheck` → the guards → `build` → the `.d.ts` seal guard →
an ESM load smoke test → `check:snippets` → `typecheck:examples` → `test`. A green `npm test` alone is
**not** the bar. `.github/workflows/ci.yml` invokes the same script, so green `verify` means green CI.

Individual pieces if you need them: `npm run guard:decorrelation`, `npm run guard:lines`,
`npm run guard:docrefs`, `npm run guard:consumer-agnostic`, `npm run guard:capability-ownership`,
`npm run guard:seal` (build first), `npm run check:esm`, `npm run check:snippets`, and
`npm run format` to auto-fix formatting.

### Documented snippets are compiled

`check:snippets` typechecks every ` ```ts ` block that ships, against this commit's own types —
the guides under `docs/`, the `README`, and the fences inside `src/` JSDoc that generate the published
reference. It types them; it never runs them. Whether a snippet WORKS needs a device and belongs in
`examples/`.

(Not to be confused with `guard:docs`, one character away, which guards the generated reference's
publication and lives outside `verify`.)

A snippet is compiled as a fragment: the shared vocabulary the guides use without declaring — `dev`,
`eufy`, `cam`, `clean`, `light`, … — comes from a prelude in the script, and a bare `…` is treated as an
elision. Two markers, both invisible to a reader, go immediately above a fence:

```md
<!-- typecheck: skip — pseudocode for the retry shape, not real API -->
<!-- typecheck: host bus, consumeAudio -->
```

`skip` drops the snippet; put the reason in the marker so the next reader knows it was a decision.
`host` declares names belonging to the READER — their event bus, their UI slider — as `any`, which
leaves every SDK call around them checked as before.

**Never `host` a name of ours.** `any` is an opt-out from the guard, so hosting an SDK type disables
the check on our own surface, which is the failure this gate exists to prevent. If the shared
vocabulary is genuinely missing a name, add it to the prelude with its real type instead.

**One gate lives outside `verify`:** `guard:docs`, the publication guard over the generated API
reference. It needs the docs toolchain, which `verify` deliberately does not require. Reproduce it
with:

```bash
npm -C docs ci && npm -C docs run build     # TypeDoc → guard:docs → VitePress
npm -C docs run dev                         # preview the site
```

Tests live in a `__tests__/` folder **beside the code they cover**, are fully offline, and use only
synthetic fixtures. Add tests for new wire logic and capability behaviour.

## Commits & PRs

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`, …).
- **Sign your commits** (GPG / `-S`).
- **PRs: concise, dev-to-dev, to the point.** Say what changed and why; call out anything unverified
  or deferred. Before opening one, check the list in AGENTS.md under Before you open a pull request.
- **Live testing is read-only by default.** Never run write commands against a real device without
  explicit confirmation — the unverified-write rule exists for a reason.

## Where your branch goes

**`main` only accepts pull requests from a `beta-X.Y.Z` branch.** A CI check enforces it, so a pull
request opened against `main` from anywhere else is refused before review. Work targets the beta
branch of the release it belongs to:

```
your branch  ──PR──▶  beta-1.2.0  ──every push──▶  npm 1.2.0-beta.N
                      beta-1.2.0  ──PR──▶  main  ──tag v1.2.0──▶  npm 1.2.0
```

The intent is that code ships as an installable prerelease before it ships as a stable one. Beta
branches live in this repository and maintainers cut them from `main`; a fork's branch named
`beta-X.Y.Z` is still a feature branch and is refused like one. **Every push to a beta triggers a
publish**, so it is a staging branch, not a scratchpad. Each of those publishes
waits for a maintainer to approve the deployment, so nothing leaves for npm unattended; a run sitting
at "waiting" is that, not a stuck job.

`alpha-X.Y.Z` branches work the same way and publish to the `alpha` dist-tag, but they cannot merge
into `main` — they are for trying something out, not for staging a release.

Dependabot is the one exemption from the branch rule; its target branch is static configuration and
cannot follow whichever beta is open.

## Releasing

`npm run release` does one of two things, chosen by the branch. Cutting the stable release is
maintainers only; the bump is ordinary work on a beta branch.

```bash
# on beta-1.2.0 — bump the version where the work already is
npm run release minor        # patch | minor | major | an explicit 1.2.3
                             # bumps, commits, pushes; that push publishes 1.2.0-beta.N

# ...open the pull request against main, review, merge, then:

# on main — cut the release for the version that arrived with the merge
npm run release
```

The bump lives on the beta branch because that branch is what carries it to `main`, through the same
reviewed pull request as everything else — nothing writes to `main` outside a review. It refuses to
bump anywhere else, and refuses a bump that would leave the branch name no longer naming the version
it builds.

You never type the version twice: the bump computes it, and the tag is read back from `package.json`.
Typing it again is how a tag ends up disagreeing with the file it came from, and since the tag is what
publishes, that disagreement ships silently. Cutting a release also refuses a dirty tree, a `main` out
of sync with the remote, and a tag that already exists.

It opens an editor for the notes rather than generating them: the release notes **are** the changelog
— [CHANGELOG.md](./CHANGELOG.md) only points at them.

Creating the release is the whole job. `.github/workflows/release.yml` takes over: it pauses for a
maintainer's approval, runs the full gate again, and publishes with provenance. The gate runs twice on
the same commit on purpose — a failure there costs a version number, since a tag that has belonged to
a release can never be reused. No npm token exists anywhere in this repository; the runner
authenticates with a short-lived OIDC identity tied to this workflow's filename and the `release`
environment.

Three things worth knowing before you cut one:

- **The tag decides the version, not `package.json`.** `v1.2.3` publishes 1.2.3 whatever the file
  says. `npm version` computes the next number from the file, though, so `patch` on a file that
  drifted behind the registry gives a version that is already taken. If you doubt it, resync first
  with `npm pkg set version="$(npm view @mega-yfue/eufy-sdk version)"`.
- **A failed release burns its number, permanently.** Immutable releases mean a tag that has ever
  belonged to a release can never be reused, even after deleting both. Never retry a release on the
  same version — fix forward and bump.
- **Prereleases come from a branch**, not a tag: push `beta-1.2.3` or `alpha-1.2.3` and each push
  publishes `1.2.3-beta.N` on that dist-tag, with N continuing from the registry.

## Working with AI agents

An AI agent is welcome here — most tools load [AGENTS.md](./AGENTS.md) on their own, which is where
the invariants live. Beyond that:

- **Never trust training data for a wire detail.** Models "know" older third-party eufy clients and
  will confidently reproduce them, and those are wrong for this protocol. Point the agent at real
  evidence or it will guess convincingly.
- **Never let it paste real data.** Agents happily inline whatever they saw — serials, device ids,
  account ids, IPs. Review every AI diff for these before committing, and grep it.
- **Keep it out of the public API reference.** `guard:docs` fails the build on protocol or crypto
  detail that reaches a public symbol's JSDoc; don't let an agent "helpfully" add wire explanations
  there.
- **Verify, don't trust.** If an agent names a file, flag or symbol, check it still exists. Run the
  full gate on its output — a green build is the bar, not a confident summary.
- **You own what you submit.** AI-assisted or not, the code in your PR is _your_ Contribution. You are
  responsible for making sure the agent did not regurgitate code under a license incompatible with
  Apache-2.0 — GPL/AGPL and proprietary code exist in training data. If you can't stand behind a hunk,
  don't submit it.

## Reporting a security issue

Don't open a public issue — see [SECURITY.md](./SECURITY.md).
