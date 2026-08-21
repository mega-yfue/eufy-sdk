/**
 * Public type surface of the {@link EufyMega} facade — options + the typed event map.
 *
 * Kept separate from the class so the event contract reads on its own. The declaration-merged
 * `interface EufyMega` (the typed on/once/off/emit overloads) stays in `eufy-mega.ts` next to the
 * class — TS declaration merging requires both in the same module.
 */
import type { MegaClientConfig } from "../transport/http/mega-client.js";
import type { FcmStore } from "../transport/push/store.js";
import type { FfmpegLevel } from "../transport/ffmpeg.js";
import type { DeviceEventMap } from "../model/capabilities/index.js";
import type { Capability } from "../model/index.js";
import type { P2PFrame } from "../transport/p2p/p2p-session.js";
import type { PushEvent, RawPushMessage } from "../transport/push/types.js";
import type { AvailabilityObservation, EufyDevice, RealtimeMessage } from "../core/types.js";

/** Count-only startup status for one auto-managed realtime transport plane. */
export interface RealtimePlaneReadiness {
  /** Number of transport starts selected for the plane. */
  readonly required: number;
  /** Number of selected starts that completed successfully. */
  readonly ready: number;
  /** Number of selected starts that failed. */
  readonly failed: number;
  /** Number of selected starts that have not settled. */
  readonly pending: number;
}

/**
 * Count-only status of the current auto-managed realtime generation.
 *
 * The summary intentionally carries no credentials, identifiers, or underlying errors. Transport
 * failures continue to surface through the `error` event.
 */
export interface RealtimeReadiness {
  /** Outcome of the generation or of this caller's bounded wait. */
  readonly state: "ready" | "partial" | "disabled" | "superseded" | "timed-out";
  /** Account-wide FCM push startup status. */
  readonly push: RealtimePlaneReadiness;
  /** Secure-MQTT credential-scope startup status. */
  readonly mqtt: RealtimePlaneReadiness;
  /** Persistent station-control P2P startup status for wired stations. */
  readonly wiredP2p: RealtimePlaneReadiness;
}

/** Options for {@link EufyMega.waitForRealtime}. */
export interface WaitForRealtimeOptions {
  /**
   * Maximum time in milliseconds for this caller to wait. Expiry does not cancel background startup;
   * a later call can observe the generation's final result.
   */
  timeoutMs?: number;
}

export interface EufyMegaOptions extends MegaClientConfig {
  /** Persist FCM push credentials + seen ids across runs (default: in-memory). */
  pushStore?: FcmStore;
  /** Eagerly retain validated push thumbnails in memory for `camera.snapshotStored()` (default `true`). */
  storedSnapshotCache?: boolean;
  /**
   * LAN address overrides for direct P2P, keyed by **parent-station serial** → `host` or `host:port`.
   * The SDK normally derives a station's LAN address from its device record; supply this when the
   * record's IP is wrong/blocked (AP isolation, a stale `ip_addr`) and you know the real LAN address.
   */
  localAddresses?: Record<string, string>;
  /**
   * Auto-manage connectivity (default `true`). When on, a successful {@link EufyMega.login} brings up
   * the always-on event channels itself — FCM push + secure MQTT (if the account has appliances) — and
   * eagerly warms P2P only for **wired** stations (HomeBases / mains cameras). Battery cameras stay
   * detached until a command / stream / event pre-warm needs them, and idle-detach afterwards. The host
   * calls no `connect*` — connectivity is transport-agnostic. Set `false` to manage nothing
   * automatically (advanced/testing).
   */
  autoRealtime?: boolean;
  /**
   * Read-through cache freshness window in ms (default 15000). A `getProperty`/`getProperties` read of
   * a value older than this schedules ONE coalesced background refresh and returns the last-known value
   * immediately; realtime (push/P2P) updates keep values fresh so a live device rarely refetches.
   */
  cacheTtlMs?: number;
  /**
   * How long {@link EufyMega.getDevice} waits (ms, default `4000`) for a device whose state exists ONLY
   * on its realtime wire to make its first report, before resolving it.
   *
   * Such a device has no pollable cloud state, and the typed read getters are gated on what it has
   * actually reported — so one resolved before its first report has no readable state, and no later
   * report can add the getters to it. A short wait buys a populated read surface. `0` disables the wait
   * and accepts that reads appear only on a `Device` fetched after the first report. Devices with a
   * cloud record never wait.
   */
  stateSnapshotMs?: number;
  /**
   * Idle window in ms before an on-demand P2P session to a **battery** station is closed so the device
   * can sleep (default 300000 = 5 min). Wired stations stay persistent.
   */
  p2pIdleMs?: number;
  /**
   * Speculative pre-warm window in ms after a high-intent event (default 28000). On a doorbell ring the
   * SDK opens the camera's P2P session so a tap-to-view / talkback starts instantly; if nothing attaches
   * within the window the session idle-detaches.
   */
  prewarmMs?: number;
  /**
   * How often to re-read the cloud device list and emit a semantic event for each param that changed
   * (default 600000 = 10 min). Set `0` to disable polling entirely.
   *
   * The default is paced to the data rather than to a host's refresh appetite — see
   * the device's `params` for how slowly the cloud actually refreshes them. Polling faster costs
   * requests without seeing anything sooner.
   *
   * This channel carries the slow-moving state that has no push of its own (a battery level; a sensor
   * that only reports to the cloud). Fast state — motion, doorbell, contact, lock — arrives over
   * push/P2P/MQTT and is unaffected by this setting.
   */
  pollMs?: number;
  /**
   * Which semantic events pre-warm P2P — typed to the semantic event names ({@link DeviceEventMap}
   * keys), so the list autocompletes and a typo won't compile. Default: `["doorbellPress",
   * "personDetected", "petDetection", "packageDelivered"]` — a doorbell ring plus the high-intent AI
   * detections (human / animal / object), all rare + likely to prompt a look. Raw `motion` is
   * deliberately NOT a default (a battery camera sees it constantly, which would defeat the
   * idle-detach); add it only for a wired camera. Set your own list to override.
   */
  prewarmEvents?: (keyof DeviceEventMap)[];
  /**
   * ffmpeg's own `-loglevel` for the media paths that shell out to it (live snapshot / record / WebRTC
   * container). Default `"error"` (quiet). Raise it (e.g. `"trace"`) to diagnose a failing decode/mux;
   * ffmpeg's stderr is then forwarded to the {@link EufyMegaOptions.logger} as `[ffmpeg]` debug lines
   * — so you also need a `logger` that shows `debug`. Independent of the SDK's own log level.
   */
  ffmpegLogLevel?: FfmpegLevel;
  /**
   * Opt into unverified Tuya DP writes for `eufy_home_tuya` clean-line devices (G-series / X8).
   *
   * By default `TuyaCommandRouter` refuses to send `dp.publish` because the request shape
   * has been reversed but not yet confirmed from a live on-device capture — a wrong shape comes back
   * as a generic Tuya error indistinguishable from an actual device rejection. Set `true` only once
   * you have confirmed the full round-trip on a real device, or have accepted that ambiguity.
   */
  tuyaAllowUnverified?: boolean;
  /**
   * The `ffmpeg` executable the media paths that shell out should run (live snapshot / record / WebRTC
   * container). Default: the bare name `"ffmpeg"`, looked up on `PATH`.
   *
   * Set it when the host ships or manages its own build — an absolute path is resolved without any
   * `PATH` lookup, so those paths work on a host that has no system ffmpeg at all. The SDK never
   * edits `process.env.PATH`; naming the binary here is the supported way to point it at one. The
   * path is not probed, so a wrong one surfaces as the media call's own "not runnable" rejection.
   */
  ffmpegPath?: string;
}

/**
 * What the SDK can honestly say about a device's liveness at one instant — the facts, never a verdict.
 *
 * There is deliberately **no `online: boolean`**. "Unreachable" is a threshold decision, and the right
 * threshold differs per device: a mains camera reports constantly, while a battery contact sensor can
 * be silent for days by design and is perfectly healthy. Baking one timeout into the SDK would force
 * that choice on every host. The SDK reports when the device last spoke; the caller decides what that
 * means — the same split as the snapshot cache TTL and the live power budget.
 *
 * P2P session state is **not** a liveness signal and is not carried here: sessions are opened only
 * when something needs one and closed when idle, so "no session" is the resting state of a healthy
 * device. Transport visibility lives on `getP2pSessions()` and the `p2pConnect`/`p2pClose` events,
 * station-scoped like the session itself.
 *
 * The cloud record carries no connectivity field either: it has no `status` / `device_online`, and the
 * connection-related fields it does carry are opaque routing strings, not booleans.
 */
export interface DeviceState {
  sn: string;
  /** The parent station whose P2P session covers this device (itself, when standalone). */
  stationSn: string;
  /**
   * When the device last reported to the cloud, in ms. Bounded by
   * the cloud's own slow refresh — minutes, not seconds — so it answers "is this device alive at all",
   * not "what is it doing right now".
   */
  lastSeenMs?: number;
}

/**
 * A single semantic event tagged with its name — the payload of the catch-all `"event"` listener.
 * A discriminated union over {@link DeviceEventMap}, so switching on `e.eventName` narrows `e` to that
 * event's payload. Lets a consumer fan every device event to one bus/handler without registering a
 * listener per name (`eufy.on("event", e => bus.emit(e.eventName, e))`).
 *
 * The tag is `eventName`, not `name`: an event payload may legitimately carry its own `name` field, and
 * overwriting it to tag the event would destroy data. Matches the `eventName` carried on a push event.
 */
export type AnyDeviceEvent = {
  [K in keyof DeviceEventMap]: DeviceEventMap[K] & { eventName: K };
}[keyof DeviceEventMap];

/**
 * The complete typed event surface of {@link EufyMega} — event name → listener-argument tuple.
 *
 * Two groups:
 *  - **Semantic events** (motion, doorbellPress, lockState, ptzNotify, …) — projected from the
 *    capability modules via {@link DeviceEventMap}, so adding a capability event adds a typed event
 *    here automatically (one line in that map).
 *  - **Low-level / lifecycle events** — the raw escape hatches and transport lifecycle.
 */
export type EufyMegaEventMap = {
  [K in keyof DeviceEventMap]: [DeviceEventMap[K]];
} & {
  /** Catch-all: fires for EVERY semantic event, payload tagged with its `eventName`. */
  event: [AnyDeviceEvent];
  /**
   * A device appeared on the account since the previous poll — a pairing, or a device that became
   * visible again. Account topology, so it lives here rather than on the per-device capability map.
   *
   * Fires only for a device the SDK has seen the account WITHOUT; the first enumeration after login is
   * not a stream of additions. Suppressed when the baseline it would be measured against only partly
   * resolved, so a recovering outage doesn't read as a burst of pairings.
   */
  deviceAdded: [device: EufyDevice];
  /**
   * A device is gone from the account — unpaired, or moved away.
   *
   * Deliberately conservative: suppressed when a poll only partially resolved (a failed house query
   * returns a subset), because a host acting on this typically deletes an accessory, and an absence
   * caused by an outage is not a removal.
   */
  deviceRemoved: [device: EufyDevice];
  /**
   * A device a caller is holding gained capabilities, because it reported evidence it hadn't before.
   * `gained` is what is newly available; `capabilities` is the full set after widening.
   *
   * A `Device` resolves its capabilities from the evidence available at the time, so one resolved
   * before the device had reported a param lacks the capability that param proves. When a later poll
   * supplies it, the object is re-resolved and re-bound in place — the new accessor is live on the
   * instance the host already has. Capabilities are never retracted, so this only ever widens.
   */
  deviceCapabilities: [info: { deviceSn: string; gained: Capability[]; capabilities: Capability[] }];
  // MQTT realtime lifecycle + raw message.
  connect: [];
  disconnect: [reason?: unknown];
  message: [msg: RealtimeMessage];
  /**
   * A device reported to the cloud since the last poll — its {@link DeviceState.lastSeenMs} advanced.
   * Carries {@link DeviceState}; the host applies its own staleness threshold.
   *
   * Transport/session lifecycle is NOT this event: that's `p2pConnect`/`p2pClose`, station-scoped where
   * a session actually lives.
   */
  deviceState: [state: DeviceState];
  /**
   * A verified vendor-wire availability observation. Duplicate states are coalesced; silence,
   * `lastSeenMs`, operation failure and transport lifecycle never emit or clear this event.
   */
  availability: [observation: AvailabilityObservation];
  // P2P lifecycle + raw frame.
  p2pConnect: [stationSn: string];
  p2pClose: [stationSn: string];
  p2pLevel2Ready: [info: { stationSn: string; cipherId: number }];
  p2p: [frame: P2PFrame];
  // Push lifecycle + raw normalized push.
  pushConnect: [];
  pushDisconnect: [];
  pushRaw: [raw: RawPushMessage];
  push: [event: PushEvent];
  /**
   * A transport-level command got an acknowledgement (or didn't) — emitted by the MQTT command router.
   * For `ff09-actuate` the reply is a "device received it"
   * signal, not a physical-actuation-complete one (see that handler's doc); for `ff09-autolock` the GET
   * step already threw on no reply by the time this fires — `getAcked` is always `true` here, `acked`
   * reports the SET step's fire-and-forget ack. `dispatch()`/`lock()`/`unlock()`/`setAutoLock()` stay
   * `Promise<void>` and never throw on a missing SET ack (fire-and-forget, same as every other write) —
   * this event is the optional channel for a host that wants delivery visibility without the dispatch
   * contract itself changing shape. Secure-MQTT DP writes use the persistent account connection and
   * report broker publication (`acked: true`) without an `instanceIp`; that is not device convergence.
   */
  commandAck: [info: { sn: string; kind: string; acked: boolean; instanceIp?: string; getAcked?: boolean }];
  // Any transport error.
  error: [err: Error];
};

/** Event names {@link EufyMega} can emit. */
export type EufyMegaEvent = keyof EufyMegaEventMap;
