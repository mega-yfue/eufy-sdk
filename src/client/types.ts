/**
 * Public type surface of the {@link EufyMega} facade — options + the typed event map.
 *
 * Kept separate from the class so the event contract reads on its own. The declaration-merged
 * `interface EufyMega` (the typed on/once/off/emit overloads) stays in `eufy-mega.ts` next to the
 * class — TS declaration merging requires both in the same module.
 */
import type { MegaClientConfig, SessionExpiredError } from "../transport/http/mega-client.js";
import type { FcmStore } from "../transport/push/store.js";
import type { FfmpegLevel } from "../transport/ffmpeg.js";
import type { DeviceEventMap } from "../model/capabilities/index.js";
import type { Capability } from "../model/index.js";
import type { P2PFrame } from "../transport/p2p/p2p-session.js";
import type { PowerTier } from "../transport/p2p/session-manager.js";
import type { BizMapFrame } from "../transport/mqtt/biz-stream.js";
import type { VacuumMapSnapshot } from "../model/index.js";
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
   * The SDK normally derives a station's LAN address from its device record; an entry here overrides it
   * where the record's IP is wrong/blocked (AP isolation, a stale `ip_addr`).
   */
  localAddresses?: Record<string, string>;
  /**
   * Suppress the `255.255.255.255` local-lookup broadcast (default `false` — broadcast is sent).
   *
   * An unconnected P2P session broadcasts a local lookup **once a second for the whole connect
   * timeout**, which is how a station on the same LAN is found without knowing its address. That is
   * cheap when it works and not free when it does not: the datagram goes to every host on the segment,
   * every associated client of a WLAN has to receive it, and a host that sets `SO_BROADCAST` on many
   * sockets in quick succession is doing something unusual to its own network stack.
   *
   * Turning it off costs the LAN-discovery path only. A station whose record carries a usable
   * `ip_addr` is still found directly, and the PPCS cloud lookup — which is what actually connects a
   * station in most topologies — is unaffected. Set it when the caller knows its stations' addresses,
   * or when the broadcast is suspected of disturbing the host's own networking.
   */
  noBroadcast?: boolean;
  /**
   * Auto-manage connectivity (default `true`). When on, a successful {@link EufyMega.login} brings up
   * the always-on event channels itself — FCM push + secure MQTT (if the account has appliances) — and
   * eagerly warms P2P only for **wired** stations (HomeBases / mains cameras). Battery cameras stay
   * detached until a command / stream — or a pre-warm the caller opted into via {@link
   * EufyMegaOptions.prewarmEvents} — needs them, and idle-detach afterwards. The host calls no
   * `connect*` — connectivity is transport-agnostic. Set `false` to manage nothing automatically
   * (advanced/testing).
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
   * How long a speculative pre-warm holds the session it opened, in ms (default 28000). Applies only to
   * the events {@link EufyMegaOptions.prewarmEvents} opts into; pre-warm is off until then.
   *
   * When the window expires with nothing attached, the session does not close — the hold is released and
   * the station's own idle window takes over, which for a battery station is {@link
   * EufyMegaOptions.p2pIdleMs} (5 min by default). Budget an unattended pre-warm at the sum of the two.
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
   * Which semantic events speculatively pre-warm a camera's P2P session — **opt-in, default `[]`**, an
   * empty list being what disables it. Naming an event buys a stream or talkback opened right after it
   * starting warm rather than paying a cold open, and costs what the three paragraphs below describe.
   *
   * Any name in {@link DeviceEventMap} is accepted, so the list autocompletes and a typo won't compile.
   * A pre-warm rides the push channel, so only an event push carries can trigger one — a poll-carried
   * event is inert however it is listed, and each capability module declares which source carries its own
   * events. An event from a device that is not a camera pre-warms the station behind it, which for an
   * attached sensor is its HomeBase.
   *
   * **One camera pays for it.** Wired stations are warmed at login and never idle-detach, and an attached
   * camera's session lives on its wired base — so the only station a pre-warm genuinely opens is a
   * standalone battery camera, the device class the on-demand session lifecycle exists to let sleep.
   * {@link EufyMegaOptions.prewarmTiers} is how that class is spared while keeping the opt-in.
   *
   * **An unwatched pre-warm costs more than its window**, per {@link EufyMegaOptions.prewarmMs}: the hold
   * expiring arms the station's idle window instead of closing the session, and a second qualifying event
   * inside that tail restarts it.
   *
   * **Frequency is a property of the installation, not of the event name.** A camera set to report human
   * detection only fires `personDetected` as often as a busier one fires raw `motion`, so the rate is the
   * fleet's and not the event's.
   */
  prewarmEvents?: (keyof DeviceEventMap)[];
  /**
   * Which station power tiers {@link EufyMegaOptions.prewarmEvents} may pre-warm (default: both). The
   * tier is the one of the **station whose session would open** — a camera attached to a HomeBase is
   * pre-warmed as `wired`, because that base's session is the one being held.
   *
   * `["wired"]` keeps the opt-in and spends no battery: it is close to a no-op, since wired stations are
   * already warmed at login and never idle-detach, so it only bites after a session drops.
   */
  prewarmTiers?: PowerTier[];
  /**
   * ffmpeg's own `-loglevel` for the media paths that shell out to it (live snapshot / record).
   * Default `"error"` (quiet). A raised level (e.g. `"trace"`) reports a failing decode/mux;
   * ffmpeg's stderr is then forwarded to the {@link EufyMegaOptions.logger} as `[ffmpeg]` debug lines
   * — visible only where that logger shows `debug`. Independent of the SDK's own log level.
   */
  ffmpegLogLevel?: FfmpegLevel;
  /**
   * Opt into unverified Tuya DP writes for `eufy_home_tuya` clean-line devices (G-series / X8).
   *
   * By default `TuyaCommandRouter` refuses to send `dp.publish` because the request shape
   * has been reversed but not yet confirmed from a live on-device capture — a wrong shape comes back
   * as a generic Tuya error indistinguishable from an actual device rejection. `true` sends it anyway,
   * which is sound only where the full round-trip has been confirmed on a real device, or that
   * ambiguity is accepted.
   */
  tuyaAllowUnverified?: boolean;
  /**
   * The `ffmpeg` executable the media paths that shell out should run (live snapshot / record).
   * Default: the bare name `"ffmpeg"`, looked up on `PATH`.
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
 * event's payload.
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
   * returns a subset), because an absence caused by an outage is not a removal.
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
   * One frame off a clean-line device's map stream — the `biz/…/res` leg, which carries pixel planes,
   * room outlines and names, virtual walls and the live pose.
   *
   * The frame is unwrapped as far as its bytes and no further: `frame.payload` is a Raw-DP frame in
   * the base64 a codec reads, and `frame.channelId` says which `stream.proto` message it holds. That
   * split is deliberate while the decoders are being built — the meaning of a channel is settled in one
   * place rather than in this event's shape.
   */
  mapFrame: [info: { deviceSn: string; frame: BizMapFrame }];
  /**
   * A device's map changed — a new cell plane, a renamed room, a zone the user drew.
   *
   * Carries the whole snapshot rather than the piece that changed, because the pieces are only useful
   * together: a room outline without the room list names nothing. Emitted only when something actually
   * changed; the robot republishes its map throughout a clean and a repeat of what is already held is
   * dropped rather than woken on.
   */
  map: [info: { deviceSn: string; map: VacuumMapSnapshot }];
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
   * this event is the optional channel for delivery visibility, without the dispatch
   * contract itself changing shape. Secure-MQTT DP writes use the persistent account connection and
   * report broker publication (`acked: true`) without an `instanceIp`; that is not device convergence.
   */
  commandAck: [info: { sn: string; kind: string; acked: boolean; instanceIp?: string; getAcked?: boolean }];
  /**
   * A write was acknowledged and its declared observation then never converged, so the device never
   * reported the state the write asked for.
   *
   * This is the answer to the question `dispatch` deliberately does not wait for. A command resolves once the
   * transport has carried it, and the observation a member declares decides separately whether the device
   * applied it; where that observation times out, the wire accepted the write and the device ignored it — seen
   * on a battery camera whose power write is acknowledged and never acted on. It is reported here rather than
   * on `error` because it is an outcome and not a fault, for the same reason `commandAck` has its own
   * channel. `observed` is what the param read when the deadline passed, absent where the
   * device reported none at all.
   */
  commandUnconfirmed: [
    info: {
      sn: string;
      property: string;
      param: number;
      expected?: boolean | number | string;
      observed?: boolean | number | string;
      timeoutMs: number;
    },
  ];
  /**
   * The cloud session was kicked or invalidated — another client logged into the same account, or the
   * token expired. The SDK has already cleared the persisted session, so recovery is a fresh `login()`
   * (which usually needs 2FA). Distinct from `error`: a session error is emitted ONLY here, not also
   * on `error`.
   *
   * The error carries the rate: `err.retryAfterMs` is how long the next session replacement is barred
   * for, and `err.contended` says this session is being displaced by another client rather than expiring
   * — which a re-login does not answer. A login made before that wait elapses extends it.
   */
  sessionExpired: [err: SessionExpiredError];
  // Any transport error.
  error: [err: Error];
};

/** Event names {@link EufyMega} can emit. */
export type EufyMegaEvent = keyof EufyMegaEventMap;
