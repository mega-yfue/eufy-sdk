# RTSP — publishing a camera to a recorder

How a host publishes a camera's stream over RTSP so a NAS or NVR can record it, and how to control
who may read it.

This is distinct from [consuming a live stream](/live-media): there the SDK pulls frames to your
process, here the device serves a stream on your local network and you point other software at it.

```ts
const dev = await eufy.getDevice(sn);
const rtsp = dev.rtsp?.(); // present only on a camera that reports the feature
```

The accessor is absent on a device that never advertises RTSP, so guard it (`dev.rtsp?.()`) or assert
once up front.

## Publishing

```ts
await rtsp?.publish?.(); // persistently publish this camera
await rtsp?.withdraw?.(); // explicitly withdraw the publication
rtsp?.published; // boolean | undefined — current state
```

`published` is a typed read, present only when the device actually reports the backing state and
the publish switch has a wire to it.

The device does not stream to your process here — it serves an RTSP endpoint on your LAN that any
recorder can open. Which host serves it depends on how the camera is installed:

| Camera            | Served by                                   |
| ----------------- | ------------------------------------------- |
| HomeBase-attached | the HomeBase, one URL per attached camera   |
| Standalone        | the camera itself, on its own local address |

### Publication ownership

`publish()` changes a persistent device setting; it does not open an SDK-owned media session. An
RTSP player connects directly to the camera or HomeBase, outside the SDK. The SDK does not observe
that player's disconnect, `TEARDOWN`, or retry loop, and therefore does not call `withdraw()` in
response. Treat the endpoint as published until its state reports otherwise or a caller explicitly
withdraws it.

The caller that enables publication therefore owns its lifetime. Pair `publish()` with `withdraw()`
when the recorder no longer needs the endpoint:

<!-- typecheck: host runRecorder -->

```ts
await rtsp?.publish?.();
try {
  await runRecorder();
} finally {
  await rtsp?.withdraw?.();
}
```

Coordinate this ownership when several processes can control the same camera. A process must not
withdraw a publication that another process or the vendor app still expects to remain available.
After an observed withdrawal, `DESCRIBE` returns 404 until the stream is published again; a consumer
retry does not ask the SDK to publish it.

### The device-reported URL

Once publication is on, the device reports its own RTSP URL — host, path, and the credentials it is
enforcing right now:

```ts
rtsp?.url; // string | undefined — "rtsp://user:pass@host/path", as the device reports it
```

Point your recorder at that URL unchanged. The credentials in it are regenerated every time
publication is toggled and the cloud record trails a cycle behind, so an address you assemble
yourself — or one kept from an earlier cycle — can fail to authenticate against a stream that is
serving perfectly well.

It arrives on the device's realtime wire and never in the cloud record, which shapes how it reads
back:

- **Absent until the device pushes it.** `publish()` is what provokes the push, and the read appears
  shortly after the write resolves rather than with it. Wait for the property; don't read it on the
  next line.
- **Announced as a property change** named `rtspUrl` when the value moves. A device re-reporting a
  byte-identical URL is silent, as every property is — so treat the announcement as "it changed",
  not as "it was reported".
- **Not retracted by `withdraw()`.** The last reported URL keeps reading until the cloud is observed
  to move the publication state, so a URL read after a withdrawal can name credentials the device no
  longer accepts. `published` is reported on the same wire and goes stale with it.
- **It carries a live secret.** The password is in the string, so it is also in `deviceState`, in a
  `propertyChanged` payload, and in anything a host logs from either. Redact it as you would any
  credential.

## Three constraints worth knowing up front

**One camera at a time per HomeBase.** A station publishes for a single attached camera. Calling
`publish()` on a second one silently stops the first — the station has room for one, not a set. The
SDK cannot detect or prevent this, so a host driving several cameras owns the choice of which is
live.

**It will drain a battery camera.** A published stream encodes continuously. The SDK intentionally
does not apply the live-media power budget here: it owns a P2P live session, but it cannot know whether
an independent RTSP recorder still needs this persistent endpoint. The feature is meant for
mains-powered cameras feeding a recorder. Check `dev.has("battery")` before offering it, leave it off
by default, and make the enabling caller responsible for `withdraw()`.

**A published stream is readable by your whole local network** unless the camera enforces
authentication — see below. Treat publishing as making the camera available to anything on that
network.

## Authentication

```ts
await rtsp?.requireAuth("eufy", secret); // request authenticated serving
await rtsp?.allowAnonymous("eufy", secret); // request anonymous serving
```

These methods request an authentication mode and store the supplied credentials. A standalone camera
has been observed serving a Digest challenge, but verify the endpoint rather than treating a resolved
write as proof of enforcement. On a HomeBase-attached camera, the device-reported URL echoed freshly
supplied Basic credentials, confirming storage, while unauthenticated `DESCRIBE` still returned 200
with no challenge. The station continued serving anonymously.

**Authentication enforcement is device- and topology-dependent.** A tested HomeBase-attached camera
stored the requested credentials but its station continued serving without a challenge.
A resolved `requireAuth()` call is therefore not proof of access control: verify storage from the
device-reported URL and enforcement from `DESCRIBE` on the endpoint you will use. If that endpoint
stays open, restrict access at the network instead, or leave the camera unpublished and use
[live media](/live-media) instead.

## Choosing between RTSP and live media

| You want                                | Use                                         |
| --------------------------------------- | ------------------------------------------- |
| Frames in your own process              | [live media](/live-media)                   |
| Several cameras at once                 | [live media](/live-media)                   |
| A battery camera, occasionally          | [live media](/live-media)                   |
| A recorder (NAS/NVR) to pull the stream | RTSP                                        |
| Continuous recording of a wired camera  | RTSP                                        |
| An authenticated stream                 | RTSP, after `DESCRIBE` confirms a challenge |

Live media is the general answer. RTSP earns its place when the consumer is an existing recorder that
speaks RTSP and you would rather not proxy frames through your own application.
