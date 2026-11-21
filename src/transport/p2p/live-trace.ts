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
import type { LiveStreamStartFailureReason, LiveStreamStartStage } from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";

/** The message every startup trace is logged under. */
export const LIVE_TRACE_MESSAGE = "[live] start trace";

/** One bounded startup observation. */
export type LiveTrace =
  /** A media start was sent, with its outer command and the media-key type it offered. */
  | { phase: "media-command"; cmd: number; key: "ecc" | "rsa" }
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
   *
   * `cloudMissing` names the input the cloud channel lacked, present exactly when `cloud` is false: `dsk-key`
   * where no key was held for the station, `cloud-addresses` where its record named no address to ask. The key
   * is named where both are absent.
   */
  | { phase: "lookup-channels"; local: boolean; cloud: boolean; cloudMissing?: "dsk-key" | "cloud-addresses" }
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
  /** A gateway info's key was set (ECC, or RSA), under the cipher it named. */
  | { phase: "level2-ready"; cipherId: number }
  /**
   * A gateway info's key step ended without a key, why, and the cipher where the station named one:
   * `no-cipher-key` and `derivation-failed` are about this account's cipher material, `gateway-refused` a
   * station that answered with a refusal.
   */
  | {
      phase: "level2-unavailable";
      reason: "no-cipher-key" | "derivation-failed" | "gateway-refused";
      cipherId?: number;
    }
  /**
   * The station answered its gateway-info prompt, so a key derivation has begun under the cipher it named.
   *
   * What separates a station that never answered the prompt from one that answered and produced no usable key.
   * `version` is the gateway info's header version, which picks the key branch: 8 derives on ECC, any other on RSA.
   */
  | { phase: "level2-negotiating"; cipherId: number; version: number }
  /**
   * A station was resolved for a call, stating what the caller's device is on it and whose station it is.
   *
   * Emitted before the session is waited on, so a station that is never reached still has this record. `stationAdmin` states whether the signed-in account is the station's
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
  /** A shared source began warming, with the deadline it fails at. */
  | { phase: "warming"; deadlineMs: number }
  /**
   * This connection's path has stopped answering the heartbeat, with how long it has been silent.
   *
   * The station answers every PING with a PONG, so silence past several heartbeats is the path being gone.
   * Stated only where a pong arrived: a station that has never answered says nothing by not answering now.
   */
  | { phase: "path-stale"; silentMs: number }
  /**
   * A live start failed, with the facts of the `LiveStreamStartError` it was refused with.
   *
   * `errorName` is the upstream error's class name, present for `source-error` only; its message is never
   * carried, because an upstream message can name a station.
   */
  | {
      phase: "start-failed";
      reason: LiveStreamStartFailureReason;
      stage: LiveStreamStartStage;
      errorName?: string;
    };

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
