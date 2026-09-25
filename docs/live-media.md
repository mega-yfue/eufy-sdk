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

## Several cameras behind one station

A camera behind a HomeBase reads the station's inbound feed, and the station **tags each media frame with
the camera it belongs to**; the SDK matches on that, so each handle receives only its own camera's video and
audio.

One session serves one camera at a time — a station answers the most recent media start on it — so a live
pull that finds the station's own session already carrying one gets **a connection of its own**, and several
cameras on one HomeBase stream at full rate together. Measured on two attached cameras, one at 3840×2160:
both held ~15 fps for the length of the run, where the same pair down one session could only take turns.

A **still** never opens a connection of its own: it wants one frame, and a socket plus a key negotiation per
thumbnail is not worth it. So a still asked for while a sibling is being watched still yields, and the
retained image answers it.

Worth knowing:

- Cameras that own their session (standalone, no HomeBase) number their stream for themselves, so nothing
  is matched there — there is only one camera on that session.
- If a station ever tags an attached camera's frames with something other than the channel that was
  started, the SDK notices within about two seconds, logs a warning and stops matching rather than serving
  a stream that never delivers. Two cameras warm on such a station would interleave, as they did before
  this existed.
- `record()` opens its own pull instead of joining the shared source, so it costs a second stream on a
  camera that is already streaming. `recordFragments()` is a shared consumer like everything else.

## 1. Event stream (low-level)

The direct escape hatch — raw frames as they arrive.

<!-- typecheck: host consumeAudio -->

```ts
const stream = await cam?.live?.();
if (!stream) return; // this device has no camera, or no live path bound yet

stream.on("video", (frame) => {
  // frame.data    Annex-B bytes (ONE whole access unit, start-code-prefixed NAL units)
  // frame.codec   "h264" | "h265" | "av1"
  // frame.width, frame.height  what the station's frame header reported (see below — these change
  //                            within a session; `video-config` is the authority)
  // frame.keyframe  true on an IDR (a valid resync/segment boundary)
});
stream.on("audio", (frame) => {
  consumeAudio(frame.codec, frame.data);
});
stream.on("video-config", (config) => {
  // config.codec, config.width, config.height — the coded configuration of the video that follows
});
stream.on("start", () => {});
stream.on("stop", () => {}); // upstream ended, or you called stop()
stream.on("error", (err) => {}); // includes a warm-up stall (see below)
stream.on("budget", (n) => n.extend()); // battery cameras only — see Power budget

stream.stop(); // detach this consumer
```

`stream.stop()` detaches **this** consumer only. The shared pull stops when the _last_ consumer
detaches (after the linger window).

### The source reconfigures mid-session

A camera changes the coded geometry of its live stream **within one session**, repeatedly. Measured on
eight cameras and both codecs: four of them changed, 2 to 9 times per 25-60 s, oscillating up and down a
ladder (`640x360`, `960x540`, `1280x720`, `1600x1200`, `1920x1080`, `2304x1296`, `2560x1440`, `2880x1616`)
rather than only climbing it; the other four held one geometry throughout. The ladder is not fixed per
model.

Two things this does NOT establish. Whether the number of consumers influences it: a single-consumer
session produced more changes than a two-consumer one, but on a different camera, so nothing here is a
controlled comparison. And whether it can be pinned: no capability the SDK models sets a per-session cap —
the camera's video-quality member is a persistent recording tier — but that is read off the modelled
surface rather than measured against a device.

An encoder cannot change input geometry mid-stream, so a caller adapting this source to a fixed output
has to tear down and rebuild on every change. `video-config` is how it learns:

<!-- typecheck: host Encoder, openEncoder -->

```ts
let encoder: Encoder | undefined;
stream.on("video-config", (config) => {
  encoder?.close(); // the frames that follow cannot go into the encoder opened for the last config
  encoder = openEncoder(config);
});
stream.on("video", (frame) => encoder?.write(frame.data));
```

It fires once per change, immediately before the first frame carrying the new configuration, beginning
with the first frame the consumer receives. `width` and `height` are the **coded** geometry — read out of
the sequence parameter set and cropped by the offsets it declares, which is the size a decoder produces.
A frame's own `width`/`height` are what the station's frame header reported; they agreed with the
parameter sets in all but 28 of some 6000 measured frames, but only one of the two is a definition rather
than a report. Where the parameter sets state no readable geometry — before the first keyframe has carried
any — the header's report is carried instead, so there is always a configuration to act on. That means the
first announcements of a session can move from the header's answer to the parameter sets' without the camera
having reconfigured; a caller that rebuilds on a difference rebuilds once there.

The announcement is per consumer, against what **that** consumer was last given. A consumer joining
mid-session is primed with a cached keyframe it did not witness arriving, and one that crosses its queue
bound resynchronises onto a later IDR having skipped the frame the change arrived on — so both are told,
even though the shared source saw the change once.

A change arriving on a keyframe carrying fresh parameter sets is what every run but one showed, and that
run is not accounted for — so nothing here depends on it, and a change on a delta frame would simply be
announced when it arrived. A recording made through
`recordFragments()` needs nothing here: one init segment describes the whole recording and the samples
carry their own parameter sets, which is how a decoder follows the change.

A caller writing frames into a sink of its own paces the stream rather than buffering what the sink will
not take:

```ts
stream.on("video", (frame) => {
  if (!sink.write(frame.data)) {
    stream.pause(); // frames now queue against a bound instead of piling up behind the sink
    sink.once("drain", () => stream.resume());
  }
});
```

While paused, frames queue per consumer against a bound; crossing it drops the backlog and resynchronises
at the next IDR, so a sink that stays slow resumes on decodable media rather than replaying stale media.
`resume()` stops handing over the backlog the moment the sink pauses again, so the bound keeps applying to
whatever is left. `stream.awaitingKeyframe` is true while such a resynchronisation is in progress. None of
this touches the shared pull or any peer consumer.

The two codecs reach you differently. **Video** `codec` is sniffed off the parameter sets on a keyframe
and carried on the delta frames that follow, so every frame carries one even though only keyframes have
config to sniff. **Audio** `codec` is declared by the station in each frame's header, so it is read
rather than inferred — and read on every frame, because the device is free to change it mid-stream.

Audio deliberately carries **no sample rate and no channel count**: neither is on the wire. The eufy app
assumes 16 kHz mono for all three codecs, and a host that needs those numbers is making the same
assumption — the SDK does not dress it up as a device fact.

A `video` event is **one whole access unit**. A station serves a unit bigger than its own chunk size as
several frames, and those are rejoined before you see them — so `keyframe` really does mean "you may
begin decoding here", and counting `video` events counts frames. A unit the transport could not complete
(a lost datagram costs all of it) is dropped rather than handed to you short, because bytes that stop
mid-slice decode to nothing.

## 2. Node Readable (pipe it)

A fresh video-only `node:stream` Readable per call, over its own consumer. Default is raw Annex-B
bytes; pass `objectMode: true` to get `LiveVideoFrame` objects instead. Use `live()` for separate raw
video/audio frames or `recordFragments()` for a muxed stream; raw elementary audio is never
interleaved into the Annex-B byte stream.

```ts
const r = await cam?.openReadable?.(); // Annex-B byte stream
r?.pipe(fs.createWriteStream("out.h264"));
// ...
r?.destroy(); // releases this consumer (and the pull if it was the last)
```

Backpressure is handled per-consumer, on the same policy `live()` exposes: a slow reader drops to the next
keyframe rather than stalling the shared pull or any peer consumer. The Readable pauses and resumes its
consumer for you. Destroying the Readable releases the consumer.

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

The loop paces itself: a fragment is a complete ordered unit, so a caller that falls far enough behind holds
the recording's consumer rather than having fragments accumulate. The bound then applies to the frame queue
behind it, which drops to the next IDR — so a sink that cannot keep up costs a gap in the recording, never
unbounded memory. Nothing is required of the caller beyond consuming the iterator.

`preBufferSeconds` drains retained audio/video before live frames, beginning at a video keyframe and
preserving transport-arrival timing across the handoff. A drain opens on the newest keyframe at or before
the window starts, so it covers the whole window and exceeds it by however far back that keyframe sits —
one keyframe interval on a steady stream, more where delivery stalled, because retention is timed on
arrival and a frame carries no device clock. Asking for `0` drains nothing.

The window is a finite positive duration. Absent, negative, `NaN`, and infinite values disable retention
and drain nothing rather than creating an unbounded buffer.

It can only return media already retained by a warm shared source; opening a cold recording cannot
reconstruct time before the source started. **Retention is fixed when the pull is opened, and every egress
can set it**, because whichever call opens the pull is the one that decides:

```ts
await cam?.snapshotLive?.({ preBufferSeconds: 10 });
const stream = await cam?.live?.({ preBufferSeconds: 10 });
```

An egress that omits it is not opting out — it leaves the choice to whoever got there first, so a still
polled on an idle camera opens a pull retaining nothing and a recording seconds later has nothing to drain,
however much it asks for. Pass the same window on every egress a device uses, or none of them.

## Snapshots

The two snapshot methods are intentionally distinct. Choose whether the call may start live media;
there is no automatic stored-to-live fallback.

### Stored: passive retained push JPEG

```ts
import { StoredSnapshotUnavailableError } from "@mega-yfue/eufy-sdk";

try {
  const jpeg: Buffer | undefined = await cam?.snapshotStored?.();
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
- `download-failed` — the latest acquisition did not produce an image;
- `invalid-image` — the bytes that arrived did not have the required JPEG structure.

Only structurally valid, bounded JPEG bytes are retained. `eufysecurity:` wrappers are unwrapped before
validation: a v1 wrapper is decrypted with its device record's key input, and a v2 wrapper — which is
not encrypted, only stripped of its header — is reconstructed from its own entropy-coded scan.

`download-failed` covers everything between observing a URL and holding an image, so the SDK also logs
WHY, as a `cause` on the `[stored-snapshot-cache] candidate failed` warning. It is a closed vocabulary,
because the alternative — the underlying error's message — would put a signed media URL and a response
body in a log line:

- `url-not-allowed` — the candidate URL failed the media allowlist (scheme, credentials, port, a literal
  address, or a host the SDK does not download from). Nothing was requested;
- `address-not-public` — the host resolved to nothing, or to an address that is not public;
- `redirect-not-allowed` — the redirect had no target, went somewhere the object-store allowlist
  refuses, or was followed by a second one;
- `http-status` — the host answered with something other than 200, reported alongside as `status`;
- `too-large` — the body exceeded the 10 MiB bound, declared or observed;
- `timeout` — the attempt, DNS included, outlived the 15 s window;
- `network` — the request itself failed: connect, TLS, or a reset mid-body;
- `decode-failed` — the bytes arrived and the push-image decoder refused them.

A candidate is attempted once: the same URL arriving again on a later push (one event is often several)
is recognised as already attempted and not re-downloaded, for as long as it is inside the per-device
window of recent URLs. The next event carries a new URL and a new attempt.

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

`width` and `height` describe the returned image — they are read back out of the JPEG, not taken from
the stream's frame header, so they cannot disagree with the bytes. (Some cameras reconfigure resolution
inside one short burst, which is exactly when the header and the encoded still part company.)

If the shared source already has a cached keyframe (a live view or another consumer is warm),
`snapshotLive` decodes that keyframe directly — **no second pull**. Only if nothing is warm does it
briefly attach, wait for a clean keyframe, decode, and detach. (The JPEG decode itself uses ffmpeg as
an optional convenience sink — resolved on `PATH`, or set `ffmpegPath` on the client to name the binary
you ship; the raw keyframe bytes are always available dependency-free via `openReadable` / the event
stream.)

## Recordings stored on a HomeBase 2

A HomeBase 2 (T8010) keeps each event recording of its attached cameras, and names it in the event push:
`payload.p` is the recording name and `cipher` the key id it was stored under. `downloadRecording`
fetches that recording over the station's P2P session and decodes it; it does not wake the camera.

```ts
import { RecordingDownloadError } from "@mega-yfue/eufy-sdk";

eufy.on("push", async (ev) => {
  const recording = ev.payload.p;
  if (!ev.deviceSn || typeof recording !== "string" || ev.cipher === undefined) return;
  const cam = (await eufy.getDevice(ev.deviceSn)).camera?.();
  try {
    const clip = await cam?.downloadRecording?.({ recording, cipherId: ev.cipher });
    // clip.video: Annex-B H.264 · clip.audio: AAC-LC 16 kHz mono ADTS · clip.fps, clip.durationMs
  } catch (error) {
    if (error instanceof RecordingDownloadError) console.log(error.reason);
  }
});
```

The download is confirmed on recordings that had finished. How the station answers for a recording it is
still writing is not established, so issue the download once the camera's configured clip length has
elapsed since the push. Downloads queue one at a time per station, and the transfer runs faster than real
time: a 12.8 s recording took about 6 s.

The result is elementary streams, not a container: `video` is Annex-B H.264 and `audio` (when present) is
AAC-LC in ADTS framing. `fps` and `durationMs` come from the camera's own frame stamps, and `missingFrames`
counts frames the camera numbered that never arrived. Muxing is the caller's; for example with ffmpeg,
`-framerate <fps> -f h264 -i video.h264 -f aac -i audio.aac -c copy clip.mp4`.

The download is confirmed on a HomeBase 2 only. Any other station rejects with `RecordingDownloadError`
reason `unsupported` before anything is sent.

## Talkback — audio the other way

`cam.talkback()` opens the reverse path: audio from the host, out of the camera's speaker. It is
present only on a camera that reported a speaker, so guard it like the other optional media methods
(the snippets below assert it once with `!` rather than repeating the guard on each line).

Audio must be **AAC-LC, 16 kHz, mono, in ADTS frames** — the device's path is fixed at those
parameters, so anything else is rejected rather than resampled (it would play at the wrong pitch and
speed). Chunk boundaries don't matter; frames are recovered from the stream.

```ts
const talk = await cam?.talkback?.();
if (!talk) return; // this camera has no two-way audio

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

<!-- typecheck: host myAacEncoder -->

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

<!-- typecheck: host keepWatching -->

```ts
stream.on("budget", (notice) => {
  if (keepWatching) notice.extend(); // re-push another full budget, cancel the auto-stop
  // else: do nothing → auto-stops after notice.graceMs to protect the battery
});
```

Defaults: 45 s budget, 10 s grace. A host tunes only the **timings** (not the power decision):

```ts
await cam?.live?.({ batteryBudgetMs: 8000, budgetGraceMs: 5000, keepAliveMs: 3000 });
```

A wired camera ignores all of this and streams until you `stop()`.

See `examples/07-live-stream-battery-budget.ts` for the full detect → budget → extend → auto-stop
cycle. The budget bounds an **active** stream; when it (or you) stops the stream, the camera's P2P
session idle-detaches so a battery device sleeps — see [Connectivity & battery](/connectivity).

## Reliability

- **UDP retransmissions.** Each data type is sequenced independently. Duplicate and stale datagrams are
  acknowledged and ignored without discarding a different frame being assembled, and the numbering may wrap
  without a false gap. A missing datagram still drops that incomplete frame so corrupt media is never
  delivered. An unacknowledged own-session `START_LIVE` is repeated with identical bytes until the camera
  acknowledges it, and abandoned after 3s — at which point that channel is no longer treated as started, so
  the next keepalive tick issues a real start instead of nudging a stream that never began. A new connection
  starts the numbering over, so its first datagrams are never read as stale — and so does a camera that
  begins a fresh stream on a connection already up, which sequencing follows onto the restarted numbering
  rather than waiting for it to climb back.
- **No silent hang.** `live()` re-issues the media-start (`nudge`) until the first keyframe arrives; if
  none arrives within the warm-up window the stream emits a `LiveStreamStartError` rather than hanging
  forever. It carries everything needed to tell the failures apart without transport logs: `reason`
  (deadline elapsed / source error / source ended), `stage` (`awaiting-first-frame` when the source
  delivered nothing at all, `audio-only` when it was streaming audio and never sent a video frame,
  `awaiting-keyframe` when video units arrived but none was decodable), `timeoutMs`, and `attempts` —
  the media starts actually issued. Handle `error`.
- **A camera that is switched off looks like a broken transport.** It keeps its session, accepts the media
  start, and then sends audio and never a video frame — measured: 234 audio frames, no video, no
  stream-status report and no lost datagrams across a 20s window, then 217 video access units with nothing
  changed but its own on/off state. The signature is `stage: "audio-only"`. Since the refusal below landed, a
  pull normally never gets that far: it is reached on a camera whose enablement reads `undefined`, and
  otherwise only where a camera is switched off after its pull was admitted, which the warm-up window is long
  enough to contain. `snapshotStored()` will also report `not-observed` on such a camera, because a camera that
  has been off recorded no events and so banked no thumbnail.
- **`cam.enabled` is trustworthy, and the SDK acts on it.** A write used to leave the reported value frozen —
  `setEnabled(true)` succeeded, the camera streamed, and the reading stayed `false` indefinitely. An
  enablement write is now confirmed by bounded readback on whichever param the device actually reports: the
  value converges on its own (measured 2–6s on both wire families) and `cameraEnabledChanged` fires once when
  it lands. A change made anywhere else — the vendor app, another client, a physical switch — arrives as
  `propertyChanged` on whichever inbound path saw it, including the read-through re-read, so a long-lived
  client is no longer left polling for one.
- **A pull on a camera reading `enabled === false` is refused.** `live()`, `snapshotLive()`, `record()`,
  `openReadable()` and `recordFragments()` answer `CameraDisabledError` rather than a stream that can only
  deliver audio — rejecting on the four that answer with a promise, and throwing on `recordFragments()`, which
  answers with a handle. `snapshotStored()` is exempt, because a retained push thumbnail is not a pull. A
  reading of `undefined` refuses nothing: families reporting neither wire param leave the state unknown, and
  unknown is not known-off, so such a camera pulls exactly as before. The reading is consulted when a pull is
  opened and at no other point, so a camera switched off mid-stream keeps the pull it already has; a caller
  that must end a live view for it acts on `propertyChanged` or on its own re-read. Presenting an off camera as
  unavailable so nothing asks in the first place is still a caller's policy.
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

## Where the SDK stops

The SDK owns verified device media truth and reusable media mechanics: typed inbound audio metadata,
audio-aware container muxing, rolling prebuffer drainage, recording-budget extension, and correct
readable-stream behaviour.

Host-specific representation stays outside it — output codec negotiation, transcoding targets, bitrate
and profile policy, packetization, and session keep-alives are the caller's. That boundary is what lets
every host consume the same truthful primitives without coupling the SDK to one presentation protocol.

So the APIs here do not claim negotiation or timing guarantees the device source cannot provide: a
fragment duration is a keyframe-bounded **minimum**, prebuffer is available only from an already-warm
retained source, and fragmented recordings are caller-owned evented async iterables — which is how a
caller extends a shared battery budget without control notices mixing into media output.
