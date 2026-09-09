import type { Command } from "../../core/contracts.js";
import { asBool, enumLabels } from "../../core/util.js";
import { setJson, setPayload, setScalar } from "./access.js";
import { method, propertiesOf, type Members, type Surface } from "./members.js";
import type { CapabilityModule, CommandContext, DecodedState, InboundSignal } from "./types.js";

/** The state params this capability owns — its OWN vocabulary, used by no other capability. */
export const RTSP_PARAM = {
  /**
   * RTSP publish switch (app `NAS_STREAM_SWITHC`, the vendor's own typo for SWITCH). `1` publishes the
   * camera's stream, `0` withdraws it. ✅ Verified live 2026-08-01 on a HomeBase-attached doorbell and
   * two indoor cameras: written through this param's scalar wire, both directions confirmed by the
   * stream appearing and disappearing on the serving device's RTSP port.
   */
  STREAM_SWITCH: 1145,
  /**
   * The served-livestream switch (app `NAS_TEST_STREAM`) — `1` starts the livestream the publish switch
   * has made available, `0` stops it. The second half of the app's own publish sequence, sent after
   * {@link STREAM_SWITCH} and never instead of it.
   *
   * ✅ Verified live on a standalone camera: `1145=1` followed by `1146=1` is the sequence that elicits
   * the station's URL push on the 1145 wire, and the camera served its endpoint under it. The switch
   * alone has been observed to open the port ({@link STREAM_SWITCH}) but never to report the URL, and
   * the credentials the device is enforcing are reported nowhere else — so a stream a caller can
   * actually address needs both frames.
   */
  TEST_STREAM: 1146,
  /**
   * The camera's authoritative RTSP URL — `rtsp://user:pass@host/path`, with the credentials it is
   * enforcing right now. The station pushes this back on the 1145 wire as a string data frame after the
   * publish switch flips; {@link RTSP.decodeState} lifts it into state, read as `dev.rtsp()?.url`.
   *
   * A SYNTHETIC id: the wire supplies no second id — the URL rides the same 1145 as the publish bool,
   * and {@link STREAM_SWITCH} already owns that — so the string gets its own id here, keeping the two as
   * distinct properties rather than one id read two ways. Never in the cloud record (P2P-notify only), so
   * it is quarantined in `property-id-integrity`'s `KNOWN_UNLISTED` — which otherwise holds real-but-unlisted
   * ids (1612), so its entry for this one says it is not a wire id at all.
   *
   * `1145 * 10` is a readable, currently-free number, NOT a reserved allocation — height buys nothing,
   * the dictionary already holds real ids past 100000. It is the only synthetic id today; if a second is
   * ever needed, reserve a stated band for them rather than copying this per-site choice.
   */
  STREAM_URL: 11450,
  /**
   * RTSP credentials + the authentication switch (app `NAS_SEND_SECURITY_PASSWD`). A `SET_PAYLOAD`
   * (1350) envelope: `{cmd:1287, mChannel:<deviceCh>, mValue3:0, payload:{mode, passwd, username}}`.
   *
   * ✅ Byte-exact against the app's own frame (confirmed 2026-08-03 on a T8425 behind a T8030): the app
   * auto-generates BOTH a username and a password (16 chars each — its "13 char" UI rule is
   * frontend-only; the firmware accepts any length). The app maps `mode` as `0` = open, `1` = Basic,
   * `2` = Digest and offers Basic/Digest but no "open" option. A standalone T8442 was observed serving
   * a Digest challenge. A HomeBase-attached T8210 echoed freshly supplied Basic credentials in its URL,
   * confirming storage, while unauthenticated `DESCRIBE` remained 200 with no challenge.
   */
  SEND_SECURITY_PASSWD: 1287,
  /**
   * What the NAS records (app `NAS_VIDEO_TYPE_EVENT`): events only or continuously. The readable half
   * of the app's two-frame recording-mode pair (6050 + 6010). ✅ Write verified live on a T8030 by
   * param readback (0 → 1 → 0).
   */
  VIDEO_TYPE_EVENT: 6050,
  /** Second frame of the recording-mode pair — see {@link VIDEO_TYPE_EVENT}. Sent with it, never alone. */
  VIDEO_TYPE_CONTINUE: 6010,
} as const;

/**
 * The RTSP authentication scheme a caller can require. Maps to the credential write's `mode` field.
 *
 * - `"digest"` — request a hashed nonce challenge, observed on a standalone camera. The reader does
 *   not send the plaintext password during RTSP authentication, though configuration still sends it
 *   to the device. The safer choice, and the app's default.
 * - `"basic"` — request Basic authentication, where the reader sends the password base64-encoded on
 *   every request (encoding, not encryption). Offered for players that only speak Basic.
 */
export type RtspAuthScheme = "digest" | "basic";

/**
 * `mode` on the credential write — the app's authentication request: `0` = open, `1` = Basic, `2` =
 * Digest. The app sends `2` by default and exposes Basic/Digest in its UI but no "open" option. Served
 * enforcement is topology-dependent; see {@link RtspActions}.
 */
const AUTH_MODE = { off: 0, basic: 1, digest: 2 } as const;

/**
 * What the NAS records. `Events` stores clips around a detection; `Continuous` records without
 * stopping.
 */
export const RtspRecordingMode = {
  /** Record only around detections. */
  Events: 0,
  /** Record continuously. */
  Continuous: 1,
} as const;
/** A NAS recording mode — the value side of {@link RtspRecordingMode}. */
export type RtspRecordingModeValue = (typeof RtspRecordingMode)[keyof typeof RtspRecordingMode];

/**
 * Bound RTSP controls — the object returned by `dev.rtsp()`.
 *
 * This is the vendor's NAS/RTSP feature: publish a camera's stream so a NAS/NVR (or the HomeBase
 * itself) can record it. Two things a caller must know, because neither is expressible in the wire:
 *
 * - **A station publishes for ONE attached camera at a time.** Enabling a second withdraws the first,
 *   silently — the station tracks a single camera, not a set. The SDK cannot detect or prevent this;
 *   a caller driving several cameras owns the arbitration.
 * - **Publication is a persistent device setting, not an SDK-owned media session.** An RTSP consumer
 *   connects directly to the serving device; the SDK does not observe consumer disconnects and does
 *   not withdraw in response. The caller that publishes owns calling `withdraw()` when its recorder is
 *   done. The SDK deliberately applies no live-media power budget: on a device with the `battery`
 *   capability, leaving RTSP published will drain the cell, so the feature suits mains-powered cameras
 *   feeding a recorder.
 *
 * Publishing is TWO frames, and `publish()` sends both: the persistent NAS setting (1145) and the
 * served-livestream switch (1146) that starts the livestream and makes the device report its URL. The
 * setting alone can leave a device serving an endpoint whose credentials are reported nowhere, which a
 * caller cannot address. Writing the `rtspStream` property sends only the first; `startStream()` is the
 * second on its own.
 *
 * The stream itself is served over plain RTSP on the local network, by the station for a
 * HomeBase-attached camera or by the camera itself when standalone. A standalone camera has been
 * observed serving a Digest challenge. A tested HomeBase-attached camera echoed freshly supplied Basic
 * credentials in its URL but stayed open without them. Verify storage from the device-reported URL
 * and the served effect on each endpoint with an RTSP `DESCRIBE`: 401 = challenged, 200 = open.
 */
export type RtspActions = Surface<typeof RTSP_MEMBERS>;

/** The RTSP publish switch, both directions — a plain scalar, verified live on both topologies. */
function publishCommand(on: boolean, ctx: CommandContext): Command {
  return setScalar(RTSP_PARAM.STREAM_SWITCH, on ? 1 : 0, ctx);
}

/**
 * The served-livestream switch, both directions — the same plain scalar wire as the publish switch, on
 * {@link RTSP_PARAM.TEST_STREAM}. Sent `"auto"` so the ONE level decision applies: a keyed HomeBase
 * seals it at level 2, a standalone camera at level 1.
 */
function streamCommand(on: boolean, ctx: CommandContext): Command {
  return setScalar(RTSP_PARAM.TEST_STREAM, on ? 1 : 0, ctx);
}

/**
 * The credentials frame. `mValue3` is 0, byte-exact with the app's own frame (captured live 2026-08-03
 * on a T8425 behind a T8030): `{cmd:1287, mChannel:<deviceCh>, mValue3:0, payload:{mode,passwd,username}}`.
 * Passing 0 explicitly overrides the transport's `mValue3 ?? cmd` default, which would send 1287.
 */
function credentialsCommand(mode: number, username: string, password: string, ctx: CommandContext): Command {
  return setPayload(RTSP_PARAM.SEND_SECURITY_PASSWD, { mode, username, passwd: password }, ctx, 0, undefined, "auto");
}

/**
 * Every `rtsp` feature, declared once.
 *
 * `setRecordingMode` is a `method`, not a derived setter, because ONE UI change is TWO frames on
 * the wire — the app sends 6050 then 6010, and sending only the first leaves the continuous recorder out
 * of step with the advertised type. A member's `write` returns a single command, so the pair cannot be
 * expressed as one.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const RTSP_MEMBERS = {
  /**
   * This is DEVICE STATE — "whether the stream is published over RTSP" — not a record of who turned it
   * on. So it reads true from more than a caller's own `publish()`: {@link RTSP.decodeState} sets it from
   * the station's URL push (which proves the stream is up) and the cloud poll reports it too. A caller
   * that needs "did *I* turn it on" tracks its own `publish()` call rather than reading this back.
   *
   * `provenance` is name-trust: the name is the app's own typo'd constant (`NAS_STREAM_SWITHC`), so it
   * is "apk". The verified live WRITE — both directions, HomeBase and standalone — is in the description.
   */
  published: {
    param: RTSP_PARAM.STREAM_SWITCH,
    property: "rtspStream",
    type: "bool",
    kind: "boolean",
    provenance: "apk",
    description:
      "Whether this camera's stream is published over RTSP (1145 NAS_STREAM_SWITHC). Name from the " +
      "apk; the WRITE is verified live on a HomeBase-attached doorbell and two indoor cameras, both " +
      "directions (DESCRIBE 404→200 with a real SDP, and back).",
    write: (v, ctx) => publishCommand(asBool(v), ctx),
    aliases: { publish: true, withdraw: false },
  },
  /**
   * The device-reported RTSP URL — the full `rtsp://user:pass@host/path`, carrying the credentials the
   * device enforces RIGHT NOW. This is the only source of the freshly-generated pair: the credentials
   * regenerate on every publish toggle and the cloud record lags a cycle, so an assembled URL or an
   * imposed one would not match what the device is enforcing.
   *
   * The flat property name is `rtspUrl`, not `url`: property names are a FLAT namespace shared across
   * every capability (`getProperty`/`setProperty`/`propertyChanged` key on the bare string), so the
   * generic `url` would claim that word SDK-wide. The fluent read stays `dev.rtsp()?.url` — the member
   * key qualifies it there.
   *
   * **What provokes it.** The served-livestream switch ({@link RTSP_PARAM.TEST_STREAM}), not the publish
   * switch alone: the one live capture that produced a URL sent `1145=1` then `1146=1`, and the publish
   * switch has never been observed to elicit a push on its own. {@link publish} and {@link startStream}
   * both send the livestream frame, so either populates this; writing the `rtspStream` property sends
   * only the setting, and no URL follows.
   *
   * `provenance` below is `verified` for the VALUE and its frame — not for the id: {@link STREAM_URL}
   * is synthetic and the wire never reports it, so no capture could have "verified" the id itself.
   *
   * Arrives ONLY over the P2P notify wire and never in the cloud record, so it is absent until a push
   * lands and then reads back like any other state. Read-only: the device reports it, a caller does not
   * set it. Lifted from the frame by {@link RTSP.decodeState}.
   */
  url: {
    param: RTSP_PARAM.STREAM_URL,
    property: "rtspUrl",
    type: "string",
    kind: "text",
    // `verified` describes the value and its frame (observed live), not the synthetic id — see the note above.
    provenance: "verified",
    description:
      "The device-reported rtsp://user:pass@host/path, with the credentials the device currently " +
      "enforces. P2P-notify only (pushed on the 1145 wire once published); absent until a push lands.",
  },
  /**
   * The READ half of a control written by `setRecordingMode` below, hence `writtenElsewhere` — one UI
   * change is TWO frames on the wire (6050 then 6010) and a member's `write` returns a single command,
   * so the pair cannot be a derived setter. 6050 is the half the device reports back, which is why the
   * member hangs off that id and not its silent partner.
   */
  recordingMode: {
    param: RTSP_PARAM.VIDEO_TYPE_EVENT,
    type: "enum",
    kind: "enum",
    enumValues: enumLabels(RtspRecordingMode),
    provenance: "apk",
    writtenElsewhere: true,
    description:
      "What the NAS records: 0 = events only, 1 = continuous (6050 NAS_VIDEO_TYPE_EVENT). The app " +
      "sends a PAIR of 1700-wrapped frames (6050 + 6010) for one change; setRecordingMode sends both. " +
      "6050 is the readable half. Name from the apk; the WRITE is verified live on a T8030 by param " +
      "readback (0 → 1 → 0).",
  },

  /**
   * Persistently publish this camera's stream AND start the livestream serving it — the NAS setting
   * ({@link RTSP_PARAM.STREAM_SWITCH}) followed by the served-livestream switch
   * ({@link RTSP_PARAM.TEST_STREAM}), in that order, which is the app's own sequence and the only one
   * observed to make a device report its URL. Both frames, not just the setting: the setting alone
   * reports `published` true while {@link RTSP_MEMBERS.url} stays absent, and the credentials in that
   * URL are reported nowhere else.
   *
   * The enabling caller owns withdrawing it when done.
   */
  publish: method(
    ({ ctx, sink }) =>
      async (): Promise<void> => {
        await sink.dispatch(publishCommand(true, ctx));
        await sink.dispatch(streamCommand(true, ctx));
      },
    "Publish the stream.",
  ),
  /**
   * Stop serving this camera's stream and withdraw its publication — the reverse of {@link publish},
   * stopping the livestream before clearing the setting. Consumer retries do not ask the SDK to
   * republish it.
   */
  withdraw: method(
    ({ ctx, sink }) =>
      async (): Promise<void> => {
        await sink.dispatch(streamCommand(false, ctx));
        await sink.dispatch(publishCommand(false, ctx));
      },
    "Withdraw the stream.",
  ),

  /**
   * Start serving the stream WITHOUT touching the persistent NAS setting — the second half of
   * {@link publish} on its own, for a camera whose setting is already on and whose endpoint should come
   * and go with a recorder. Answers nothing: the served URL arrives on the realtime wire and reads back
   * as {@link RTSP_MEMBERS.url} shortly after.
   *
   * A device whose publish switch is off does not serve from this alone — {@link publish} is what
   * establishes both.
   */
  startStream: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        sink.dispatch(streamCommand(true, ctx)),
    "Start serving the published stream.",
  ),
  /** Stop serving the stream while leaving the persistent NAS setting on — the dual of {@link startStream}. */
  stopStream: method(
    ({ ctx, sink }) =>
      (): Promise<void> =>
        sink.dispatch(streamCommand(false, ctx)),
    "Stop serving the stream, leaving it published.",
  ),

  /**
   * Store credentials and request authentication on this camera's stream. Served enforcement is
   * topology-dependent and must be verified with `DESCRIBE` (401 = challenged, 200 = open).
   *
   * `scheme` defaults to `"digest"` (a hashed nonce challenge and the app's own default). The reader
   * does not send the plaintext password during Digest authentication, though this configuration write
   * still sends it to the device. Pass `"basic"` only for a player that can't do Digest: Basic sends
   * the password base64-encoded on every request, readable by anyone on the LAN.
   *
   * The write stores credentials on both topologies, but a tested HomeBase-attached endpoint did not
   * enforce the requested mode. Verify storage from the device-reported URL, which embeds the
   * credentials, and enforcement with a `DESCRIBE` (401 = challenged, 200 = open).
   */
  requireAuth: method(
    ({ ctx, sink }) =>
      (username: string, password: string, scheme: RtspAuthScheme = "digest"): Promise<void> =>
        sink.dispatch(
          credentialsCommand(scheme === "basic" ? AUTH_MODE.basic : AUTH_MODE.digest, username, password, ctx),
        ),
    "Store credentials and request authentication; verify the served endpoint.",
  ),
  /** Store an anonymous-mode request while keeping the supplied credentials. */
  allowAnonymous: method(
    ({ ctx, sink }) =>
      (username: string, password: string): Promise<void> =>
        sink.dispatch(credentialsCommand(AUTH_MODE.off, username, password, ctx)),
    "Store an anonymous-mode request.",
  ),

  /**
   * Set what the NAS records — events only, or continuously. Sends the app's two-frame pair in one call.
   * Present only when this camera reports the recording-mode state, mirroring the publish switch's own
   * evidence gate.
   *
   * On a battery-powered camera, `Continuous` keeps the stream up and will flatten the battery far
   * faster than event recording — the app only offers it for wired/HomeBase-attached cameras.
   */
  setRecordingMode: method(
    ({ ctx, sink }) =>
      async (mode: RtspRecordingModeValue | number): Promise<void> => {
        const v = Number(mode);
        if (v !== RtspRecordingMode.Events && v !== RtspRecordingMode.Continuous) {
          throw new Error(`rtsp: recordingMode ${JSON.stringify(mode)} must be 0 (events) or 1 (continuous)`);
        }
        await sink.dispatch(setJson(RTSP_PARAM.VIDEO_TYPE_EVENT, { value: v }, ctx));
        await sink.dispatch(
          setJson(
            RTSP_PARAM.VIDEO_TYPE_CONTINUE,
            {
              enable: v,
              index: 0,
              status: 0,
              type: 0,
              value: 0,
              voiceID: 0,
              zonecount: 0,
              transaction: Math.floor(Math.random() * 1e7) + 1,
            },
            ctx,
          ),
        );
      },
    "Set what the NAS records: events only, or continuously.",
    (ctx) => ctx.paramIds.has(RTSP_PARAM.VIDEO_TYPE_EVENT),
  ),
} as const satisfies Members;

/**
 * `rtsp` — publish a camera's stream over RTSP for a NAS/NVR to record.
 *
 * Detection is evidence-only: a device advertises param 1145 or it does not get the accessor. The
 * vendor app gates the setting to a subset of models, but that gate is CLIENT-side — a model whose app
 * never shows the toggle still accepts the write, which is why detection keys off the reported param
 * rather than a model table.
 */
export const RTSP: CapabilityModule = {
  capability: "rtsp",
  description:
    "Publish a camera's stream over RTSP on the local network for a NAS/NVR to record. One camera " +
    "at a time per station; a published stream encodes continuously.",
  members: RTSP_MEMBERS,
  properties: propertiesOf(RTSP_MEMBERS),
  detection: { evidenceParams: [RTSP_PARAM.STREAM_SWITCH] },
  /**
   * Lift the camera's authoritative RTSP URL out of the station's push into state.
   *
   * The station answers the served-livestream switch (1146) by pushing the PUBLISH command id (1145)
   * back as a data frame whose string payload is the full `rtsp://user:pass@host/path`. That is a bare
   * string rather than the `params` array the transport unwraps generically, so without this the URL is announced on the wire
   * and never reaches the {@link RTSP_MEMBERS.url} getter. It is surfaced under {@link RTSP_PARAM.STREAM_URL}
   * — its own synthetic id, since 1145 is the publish bool's.
   *
   * The push ALSO proves the stream is published, so 1145 is set true from it — the device stating its
   * own state, which is the best evidence of `published` the wire offers and reaches the getter a poll
   * sooner. See {@link RTSP_MEMBERS.published}: it is device state, not "did I turn it on" — a caller
   * that needs the latter tracks its own `publish()` call.
   *
   * The channel demux and the capability gate are the caller's (`capabilitiesForFrame` /
   * `serialForFrame`): this runs only for a device that has the `rtsp` capability, on its own channel.
   */
  decodeState(signal: InboundSignal): DecodedState | null {
    if (signal.source !== "p2p-frame" || signal.commandId !== RTSP_PARAM.STREAM_SWITCH || !signal.data) return null;
    const text = signal.data.toString("latin1");
    const end = text.indexOf("\0");
    const url = end >= 0 ? text.slice(0, end) : text;
    return url.startsWith("rtsp://")
      ? { params: { [RTSP_PARAM.STREAM_SWITCH]: "1", [RTSP_PARAM.STREAM_URL]: url } }
      : null;
  },
};
