# Live media — consuming a camera stream

How a host application consumes live video/audio from a camera with the SDK.

Everything here hangs off a bound camera:

```ts
const dev = await eufy.getDevice(sn);
const cam = dev.camera?.(); // camera controls + media (media present only when client-bound)
```

The media methods (`snapshotStored`, `snapshotLive`, `live`, `openReadable`, `recordFragments`, `record`)
are **optional** on the returned object and require a device bound to a live client. `snapshotStored`
also requires snapshot capability evidence and the stored-image cache described below. Guard methods
(`cam?.live`) or assert once up front.

## One pull, many consumers

Every consumer of a given camera shares **one** underlying media session (one live pull), fanned out
to all of them. `cam.live()` twice, a `snapshotLive()` while a `recordFragments()` runs, a
`openReadable()` alongside a `live()` — all attach to the **same** shared source. There is exactly one
start on the wire regardless of how many consumers attach.

Consequences a host should rely on:

- **Cheap re-use.** The motion-thumbnail → tap-to-watch flow attaches a snapshot then a live view
  within seconds; the second attach re-uses the warm session, no second pull.
- **Late joiners are primed instantly.** The last keyframe (IDR) is cached and replayed to a new
  consumer on attach — no waiting a full GOP for the next keyframe before the picture appears.
- **Linger, then stop.** When the last consumer detaches the source lingers briefly (so a quick
  re-attach reuses it) and then stops the pull. You don't manage the pull; you manage your consumer.

## 1. Event stream (low-level)

The direct escape hatch — raw frames as they arrive.

```ts
const stream = await cam.live();

stream.on("video", (frame) => {
  // frame.data    Annex-B bytes (one or more start-code-prefixed NAL units)
  // frame.codec   "h264" | "h265" | "av1"
  // frame.width, frame.height
  // frame.keyframe  true on an IDR (a valid resync/segment boundary)
});
stream.on("audio", (frame) => {
  consumeAudio(frame.codec, frame.data);
});
stream.on("start", () => {});
stream.on("stop", () => {}); // upstream ended, or you called stop()
stream.on("error", (err) => {}); // includes a warm-up stall (see below)
stream.on("budget", (n) => n.extend()); // battery cameras only — see Power budget

stream.stop(); // detach this consumer
```

`stream.stop()` detaches **this** consumer only. The shared pull stops when the _last_ consumer
detaches (after the linger window).

The two codecs reach you differently. **Video** `codec` is sniffed off the parameter sets on a keyframe
and carried on the delta frames that follow, so every frame carries one even though only keyframes have
config to sniff. **Audio** `codec` is declared by the station in each frame's header, so it is read
rather than inferred — and read on every frame, because the device is free to change it mid-stream.

Audio deliberately carries **no sample rate and no channel count**: neither is on the wire. The eufy app
assumes 16 kHz mono for all three codecs, and a host that needs those numbers is making the same
assumption — the SDK does not dress it up as a device fact.

## 2. Node Readable (pipe it)

A fresh video-only `node:stream` Readable per call, over its own consumer. Default is raw Annex-B
bytes; pass `objectMode: true` to get `LiveVideoFrame` objects instead. Use `live()` for separate raw
video/audio frames or `recordFragments()` for a muxed stream; raw elementary audio is never
interleaved into the Annex-B byte stream.

```ts
const r = await cam.openReadable?.(); // Annex-B byte stream
r.pipe(fs.createWriteStream("out.h264"));
// ...
r.destroy(); // releases this consumer (and the pull if it was the last)
```

Backpressure is handled per-consumer: a slow reader drops to the next keyframe rather than stalling
the shared pull or any peer consumer. Destroying the Readable releases the consumer.

## 3. fMP4 / CMAF fragments (for HLS / MSE)

Continuous fragmented-MP4, muxed **dependency-free** (no ffmpeg, no native dep). The returned
recording handle is an async iterable: the init segment (`ftyp`+`moov`) comes first, then media
fragments at keyframe boundaries. `fragmentSeconds` is a **minimum**, not a fixed cadence: after the
minimum elapses, the next keyframe closes the fragment. A long GOP therefore produces a longer
fragment.

```ts
const recording = cam.recordFragments!({ fragmentSeconds: 2, preBufferSeconds: 10 });
recording.on("budget", (notice) => notice.extend());

for await (const frag of recording) {
  if (frag.init) sink.write(frag.init); // once, on the first emission
  if (frag.data.length) sink.write(frag.data); // moof+mdat; frag.keyframe marks a segment boundary
}
```

Both H.264 (`avc1`/`avcC`) and H.265 (`hvc1`/`hvcC`) are handled; Annex-B start codes are converted to
AVCC length-prefixed NALs in the `mdat`. AAC-LC and AAC-ELD sources add an `mp4a`/`esds` audio track,
with ADTS framing removed from each media sample. G.711 A-law remains available through `live()` and
is not mislabeled as MPEG-4 AAC in the container.

`preBufferSeconds` drains retained audio/video before live frames, beginning at a video keyframe and
preserving transport-arrival timing across the handoff. It can only return media already retained by a
warm shared source; opening a cold recording cannot reconstruct time before the source started.

## Snapshots

The two snapshot methods are intentionally distinct. Choose whether the call may start live media;
there is no automatic stored-to-live fallback.

### Stored: passive retained push JPEG

```ts
import { StoredSnapshotUnavailableError } from "@mega-yfue/eufy-sdk";

try {
  const jpeg: Buffer = await cam.snapshotStored!();
} catch (error) {
  if (error instanceof StoredSnapshotUnavailableError) console.log(error.reason);
}
```

`snapshotStored(): Promise<Buffer>` returns the latest qualifying push thumbnail retained for that
device. Acquisition happens eagerly when the push arrives, before any snapshot call. A candidate must
be attributed to one exact account-known device that has snapshot capability evidence; ambiguous or
station-only candidates are ignored.

The call itself is passive: it does not wait for an acquisition, access storage, make an HTTP request,
open P2P, start live media, or transcode. If no JPEG is retained it rejects with
`StoredSnapshotUnavailableError`; `reason` is one of:

- `not-observed` — no qualifying candidate has been observed;
- `pending` — acquisition of a qualifying candidate is queued or in progress;
- `download-failed` — the latest acquisition could not be downloaded;
- `invalid-image` — downloaded bytes did not have the required JPEG structure.

Only structurally valid, bounded JPEG bytes are retained. V1 `eufysecurity:` wrappers are decrypted
with their device record's key input before validation. V2 wrappers do not pass validation because
their reconstruction requires image decoding and re-encoding outside this contract.

The cache is enabled by default. Constructing `EufyMega` with `{ storedSnapshotCache: false }` ignores
candidates and omits `snapshotStored` from bound cameras. Retained bytes live only in the client process
for the current account: `logout()`, `clearSession()`, or changing account clears them; a plain
`disconnect()` does not clear the same client's account cache.

Eager acquisition uses `MegaHttpClient.downloadMedia`, which enforces HTTPS host allowlists, a 15 s
timeout, and a 10 MiB body limit. It follows at most one allowlisted object-store redirect and does not
forward account authentication headers to the redirected host.

### Live: explicit fresh capture

```ts
const shot = await cam.snapshotLive?.(); // { jpeg, width, height }
```

If the shared source already has a cached keyframe (a live view or another consumer is warm),
`snapshotLive` decodes that keyframe directly — **no second pull**. Only if nothing is warm does it
briefly attach, wait for a clean keyframe, decode, and detach. (The JPEG decode itself uses ffmpeg as
an optional convenience sink — resolved on `PATH`, or set `ffmpegPath` on the client to name the binary
you ship; the raw keyframe bytes are always available dependency-free via `openReadable` / the event
stream.)

## Talkback — audio the other way

`cam.talkback()` opens the reverse path: audio from the host, out of the camera's speaker. It is
present only on a camera that reported a speaker, so guard it like the other optional media methods
(the snippets below assert it once with `!` rather than repeating the guard on each line).

Audio must be **AAC-LC, 16 kHz, mono, in ADTS frames** — the device's path is fixed at those
parameters, so anything else is rejected rather than resampled (it would play at the wrong pitch and
speed). Chunk boundaries don't matter; frames are recovered from the stream.

```ts
const talk = await cam.talkback!();

talk.on("error", (err) => console.error(err.message));
talk.on("finished", () => void talk.stop());
fs.createReadStream("greeting.aac").pipe(talk.writable());
```

Producing a suitable file with ffmpeg:

```bash
ffmpeg -i greeting.mp3 -ac 1 -ar 16000 -c:a aac -b:a 32k -f adts greeting.aac
```

Keep the bitrate at or below **32 kbps**. The device caps how long a single frame may be, and above
about 32 kbps an encoder will occasionally emit one that exceeds it; those frames are dropped with an
`error` rather than sent, so a higher bitrate quietly costs you audio instead of buying quality. The
path is 16 kHz mono speech — there is nothing above 32 kbps to gain.

Frames are **paced** at their own playback rate (64 ms each) rather than flushed as fast as they
arrive, so piping a file plays it at speed instead of overrunning the device. `talk.pending` reports
what is still waiting, and `writable()` applies backpressure at the queue's high-water mark, so a fast
source cannot buffer a whole clip in memory. A realtime source (a live mic) simply keeps the queue
near-empty and never hits that mark.

`finished` is the completion signal: it fires once, when the input has ended **and** everything queued
has reached the wire. Ending the input is what `writable()`'s `final` does for you; an imperative
`write()` caller calls `talk.end()` instead. Note that `finished` deliberately does not mean "the queue
is momentarily empty" — a realtime source empties the queue after every single frame, so stopping on
that would cut the clip to 64 ms.

`stop()` closes the path and **drops** anything still queued — wait for `finished` if you want the clip
played out. A talkback that goes quiet (nothing written, nothing queued) closes itself after 30 s, so a
dropped handle can't hold a session open indefinitely.

Only **one talkback at a time** per camera: the device plays a single audio stream, so a second
`talkback()` call on a camera that is already talking is rejected rather than silently interleaved into
noise. Stop the open one first.

To push raw PCM instead, supply an encoder. The SDK ships none: every AAC encoder is either a native
dependency or an external process, both of which belong to the host rather than to a protocol SDK.

```ts
const talk = await cam.talkback!({ encoder: myAacEncoder }); // write() now takes 16-bit LE mono PCM
```

Talkback holds a live session open for its whole duration, because **the camera only plays host audio
while its media session is running** — the same frames sent without one are silently discarded. A host
already streaming pays nothing extra (the session is shared); a host that only wants to talk gets one
opened and released automatically.

Unlike the control path, the audio channel is **ordered and acknowledged**: a lost frame stalls
everything behind it, so the SDK tracks acknowledgements and repeats a frame that goes missing. A frame
the device never acknowledges at all is reported as an `error` — because the channel is ordered, that
gap can be why the rest of a clip was never heard, and it is worth surfacing rather than guessing.

Talkback is verified audible on **both** topologies (HomeBase-attached and standalone) and on both
**full- and half-duplex** cameras — a camera the vendor's app drives with press-and-hold plays SDK
talkback the same as a tap-to-toggle one, so the duplex mode does not change how a host uses this.

## Power budget (battery / solar cameras)

A camera's power source is a **runtime fact** derived from its resolved capabilities, not its model. A
battery (or solar — solar only trickle-charges) camera drains while streaming, so the SDK bounds a
continuous stream to a **budget**; a wired/mains camera streams unbounded and never emits a budget
notice.

The model sets the `powered` hint for you from `dev.has("battery")` — a host does **not** pass it. It
applies to every egress that can open the session (`live`, `openReadable`, `recordFragments`,
`talkback`, and `snapshotLive`), so the budget doesn't depend on which one you happened to open first.

The budget belongs to the **shared session**, not to one consumer: a live stream and a talkback on the
same camera are two consumers of one pull, so a single `extend()` covers both. If nobody extends, the
session stops on schedule and every consumer ends with it.

When the budget elapses on a battery camera, live streams and fragmented recording handles emit
`budget` with an `extend()` handle:

```ts
stream.on("budget", (notice) => {
  if (keepWatching) notice.extend(); // re-push another full budget, cancel the auto-stop
  // else: do nothing → auto-stops after notice.graceMs to protect the battery
});
```

Defaults: 45 s budget, 10 s grace. A host tunes only the **timings** (not the power decision):

```ts
await cam.live({ batteryBudgetMs: 8000, budgetGraceMs: 5000, keepAliveMs: 3000 });
```

A wired camera ignores all of this and streams until you `stop()`.

See `examples/07-live-stream-battery-budget.ts` for the full detect → budget → extend → auto-stop
cycle. The budget bounds an **active** stream; when it (or you) stops the stream, the camera's P2P
session idle-detaches so a battery device sleeps — see [Connectivity & battery](/connectivity).

## Reliability

- **No silent hang.** `live()` re-issues the media-start (`nudge`) until the first frame arrives; if
  none arrives within the warm-up window the stream emits an `error` (a start stall) rather than
  hanging forever. Handle `error`.
- **Reconnect.** On a session close the source stops and consumers get `stop`/`error`; re-attach
  (`cam.live()` again) to rebuild the pull.

## Choosing an egress

| Need                                | Use                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------- |
| Raw frames, custom pipeline         | `cam.live()` → `on("video"/"audio")`                                        |
| Pipe bytes to a file/socket/encoder | `cam.openReadable()`                                                        |
| Serve HLS / feed an MSE player      | `cam.recordFragments()`                                                     |
| A single still                      | `cam.snapshotLive()` (fresh) or `cam.snapshotStored()` (retained push JPEG) |
| Fixed-length clip buffer            | `cam.record(seconds)`                                                       |
| Send audio TO the camera            | `cam.talkback()`                                                            |
