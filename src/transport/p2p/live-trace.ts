/**
 * Bounded, identity-free live-startup diagnostics.
 *
 * A live start spans two modules — the session issues the media command and reassembles datagrams, the
 * stream turns accepted frames into access units — so the message and its phase vocabulary have one owner
 * here rather than a literal repeated at each call site. A caller reads these to tell one startup outcome
 * from another, and matches on {@link LIVE_TRACE_MESSAGE} plus a {@link LiveTrace} phase to do it.
 *
 * Every field is a fixed label, a boolean, a data-type id, or a sign code. No serial, P2P identifier,
 * address, account id, key material, or media byte is carried, so the records are safe in a host's log.
 *
 * @module p2p/live-trace
 */
import type { Logger } from "../../core/logger.js";

/** The message every startup trace is logged under. */
export const LIVE_TRACE_MESSAGE = "[live] start trace";

/** One bounded startup observation. */
export type LiveTrace =
  /** A media start or keepalive was sent, with the topology and encryption level it was sent under. */
  | { phase: "media-command"; topology: "attached" | "own"; action: "start" | "keepalive"; level2: boolean }
  /** The device acknowledged a retained start, or that start was repeated / abandoned unacknowledged. */
  | { phase: "media-command-ack" | "media-command-retry" | "media-command-unacknowledged"; action: "start" }
  /** The first inbound video command, and whether this stream's channel filter accepted it. */
  | { phase: "first-video-command"; signCode: number; accepted: boolean }
  /** The first reassembled video access unit, and whether it was decodable on its own. */
  | { phase: "first-video-unit"; keyframe: boolean }
  /** The first keyframe reached the consumer. */
  | { phase: "first-keyframe" }
  /** Media tagged for another camera on the same station arrived first. */
  | { phase: "first-foreign-media-command"; media: "audio" | "video" }
  /** A video payload decoded to nothing, so no access unit could be built from it. */
  | { phase: "video-decode-empty"; signCode: number }
  /** A datagram was missing on a data channel, discarding the logical frame being reassembled. */
  | { phase: "datagram-gap"; dataType: number }
  /** A data channel's numbering restarted mid-connection, so sequencing resynchronized onto it. */
  | { phase: "sequence-restart"; dataType: number }
  /**
   * Which lookup channels a connection can ask for the station on, before it asks.
   *
   * A station is found by a local lookup, by a cloud lookup, or by both, and each needs something the other
   * does not: the local one needs the station on this link, the cloud one needs both a key for the station and
   * an address to ask. A connect that had one channel failed for that channel's reason alone, and a connect
   * that had neither could not have succeeded — outcomes a station that is switched off is otherwise
   * indistinguishable from, because nothing else in a failed connect states what was even attempted.
   */
  | { phase: "lookup-channels"; local: boolean; cloud: boolean }
  /**
   * Work on a station is holding for its session to connect, with the milliseconds it will wait.
   *
   * The earliest phase there is: nothing else on a station can be attempted until its session is up, and a
   * caller whose own deadline expires inside this wait has this record and no other. Emitted only where a wait
   * actually happens, so its absence states that the session was already connected.
   */
  | { phase: "session-connect-wait"; waitMs: number }
  /** The session connected, after this long. */
  | { phase: "session-connected"; waitedMs: number }
  /**
   * The session did not connect within its wait, so nothing on this station can be attempted.
   *
   * The one outcome that is otherwise indistinguishable from a station that answered and then refused: both
   * leave a caller with no media and no phase naming a station.
   */
  | { phase: "session-unreachable"; waitedMs: number }
  /**
   * A live start is holding for the station's level-2 key, with the milliseconds it will wait.
   *
   * A start that looks slow is either waiting here, waiting for its session to connect, waiting for the station
   * to serve the channel it was asked for, or being re-issued — and only these phases separate them.
   */
  | { phase: "level2-wait"; waitMs: number }
  /** The station's level-2 key was negotiated, under the cipher it selected. */
  | { phase: "level2-ready"; cipherId: number }
  /**
   * The station's key is not coming, why, and the cipher where a station named one.
   *
   * Every ending of a level-2 wait carries one of these reasons, so a start refused for want of a key is
   * accounted for however it ended. `grace-elapsed` is a wait that ran out and states how long was waited;
   * the rest are answered without waiting, because the negotiation is one-shot per connection and a
   * concluded one is final. `no-cipher-key` and `derivation-failed` are about this account's cipher
   * material, `not-negotiating` and `session-closed` about the station or its connection — and only a
   * reason reached under a negotiation has a cipher to name.
   *
   * A `grace-elapsed` start proceeds at level 1 where it has such a form, and not at all where it does not.
   */
  | {
      phase: "level2-unavailable";
      reason: "no-cipher-key" | "derivation-failed" | "not-negotiating" | "session-closed" | "grace-elapsed";
      cipherId?: number;
      waitedMs?: number;
    }
  /**
   * A station's cipher was answered with material for a DIFFERENT cipher, which was used in its place.
   *
   * The one lookup outcome no other phase accounts for: material for the cipher the station named is followed
   * by `level2-ready` or by `level2-unavailable` with `derivation-failed`, an answer holding none by
   * `no-cipher-key`, and a lookup that threw is reported as an error. Substituted material derives to
   * nothing and otherwise reads as a station fault. `cipherId` is the cipher the station asked for,
   * `answeredCipherId` the one whose material was used.
   */
  | { phase: "cipher-fallback"; cipherId: number; answeredCipherId: number }
  /**
   * The station answered its gateway-info prompt, so a key derivation has begun under the cipher it named.
   *
   * What separates a station that never answered the prompt from one that answered and produced no usable key:
   * without it, `level2-unavailable` with `not-negotiating` covers both, and they are a station or network
   * problem and an account cipher-material problem respectively.
   */
  | { phase: "level2-negotiating"; cipherId: number }
  /**
   * A station was resolved for a call, stating what the caller's device is on it and whose station it is.
   *
   * Emitted before the session is waited on, so a station that is never reached still has this record: an
   * attached camera's media start has no unencrypted form, so whether a device was taken as attached decides
   * what its failure means. `stationAdmin` states whether the signed-in account is the station's
   * administrator, which is what a key the account cannot resolve turns on; `unstated` is a device record
   * that names no administrator, which is not the same as naming another. `stationModel` is the model of the
   * station the call resolved — the base's for an attached camera, the device's own where it is its own
   * station — absent where that record states none; without it a base this SDK reaches differently is
   * indistinguishable from one that is switched off.
   */
  | {
      phase: "station-resolved";
      topology: "attached" | "own";
      channel: number;
      stationAdmin: "self" | "other" | "unstated";
      stationModel?: string;
    }
  /**
   * The call's device has no usable channel on the station it resolved: its record states none (`missing`), or
   * another device attached to the same station states the same one (`shared`). The call is refused with
   * `DeviceChannelUnresolvedError` and nothing is sent.
   */
  | { phase: "station-channel-unresolved"; issue: "missing" | "shared" }
  /** A shared source began warming, with the interval it re-issues on and the deadline it fails at. */
  | { phase: "warming"; retryMs: number; deadlineMs: number }
  /**
   * A media command was never put on the wire, and what it was missing.
   *
   * The attached media start has no level-1 form, so without the station's level-2 key there is nothing to
   * send. A command that was never sent is otherwise indistinguishable from one the station ignored, which is
   * the difference between a key that never arrived and a station that is not answering.
   */
  | { phase: "media-command-unsent"; reason: "level2-key" | "address" }
  /**
   * This connection's path has stopped answering the heartbeat, with how long it has been silent.
   *
   * The station answers every PING with a PONG, so silence past several heartbeats is the path being gone.
   * Stated only where a pong arrived: a station that has never answered says nothing by not answering now.
   */
  | { phase: "path-stale"; silentMs: number }
  /**
   * A stream received nothing on its own channel for the stall window, and what was done about it.
   *
   * A station that switches to a sibling leaves the stream it was serving with no frames, no error and no
   * stop, so this silence is the only statement that it happened. `reasserted` re-issued the media start,
   * which is the repair; `declined` left the channel alone because nothing is attached to this pull and
   * taking the station back would take it from a camera someone is watching.
   *
   * Media still arriving means this never fires, so a picture that stopped advancing while this is silent
   * stopped for a reason upstream of the station's attention.
   */
  | { phase: "channel-silent"; silentMs: number; outcome: "reasserted" | "declined" };

/**
 * Record one startup observation at debug level.
 *
 * `source` states which pull the record belongs to, as an OPAQUE per-process handle — never a serial, a
 * channel or an address. A phase says what happened and nothing about where, so four cameras warming off one
 * HomeBase produce four indistinguishable records; the handle groups them without naming anything, cannot be
 * resolved to a device by whoever reads it, and means nothing in the next run. That is what keeps these
 * records retainable.
 */
export function traceLiveStart(logger: Logger, trace: LiveTrace, source?: string): void {
  logger.debug(LIVE_TRACE_MESSAGE, source === undefined ? trace : { ...trace, source });
}
