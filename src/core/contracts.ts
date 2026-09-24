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
 * - `no-keyframe` — no clean keyframe arrived within the acquisition window, and the live source never
 *   reported a failure of its own. The source may simply be slower than the window allowed.
 * - `source-failed` — the live source reported a failure, so the burst will not arrive at all. Distinct
 *   from `no-keyframe` because it is known rather than merely elapsed, and it is known EARLY: a caller
 *   gets it instead of waiting out the window on a source that has already given up.
 * - `undecodable-burst` — a burst was collected but the decoder refused it. Per-attempt framing, not a
 *   property of the camera.
 * - `decoder-unavailable` — the decoder could not be run at all.
 */
export type LiveSnapshotUnavailableReason =
  "no-keyframe" | "source-failed" | "undecodable-burst" | "decoder-unavailable";

/**
 * The reasons another attempt could plausibly succeed against an unchanged configuration.
 *
 * All three acquisition failures qualify, because each is a property of the attempt rather than of the
 * camera: a window can elapse, a source can fail to start and then start, and a burst's framing is luck.
 * An unrunnable decoder is the one that is not — it is host configuration, and no number of retries
 * changes it.
 */
const RETRYABLE_LIVE_SNAPSHOT_REASONS: readonly LiveSnapshotUnavailableReason[] = [
  "no-keyframe",
  "source-failed",
  "undecodable-burst",
];

/**
 * Thrown by {@link MediaProvider.snapshotLive} when no still could be produced.
 *
 * {@link retryable} is the distinction the reason exists for: a burst the decoder refused is per-attempt
 * framing and another try is worthwhile, while an unrunnable decoder is host configuration that no number
 * of retries will change. Without it every failure looks alike.
 *
 * It is derived from {@link reason} rather than passed in, so the two can never disagree, and every
 * caller reads one answer instead of re-deriving the mapping and drifting from it.
 *
 * The underlying diagnostics are preserved in the error's `message` and, where there is one, its `cause` — so
 * classifying the failure never costs the detail needed to explain it.
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
 * A media pull was refused: the camera is switched off.
 *
 * A disabled camera serves no live media, video or audio.
 *
 * Raised by every media pull on the camera surface. The pulls that answer with a promise REJECT with it;
 * fragment recording answers with a handle and therefore THROWS it at the call site rather than reporting
 * it on the handle. A retained push thumbnail is exempt — it is not a pull.
 */
export class CameraDisabledError extends Error {
  constructor(
    /** How the camera identifies itself to a reader — its name where the record carries one. */
    readonly camera: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(`camera${camera ? ` ${camera}` : ""} is disabled — no live stream possible`, options);
    this.name = "CameraDisabledError";
  }
}

/**
 * Work on a station was refused: the station did not provide the session key that work requires.
 *
 * A station reached over its HomeBase encrypts what it is sent under a key negotiated once per connection, and
 * a media start for an attached camera has no unencrypted form at all — so without that key there is nothing
 * to send, however reachable the station is. Naming this apart from a source that failed is what separates an
 * account whose cipher material could not be resolved from a camera that is off, a station that is busy, or a
 * stream that produced nothing: they share no next step.
 *
 * The `level2-unavailable` trace states WHY the key is not coming. This states only that it is not, because
 * that is what the refusal itself knows.
 *
 * `stationSn` is the station that owed the key, which is the parent for an attached camera and therefore not
 * the serial the refused call was made about: several cameras refused at once are one station's outcome, and
 * nothing else in the refusal says so.
 */
export class StationKeyUnavailableError extends Error {
  /** Always true: the negotiation is per connection, so a later one may still produce a key. */
  readonly retryable = true;

  constructor(
    /** The station whose session key did not arrive. */
    readonly stationSn: string,
    options?: { cause?: unknown },
  ) {
    super(`station ${stationSn} did not provide its session key, so nothing that requires one could be sent`, options);
    this.name = "StationKeyUnavailableError";
  }
}

/**
 * Work on a station was refused: its session did not connect within the wait it was given.
 *
 * A station is reached over its own session, and nothing addressed to it — a media start, a property read, a
 * still — can be attempted before that session is up. Naming this apart from every other failure is what tells
 * a station that could not be reached at all from one that answered and then refused, or one that served media
 * a caller could not use: those call for opposite next steps, and a caller cannot infer which it had from a
 * message.
 *
 * `waitedMs` is how long was actually waited, which a caller compares against its own deadline to know whether
 * this SDK concluded or its own bound expired first. `stationSn` is the station that could not be reached —
 * the parent for an attached camera, so it is not derivable from the serial the call was made about.
 */
export class StationUnreachableError extends Error {
  /** Always true: a station unreachable now may answer on a later attempt. */
  readonly retryable = true;

  constructor(
    /** The station whose session did not connect. */
    readonly stationSn: string,
    /** How long the session was waited on before this was raised. */
    readonly waitedMs: number,
    options?: { cause?: unknown },
  ) {
    super(
      `station ${stationSn}'s P2P session did not connect within ${waitedMs}ms, so nothing could be sent to it`,
      options,
    );
    this.name = "StationUnreachableError";
  }
}

/**
 * How a live stream ended before its first video keyframe: the warm-up deadline elapsed, the source
 * reported an error, or the source ended on its own.
 */
export type LiveStreamStartFailureReason = "warm-timeout" | "source-error" | "source-ended";

/**
 * How far the media source got before it failed.
 *
 * `awaiting-first-frame` means the source delivered nothing at all; `audio-only` means it delivered audio
 * and never a video frame; `awaiting-keyframe` means video units arrived but none of them was a keyframe, so
 * nothing was decodable. The three need different answers — a source that is not answering, one that is
 * answering with sound and no picture, and one producing media a decoder cannot start from — and this states
 * which without a caller reading transport logs.
 *
 * Each names only what the source did, never why. `audio-only` in particular is an observation and not a
 * diagnosis: a device that is streaming but has no picture to send and one whose video this build cannot read
 * both reach it.
 */
export type LiveStreamStartStage = "awaiting-first-frame" | "audio-only" | "awaiting-keyframe";

/** The bounded facts a live start failure reports. */
export interface LiveStreamStartFailure {
  reason: LiveStreamStartFailureReason;
  stage: LiveStreamStartStage;
  /** The warm-up deadline the source was bounded by, in milliseconds. */
  timeoutMs: number;
  /** The initial media start plus every warm-up retry issued before the deadline. */
  attempts: number;
  cause?: unknown;
}

/** Emitted by {@link LiveStreamHandle} when its bounded warm-up policy ends without a video keyframe. */
export class LiveStreamStartError extends Error {
  readonly reason: LiveStreamStartFailureReason;
  readonly stage: LiveStreamStartStage;
  readonly timeoutMs: number;
  readonly attempts: number;

  constructor(failure: LiveStreamStartFailure) {
    super(
      `live stream failed to start (${failure.reason} at ${failure.stage} after ${failure.attempts} attempts; ` +
        `${failure.timeoutMs}ms deadline)`,
      failure.cause === undefined ? undefined : { cause: failure.cause },
    );
    this.name = "LiveStreamStartError";
    this.reason = failure.reason;
    this.stage = failure.stage;
    this.timeoutMs = failure.timeoutMs;
    this.attempts = failure.attempts;
  }
}

/**
 * What the observation a write declared was still waiting for when its deadline passed, carried by
 * {@link StateConvergenceError}.
 */
export interface StateConvergenceFailure {
  sn: string;
  /** The decoded property the observation names, which is what a caller reads. */
  property: string;
  param: number;
  /** The RAW param value the write asked the device to report. */
  expected?: boolean | number | string;
  /** What the param actually read when the deadline passed, absent where the device reported none at all. */
  observed?: boolean | number | string;
  timeoutMs: number;
}

/**
 * Thrown when a write's declared observation never converges, so the SDK cannot say the write landed.
 *
 * A command is acknowledged when the transport has carried it, which is delivery and not convergence, and
 * the observation a member declares is what decides the second question. Where that observation times out
 * the write was accepted by the wire and never applied by the device — measured on a battery camera whose
 * power write is acknowledged and simply ignored — so this is a distinct outcome from a transport fault and
 * carries the attribution that names which member on which device is unconfirmed.
 */
export class StateConvergenceError extends Error {
  readonly sn: string;
  readonly property: string;
  readonly param: number;
  readonly expected?: boolean | number | string;
  readonly observed?: boolean | number | string;
  readonly timeoutMs: number;

  constructor(failure: StateConvergenceFailure) {
    super(
      `device ${failure.sn} did not report ${failure.property} as ${String(failure.expected)} within ` +
        `${failure.timeoutMs}ms (param ${failure.param} read ${String(failure.observed)})`,
    );
    this.name = "StateConvergenceError";
    this.sn = failure.sn;
    this.property = failure.property;
    this.param = failure.param;
    this.expected = failure.expected;
    this.observed = failure.observed;
    this.timeoutMs = failure.timeoutMs;
  }
}

/**
 * Wire form for a scalar {@link Command} `"set-param"` intent — how the write is sealed. The BODY is the
 * same struct in every case — `[u32 channel][u32 value][account_id → 128B]` — so these choose only the
 * encryption.
 *
 * - `"int-string"` pins level-1 (AES-128-ECB), `"direct-binary"` pins level-2 (AES-256-GCM).
 * - `"auto"` lets the transport pick the level, which it resolves from the session it will send on.
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
  /** The RAW param value the device must report before this write counts as landed. */
  expected: boolean | number | string;
  /**
   * The DECODED property value to expect once that raw value has been applied, where it differs from the raw
   * one. Absent when the two coincide.
   *
   * They diverge whenever the property's decode is not the identity: a disable-bit param reports `0` for a
   * property that reads `true`, so checking the decoded value against the raw expectation would reject a write
   * that had in fact landed. Stating both is what lets each check compare like with like.
   */
  observed?: boolean | number | string;
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

/**
 * One decoded video access unit, as Annex-B (H.264 or H.265).
 *
 * A WHOLE access unit, always: a station serves a unit larger than its chunk size as several frames, and
 * those are reassembled before delivery — so deciding anything per access unit (begin at a keyframe,
 * switch codec at a keyframe, count frames) operates on what it says it does. A unit the transport could
 * not complete is dropped rather than delivered short, because an access unit shorter than its own slice
 * headers promise decodes to no picture at all.
 */
export interface LiveVideoFrame {
  /** True on an IDR — a unit a consumer may begin decoding at, never a continuation of an earlier one. */
  keyframe: boolean;
  /**
   * Frame geometry as the station's own frame header states it — {@link height} is the same field.
   *
   * A camera reconfigures its live source WITHIN one session, so these change between frames of one
   * stream. Measured on eight cameras and both codecs: four of them changed, 2 to 9 times per 25-60 s,
   * oscillating up and down a ladder rather than only climbing it; the other four held one geometry
   * throughout. A change arriving on a keyframe carrying fresh parameter sets is what every run but one
   * showed, and that run is not accounted for, so it is not a property to rely on.
   *
   * This is what the station REPORTED. The size a decoder will actually produce is stated by the
   * parameter sets, and a consumer is told it through {@link LiveStreamConsumer} rather than having to
   * retain these and diff every frame against them.
   */
  width: number;
  /** See {@link width} — the same field, and it moves with it. */
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
 * The coded video configuration a live source is producing — the codec, and the picture size a decoder
 * will produce from the parameter sets in force.
 *
 * The geometry is the CODED one, read out of the sequence parameter set and cropped by the offsets it
 * declares, not the geometry a frame header reports. Those agreed on all but 28 of some 6000 measured
 * frames, but only one of them is the size a decoder produces: 1080 is not a multiple of the 16-sample
 * macroblock, so a 1080p H.264 stream codes 1088 rows and crops 8 away, and the frame header is a report
 * about that rather than the definition of it.
 *
 * Where the parameter sets state no readable geometry — before a stream's first keyframe has carried any,
 * or from a set that cannot be parsed — the frame header's report is carried instead, so a configuration is
 * always present. The two are not distinguished in the payload: a configuration is acted on by comparing it
 * with the one already in use, and that comparison answers the same whichever half stated it.
 *
 * The header's report is carried as it reads, so where the header declares no geometry either the width and
 * height are `0`. A caller sizing a decoder from these treats a zero as "not yet stated" and waits for the
 * next announcement, which the first keyframe's parameter sets produce.
 *
 * A consequence worth knowing: the first announcements of a session can move from a header-derived
 * configuration to a parameter-set-derived one without the camera having reconfigured, because the sets
 * arrive with the first keyframe and the frames before it have only their headers.
 */
export interface LiveVideoConfig {
  codec: VideoCodec;
  width: number;
  height: number;
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
 * device never sent.
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
 * A fragmented-MP4 recording owned by the caller. It is an async iterable for direct `for await`
 * consumption, and exposes the shared source's battery budget plus an explicit stop.
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
  /**
   * Re-issue the media-start command (start-race retry / keepalive nudge). Optional.
   *
   * `force` states that the channel is NOT being served, so a real start is required rather than a keepalive.
   * An own-session camera sends one or the other depending on whether its session believes the channel is
   * already started — a belief that outlives a station which acknowledged a start and then served nothing.
   */
  nudge?(force?: boolean): void;
  on(event: "video", listener: (frame: LiveVideoFrame) => void): this;
  on(event: "audio", listener: (frame: LiveAudioFrame) => void): this;
  on(event: "start" | "stop", listener: () => void): this;
  on(event: "error", listener: (err: Error) => void): this;
  /** Battery-budget elapsed — extend to keep streaming or let it auto-stop (battery cameras only). */
  on(event: "budget", listener: (notice: StreamBudgetNotice) => void): this;
  /**
   * A media start was repeated to its acknowledgement deadline and abandoned.
   *
   * The start is repeated byte-identically, so an abandonment is many sends with no reply — the device was
   * never told to stream, and a warm-up waiting on it can only time out. Distinct from `error`: the transport
   * is intact and the session is simply not being heard.
   */
  on(event: "unacknowledged", listener: () => void): this;
}

/**
 * One consumer's view of a live stream, carrying the flow control a sink needs to apply backpressure.
 *
 * A sink that cannot keep up calls {@link pause}, and the frames it would have received queue against a
 * bound instead of accumulating behind the sink. Crossing that bound drops the backlog and resynchronises
 * at the next IDR, so a sink that stays slow resumes on decodable media rather than replaying stale media.
 * {@link resume} stops the moment the sink pauses again, so the bound keeps applying to whatever is left.
 *
 * This is per consumer: pausing never stalls the shared source or any peer consumer.
 */
export interface LiveStreamConsumer extends LiveStreamHandle {
  /** True while this consumer is dropping frames after crossing its bound, waiting for the next IDR. */
  readonly awaitingKeyframe: boolean;
  /** Hold delivery — frames queue against the bound until {@link resume}. */
  pause(): void;
  /** Release delivery and hand over the queued backlog, stopping if the sink pauses again mid-drain. */
  resume(): void;
  /**
   * The coded configuration of the video that follows, announced immediately before the first frame
   * carrying it and again whenever it changes.
   *
   * A camera reconfigures its source repeatedly within one session, and an encoder opened for one geometry
   * cannot accept a frame of another — so a consumer adapting this source to a fixed output has to rebuild
   * on every change. Fires once per change rather than per frame, beginning with the first frame this
   * consumer receives, so a consumer holding media it has not been told the configuration of is not a state
   * it can reach.
   *
   * Per consumer, against what THIS consumer was last given: a consumer that joins mid-session is primed
   * with a cached keyframe it did not witness arriving, and one that crosses its bound resynchronises onto
   * a later IDR having skipped the frame the source saw the change on. Announcing what the source saw
   * would leave both holding an encoder built for media they never received.
   *
   * Only a consumer announces this, never a bare {@link LiveStreamHandle}: it is read from the parameter
   * sets a shared source watches every frame for, which the raw pull underneath it does not do. That is
   * also why the inherited events are restated here — a subtype may add an overload only by declaring the
   * whole set.
   */
  on(event: "video-config", listener: (config: LiveVideoConfig) => void): this;
  /** One whole video access unit — see {@link LiveVideoFrame}. */
  on(event: "video", listener: (frame: LiveVideoFrame) => void): this;
  /** One audio access unit, in the codec the station declared for it. */
  on(event: "audio", listener: (frame: LiveAudioFrame) => void): this;
  on(event: "start" | "stop", listener: () => void): this;
  /** Why this consumer's stream is over, including a warm-up that never produced a keyframe. */
  on(event: "error", listener: (err: Error) => void): this;
  /** Battery-budget elapsed — extend to keep streaming or let it auto-stop (battery cameras only). */
  on(event: "budget", listener: (notice: StreamBudgetNotice) => void): this;
  /**
   * A media start was repeated to its acknowledgement deadline and abandoned.
   *
   * The start is repeated byte-identically, so an abandonment is many sends with no reply — the device was
   * never told to stream, and a warm-up waiting on it can only time out. Distinct from `error`: the transport
   * is intact and the session is simply not being heard.
   */
  on(event: "unacknowledged", listener: () => void): this;
}

/**
 * What a media call tells the shared pull it may be the one to OPEN.
 *
 * Every egress on a device joins ONE shared pull, and whichever asks for it first is the call that builds
 * it — so these are settings any egress may have to supply, and none can change once consumers are
 * attached. An egress that omits one is not opting out of it; it is leaving the choice to whichever call
 * got there first, which is why every egress accepts them rather than only the ones they read like.
 */
/**
 * How a caller abandons ONE media call, without touching the shared pull other callers hold.
 *
 * Acquiring media can wait a long time before it can succeed or fail: a station has to connect, a level-2
 * key has to be negotiated or given up on, and a camera has to produce a keyframe. Measured at twenty
 * seconds and more on a battery camera.
 *
 * Aborting settles the call with an `AbortError` and gives back whatever it had taken, so a pull nothing
 * else holds is released rather than left running for a caller that has gone. It never disturbs a pull
 * another consumer is attached to: this abandons a call, not a stream.
 *
 * Separate from {@link SharedSourceHints} on purpose. Those describe the pull a call may open and are
 * fixed for everyone who joins it; this belongs to one call and to nobody else.
 */
export interface AbortableCall {
  signal?: AbortSignal;
}

export interface SharedSourceHints {
  /**
   * Power source, a runtime device fact (`"battery"` incl. solar, or `"wired"`) — never a device-family
   * trait. `"wired"` streams unbounded; `"battery"` bounds a continuous stream to a budget, after which
   * the handle's `budget` notice offers an extension.
   */
  powered?: "wired" | "battery";
  /**
   * Seconds of already-captured media the pull retains for a later drain; `0`, absent, non-finite and
   * negative values retain none.
   *
   * Retention costs memory on every frame and only a caller knows whether anything will drain it, so it
   * is never assumed. Media can only be retained while the pull is running, so a window answers "what did
   * the camera capture just before this" only for a pull something already opened.
   */
  preBufferSeconds?: number;
}

/** A local operating-power claim; `auto` returns to the SDK's evidence-based policy. */
export type PowerOverride = "auto" | "always-on" | "battery";

/** Read or replace one device's local operating-power claim without writing to the device. */
export interface PowerOverrideController {
  getOverride(): PowerOverride;
  setOverride(override: PowerOverride): void;
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
   * `width`/`height` describe the RETURNED IMAGE, read back out of it rather than taken from the stream's
   * frame header: the header states the geometry at capture start, and a camera whose stream reconfigures
   * mid-burst leaves it contradicting the bytes — which a caller sizing a buffer or caching by resolution
   * cannot detect short of parsing the JPEG itself.
   *
   * Rejects with {@link LiveSnapshotUnavailableError}, whose {@link LiveSnapshotUnavailableError.retryable}
   * says whether another attempt could succeed.
   *
   * Carries {@link SharedSourceHints} for the reason stated there: a still polled on an idle camera is
   * routinely the call that OPENS the shared pull, so it decides the power budget and the retained window
   * for every egress that joins later.
   */
  snapshotLive(
    opts?: {
      timeoutMs?: number;
      collectMs?: number;
      skipKeyframes?: number;
    } & SharedSourceHints &
      AbortableCall,
  ): Promise<{
    jpeg: Buffer;
    width: number;
    height: number;
    /**
     * Present and `true` only when these bytes are the RETAINED still rather than a fresh capture.
     *
     * A live still is refused while a sibling camera on the same station is being watched, because one
     * session serves one camera at a time, a still does not open a connection of its own, and the live view
     * is the picture someone is looking at. Answering
     * the retained still there answers the call instead of failing it, and this says the bytes are not
     * current. Absent means freshly captured.
     */
    retained?: true;
  }>;
  /**
   * Open a managed live stream.
   *
   * Several cameras behind one station stream at the same time, each over its own connection to it. One
   * connection serves one camera — a station answers the most recent start on a session, so two cameras
   * sharing one take it from each other in turn — so a camera asked for while its station is already
   * serving another gets a connection of its own. Measured on a base carrying two attached cameras, one
   * at 3840x2160: both held full frame rate at once. Each handle receives only the frames the station
   * tagged for ITS camera.
   *
   * @example
   * ```ts
   * const stream = await cam.live?.();
   * stream?.on("video", (frame) => sink.write(frame.data)); // Annex-B
   * stream?.stop(); // detach this consumer
   * ```
   */
  live(opts?: SharedSourceHints & AbortableCall & Record<string, unknown>): Promise<LiveStreamConsumer>;
  /**
   * Record `seconds` of video → an mp4/h264 buffer.
   *
   * Opens its OWN pull rather than joining the shared source, so it costs a second stream on a camera that
   * is already streaming. {@link recordFragments} is a shared consumer like every other egress.
   *
   * Always settles: it resolves once the requested window has elapsed — with the run the camera actually
   * delivered inside it, which a camera that goes quiet mid-clip makes shorter than asked — and rejects when
   * the pull fails or ends before that window is up, or when no keyframe arrives to start the clip at.
   */
  record(seconds: number, opts?: { timeoutMs?: number; skipKeyframes?: number }): Promise<Buffer>;
  /**
   * Open a video-only `node:stream` Readable over a shared source consumer — raw Annex-B bytes
   * (default) or `objectMode` {@link LiveVideoFrame}s. Audio is available separately through
   * {@link live} or muxed through {@link recordFragments}; it is never interleaved into raw video.
   * The caller owns the Readable's lifetime, and destroying it releases the shared pull.
   */
  openReadable?(
    opts?: { objectMode?: boolean } & SharedSourceHints & AbortableCall,
  ): Promise<import("node:stream").Readable>;
  /**
   * Continuously record the live feed as fragmented-MP4 (CMAF). The caller-owned
   * {@link FragmentRecordingHandle} yields an init segment then keyframe-bounded media fragments,
   * emits battery-budget notices, and releases the shared pull on `stop`, `break`, or `return`.
   *
   * {@link SharedSourceHints.preBufferSeconds} does double duty here: it configures the retained window
   * when this call is the one that opens the pull, and it is the length this recording drains from a pull
   * that was already open. The drain opens on the newest keyframe at or before the window starts, so it
   * covers the request and exceeds it by however far back that keyframe sits.
   */
  recordFragments?(opts?: { fragmentSeconds?: number } & SharedSourceHints & AbortableCall): FragmentRecordingHandle;
  /**
   * Open the camera's **talkback** path — audio travelling from the host TO the device, the opposite
   * direction to everything else here. See {@link TalkbackHandle} for the accepted audio. Optional (an
   * unbound model has no client), and absent on a device whose talkback wire is unverified.
   */
  talkback?(opts?: { encoder?: AacEncoder } & SharedSourceHints): Promise<TalkbackHandle>;
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
 * It is unnecessary where the audio is already AAC — see {@link TalkbackHandle}.
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
   * cut the clip to 64 ms. {@link pending} is the instantaneous depth.
   */
  on(event: "finished", listener: () => void): this;
  /**
   * The path closed — either {@link stop} was called, or the media session it rides inside ended and
   * took it with it. It always fires exactly once, so it is a teardown hook rather than a signal that
   * something went wrong.
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
