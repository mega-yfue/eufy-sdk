<div align="center">

<!--
  The suffix names the MODE, not the ink: logo-dark.svg is the white glyph for a dark background,
  logo.svg the near-black one for a light background. The fallback <img> must be the light-mode file,
  since that is what any renderer without prefers-color-scheme support will show.
-->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/mega-yfue/eufy-sdk/main/docs/public/logo-dark.svg">
  <img src="https://raw.githubusercontent.com/mega-yfue/eufy-sdk/main/docs/public/logo.svg" alt="eufy-sdk" height="72">
</picture>

**One typed client for the whole eufy ecosystem — devices, realtime events, and live media.**

[![npm](https://img.shields.io/npm/v/@mega-yfue/eufy-sdk?logo=npm&color=cb3837)](https://www.npmjs.com/package/@mega-yfue/eufy-sdk)
[![CI](https://github.com/mega-yfue/eufy-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/mega-yfue/eufy-sdk/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@mega-yfue/eufy-sdk?logo=nodedotjs)](./.nvmrc)
[![license](https://img.shields.io/npm/l/@mega-yfue/eufy-sdk)](./LICENSE)

[Documentation](https://mega-yfue.github.io/) · [Contributing](./CONTRIBUTING.md) · [Changelog](./CHANGELOG.md)

</div>

---

> [!IMPORTANT]
> **Not usable yet.** This repository is being set up: the scaffold, the CI gate and the docs pipeline
> are in place, the library source lands next. `0.0.1` exists on npm only to prove the release
> pipeline works — it is an empty package. Wait for `0.1.0`.

## What it is

A TypeScript SDK for the eufy cloud that the current eufy app speaks. It logs in (captcha and 2FA
included), keeps a **persistent session**, and models every device as a capability-driven `Device`
you drive through a **typed, fluent API**:

```ts
const dev = await eufy.getDevice(sn);

const stored = await dev.camera()?.snapshotStored?.(); // latest retained push JPEG
const fresh = await dev.camera()?.snapshotLive(); // explicit fresh live capture
await dev.panTilt()?.rotate(PtzDirection.left);
await dev.light()?.setBrightness(60);

eufy.on("motion", (e) => console.log(e.device.name, "saw something"));
```

Realtime arrives over **P2P** (cameras and HomeBases), **secure MQTT** (appliances) and **push**
(events), all surfaced as typed semantic events. Live **video streaming** works, with one shared pull
fanned out to every consumer.

The SDK targets the **whole** ecosystem — security, robot vacuums and mowers, smart lights — not just
cameras. Devices are classified dynamically from what the account reports, so there is no per-model
code path and an unlisted or future device resolves the same way as a known one.

## Install

Releases go to **GitHub Packages** while this repository is private. That registry serves whoever can
already read the repo, so installing needs a `.npmrc` telling npm where the scope lives and a token to
authenticate with — a personal access token with `read:packages` is enough:

```ini
# .npmrc
@mega-yfue:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```bash
npm install @mega-yfue/eufy-sdk
```

Once the repository is public, releases also go to npmjs and the `.npmrc` becomes unnecessary.

**Node.js ≥ 24.5.0** is required, not just recommended (see [`.nvmrc`](./.nvmrc)). `ffmpeg` is
optional — only the live JPEG snapshot, one-shot mp4 record and WebRTC container-output paths use it,
and a host that ships its own build names it with `new EufyMega({ ffmpegPath })` rather than needing
one on `PATH`.

## Documentation

The guides at **<https://mega-yfue.github.io/>** are the source of truth; this README stays a thin
landing page. They cover installing and logging in, devices and capabilities, events and realtime
transports, consuming live media, and the generated API reference. Runnable, typechecked samples live
in [`examples/`](./examples/).

## Design

Four layers, one dependency direction — `core` → `transport` → `model` → `client`:

```
src/
  core/         shared floor: crypto, cross-layer contracts, value types, session store
  transport/    every byte-on-a-wire module: http, mqtt, p2p, push, webrtc
  model/        Device + one self-contained module per capability
  client/       the facade: login, device registry, event fan-out
  index.ts      public surface — one `export *` per layer barrel
```

**Capability ↔ transport decorrelation is a hard, CI-enforced rule:** `model/` never imports
`transport/` and vice versa. A capability describes what a value MEANS; a transport moves bytes and
never names a feature. Anything genuinely shared is a contract in `core/`. That rule and the rest of
the code practice are in [AGENTS.md](./AGENTS.md).

Three runtime dependencies — `mqtt`, `protobufjs`, `werift` — and that is deliberate. HTTP is native
`fetch`, hashing and ciphers are `node:crypto`, 64-bit integers are `BigInt`.

**Unverified write paths throw rather than guess.** Some writes are fire-and-forget, so a guessed
frame looks exactly like success; the SDK refuses instead of pretending.

## Develop

```bash
nvm use            # Node 24.5.0
npm install
npm run verify     # the full CI gate in one command — run it green before a PR
```

## Contributing

PRs welcome. [CONTRIBUTING.md](./CONTRIBUTING.md) covers setup, the dev workflow and the PR process;
[AGENTS.md](./AGENTS.md) is the code practice — the architecture invariants and the rules CI enforces.
Security issues go through [SECURITY.md](./SECURITY.md), never a public issue.

## License

[Apache-2.0](./LICENSE). Contributions are accepted under the same license (inbound = outbound).

## Disclaimer

Independent and unofficial, built for interoperability with eufy devices you own. **Not affiliated
with, endorsed by, or sponsored by Anker Innovations or eufy.** "eufy" and "Anker" are trademarks of
their respective owners and appear here only to identify the hardware this SDK talks to. Use
responsibly — rapid or failed logins can trigger a captcha or a temporary cooldown.
