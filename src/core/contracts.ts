/**
 * Transport boundary contract — the shared vocabulary between the capability layer (which emits
 * intent) and the transport layer (which puts bytes on a wire). It belongs to NEITHER: capabilities
 * (`model/`) produce these, transports (`transport/`) consume them. Housing it in `core/` — the leaf
 * both layers may import — is what lets the capability↔transport decorrelation be enforced with NO
 * exceptions: `model/` never imports `transport/`, `transport/` never imports `model/`.
 *
 * Self-contained on purpose (no model/ or transport/ import). `LiveStreamHandle` is a STRUCTURAL
 * subset of the concrete `transport/p2p/LiveStream` (which is assignable to it), so the media
 * contract doesn't drag a transport type into core.
 */

/** Why {@link MediaProvider.snapshotStored} has no retained push thumbnail to return. */
export type StoredSnapshotUnavailableReason = "not-observed" | "pending" | "download-failed" | "invalid-image";

/**
 * Thrown by {@link MediaProvider.snapshotStored} when no validated push thumbnail is retained. The
 * reason distinguishes absence, acquisition still in progress, and the latest terminal failure; the
 * SDK returns only observed JPEG bytes and never substitutes live media or presentation bytes.
 */
export class StoredSnapshotUnavailableError extends Error {
  constructor(
    readonly reason: StoredSnapshotUnavailableReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StoredSnapshotUnavailableError";
  }
}

/**
 * Why {@link MediaProvider.snapshotLive} could not return a still.
 *
 * - `no-keyframe` — no clean keyframe arrived within the acquisition window. The stream may simply be
 *   slow to start, or the source may be delivering nothing.
 * - `undecodable-burst` — a burst was collected but the decoder refused it. Per-attempt framing, not a
 *   property of the camera.
 * - `decoder-unavailable` — the decoder could not be run at all (no ffmpeg was runnable).
 */
export type LiveSnapshotUnavailableReason = "no-keyframe" | "undecodable-burst" | "decoder-unavailable";

/** The reasons another attempt could plausibly succeed against an unchanged configuration. */
const RETRYABLE_LIVE_SNAPSHOT_REASONS: readonly LiveSnapshotUnavailableReason[] = ["no-keyframe", "undecodable-burst"];

/**
 * Thrown by {@link MediaProvider.snapshotLive} when no still could be produced.
 *
 * {@link retryable} is the distinction the reason exists for. A caller that rate-limits acquisition has
 * to spend its budget on attempts that can succeed: a burst the decoder refused is per-attempt framing
 * and another try is worthwhile, while an unrunnable decoder is host configuration that no number of
 * retries will change. Without it every failure looks alike, and a caller either retries a permanent
 * fault forever or gives up on a camera that would have answered on the next attempt.
 *
 * The decoder's own diagnostics are preserved in {@link Error.message}, so classifying the failure never
 * costs the detail needed to explain it.
 */
export class LiveSnapshotUnavailableError extends Error {
  /** Whether another attempt could plausibly succeed without the host changing anything. */
  readonly retryable: boolean;

  constructor(
    readonly reason: LiveSnapshotUnavailableReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LiveSnapshotUnavailableError";
    this.retryable = RETRYABLE_LIVE_SNAPSHOT_REASONS.includes(reason);
  }
}

/**
 * Wire form for a scalar {@link Command} `"set-param"` intent. `"auto"` lets the transport choose the
 * right encoding for the device's session; `"int-string"` / `"direct-binary"` pin a specific encoding
 * when the firmware requires one.
 */
export type ScalarForm = "auto" | "int-string" | "direct-binary";

/**
 * The identity fields the `ff09` frame is built from — the AES key/IV inputs (`adminUserId`/`deviceSn`)
 * plus the frame's own direction bit and user-attribution fields (`A3`/`A4`/`A5`). Shared by the
 * actuate intent; the settings intents carry a narrower subset (the GET/SET frames omit the
 * user-attribution fields).
 */
export interface Ff09Identity {
  /** Actuation direction: `true` = engage (lock / close), `false` = release (unlock / open) — the frame's `A3` byte. */
  engage: boolean;
  adminUserId: string;
  username: string;
  shortUserId: string;
  deviceSn: string;
}

/** @internal */
export interface CommandObservation {
  event: string;
  expected: boolean | number | string;
  param: number;
  property: string;
  resetStandaloneSession?: boolean;
  timeoutMs: number;
}

const COMMAND_OBSERVATION = Symbol("command-observation");

/**
 * A transport-neutral outbound **command intent**. Capability modules emit one of these; they never
 * call the network directly, never name a transport, and never carry a routing key. The
 * {@link CommandSink} routes each by `kind`; kinds are named after the WIRE MECHANISM (the frame or
 * protocol), never the capability that happens to be the first caller. Most carry an opaque param/id +
 * value; a `kind` whose wire interaction is a bespoke sequence (a burst, a read-modify-write) earns its
 * own variant. The `ff09-*` kinds share ONE frame that rides BOTH P2P and secure-MQTT, so the sink
 * routes them by the device's runtime topology and the chosen router re-resolves its own routing tail
 * from the device record — nothing transport- or route-specific lives in the intent.
 */
export type Command =
  | { kind: "set-param"; param: number; value: number; form: ScalarForm; channel: number }
  | { kind: "set-json"; param: number; data: Record<string, unknown>; channel: number }
  // `set-json-raw` differs from `set-json` in ONE way: the wire's outer P2P command IS `cmd` itself
  // (no `1700` CONTROL_PAYLOAD wrapper, no `{commandType,data}` nesting) — the plaintext is exactly
  // `data` (plus an injected `account_id`), matching the app's own SET_SNOOZE_TIME (1271) frame.
  | { kind: "set-json-raw"; cmd: number; data: Record<string, unknown>; channel: number }
  | {
      kind: "set-payload";
      cmd: number;
      payload: Record<string, unknown>;
      channel: number;
      mValue3?: number;
      form?: ScalarForm;
    }
  | { kind: "p2p-privacy-burst"; enabled: boolean; channel: number }
  | { kind: "p2p-station-scalar"; cmd: number; value: number; channel: number }
  /** P2P int-plus-string frame; the transport injects the authenticated account id string. */
  | { kind: "p2p-int-string"; cmd: number; value: number; valueSub: number; channel: number }
  | ({ kind: "ff09-actuate" } & Ff09Identity)
  | { kind: "ff09-autolock"; adminUserId: string; deviceSn: string; enabled: boolean; delaySeconds?: number }
  | { kind: "ff09-setting-toggle"; adminUserId: string; deviceSn: string; settingId: number; value: boolean }
  // `mqtt-dp` — an `eufy_life` secure-MQTT "DP" TLV write (smart lights + kin). The capability supplies
  // its own opaque `mqttCmdCode` (the outer envelope's dispatch id) + `cmdCode` (the feature id whose
  // low byte is the frame subtype) + already-tagged scalar `fields`; the router does ONLY the generic
  // ff09-TLV framing + envelope (it names none of these ids). See `transport/mqtt/dp-codec.ts`.
  | { kind: "mqtt-dp"; mqttCmdCode: number; cmdCode: number; fields: ReadonlyArray<{ tag: number; value: Buffer }> }
  // `mqtt-dp-preset` — a DP write whose payload is too large to pass inline, named by a **cloud catalog
  // id** the router resolves through an injected lookup and serializes. Named for that wire shape, not
  // for the feature that uses it (as `ff09-actuate` is named for the action, not for locks): any
  // `eufy_life` device with a catalog-defined payload rides this kind. The capability supplies the
  // feature ids it owns — `cmdCode` for the preset frame and `companionCmdCode` for the follow-up frame
  // a resolved preset may need — and the router forwards both opaquely, naming neither.
  | { kind: "mqtt-dp-preset"; mqttCmdCode: number; cmdCode: number; companionCmdCode: number; presetId: number }
  /** A DP custom-colour write; the transport owns RGB-to-wire conversion and field serialization. */
  | {
      kind: "mqtt-dp-color";
      mqttCmdCode: number;
      cmdCode: number;
      red: number;
      green: number;
      blue: number;
      segmentCount: number;
    }
  | { kind: "aiot-dp"; dp: number; value: boolean | number | string };

/** Attach non-wire observation policy to a command without changing its enumerable transport intent. @internal */
export function observeCommand(command: Command, observation: CommandObservation): Command {
  return Object.defineProperty(command, COMMAND_OBSERVATION, { configurable: true, value: observation });
}

/** Read capability-owned observation policy at the client boundary. @internal */
export function commandObservation(command: Command): CommandObservation | undefined {
  return (command as Command & { [COMMAND_OBSERVATION]?: CommandObservation })[COMMAND_OBSERVATION];
}

/**
 * The command transport boundary. The client implements it (routing each {@link Command} `kind` to
 * P2P / Tuya). Capability modules receive a sink to emit intent through, staying transport-agnostic.
 */
/**
 * A decoded inbound "DP" TLV frame — the transport's parse of a device→app message, handed to the
 * capability layer so it can attribute MEANING to the tags without knowing the framing.
 *
 * The split follows the outbound direction, mirrored: a capability supplies opaque `cmdCode` + tagged
 * fields and the transport frames them; inbound, the transport unwraps the envelope and validates the
 * frame, and the capability decides what each tag means. Neither side needs the other's half — which is
 * the whole reason this type sits on the shared floor rather than in either layer.
 */
export interface DpInboundFrame {
  /** The envelope's dispatch id (`head.cmd`) — capability-owned vocabulary, forwarded verbatim. */
  envelopeCmd: number;
  /** The frame command (`cmdHi`/`cmdLo`), likewise forwarded without interpretation. */
  cmd: number;
  /** The status byte a response frame carries ahead of its TLVs; absent on an unsolicited report. */
  status?: number;
  /** The frame's TLV run, in wire order. */
  fields: ReadonlyArray<{ tag: number; value: Buffer }>;
}

/**
 * One top-level field of a payload decoded by a {@link RawDpCodec}, identified by its numeric position
 * in the message. `kind` reports how the value was encoded, not what it means: a variable- or
 * fixed-width integer arrives as `int`, and a length-delimited run — a string, a byte blob, or a nested
 * message — arrives as `bytes`, for the reader to interpret.
 */
export type RawDpField =
  { field: number; kind: "int"; value: bigint } | { field: number; kind: "bytes"; value: Buffer };

/**
 * Reader for the structured, base64-encoded values some device data points carry in place of a plain
 * scalar. Such a value is a length-prefixed field-and-value tree; this walks the tree and reports the
 * fields it finds, with no schema and no notion of which data point the value came from.
 *
 * The split mirrors {@link DpInboundFrame}: decoding a container is a technical job, naming its
 * contents is a semantic one. A capability receives a codec and asks for the field positions whose
 * meaning it knows, so neither half has to carry the other's knowledge.
 */
export interface RawDpCodec {
  /**
   * Decode a base64 payload to its top-level fields, or `undefined` when the value is not a
   * well-formed payload — a length prefix disagreeing with the body, an encoding this does not
   * recognise, or a string that is not base64 at all. The result is a whole field list or nothing,
   * never a partial read.
   */
  decode(value: string): readonly RawDpField[] | undefined;
  /** Read a length-delimited field's bytes as a nested field list, on the same terms as {@link decode}. */
  nested(value: Buffer): readonly RawDpField[] | undefined;
}

export interface CommandSink {
  dispatch(cmd: Command): Promise<void>;
}

/**
 * Inbound Tuya DP event contract — the transport parses a ThingClips MQTT payload
 * (string-keyed object → numeric-keyed record) and delivers it through this interface. The
 * transport owns the parse; a capability owns the semantics (which DP id means what). Mirrors
 * {@link DpInboundFrame} for the AIoT MQTT path; the capability layer never names the Tuya framing.
 *
 * Routing note: outbound Tuya writes use the same `aiot-dp` {@link Command} kind as AIoT MQTT;
 * the facade distinguishes them by `dev.category === "eufy_home_tuya"` and routes to
 * `TuyaCommandRouter` accordingly — the capability layer stays transport-agnostic.
 */
export interface TuyaDpInbound {
  /**
   * Deliver a parsed DP event for `sn`. `dps` is numeric-keyed (converted from the wire's
   * string-keyed map). The client receives this, converts to `dpParams` strings, and delivers
   * via `decodeState({ source: "mqtt", dpParams })` so capability modules read Tuya values
   * through the same typed getters as AIoT reports.
   */
  onDps(sn: string, dps: Record<number, boolean | number | string>): void;
}

/** Elementary-stream video codec of a {@link LiveVideoFrame} — eufy cameras stream H.264 or H.265. */
export type VideoCodec = "h264" | "h265" | "av1";

/** One decoded video access unit, as Annex-B (H.264 or H.265). */
export interface LiveVideoFrame {
  keyframe: boolean;
  width: number;
  height: number;
  /**
   * Codec of the elementary stream this access unit belongs to. Sniffed off the parameter sets on a
   * keyframe and carried on the delta frames that follow (a delta frame has no config to sniff).
   */
  codec: VideoCodec;
  /** Annex-B bytes (one or more NAL units, start-code prefixed). */
  data: Buffer;
}

/**
 * Elementary-stream audio codec of a {@link LiveAudioFrame}. The station declares it per frame as a
 * byte in the `CMD_AUDIO_FRAME` header — unlike video, nothing is sniffed. These are the three values
 * the v6 app accepts (`AudioReader.setAudioSpecificConfig`: 0 → `mp4a.40.2`, 2 → G.711 A-law,
 * 7 → `mp4a.40.39`); it fails the stream on anything else.
 */
export type AudioCodec = "aac-lc" | "aac-eld" | "g711a";

/**
 * One audio access unit, carrying the codec the station declared for it.
 *
 * Sample rate and channel count are deliberately absent: they are not on the wire. The v6 app assumes
 * 16 kHz mono for every audio type rather than reading them, so the SDK does not invent fields the
 * device never sent — a host needing them applies that assumption knowingly.
 */
export interface LiveAudioFrame {
  /** Codec declared in the frame header. */
  codec: AudioCodec;
  /** Elementary-stream bytes (ADTS-framed for the two AAC profiles). */
  data: Buffer;
}

/**
 * One fragmented-MP4 (CMAF) output unit from the native muxer. `init` (the `ftyp`+`moov` init
 * segment) is present exactly once, on the first fragment; every fragment carries a `moof`+`mdat`
 * media segment in `data`. Structural (plain `Buffer`s) so it stays in core with no transport import.
 */
export interface MediaFragment {
  /** The init segment (`ftyp`+`moov`), present only on the first emitted fragment. */
  init?: Buffer;
  /** A media fragment (`moof`+`mdat`); may be empty on the init-only first emission. */
  data: Buffer;
  /** Whether this fragment opens on a keyframe (a valid CMAF segment boundary). */
  keyframe: boolean;
}

/**
 * A fragmented-MP4 recording owned by the caller. It remains an async iterable for direct `for await`
 * consumption, while exposing the shared source's battery budget and an explicit stop for callers
 * whose recording lifetime is not naturally scoped by an iterator.
 */
export interface FragmentRecordingHandle extends AsyncIterable<MediaFragment> {
  /** Battery budget elapsed; call `notice.extend()` to keep the shared media session alive. */
  on(event: "budget", listener: (notice: StreamBudgetNotice) => void): this;
  /** End this recording and release its shared-source consumer. Idempotent. */
  stop(): void;
}

/**
 * Battery-budget notice for a live stream. Battery/solar cameras drain while streaming, so the source
 * bounds a continuous stream to a budget; when it elapses this fires and the host decides: call
 * {@link extend} to keep streaming (re-pushes the budget), or do nothing and the source auto-stops
 * after a short grace to protect the battery. Wired/mains cameras never emit this — they stream
 * unbounded.
 */
export interface StreamBudgetNotice {
  /** Milliseconds left to call {@link extend} before the source auto-stops. */
  graceMs: number;
  /** Re-push the budget by `ms` (default: another full budget), cancelling the pending auto-stop. */
  extend(ms?: number): void;
}

/**
 * The consumer-facing surface of a live stream — a STRUCTURAL subset of the concrete
 * `transport/p2p/LiveStream` (an EventEmitter), so the media contract can live in core without
 * importing transport. The concrete `LiveStream` is assignable to this.
 */
export interface LiveStreamHandle {
  start(): this;
  stop(): void;
  /** Re-issue the media-start command (start-race retry / keepalive nudge). Optional. */
  nudge?(): void;
  on(event: "video", listener: (frame: LiveVideoFrame) => void): this;
  on(event: "audio", listener: (frame: LiveAudioFrame) => void): this;
  on(event: "start" | "stop", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  /** Battery-budget elapsed — extend to keep streaming or let it auto-stop (battery cameras only). */
  on(event: "budget", listener: (notice: StreamBudgetNotice) => void): this;
}

/** An SDP session description crossing the WebRTC signaling boundary (JSEP shape). */
export interface WebRTCSessionDescription {
  type: "offer" | "answer";
  sdp: string;
}

/** A trickle-ICE candidate crossing the WebRTC signaling boundary (JSEP shape). */
export interface WebRTCIceCandidate {
  /** The `candidate:` attribute value (without the `a=` prefix). */
  candidate: string;
  /** Media-stream identification tag of the m-section this candidate belongs to. */
  sdpMid?: string;
  /** Index of the m-section this candidate belongs to. */
  sdpMLineIndex?: number;
}

/**
 * Engine-free structural surface of a WebRTC peer — a STRUCTURAL subset of the concrete
 * `transport/webrtc` peer, so the WebRTC boundary lives in core WITHOUT dragging the engine
 * (`werift`) type surface (`RTCPeerConnection`, `MediaStreamTrack`, `RtpPacket`, …) into the public
 * `.d.ts`. Signaling in / media out (to a file / a plain callback); no engine handle is exposed.
 * The engine is lazy-loaded only when a concrete peer is constructed, so a host that never opens a
 * WebRTC stream never pays the WebRTC engine's import cost.
 */
export interface WebRTCPeerHandle {
  /** Build the SDP offer (app-as-offerer flow: recv-only video + audio). */
  createOffer(): Promise<WebRTCSessionDescription>;
  /** Apply the remote description (the camera's answer, or its offer in the camera-as-offerer flow). */
  setRemoteDescription(sdp: string, type: "offer" | "answer"): Promise<void>;
  /** Build the SDP answer (camera-as-offerer flow). */
  createAnswer(): Promise<WebRTCSessionDescription>;
  /** Add a remote trickle-ICE candidate. */
  addRemoteCandidate(candidate: WebRTCIceCandidate): Promise<void>;
  /** Tear down the peer and flush any file/muxer sink. */
  close(): Promise<void>;
  /** Called for each locally-gathered ICE candidate (trickle) — wire to your signaling layer. */
  onLocalCandidate?: (candidate: WebRTCIceCandidate) => void;
  /** Called when the peer-connection state changes (plain string, no engine type). */
  onConnectionStateChange?: (state: string) => void;
}

/**
 * The **media / device-query boundary** — the second transport, for operations that RETURN data (a
 * still, a live stream, a recording, a P2P request/reply query). The client implements it (P2P media
 * plumbing); capability modules call it without knowing the protocol. Bound to one device serial, so
 * methods take none. `p2pQuery` is a GENERIC request/reply primitive (transport only). Optional
 * because an unbound model has no live client (hence `?.` at the call site).
 */
export interface MediaProvider {
  /**
   * Return the latest validated push thumbnail retained in memory. This passive operation performs no
   * network, storage, P2P, live-media, or transcoding work at call time. It rejects with
   * {@link StoredSnapshotUnavailableError} when no image is retained. Optional because cache ownership
   * and capability binding belong to the client.
   */
  snapshotStored?(): Promise<Buffer>;
  /**
   * A fresh still decoded from a short live burst.
   *
   * Rejects with {@link LiveSnapshotUnavailableError}, whose {@link LiveSnapshotUnavailableError.retryable}
   * says whether another attempt could succeed — a caller that rate-limits acquisition needs that to
   * avoid spending its budget on a permanent fault, or abandoning a camera that would have answered.
   *
   * Carries `powered` for the same reason every other egress does: it may be the call that CREATES the
   * shared source, and the source keeps whatever power hint it was built with. A caller polling this
   * on a battery camera would otherwise arm no budget for anyone who joins later.
   */
  snapshotLive(opts?: {
    timeoutMs?: number;
    collectMs?: number;
    skipKeyframes?: number;
    powered?: "wired" | "battery";
  }): Promise<{
    jpeg: Buffer;
    width: number;
    height: number;
  }>;
  /**
   * Open a managed live stream.
   *
   * @example
   * ```ts
   * const stream = await cam.live();
   * stream.on("video", (frame) => write(frame.data)); // Annex-B
   * stream.stop(); // detach this consumer
   * ```
   */
  live(opts?: Record<string, unknown>): Promise<LiveStreamHandle>;
  /** Record `seconds` of video → an mp4/h264 buffer. */
  record(seconds: number, opts?: { timeoutMs?: number; skipKeyframes?: number }): Promise<Buffer>;
  /**
   * Open a video-only `node:stream` Readable over a shared source consumer — raw Annex-B bytes
   * (default) or `objectMode` {@link LiveVideoFrame}s. Audio is available separately through
   * {@link live} or muxed through {@link recordFragments}; it is never interleaved into raw video.
   * The caller owns the Readable's lifetime, and destroying it releases the shared pull.
   */
  openReadable?(opts?: {
    objectMode?: boolean;
    powered?: "wired" | "battery";
  }): Promise<import("node:stream").Readable>;
  /**
   * Continuously record the live feed as fragmented-MP4 (CMAF). The caller-owned
   * {@link FragmentRecordingHandle} yields an init segment then keyframe-bounded media fragments,
   * emits battery-budget notices, and releases the shared pull on `stop`, `break`, or `return`.
   */
  recordFragments?(opts?: {
    fragmentSeconds?: number;
    /** Drain this much retained media before live frames; capped by the source's configured window. */
    preBufferSeconds?: number;
    powered?: "wired" | "battery";
  }): FragmentRecordingHandle;
  /**
   * Open the camera's **talkback** path — audio travelling from the host TO the device, the opposite
   * direction to everything else here. See {@link TalkbackHandle} for the accepted audio. Optional (an
   * unbound model has no client), and absent on a device whose talkback wire is unverified.
   */
  talkback?(opts?: { encoder?: AacEncoder; powered?: "wired" | "battery" }): Promise<TalkbackHandle>;
  /**
   * Generic P2P request/reply query: send a `SET_PAYLOAD` sub-command and resolve with the reply
   * frame's `payload` (the reply whose `cmd` echoes `subCmd`). Transport-only — the caller owns the
   * sub-command id and the reply shape (e.g. the doorbell's 6237 quick-response list).
   * @internal
   */
  p2pQuery?(subCmd: number, opts?: { timeoutMs?: number }): Promise<Record<string, unknown>>;
  /**
   * Generic control-payload request/reply query: send a `CONTROL_PAYLOAD` (1700) `{commandType,data}`
   * and resolve with the correlated notify (`1351`) frame's `payload`. Distinct from {@link p2pQuery}'s
   * `SET_PAYLOAD` (1350) envelope — some queries ride the 1700 wrapper with a 1351 reply instead.
   * Transport-only; the caller owns the command id, request data, and reply shape.
   * @internal
   */
  p2pControlQuery?(
    param: number,
    data: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>>;
}

/**
 * An encoder that turns raw PCM into AAC-LC frames, supplied by the CALLER. The SDK ships none: the
 * device's audio path is fixed at AAC-LC 16 kHz mono, and every plausible encoder is either a native
 * dependency or an external process, both of which belong to the host rather than to a protocol SDK.
 * A caller that already holds AAC needs none of this — see {@link TalkbackHandle}.
 *
 * `encode` receives 16-bit little-endian mono PCM at 16 kHz and returns whole ADTS frames, zero or
 * more per call (an encoder buffers until it has a full 1024-sample block). `flush` drains a partial
 * trailing block; `close` releases whatever the encoder holds.
 */
export interface AacEncoder {
  encode(pcm: Buffer): Buffer[] | Promise<Buffer[]>;
  flush?(): Buffer[] | Promise<Buffer[]>;
  close?(): void;
}

/**
 * A live talkback session: audio pushed from the host to a camera's speaker, the mirror of
 * {@link LiveStreamHandle}'s inbound feed.
 *
 * Audio must be **AAC-LC, 16 kHz, mono, in ADTS frames** — what the device's path is fixed at, so a
 * stream at another rate or channel count is rejected rather than resampled (it would otherwise play
 * at the wrong pitch and speed). Feed it either way:
 *
 *  - **ADTS AAC** — the default. Chunk boundaries are irrelevant; frames are recovered from the
 *    stream, so piping an encoder's output straight in works.
 *  - **PCM** — only when the handle was opened with an {@link AacEncoder}, which then does the
 *    conversion. `write` takes 16-bit little-endian mono PCM at 16 kHz instead.
 *
 * Frames are **paced** at their own playback rate (64 ms each) rather than flushed as fast as they
 * arrive, so feeding a file plays it at speed instead of overrunning the device. A live source keeps
 * the queue near-empty and is unaffected.
 *
 * @example
 * ```ts
 * const talk = await cam.talkback!();
 * talk.on("error", (err) => console.error(err.message));
 * talk.on("finished", () => void talk.stop());
 * fs.createReadStream("greeting.aac").pipe(talk.writable());
 * ```
 */
export interface TalkbackHandle {
  /** Queue audio — ADTS frames, or PCM when an encoder was supplied. Partial frames are held. */
  write(chunk: Buffer): void;
  /**
   * A `node:stream` Writable over {@link write}, for piping a file or an encoder's stdout. Applies
   * backpressure while the pacing queue is full, so a fast source cannot outrun playback.
   */
  writable(): import("node:stream").Writable;
  /**
   * Declare the input finished, so a drained queue can report the clip complete. `writable()` calls
   * this from its `final`, so a piped source needs no explicit call; an imperative {@link write}
   * caller does. Writing after this is an `error`, not more audio — open a new talkback for a new clip.
   */
  end(): void;
  /** How many frames are still queued for the wire — `0` once everything written has reached it. */
  readonly pending: number;
  /** Close the path, dropping anything still queued. Idempotent. */
  stop(): Promise<void>;
  /**
   * The clip is complete: the input has ended (via {@link end} or the writable's `final`) AND every
   * queued frame has reached the wire. Fires once — the natural moment to {@link stop} a finite clip.
   *
   * This deliberately does NOT fire on a merely-empty queue. A realtime source keeps the queue near
   * empty by design, so "queue is empty" arrives after the very first frame and stopping on it would
   * cut the clip to 64 ms. Use {@link pending} if you want the instantaneous depth.
   */
  on(event: "finished", listener: () => void): this;
  /**
   * The path closed — either you called {@link stop}, or the media session it rides inside ended and
   * took it with it. It always fires exactly once, so it is a teardown hook rather than a signal that
   * something went wrong; a caller that stopped it already knows.
   */
  on(event: "stop", listener: () => void): this;
  /**
   * A frame the device would not play (wrong sample rate or channel count, or over its length limit),
   * an encoder failure, or an audio frame the device never acknowledged — the channel is ordered, so
   * an unacknowledged frame can stall playback behind it. Non-fatal: the session stays open.
   */
  on(event: "error", listener: (err: Error) => void): this;
  /**
   * Battery cameras only: the media session talkback rides inside has reached its power budget and
   * will auto-stop after the notice's grace period, taking the audio with it. Call `extend()` to keep
   * talking. Without a listener the session stops on schedule, which protects the battery.
   */
  on(event: "budget", listener: (notice: StreamBudgetNotice) => void): this;
}

/**
 * Decoded auto-lock settings, read off the device's settings reply (the response
 * tag map: `a1`=enabled, `a2`=delaySeconds, `a3`=isSchedule, `a4`/`a5`=schedule start/end). These are
 * the SAME fields `setAutoLock` already reads internally to preserve them on a write — this is that
 * read, exposed standalone with no write attached.
 */
export interface AutoLockSnapshot {
  /** Whether auto-lock is currently enabled. */
  enabled: boolean;
  /** Auto-lock delay, in seconds. */
  delaySeconds: number;
  /** Whether the schedule window is active. */
  isSchedule: boolean;
  /** Schedule start, `[hour, minute]` — read back verbatim, not independently validated. */
  scheduleStartTime: [number, number];
  /** Schedule end, `[hour, minute]` — read back verbatim, not independently validated. */
  scheduleEndTime: [number, number];
}

/**
 * The **`ff09` settings read boundary** — `GET_SETTINGS` is a request/reply query (like a
 * `MediaProvider` media op), not a passive property the device broadcasts, so it needs its own
 * request/reply primitive rather than reusing the write-only {@link CommandSink}. Named for the frame
 * family it reads, the same way the `ff09-*` {@link Command} kinds and {@link Ff09Identity} are: any
 * device driven by that frame can grow a reader here, and the settings it exposes are the frame's, not
 * one capability's.
 *
 * Bound to one device serial (transport picked internally, P2P or MQTT, same as `CommandSink`), so the
 * methods take no identity args. Optional because an unbound model has no live client, and because only
 * `ff09`-family devices have one at all.
 *
 * One method today. A further `ff09` setting that needs a live read is another method here — not
 * another injected provider.
 */
export interface Ff09SettingsReader {
  /** Read the device's current auto-lock settings via a live `GET_SETTINGS` round-trip. */
  getAutoLockState(): Promise<AutoLockSnapshot>;
}
