/**
 * eufy-sdk — one client for every eufy device class.
 *
 * Cloud APIs:  the eufy v6 cloud (+ legacy, planned)
 * Realtime:    secure MQTT (appliances)  +  P2P (cameras/HomeBases)
 *
 *   const eufy = new EufyMega({ email, password, region: "eu-pr" });
 *   await eufy.login(); // → LoginResult; on success the SDK auto-starts realtime (push/MQTT/wired P2P)
 *   eufy.on("motion", (e) => console.log(e.deviceSn)); // typed semantic events — flowing already
 *   const dev = await eufy.getDevice((await eufy.getDevices())[0].sn);
 *   await dev.camera?.()?.snapshotStored?.();
 *
 * Connectivity is SDK-managed: the host calls no `connect*`. P2P to a battery camera is opened only
 * when a command/stream/doorbell-ring needs it and closed when idle, so the camera can sleep.
 */
import { EventEmitter } from "node:events";
import { MegaHttpClient, LoginStatus, SessionExpiredError, type LoginResult } from "../transport/http/mega-client.js";
import { SecureMqtt, isNotAuthorized, type SecureMqttCredentials } from "../transport/mqtt/secure-mqtt.js";
import { mqttAppName, mqttScopeFor, type MqttScope } from "../transport/mqtt/topics.js";
import { buildAppShapedClientId, mqttUuidFrom } from "../transport/mqtt/app-client-id.js";
import { parseStateInfoSignal } from "../transport/mqtt/availability.js";
import { parseDpMessage, parseAiotDpReport } from "../transport/mqtt/dp-codec.js";
import { parseBizMapFrame } from "../transport/mqtt/biz-stream.js";
import type { BizMapFrame } from "../transport/mqtt/biz-stream.js";
import { decodeMapFrame } from "./map-channels.js";
import { VacuumMapStore } from "../model/index.js";
import { type P2PSession, type P2PFrame } from "../transport/p2p/p2p-session.js";
import { P2PCommandRouter } from "../transport/p2p/command-router.js";
import { jpegGeometry } from "../transport/p2p/media.js";
import type { PowerTier } from "../transport/p2p/session-manager.js";
import { MqttCommandRouter } from "../transport/mqtt/command-router.js";
import { TuyaCommandRouter } from "../transport/tuya/command-router.js";
import { TuyaDpRouter, parseTuyaDpReport } from "../transport/tuya/dp-codec.js";
import { rawDpCodec } from "../transport/raw-dp.js";
import { resolveLightEffect as resolveLightEffectHttp } from "../transport/http/light-catalog.js";
import {
  buildCommand as buildCapabilityCommand,
  decodeEvent as decodeCapabilityEvent,
  STATE_EVENT_FIELDS,
  decodeState as decodeCapabilityState,
  buildRealtimeInit,
  hasRealtimeReads,
  needsRealtimeInit,
  hasProvidedAction,
} from "../model/capabilities/index.js";
import type { DeviceEventMap } from "../model/capabilities/index.js";
import type { CommandContext } from "../model/capabilities/types.js";
import { CapabilityNotSupportedError } from "../model/capabilities/types.js";
import { type DpCatalog, EMPTY_DP_CATALOG, parseDpCatalog } from "../model/capabilities/dp-catalog.js";
import { type CleanRecordPage, EMPTY_CLEAN_RECORD_PAGE, parseCleanRecords } from "../model/clean-records.js";
import {
  commandObservation,
  LiveSnapshotUnavailableError,
  StateConvergenceError,
  type Command,
  type CommandObservation,
  type CommandSink,
  type Ff09SettingsReader,
  type MediaProvider,
  type TuyaDpInbound,
} from "../core/contracts.js";
import { noopLogger } from "../core/logger.js";
import { PushClient } from "../transport/push/push-client.js";
import { FcmRegistrar } from "../transport/push/fcm.js";
import { MemoryFcmStore } from "../transport/push/store.js";
import { StoredImageCache } from "../transport/stored-image-cache.js";
import type { PushEvent, RawPushMessage } from "../transport/push/types.js";
import { type AvailabilityObservation, type EufyDevice, type RealtimeTransport } from "../core/types.js";
import { Timer } from "../core/util.js";
import {
  Device,
  resolveDevice,
  detectionName,
  type Capability,
  type DeviceInspection,
  type RawParams,
} from "../model/index.js";
import { isHomeBase } from "../model/device-family.js";
import { DeviceRegistry, type ParamChange } from "./device-registry.js";
import type {
  EufyMegaOptions,
  EufyMegaEvent,
  EufyMegaEventMap,
  DeviceState,
  RealtimePlaneReadiness,
  RealtimeReadiness,
  WaitForRealtimeOptions,
} from "./types.js";

export type {
  EufyMegaOptions,
  EufyMegaEvent,
  EufyMegaEventMap,
  AnyDeviceEvent,
  DeviceState,
  RealtimePlaneReadiness,
  RealtimeReadiness,
  WaitForRealtimeOptions,
} from "./types.js";

type SemanticEventRefresh = Pick<CommandObservation, "param" | "property" | "resetStandaloneSession" | "timeoutMs"> & {
  expected?: CommandObservation["expected"];
  observed?: CommandObservation["observed"];
};

/**
 * Read a non-empty string field off a raw device record, tolerating the app's `deviceParams` nesting
 * (the v6 app resolves e.g. firmware as `record.deviceParams?.main_sw_version ?? record.main_sw_version`).
 * Returns `undefined` for a missing or empty value, so a blank firmware never surfaces as `""`.
 */
function recordString(raw: Record<string, unknown>, key: string): string | undefined {
  const nested = (raw.deviceParams as Record<string, unknown> | undefined)?.[key];
  const v = typeof nested === "string" && nested ? nested : raw[key];
  return typeof v === "string" && v ? v : undefined;
}

/**
 * Extract the Tuya device id from a `eufy_home_tuya` device's raw cloud record.
 * The cloud `get_devs_list` response embeds the Tuya id under one of several field names
 * (naming varied across firmware generations). Returns the first non-empty string found.
 */
function tuyaDevIdFrom(raw: Record<string, unknown>): string | undefined {
  for (const field of ["tuya_uuid", "tuya_virtual_id", "tuya_device_id", "virtualId"]) {
    const v = recordString(raw, field);
    if (v) return v;
  }
  return undefined;
}

/**
 * Default cloud-param poll interval (10 min) — paced to the cloud's own refresh rate rather than to a
 * host's refresh appetite. Rationale and the measurements behind the number are on
 * {@link EufyMegaOptions.pollMs}, the knob that overrides it (`0` disables the loop).
 */
const DEFAULT_POLL_MS = 600_000;

/**
 * Power tiers a speculative pre-warm may open a station on, when the caller states none. Both, because
 * the opt-in that turns pre-warm on at all is {@link EufyMegaOptions.prewarmEvents}: a caller who listed
 * an event asked for its session, and silently skipping the only tier a pre-warm can actually open would
 * make that opt-in do nothing. {@link EufyMegaOptions.prewarmTiers} narrows it.
 */
const DEFAULT_PREWARM_TIERS: readonly PowerTier[] = ["wired", "battery"];

/**
 * How long a write waits for the session recycle it asked for before letting go of the wait.
 *
 * A recycle that nothing is holding completes in the time one session teardown takes, so this bound is
 * never reached in the ordinary case. It exists for the case where a viewer is attached: the recycle
 * then waits for that viewer to detach, which may be minutes or never, and the wait is what a following
 * write to the same member queues behind. Letting go does not cancel the recycle.
 */
const SESSION_RECYCLE_WAIT_MS = 5_000;

interface RealtimeGeneration {
  readonly epoch: number;
  readonly readiness: MutableRealtimeReadiness;
  readonly promise: Promise<RealtimeReadiness>;
  readonly resolve: (readiness: RealtimeReadiness) => void;
  readonly abort: AbortController;
  result?: RealtimeReadiness;
  superseded?: RealtimeReadiness;
  settled: boolean;
}

class RealtimeStartupSupersededError extends Error {}

/**
 * The convergence window closed while waiting on a dependency, rather than the dependency failing.
 *
 * Distinguishing the two is what lets {@link EufyMega.refreshEventState} answer a write that was never applied
 * with the member it was waiting for: without it the last poll's own deadline escapes first, and the caller is
 * told only that something timed out somewhere.
 */
class RefreshWindowClosedError extends Error {}

interface MutableRealtimePlaneReadiness {
  required: number;
  ready: number;
  failed: number;
  pending: number;
}

interface MutableRealtimeReadiness {
  state: RealtimeReadiness["state"];
  push: MutableRealtimePlaneReadiness;
  mqtt: MutableRealtimePlaneReadiness;
  wiredP2p: MutableRealtimePlaneReadiness;
}

function createPlaneReadiness(required = 0): MutableRealtimePlaneReadiness {
  return { required, ready: 0, failed: 0, pending: required };
}

function readinessSnapshot(
  readiness: RealtimeReadiness | MutableRealtimeReadiness,
  state = readiness.state,
): RealtimeReadiness {
  return Object.freeze({
    state,
    push: Object.freeze({ ...readiness.push }),
    mqtt: Object.freeze({ ...readiness.mqtt }),
    wiredP2p: Object.freeze({ ...readiness.wiredP2p }),
  });
}

// Typed EventEmitter surface: declaration-merge strongly-typed on/once/off/emit onto the class so
// `eufy.on("motion", e => …)` autocompletes the name and types the payload, while the runtime is
// still the untyped node EventEmitter. Only these overloads are visible to consumers.
export interface EufyMega {
  on<E extends EufyMegaEvent>(event: E, listener: (...args: EufyMegaEventMap[E]) => void): this;
  once<E extends EufyMegaEvent>(event: E, listener: (...args: EufyMegaEventMap[E]) => void): this;
  off<E extends EufyMegaEvent>(event: E, listener: (...args: EufyMegaEventMap[E]) => void): this;
  emit<E extends EufyMegaEvent>(event: E, ...args: EufyMegaEventMap[E]): boolean;
}

/**
 * The package entry point — one client per Anker eufy account. Handles the {@link login} state machine
 * (captcha/2FA/persistence), resolves the account's devices ({@link getDevices}/{@link getDevice}
 * → capability-driven {@link Device}s), **auto-manages** the realtime channels (FCM push + secure MQTT
 * start on login; P2P opens on demand per station and idle-detaches battery cameras), and fans every
 * transport's traffic into one typed semantic event stream (`eufy.on("motion", …)`). Construct it with
 * an {@link EufyMegaOptions} (email/password + optional session/push stores), then drive `login()` to
 * completion — no `connect*` call needed (set `autoRealtime:false` to opt out). Call {@link disconnect}
 * to tear the realtime channels down.
 */
export class EufyMega extends EventEmitter {
  private readonly opts: EufyMegaOptions;
  private readonly mega: MegaHttpClient;
  /**
   * The installed secure-MQTT transports, one per credential scope.
   *
   * There is more than one because `get_user_mqtt_info` issues a DIFFERENT certificate per `app-name`
   * and the broker's policy grants each line's topic space to its own cert — a `eufy_life` light's
   * topics are silently denied to the default credential. A device's
   * scope is a pure function of its record, so the set of live connections follows the roster with no
   * extra state to keep in sync, and a scope with no devices is never connected.
   */
  private readonly transports = new Map<MqttScope, RealtimeTransport>();
  /** Shared in-flight/settled `startMqtt()` promise PER SCOPE — so realtime bring-up and an on-demand
   * publish await the SAME fully-connected transport instead of racing (and never open two). */
  private readonly mqttReady = new Map<MqttScope, Promise<void>>();
  /** Device list/record/capability resolution + the frame→caps cache. */
  private readonly registry: DeviceRegistry;
  private pushClient?: PushClient;
  /** Push-fed passive image store; absent when the caller disables acquisition. */
  private readonly storedImages?: StoredImageCache;
  /** Account whose retained images are currently held. */
  private storedImageAccount?: string;
  /**
   * Which bring-up generation is current. Bumped by every {@link disconnect}, so an in-flight
   * {@link ensureRealtime} can tell on completion whether it is still the live one.
   *
   * The bring-up is fire-and-forget, so a caller that disconnects while it is still running would
   * otherwise leave behind whatever opened after teardown had already passed. A single "closing" flag
   * is not enough: `disconnect()` followed by `login()` clears it, and the stale bring-up then finishes,
   * sees nothing amiss, and overwrites the live channels with its own — stranding the sockets it was
   * meant to release. Comparing generations makes each bring-up responsible for exactly its own epoch.
   */
  private realtimeEpoch = 0;
  /** Shared startup state for the current epoch; caller timeouts never replace or cancel it. */
  private realtimeGeneration?: RealtimeGeneration;
  /**
   * Devices already handed to a caller, so a realtime report refreshes the object they are holding
   * rather than only the registry. Weak so a caller dropping a `Device` still lets it be collected —
   * this map must never be what keeps one alive.
   */
  private readonly liveDevices = new Map<string, WeakRef<Device>>();
  /** Serialized state-transition transactions keyed by device and reflected member. */
  private readonly stateTransitions = new Map<string, Promise<unknown>>();
  /** Local writes already awaiting the same semantic transition, counted per reflected member. */
  private readonly commandRefreshes = new Map<string, { epoch: number; count: number }>();
  /**
   * The param ids each bound device's read getters were built from — the evidence the gate saw at bind
   * time. Compared against an incoming report to notice when one carries an id the getters do not cover
   * yet, which is the signal to rebuild them (see {@link rebindReads}).
   */
  private readonly boundParamIds = new Map<string, ReadonlySet<number>>();
  /** Per-SKU DP catalog cache — keyed on model/T-code, fetched lazily via `get_product_data_point`. */
  private readonly dpCatalogCache = new Map<string, DpCatalog>();
  /** Semantic event names that speculatively pre-warm P2P (resolved once from the options; empty = off). */
  private readonly prewarmEvents: ReadonlySet<string>;
  /** Station power tiers a pre-warm may open (resolved once from the options). */
  private readonly prewarmTiers: ReadonlySet<PowerTier>;
  /** Transport-side owner of the P2P sessions + all wire senders. */
  private readonly p2p: P2PCommandRouter;
  /** Transport-side owner of the secure-MQTT ff09 lock/garage command path (sibling of {@link p2p}). */
  private readonly mqtt: MqttCommandRouter;
  /** Transport-side owner of the legacy Tuya REST command path for non-AIoT vacuums (G-series). */
  private readonly tuya: TuyaCommandRouter;

  private readonly tuyaDpRouter: TuyaDpRouter;
  /**
   * Last state value announced per `deviceSn:event`, for the edge-trigger in {@link isRepeatState}.
   * Realtime-only: the poll path deliberately bypasses it so an unchanged state is still re-asserted.
   */
  private readonly lastStateAnnounced = new Map<string, unknown>();
  /** Latest authoritative availability observation per device; no heuristic path writes this map. */
  private readonly availabilityObservations = new Map<string, AvailabilityObservation>();
  /**
   * One map per clean-line device, assembled from the pieces its `biz/…/res` frames carry.
   *
   * Created on the first frame that decodes rather than per device: a store for a robot that has never
   * sent a map would answer `undefined` to everything, so allocating one buys nothing.
   */
  private readonly mapStores = new Map<string, VacuumMapStore>();
  /** Re-armed after each cloud-param poll; cancelled by {@link disconnect}. */
  private readonly pollTimer = new Timer();

  constructor(opts: EufyMegaOptions) {
    super();
    this.opts = opts;
    this.prewarmEvents = new Set(opts.prewarmEvents ?? []);
    this.prewarmTiers = new Set(opts.prewarmTiers ?? DEFAULT_PREWARM_TIERS);
    this.mega = new MegaHttpClient(opts);
    if (opts.storedSnapshotCache !== false) {
      this.storedImages = new StoredImageCache(
        async (url, deviceKey) => {
          const devices = this.registry.list();
          const device = devices.find((entry) => entry.sn === deviceKey);
          const stationKey = device?.stationSn || device?.sn;
          const p2pDid = devices.find((entry) => entry.sn === stationKey)?.p2pDid;
          return this.mega.downloadImage(url, p2pDid);
        },
        opts.logger ?? noopLogger,
        Date.now,
        (error) => error instanceof SessionExpiredError,
      );
    }
    this.registry = new DeviceRegistry({
      mega: this.mega,
      onError: (e) => this.reportError(e),
      logger: opts.logger,
    });
    this.p2p = new P2PCommandRouter({
      mega: this.mega,
      logger: opts.logger,
      ffmpegLogLevel: opts.ffmpegLogLevel,
      ffmpegPath: opts.ffmpegPath,
      poweredFor: (parentSn) => this.stationPower(parentSn),
      sessionIdle: { batteryIdleMs: opts.p2pIdleMs },
      localAddresses: opts.localAddresses,
      lanOnly: opts.lanOnly,
      noBroadcast: opts.noBroadcast,
      listDevices: () => this.registry.list(),
      ensureDevices: async () => {
        await this.registry.getDevices();
      },
      onConnect: (sn) => this.emit("p2pConnect", sn),
      onClose: (sn) => this.emit("p2pClose", sn),
      onError: (e) => this.reportError(e),
      onLevel2Ready: (sn, cipherId) => this.emit("p2pLevel2Ready", { stationSn: sn, cipherId }),
      onFrame: (stationSn, f) => this.onP2PFrame(stationSn, f),
    });
    this.mqtt = new MqttCommandRouter({
      mega: this.mega,
      logger: opts.logger,
      listDevices: () => this.registry.list(),
      ensureDevices: async () => {
        await this.registry.getDevices();
      },
      onCommandAck: (info) => this.emit("commandAck", info as EufyMegaEventMap["commandAck"][0]),
      onError: (e) => this.reportError(e),
      // The `a2` account id an `eufy_life` DP frame embeds — the owning member's `admin_user_id`,
      // falling back to the logged-in account's user id (the confirmed script path does the same).
      resolveAccountId: (dev) => {
        const member = ((dev.raw ?? {}) as Record<string, unknown>).member as Record<string, unknown> | undefined;
        const adminId = member?.admin_user_id;
        if (typeof adminId === "string" && adminId) return adminId;
        return this.mega.auth?.userId ?? "";
      },
      // Fetch + parse a gallery effect from the HTTP catalogue into the serializable spec. The catalogue
      // lives in the http layer (transport/http/light-catalog); the mqtt router owns the frame bytes.
      resolvePreset: (presetId) => resolveLightEffectHttp(this.mega, presetId),
      /**
       * Publish over the persistent transport for THIS device's credential scope — one connection per
       * product line carrying both legs, as the app does. CONFIRMED live (2026-07-28) that the
       * `eufy_life` credential grants the command leg as well as the reports.
       *
       * Uses an already-installed transport directly rather than awaiting the bring-up memo, because
       * the path is re-entrant: bringing a scope up subscribes its devices and sends their
       * realtime-init commands, which publish back through here on that same scope. Awaiting the memo
       * would have that publish wait on the bring-up waiting on it. The transport is installed before
       * subscribing begins and publishing needs no subscription, so the direct path is safe.
       */
      publishSecure: async (dev, topic, body) => {
        const scope = mqttScopeFor(dev);
        if (!this.transports.has(scope)) await this.ensureMqttStarted(scope);
        const transport = this.transports.get(scope);
        if (!transport) throw new Error(`secure-MQTT transport not connected for scope "${scope}"`);
        await transport.publish(topic, body, { qos: 1 });
      },
    });
    this.tuya = new TuyaCommandRouter({ allowUnverified: this.opts.tuyaAllowUnverified });
    this.tuyaDpRouter = new TuyaDpRouter();
    this.tuyaDpRouter.setListener(this.makeTuyaDpInbound());
  }

  /**
   * Builds the inbound listener that converts ThingClips DP maps to realtime capability state.
   * DP values arrive as booleans, numbers, or strings; they are normalised to the string form
   * the param store uses, then applied through the standard realtime-report path.
   */
  private makeTuyaDpInbound(): TuyaDpInbound {
    return {
      onDps: (sn, dps) => {
        const dpParams: Record<number, string> = {};
        for (const [id, value] of Object.entries(dps)) {
          dpParams[Number(id)] = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
        }
        if (!Object.keys(dpParams).length) return;
        const caps = this.capsForEvent(sn);
        const signal = { source: "mqtt" as const, deviceSn: sn, topic: "", raw: {}, dpParams };
        this.applyRealtimeReport(sn, decodeCapabilityState(signal, caps));
      },
    };
  }

  /**
   * Reports what became of a command already acknowledged to its caller.
   *
   * A write whose declared observation never converged is not a fault of this client, so it does not reach
   * the generic error bus: it is the answer to a question `dispatch` deliberately does not wait for, and it
   * gets its own channel for exactly the reason `commandAck` has one. Anything else that goes wrong after
   * the acknowledgement is a genuine fault and is reported as one.
   */
  private reportUnacknowledged(e: unknown): void {
    if (e instanceof StateConvergenceError) {
      this.emit("commandUnconfirmed", {
        sn: e.sn,
        property: e.property,
        param: e.param,
        expected: e.expected,
        observed: e.observed,
        timeoutMs: e.timeoutMs,
      });
      return;
    }
    this.reportError(e);
  }

  /**
   * Route an internal error to the host, without being able to kill it.
   *
   * A {@link SessionExpiredError} — a kicked/expired token, the transport having already cleared the
   * session — is emitted as the dedicated `sessionExpired` event; it is NOT also sent to `error`. Every
   * other error goes to `error`.
   *
   * Either way it falls back to a logged warning when nothing listens, because `error` on an
   * `EventEmitter` THROWS when it has no listener, and most of these failures reach us from a
   * fire-and-forget path (a transport callback, an un-awaited re-bind) where that throw would land as an
   * unhandled rejection and abort the process.
   *
   * Only reported-error paths reach here — an error thrown straight out of a direct call is the caller's
   * to handle.
   */
  private reportError(e: unknown): void {
    const err = e instanceof Error ? e : new Error(String(e));
    if (err instanceof SessionExpiredError) {
      if (this.listenerCount("sessionExpired")) this.emit("sessionExpired", err);
      else this.opts.logger?.warn?.(`[eufy] ${err.message}`);
      return;
    }
    if (this.listenerCount("error")) this.emit("error", err);
    else this.opts.logger?.warn?.(`[eufy] ${err.message}`);
  }

  /**
   * The single entry point that installs the persistent secure-MQTT transport for one credential
   * scope — used by BOTH the auto-realtime bring-up ({@link ensureRealtime}) and an on-demand light-DP
   * publish (the router's `publishSecure`, wired in the constructor). Memoised per scope on
   * {@link mqttReady} so the two can't race into two connections: whoever calls first starts it, the
   * other awaits the same promise. Resolves only once {@link startMqtt} has `connect()`-ed, the
   * transport is installed, and every device on that scope is subscribed — so a publish that awaits it
   * always hits a live, subscribed client (never the silent no-op of firing into an unconnected
   * transport). Epoch-guarded: if a {@link disconnect} lands mid bring-up, the freshly-connected
   * transport is torn down instead of stranded. On failure the memo is cleared so a later call retries
   * — but only if it is still THIS attempt's memo: a `disconnect()` clears the map and a later call can
   * install a second bring-up, so an abandoned attempt that rejects afterwards must not wipe its
   * successor (that would let two `connect()`s run concurrently and strand whichever installed first,
   * still subscribed and double-emitting).
   */
  private ensureMqttStarted(scope: MqttScope, epoch = this.realtimeEpoch): Promise<void> {
    const existing = this.mqttReady.get(scope);
    if (existing) return existing;
    const attempt: Promise<void> = (async () => {
      const mqtt = await this.startMqtt(scope);
      if (epoch !== this.realtimeEpoch) {
        await mqtt.disconnect();
        return;
      }
      this.transports.set(scope, mqtt);
      await this.subscribeMqttDevices(scope, mqtt);
    })().catch((e) => {
      if (this.mqttReady.get(scope) === attempt) this.mqttReady.delete(scope);
      throw e;
    });
    this.mqttReady.set(scope, attempt);
    return attempt;
  }

  /**
   * Give a realtime-only device a bounded chance to report before its actions are bound.
   *
   * The typed read getters are evidence-gated on the ids a device has reported, resolved once at bind
   * time. A device whose state exists ONLY on its realtime wire therefore has no readable state at all
   * if it is resolved before its first report. Waiting here is the cheap path: the returned `Device`
   * already carries its reads, so a caller never has to watch for them appearing.
   *
   * It is a head start, not the mechanism — {@link rebindReads} installs reads that arrive later, which
   * is what covers a device too slow (or too idle) to answer inside the window. A docked robot is
   * exactly that.
   *
   * Skipped entirely for a device with a pollable cloud record, for an already-reporting device, and
   * when realtime is off — so the common path adds nothing. Resolving on timeout leaves a silent device
   * read-less rather than failing the lookup.
   */
  private async awaitFirstRealtimeState(sn: string): Promise<void> {
    if (this.opts.autoRealtime === false || this.realtimeGeneration?.epoch !== this.realtimeEpoch) return;
    if (this.registry.hasRealtimeState(sn)) return;
    const timeoutMs = this.opts.stateSnapshotMs ?? 4000;
    if (timeoutMs <= 0) return;
    if (!this.registry.list().length) await this.getDevices();
    const dev = this.registry.list().find((d) => d.sn === sn);
    if (!dev || dev.realtime !== "smqtt") return;
    const caps = this.registry.capabilitiesForDevice(sn);
    if (!caps || !hasRealtimeReads(caps)) return;
    try {
      await this.ensureMqttStarted(mqttScopeFor(dev));
    } catch {
      return;
    }
    await this.registry.awaitRealtimeState(sn, timeoutMs);
  }

  /**
   * Feed one map-stream frame to the device's map, and announce it if anything changed.
   *
   * Silent about a frame it cannot use. Most of them are: channels nothing reads yet, and fragments of
   * a split message. Neither is a fault, and logging either would log on every frame of every clean.
   */
  private applyMapFrame(deviceSn: string, frame: BizMapFrame): void {
    const piece = decodeMapFrame(frame, rawDpCodec);
    if (!piece) return;

    let store = this.mapStores.get(deviceSn);
    if (!store) {
      store = new VacuumMapStore();
      this.mapStores.set(deviceSn, store);
    }
    // The device repeats its map while it cleans. Announcing an unchanged one on every repeat would
    // wake every listener for nothing, so the store's own answer decides.
    if (store.apply(piece)) this.emit("map", { deviceSn, map: store.snapshot });
  }

  private applyRealtimeReport(sn: string | undefined, states: readonly { params: Record<number, string> }[]): void {
    if (!states.length) return;
    this.applyRealtimeState(sn, Object.assign({}, ...states.map((s) => s.params)));
  }

  /**
   * Land state a capability recovered from a realtime signal: into the registry (so the next
   * {@link getDevice} sees it) AND into any `Device` already handed out (so a caller holding one sees
   * the new value without re-fetching). Announces every property whose value moved, then `deviceState`.
   *
   * Both writes matter: the registry alone would leave an existing `Device` stale until its freshness
   * window expired, and that refresh re-reads the CLOUD record — which for a realtime-only line does
   * not carry this state at all.
   *
   * This is three of the four inbound paths the security line has, and the ONLY one the clean and life
   * lines have — a robot's cloud record carries none of its data points — so it is what brings those
   * lines into scope for a property announcement at all. The announcement is edge-triggered for free:
   * {@link Device.applyParams} names only the properties whose value actually moved, so a device
   * re-reporting the same state is silent with no dedupe table to keep.
   *
   * The reported ids are recorded as evidence BEFORE the re-bind is fired, not after it lands. One
   * report fans out to one call per capability that decoded it, and the re-bind is a cloud round-trip:
   * advancing the set here is what stops the second call from firing a duplicate, and what stops a
   * failed re-bind from re-triggering on every subsequent report.
   */
  private applyRealtimeState(sn: string | undefined, params: Record<number, string>): void {
    if (!sn) return;
    const known = this.boundParamIds.get(sn);
    const reported = Object.keys(params).map(Number);
    const widens = known ? reported.some((id) => !known.has(id)) : false;
    if (widens && known) this.boundParamIds.set(sn, new Set([...known, ...reported]));
    this.registry.applyRealtimeParams(sn, params);
    const device = this.liveDeviceToAnnounce(sn);
    if (device) this.applyAndAnnounce(device, params);
    this.emit("deviceState", this.deviceState(sn));
    if (widens) void this.rebindReads(sn);
  }

  /**
   * Re-install a bound device's read getters after a report widened the evidence.
   *
   * The getters are built ONCE, and only for params the device had already reported — so a line whose
   * state arrives only over realtime binds with NO getters at all and would never grow them, no matter
   * how much state landed afterwards. A robot vacuum is exactly that: its cloud record carries none of
   * its data points, so the first report is what makes the reads exist.
   *
   * Re-binding is how the capability-gain path handles the same problem, and it is idempotent — the
   * getters read live state through a closure over `getProperty`, so rebuilding them keeps every value
   * a caller can already see. Only widening triggers it, so a device reporting the same ids repeatedly
   * rebinds once.
   *
   * `deviceState` is re-emitted once the getters exist. The report that creates them is announced before
   * they are installed, so the same event fires again when the reads are actually there, which is what
   * makes "re-read on `deviceState`" true on the first report rather than only from the second.
   * `bindActions` replaces the action objects, so the live ones are reached through the accessor
   * (`dev.vacuumClean()`) and never through a bag cached earlier.
   *
   * The evidence set is widened, never replaced: the ids come back through the cloud record, and a
   * record that omits a realtime-only id would otherwise un-know it and re-trigger on the next report.
   */
  private async rebindReads(sn: string): Promise<void> {
    const dev = this.liveDevices.get(sn)?.deref();
    if (!dev) return;
    try {
      const ctx = await this.commandContext(sn);
      dev.bindActions(
        ctx,
        this.commandSinkFor(sn),
        this.mediaProviderFor(sn),
        this.ff09SettingsReaderFor(sn, ctx),
        rawDpCodec,
      );
      this.boundParamIds.set(sn, new Set([...(this.boundParamIds.get(sn) ?? []), ...ctx.paramIds]));
      this.emit("deviceState", this.deviceState(sn));
    } catch (e) {
      this.reportError(e);
    }
  }

  /** The distinct credential scopes the current MQTT roster needs — no devices on a scope, no connection. */
  private mqttScopesInUse(): MqttScope[] {
    return [...new Set(this.getMqttDevices().map(mqttScopeFor))];
  }

  /**
   * Emit a semantic capability event whose name is only known at runtime (`decodeCapabilityEvent`
   * returns a plain-string `event` + `payload`). The typed `emit` overload requires a literal event
   * key, so this is the ONE place that bridges the dynamic name to the typed surface — every
   * `emit:` string in a capability module is a member of {@link DeviceEventMap}, so the cast is
   * sound. Keeping it here means the four dispatch loops stay a single call, not a scattered cast.
   *
   * `edge` asks for a state-carrying event to be suppressed when it only repeats what was last
   * announced. The state is noted either way: the poll re-announces an unchanged value on purpose,
   * and must still update what is known, or the next realtime signal carrying that same value would
   * read as a change and be announced a second time.
   */
  private emitSemantic(
    event: string,
    payload: Record<string, unknown>,
    opts: {
      edge?: boolean;
      refresh?: SemanticEventRefresh;
    } = {},
  ): void {
    const refresh = opts.refresh;
    const deviceSn = payload.deviceSn;
    if (refresh && typeof deviceSn === "string") {
      const key = this.eventRefreshKey(deviceSn, refresh);
      const commandOwner = this.commandRefreshes.get(key);
      if (commandOwner?.epoch === this.realtimeEpoch && commandOwner.count > 0) return;
      const device = this.liveDevices.get(deviceSn)?.deref();
      if (device) {
        const emission = this.enqueueStateTransition(key, () => this.refreshEventState(deviceSn, refresh))
          .then(async (refreshed) => {
            if (!refreshed) return;
            this.emitSemantic(event, payload, { edge: opts.edge });
          })
          .catch((error) => this.reportError(error));
        void emission;
        return;
      }
    }
    const repeat = this.noteState(event, payload);
    if (opts.edge && repeat) return;
    const emit = this.emit as (e: string, p: unknown) => boolean;
    emit.call(this, event, payload); // the named listener (eufy.on("motion", …))
    emit.call(this, "event", { ...payload, eventName: event }); // the catch-all (eufy.on("event", …)); avoids colliding with payload.name
  }

  /**
   * Await one capability-declared reflected param before publishing its valueless transition event.
   *
   * The state already on hand is consulted BEFORE fetching, but only where the observation carries a concrete
   * value to compare against: a device that reports the written param on its own session lands it through
   * {@link applyRealtimeState} within seconds, and polling the account device list to learn what the device has
   * already said costs a dozen requests to reach the same answer. Without an expectation, "converged" means
   * only "differs from what was read before", which state already on hand can satisfy spuriously — and the
   * caller that has no expectation is the push path, where the signal itself is the news that a re-read is owed.
   *
   * The cloud half is asked for through {@link DeviceRegistry.refreshedList}, never by fetching the account
   * list outright. The fetch is account-wide — one house list plus one device list per house — so a param that
   * never converges would otherwise spend a whole burst of those every iteration of this loop, and concurrent
   * transitions would multiply it by however many are in flight. The registry's reuse window and its
   * single in-flight fetch collapse all of that to one list per window, shared across every waiter. The loop
   * still turns on its own cadence: each pass re-reads what is known, so a value the device volunteers over
   * its own session settles the wait between two cloud reads rather than after them.
   */
  private refreshEventState(sn: string, refresh: SemanticEventRefresh): Promise<boolean> {
    const epoch = this.realtimeEpoch;
    return (async (): Promise<boolean> => {
      if (epoch !== this.realtimeEpoch) return false;
      const initialDevice = this.liveDevices.get(sn)?.deref();
      const before = initialDevice?.getProperty(refresh.property)?.value;
      const rawBefore = this.registry.require(sn).params?.[refresh.param];
      const deadline = Date.now() + refresh.timeoutMs;
      /**
       * Whether the state already on hand satisfies the observation, applying it to the live device when it
       * does. Reads what is already known and fetches nothing, so a param the DEVICE volunteered over its own
       * session settles the write for free.
       */
      const settled = (): boolean => {
        const device = this.liveDevices.get(sn)?.deref();
        const record = this.registry.require(sn);
        const rawValue = record.params?.[refresh.param];
        const converged =
          refresh.expected === undefined
            ? device
              ? String(rawValue) !== String(before)
              : rawValue !== rawBefore
            : String(rawValue) === String(refresh.expected);
        if (!converged) return false;
        if (!device) return true;
        device.applyParams(record.params ?? {});
        return this.matchesObservation(device.getProperty(refresh.property)?.value, refresh, before);
      };
      if (refresh.expected !== undefined && settled()) return true;
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        try {
          await this.beforeDeadline(this.registry.refreshedList(sn), remaining);
        } catch (error) {
          if (!(error instanceof RefreshWindowClosedError)) throw error;
          break;
        }
        if (epoch !== this.realtimeEpoch) return false;
        if (settled()) return true;
        const delay = Math.min(500, deadline - Date.now());
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (refresh.expected !== undefined && settled()) return true;
      }
      throw new StateConvergenceError({
        sn,
        property: refresh.property,
        param: refresh.param,
        expected: refresh.expected,
        observed: this.registry.require(sn).params?.[refresh.param],
        timeoutMs: refresh.timeoutMs,
      });
    })();
  }

  /** Serialize one complete state-transition transaction behind its keyed predecessor. */
  private enqueueStateTransition<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const predecessor = this.stateTransitions.get(key);
    const current = (async (): Promise<T> => {
      if (predecessor) {
        try {
          await predecessor;
        } catch {}
      }
      return operation();
    })();
    const tracked = current.finally(() => {
      if (this.stateTransitions.get(key) === tracked) this.stateTransitions.delete(key);
    });
    this.stateTransitions.set(key, tracked);
    return tracked;
  }

  /**
   * Recycle a standalone device's P2P session after a write that needs one, waiting only
   * {@link SESSION_RECYCLE_WAIT_MS} for it.
   *
   * The recycle itself waits for every viewer to detach, so that a write does not drop a live stream.
   * That wait is unbounded by design — a viewer may watch indefinitely — and it happens INSIDE the keyed
   * transaction, so the next write to the same member queues behind it. Racing it decouples the two: the
   * losing recycle stays pending and still runs when the station falls idle, it just stops gating an
   * unrelated write.
   *
   * A failure reported before the bound propagates; one arriving after it survives only as the session
   * manager's own log, since by then nothing is waiting to receive it.
   */
  private recycleStandaloneSession(sn: string): Promise<void> {
    const releaseWrite = new Promise<void>((resolve) => void setTimeout(resolve, SESSION_RECYCLE_WAIT_MS).unref?.());
    return Promise.race([
      this.p2p.resetStandaloneSession(sn),
      releaseWrite.then(() =>
        this.opts.logger?.debug(
          `[session ${sn}] recycle still waiting on an attached viewer — releasing the write that asked for it`,
        ),
      ),
    ]);
  }

  /**
   * Whether the DECODED property now reads what the write asked for.
   *
   * Compared against {@link CommandObservation.observed} where the property's decode is not the identity, and
   * against the raw expectation only where the two coincide. A disable-bit param reports `0` for a property
   * that reads `true`, so comparing the decoded value against the raw expectation would reject a write that
   * had landed — the value converged and the transition event never fired.
   */
  private matchesObservation(
    value: unknown,
    refresh: SemanticEventRefresh & { expected?: boolean | number | string; observed?: boolean | number | string },
    before: unknown,
  ): boolean {
    const want = refresh.observed ?? refresh.expected;
    return want === undefined ? value !== before : String(value) === String(want);
  }

  private eventRefreshKey(sn: string, refresh: Pick<CommandObservation, "param">): string {
    return `${sn}:${refresh.param}`;
  }

  /** Limit waiting on an unabortable dependency operation to the remaining semantic-event refresh window. */
  private beforeDeadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new RefreshWindowClosedError("refresh window closed")),
        Math.max(0, timeoutMs),
      );
      operation.then(
        (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      );
    });
  }

  /**
   * Fan one inbound P2P frame out: raw escape hatch, device state, then semantic events.
   *
   * The frame is decoded against the capabilities of the device it came FROM, resolved from the
   * `(station, channel)` pair — a shared command id (1700 serves pan-tilt, spotlight and privacy)
   * would otherwise let an unrelated module's parser fabricate an event. The decode is a model
   * concern kept on this side of the boundary, so the router never imports model.
   *
   * Frame events carry the station, which cannot say WHICH attached device reported when a station
   * fans same-kind sensors out by channel, so the resolved serial is folded in; a payload's own
   * fields still win on conflict.
   *
   * Params the station volunteered land as device state first. They arrive in the cloud record's own
   * `param_type → value` shape, so no capability has to claim an id it does not own, and the reads
   * they back stop waiting for the next cloud poll. A capability decode follows for the frames that
   * report a bare value rather than that array, which the generic unwrap cannot recognise. Semantic
   * events are edge-triggered: the same change also arrives as a push seconds later, and is announced
   * once.
   */
  private onP2PFrame(stationSn: string, f: P2PFrame): void {
    this.emit("p2p", f);
    const caps = this.registry.capabilitiesForFrame(stationSn, f.channel);
    const deviceSn = this.registry.serialForFrame(stationSn, f.channel);
    const signal = { source: "p2p-frame" as const, ...f };
    if (f.params) this.applyRealtimeState(deviceSn, f.params);
    this.applyRealtimeReport(deviceSn, decodeCapabilityState(signal, caps));
    for (const ev of decodeCapabilityEvent(signal, caps))
      this.emitSemantic(ev.event, deviceSn ? { deviceSn, ...ev.payload } : ev.payload, {
        edge: true,
        refresh: ev.refresh,
      });
  }

  /**
   * Record the state this signal reports, and say whether it merely repeats the last one announced.
   *
   * One physical change reaches the SDK on several transports — an entry sensor's contact arrives as
   * a station notify ~2 s before the identical FCM push — and is announced once. The comparison is
   * edge-triggered on the field a capability declared
   * ({@link CapabilityModule.stateEvents}) rather than time-windowed: a genuine open→close→open burst
   * differs from the last value at every step and passes intact, where any window wide enough to
   * cover the transport spread would have swallowed the second open.
   *
   * Returns `false` — never a repeat — in the three cases where suppressing would lose information:
   * an event no module declared as state-carrying (a pulse: motion, a doorbell press, whose
   * consecutive occurrences are all real), a signal carrying no value for the field (it says nothing
   * about the state, so it can neither duplicate nor overwrite it), and one that can't be attributed
   * to a device (announcing twice beats suppressing a different device's change).
   */
  private noteState(event: string, payload: Record<string, unknown>): boolean {
    const field = STATE_EVENT_FIELDS[event];
    if (!field) return false;
    const value = payload[field];
    if (value === undefined) return false;
    const sn = typeof payload["deviceSn"] === "string" ? payload["deviceSn"] : undefined;
    if (!sn) return false;
    const key = `${sn}:${event}`;
    if (this.lastStateAnnounced.get(key) === value) return true;
    this.lastStateAnnounced.set(key, value);
    return false;
  }

  /**
   * Begin (or resume) login. Returns a `LoginResult` — switch on `status`:
   *  - `ok` → authenticated (`result.session`).
   *  - `captcha` → show `result.image`, then {@link solveCaptcha}(answer).
   *  - `2fa` → a code was sent; {@link submitVerifyCode}(code).
   *
   * A restored session resolves straight to `ok`. No exceptions for the expected captcha/2FA flow.
   *
   * @example
   * ```ts
   * const res = await eufy.login();
   * if (res.status === "captcha") await eufy.solveCaptcha(await promptUser(res.image));
   * else if (res.status === "2fa") await eufy.submitVerifyCode(await promptUser());
   * ```
   */
  async login(opts: { messageType?: number } = {}): Promise<LoginResult> {
    return this.afterLogin(await this.mega.login(opts));
  }

  /** Continue a `{status:"captcha"}` login with the solved answer. See {@link login}. */
  async solveCaptcha(answer: string, opts: { messageType?: number } = {}): Promise<LoginResult> {
    return this.afterLogin(await this.mega.solveCaptcha(answer, opts));
  }

  /** Continue a `{status:"2fa"}` login with the verify code that was sent. See {@link login}. */
  async submitVerifyCode(code: string): Promise<LoginResult> {
    return this.afterLogin(await this.mega.submitVerifyCode(code));
  }

  /**
   * On a successful login, kick off auto-realtime (unless `autoRealtime:false`). Fire-and-forget so
   * `login()` returns as soon as the session is ready — realtime channels come up in the background and
   * surface failures via `error`. Idempotent through the retained generation promise.
   */
  private afterLogin(result: LoginResult): LoginResult {
    if (result.status === LoginStatus.Ok) {
      if (this.storedImageAccount && this.storedImageAccount !== result.session.userId) this.storedImages?.clear();
      this.storedImageAccount = result.session.userId;
      const auth = this.mega.auth;
      if (auth?.userId) this.tuya.bind(auth.userId, this.mega.regionShard, this.opts.countryCode);
      if (this.opts.autoRealtime !== false) void this.ensureRealtime();
    }
    return result;
  }

  /**
   * Wait for the auto-managed realtime startup begun by the current successful {@link login}.
   *
   * A caller-specific timeout does not cancel startup. Calls made before successful login reject with
   * `login() first`; clients configured with `autoRealtime:false` resolve as `disabled` without opening
   * a transport.
   */
  async waitForRealtime(options: WaitForRealtimeOptions = {}): Promise<RealtimeReadiness> {
    if (!this.loggedIn) throw new Error("login() first");
    if (this.opts.autoRealtime === false) {
      return {
        state: "disabled",
        push: createPlaneReadiness(),
        mqtt: createPlaneReadiness(),
        wiredP2p: createPlaneReadiness(),
      };
    }
    const generation = this.realtimeGeneration;
    if (!generation) throw new Error("login() first");
    if (generation.epoch !== this.realtimeEpoch) {
      return generation.superseded ?? readinessSnapshot(generation.readiness, "superseded");
    }
    if (options.timeoutMs === undefined) return generation.promise;
    const timeoutMs = Math.max(0, options.timeoutMs);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(readinessSnapshot(generation.readiness, "timed-out")), timeoutMs);
      timer.unref?.();
      void generation.promise.then((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  /** Raw mega HTTP client, for endpoints not yet wrapped. */
  get api(): MegaHttpClient {
    return this.mega;
  }

  /**
   * Fetch the per-user secure-MQTT credentials for realtime appliance control. Pass `appName` to
   * request a specific capability scope on the current session without re-logging in — security
   * devices (locks/garage) need the `eufy_security` scope, which the default scope can't reach.
   */
  getUserMqttInfo(appName?: string): Promise<SecureMqttCredentials> {
    // The returned credential's publish scope is set by `app-name`; `eufy_security` yields a distinct
    // security-scoped credential that the default scope's credential can't substitute for.
    return this.mega.getUserMqttInfo(appName);
  }

  /**
   * A {@link CommandSink} bound to one device serial. This is the one place a device's commands fan out
   * to whichever transport it actually has — so capability modules and `getDevice` callers never need to
   * know which, and this facade names no capability and builds no wire bytes itself. The `ff09-*` kinds
   * ride ONE shared frame over BOTH P2P and secure-MQTT, so they're routed by the device's topology
   * (`p2p_did` present → P2P, else MQTT); the chosen router re-resolves its own routing tail. Every
   * other kind is P2P.
   */
  private commandSinkFor(sn: string): CommandSink {
    return {
      dispatch: async (cmd: Command) => {
        const observation = commandObservation(cmd);
        if (!observation) {
          await this.routeCommand(sn, cmd);
          return;
        }
        const key = this.eventRefreshKey(sn, observation);
        const epoch = this.realtimeEpoch;
        const owner = this.commandRefreshes.get(key);
        const currentOwner = owner?.epoch === epoch ? owner : { epoch, count: 0 };
        currentOwner.count += 1;
        this.commandRefreshes.set(key, currentOwner);
        let acknowledge!: () => void;
        let reject!: (error: unknown) => void;
        let acknowledged = false;
        const acknowledgement = new Promise<void>((resolve, rejectPromise) => {
          acknowledge = () => {
            acknowledged = true;
            resolve();
          };
          reject = rejectPromise;
        });
        const release = (): void => {
          if (this.commandRefreshes.get(key) === currentOwner) {
            currentOwner.count -= 1;
            if (currentOwner.count === 0) this.commandRefreshes.delete(key);
          }
        };
        const transaction = this.enqueueStateTransition(key, async () => {
          try {
            if (epoch !== this.realtimeEpoch) throw new Error("observed command superseded by disconnect");
            await this.routeCommand(sn, cmd);
            acknowledge();
            const refreshed = await this.refreshEventState(sn, observation);
            if (!refreshed || epoch !== this.realtimeEpoch) return;
            this.emitSemantic(observation.event, { deviceSn: sn });
            if (observation.resetStandaloneSession) await this.recycleStandaloneSession(sn);
          } catch (error) {
            if (!acknowledged) reject(error);
            else this.reportUnacknowledged(error);
          } finally {
            release();
          }
        });
        void transaction.catch((error) => {
          if (!acknowledged) reject(error);
          else this.reportUnacknowledged(error);
          release();
        });
        return acknowledgement;
      },
    };
  }

  /**
   * Combine explicit P2P media with the optional passive push-thumbnail provider.
   *
   * The retained still also becomes the answer for a live still that could not be captured. One session
   * serves one camera at a time and a live view outranks a tile — a still does not open a connection of its
   * own — so a still asked for while a sibling is being watched is refused at the transport. Answering the retained bytes answers the read rather than
   * failing it, marked {@link MediaProvider.snapshotLive} `retained` so the caller knows they are not
   * current. With nothing retained the refusal stands.
   */
  private mediaProviderFor(sn: string): MediaProvider {
    const media = this.p2p.mediaProviderFor(sn);
    const cache = this.storedImages;
    if (!cache) return media;
    const retainedStill = () => {
      if (!this.mega.loggedIn) return Promise.reject(new Error("login() first"));
      return cache.snapshotStored(sn);
    };
    return {
      ...media,
      snapshotStored: retainedStill,
      snapshotLive: async (opts) => {
        try {
          return await media.snapshotLive(opts);
        } catch (error) {
          if (!(error instanceof LiveSnapshotUnavailableError)) throw error;
          const retained = await retainedStill().catch(() => undefined);
          const geometry = retained && jpegGeometry(retained);
          if (!retained || !geometry) throw error;
          (this.opts.logger ?? noopLogger).debug(
            `[media] a live still was unavailable (${error.reason}) — answering the retained one instead`,
          );
          return { jpeg: retained, ...geometry, retained: true };
        }
      },
    };
  }

  /**
   * Choose the transport stack for one command — the routing half of {@link commandSinkFor}.
   *
   * The `ff09-*` kinds share ONE frame that rides either transport, so each stack is asked whether it
   * drives this device (`claimsDevice`) rather than inferring from the kind. `registry.require` throws
   * on an unloaded serial, so a routing decision never silently falls through to the wrong transport.
   * The `eufy_life` DP writes (smart lights) are secure-MQTT-only. `aiot-dp` routes to either the
   * Anker AIoT MQTT stack or the legacy Tuya REST router depending on the device's category
   * (`eufy_home_tuya` → Tuya, everything else → MQTT). The capability layer emits a single `aiot-dp`
   * kind and stays transport-agnostic; only the facade sees both sides and decides here. Everything
   * else is P2P.
   */
  private routeCommand(sn: string, cmd: Command): Promise<void> {
    if (cmd.kind === "ff09-actuate" || cmd.kind === "ff09-autolock" || cmd.kind === "ff09-setting-toggle") {
      const dev = this.registry.require(sn);
      if (P2PCommandRouter.claimsDevice(dev)) return this.p2p.dispatchCommand(sn, cmd);
      if (MqttCommandRouter.claimsDevice(dev)) return this.mqtt.dispatchCommand(sn, cmd);
      throw new Error(`no transport stack claims device ${sn} for a ${cmd.kind} command`);
    }
    if (cmd.kind === "mqtt-dp" || cmd.kind === "mqtt-dp-preset" || cmd.kind === "mqtt-dp-color") {
      return this.mqtt.dispatchCommand(sn, cmd);
    }
    if (cmd.kind === "aiot-dp") {
      const dev = this.registry.require(sn);
      if (dev.category === "eufy_home_tuya") return this.tuya.dispatchCommand(sn, cmd);
      return this.mqtt.dispatchCommand(sn, cmd);
    }
    return this.p2p.dispatchCommand(sn, cmd);
  }

  /**
   * List + classify devices across all houses (mega API). Each device is tagged with its API backend
   * + realtime transport. Camera/HomeBase records still appear here for inventory; driving them is
   * P2P. Delegates to `DeviceRegistry` (the house-scoped merge/dedupe lives there).
   *
   * Side-effect: registers `eufy_home_tuya` devices with the Tuya command router so
   * the command dispatcher can resolve a eufy SN → Tuya devId without a separate lookup.
   * The Tuya id is extracted from the device's raw cloud record (`tuya_uuid`, `tuya_virtual_id`,
   * `tuya_device_id`, or `virtualId` fields — whichever is non-empty).
   *
   * A partial cloud outage still resolves, with the devices that answered plus the ones already known — but a
   * session the cloud has rejected REJECTS, with {@link SessionExpiredError}. An empty list would be
   * indistinguishable from an account with no devices.
   */
  async getDevices(): Promise<EufyDevice[]> {
    const devices = await this.registry.getDevices();
    for (const dev of devices) {
      if (dev.category !== "eufy_home_tuya") continue;
      const raw = (dev.raw ?? {}) as Record<string, unknown>;
      const devId = tuyaDevIdFrom(raw);
      if (devId) this.tuya.registerDevice(dev.sn, devId);
    }
    return devices;
  }

  /** Devices that this client drives over MQTT (transport ≠ p2p). */
  getMqttDevices(): EufyDevice[] {
    return this.registry.mqttDevices();
  }

  /**
   * One page of a robot vacuum's **cleaning history**, in whatever order the cloud returns it —
   * newest first in practice, but that is the gateway's contract and the SDK does not re-sort.
   *
   * `pageSize` is how many records to return and `page` is 1-based; page through until the returned
   * `total` is reached. Answers an empty page rather than throwing when the account has no history for
   * the device or the response cannot be read.
   *
   * Each record carries a `downloadUrl` for the run's binary detail blob (map and per-run statistics).
   * The SDK hands that URL over rather than fetching it — the host is unconfirmed and the blob's format
   * is not evidenced yet.
   */
  async getCleanRecords(deviceSn: string, pageSize = 20, page = 1): Promise<CleanRecordPage> {
    try {
      return parseCleanRecords(await this.mega.getCleanRecords(deviceSn, pageSize, page));
    } catch (err) {
      this.opts.logger?.debug?.(`[clean] record list failed: ${(err as Error).message}`);
      return EMPTY_CLEAN_RECORD_PAGE;
    }
  }

  /**
   * Inspect one device by serial: resolve its codec/capabilities, cross-reference every reported
   * `param_type` against the param dictionary, and emit a paste-ready `registry.ts` row plus
   * dictionary snippets for anything unknown. Loads the device list if needed; prefers
   * the live `get_device_param_list` for freshest params, falling back to the device-list params.
   */
  async inspectDevice(sn: string): Promise<DeviceInspection> {
    return this.registry.inspectDevice(sn);
  }

  /**
   * The device's LIVE, authoritative `rtsp://` URL — host, path, and the credentials it is
   * enforcing right now — or `undefined` when none is pushed within the read window.
   *
   * A thin public door onto the P2P transport (which stays internal otherwise): opens the
   * station's session on demand, so a viewer adopting a tile can call this directly without one
   * already existing. It writes only the publish switch and the test-stream provoke, never the
   * credentials, so a stream a NAS/NVR already consumes keeps its own pair.
   *
   * This is the CANONICAL way to fetch the URL: it provokes and returns it. The `rtsp` capability's
   * `url` member surfaces the SAME value as inbound state for code that already holds a `dev.rtsp()`
   * and reacts to `propertyChanged` — not a second way to fetch it.
   *
   * Every failure — no route, no account id, level-2 not ready, no push before the deadline — collapses
   * to `undefined`. The distinction the caller might want (terminal "no RTSP" vs a transient "session
   * not warm yet") is not drawn here yet; a caller that retries on `undefined` recovers from the
   * transient case. The read window is a fixed 12 s — long enough for a cold HomeBase to wake and
   * answer, and about the ceiling a UI adopting a tile will wait — deliberately not caller-tunable.
   */
  async reportedRtspUrl(sn: string): Promise<string | undefined> {
    return this.p2p.readReportedRtspUrl(sn);
  }

  /**
   * Build a live {@link Device} model object for one serial: the resolved codec/capabilities with
   * its current param values applied (named via the param dictionary; unknown ids kept as
   * `unknown_<pt>`). This is the device primitive — `dev.getProperties()`, `dev.has(cap)`, etc.
   * Prefers fresh `get_device_param_list`, falls back to the device-list params.
   * Under auto-realtime the returned Device is wired with a read-through freshness cache (see
   * {@link Device.setFreshnessPolicy}), so repeat reads are served from cache instead of re-fetching,
   * and realtime updates keep values fresh.
   *
   * That refresh ANNOUNCES what it lands, like the other two inbound paths. Under frequent reads it
   * fires every `cacheTtlMs` where the poll fires every ten minutes, so it is where most fresh cloud values
   * arrive — and each announcing path is edge-triggered on the same live state, so whichever sees a change
   * first announces it and the others stay silent. Its timing says only when a caller happened to read; the
   * value is the news. It applies what the device volunteered over realtime on top of the cloud half, which
   * the registry keeps apart, so it can neither revert nor announce a revert of a report already landed.
   *
   * The `Device` returned is held WEAKLY: it is what the inbound paths announce against, so a caller that
   * wants property changes for a serial keeps its own reference. Dropping it stops the announcements, not
   * the device.
   *
   * @example
   * ```ts
   * const dev = await eufy.getDevice(sn);
   * if (dev.has("camera")) await dev.camera?.()?.snapshotStored?.();
   * console.log(dev.getProperty("battery"));
   * ```
   */
  async getDevice(sn: string): Promise<Device> {
    await this.awaitFirstRealtimeState(sn);
    const rec = await this.registry.record(sn);
    const dev = Device.fromRecord(sn, rec, this.opts.logger);
    if (rec.dpParams) dev.applyParams(rec.dpParams);
    this.liveDevices.set(sn, new WeakRef(dev));
    const ctx = await this.commandContext(sn);
    dev.bindActions(
      ctx,
      this.commandSinkFor(sn),
      this.mediaProviderFor(sn),
      this.ff09SettingsReaderFor(sn, ctx),
      rawDpCodec,
    );
    this.boundParamIds.set(sn, ctx.paramIds);
    if (this.opts.autoRealtime !== false) {
      dev.setFreshnessPolicy({
        staleAfterMs: this.opts.cacheTtlMs ?? 15_000,
        refresh: async () => {
          const fresh = await this.registry.record(sn);
          this.applyAndAnnounce(dev, { ...fresh.params, ...fresh.dpParams });
        },
      });
    }
    return dev;
  }

  /**
   * The {@link Ff09SettingsReader} behind `dev.lock()?.getAutoLockState()` — picks P2P vs MQTT the same
   * way {@link commandSinkFor} does for writes, so `lock.ts` never has to know which transport this
   * device has. `undefined` when `ctx.adminUserId` is missing (not a lock-family device — mirrors
   * `CommandContext.adminUserId`'s own doc: "present on lock-family devices, absent elsewhere").
   *
   * It earns its own boundary because `GET_SETTINGS` is a request/reply query that neither
   * `CommandSink` (write-only) nor `MediaProvider.p2pQuery` (P2P-only, no decrypt) fits. Named for the
   * frame family rather than the capability, so this facade stays capability-neutral like the layers
   * below it — see `CapabilityModule.actions`'s doc before adding another.
   */
  private ff09SettingsReaderFor(sn: string, ctx: CommandContext): Ff09SettingsReader | undefined {
    if (!ctx.adminUserId) return undefined;
    const adminUserId = ctx.adminUserId;
    const deviceSn = ctx.serial ?? "";
    return {
      getAutoLockState: () =>
        ctx.hasP2p
          ? this.p2p.getAutoLockState(sn, { adminUserId, deviceSn })
          : this.mqtt.getAutoLockState(sn, { adminUserId, deviceSn }),
    };
  }

  /**
   * Auto-realtime bring-up — the SDK owns connectivity so the host calls no `connect*`. Runs once per
   * session after a successful login (unless `autoRealtime:false`). Starts the **always-on, battery-safe**
   * channels — FCM push (account-wide events) + secure MQTT (iff appliances present) — and eagerly warms
   * P2P **only for wired stations** (HomeBases / mains cameras, which don't drain). Battery cameras are
   * left detached: their P2P opens on demand (command / stream, or an opted-in event pre-warm) and
   * idle-detaches. All channels start concurrently; a single failure surfaces via `error` without
   * aborting the rest.
   */
  private ensureRealtime(): Promise<RealtimeReadiness> {
    return this.ensureRealtimeGeneration().promise;
  }

  /** Create or join the one transport bring-up owned by the current realtime epoch. */
  private ensureRealtimeGeneration(): RealtimeGeneration {
    if (this.realtimeGeneration?.epoch === this.realtimeEpoch) return this.realtimeGeneration;
    const epoch = this.realtimeEpoch;
    let resolve!: (readiness: RealtimeReadiness) => void;
    const promise = new Promise<RealtimeReadiness>((done) => (resolve = done));
    const generation: RealtimeGeneration = {
      epoch,
      readiness: {
        state: "ready",
        push: createPlaneReadiness(1),
        mqtt: createPlaneReadiness(),
        wiredP2p: createPlaneReadiness(),
      },
      promise,
      resolve,
      abort: new AbortController(),
      settled: false,
    };
    this.realtimeGeneration = generation;
    void this.startRealtimeGeneration(generation);
    return generation;
  }

  /** Start all selected transports concurrently and settle their owning generation once. */
  private async startRealtimeGeneration(generation: RealtimeGeneration): Promise<void> {
    const { epoch, readiness } = generation;
    try {
      if (!this.registry.list().length) await this.getDevices();
      if (epoch !== this.realtimeEpoch) return this.settleRealtimeGeneration(generation, "superseded");
      const scopes = this.mqttScopesInUse();
      readiness.mqtt = createPlaneReadiness(scopes.length);
      let push: PushClient | undefined;
      let startupFailed = false;
      const pushStart = this.startPush(generation.abort.signal).then(
        (client) => {
          push = client;
          readiness.push.ready++;
          readiness.push.pending--;
        },
        (error) => {
          if (error instanceof RealtimeStartupSupersededError) return;
          readiness.push.failed++;
          readiness.push.pending--;
          this.reportError(error);
        },
      );
      const mqttStarts = scopes.map((scope) =>
        this.ensureMqttStarted(scope, epoch).then(
          () => {
            readiness.mqtt.ready++;
            readiness.mqtt.pending--;
          },
          (error) => {
            readiness.mqtt.failed++;
            readiness.mqtt.pending--;
            this.reportError(error);
          },
        ),
      );
      const wiredStart = this.warmWiredP2P(readiness.wiredP2p, generation.abort.signal).then(
        (result) => {
          readiness.wiredP2p = result;
        },
        (error) => {
          this.reportError(error);
          readiness.wiredP2p.pending = 0;
          startupFailed = true;
        },
      );
      await Promise.all([pushStart, ...mqttStarts, wiredStart]);
      if (epoch !== this.realtimeEpoch) {
        push?.close();
        return this.settleRealtimeGeneration(generation, "superseded");
      }
      this.pushClient = push;
      this.schedulePoll();
      const failures = readiness.push.failed + readiness.mqtt.failed + readiness.wiredP2p.failed;
      this.settleRealtimeGeneration(generation, failures || startupFailed ? "partial" : "ready");
    } catch (e) {
      this.reportError(e);
      readiness.push.failed += readiness.push.pending;
      readiness.push.pending = 0;
      this.settleRealtimeGeneration(generation, epoch === this.realtimeEpoch ? "partial" : "superseded");
    }
  }

  /** Resolve a generation with an immutable count snapshot; later transport completions are ignored. */
  private settleRealtimeGeneration(generation: RealtimeGeneration, state: RealtimeReadiness["state"]): void {
    if (generation.settled) return;
    generation.settled = true;
    generation.readiness.state = state;
    generation.result = readinessSnapshot(generation.readiness);
    generation.resolve(generation.result);
  }

  /**
   * Arm the next cloud-param poll. Re-arms from the END of each run rather than on a fixed interval,
   * so a slow list fetch can never stack overlapping polls, and re-arms in `finally` so a failed poll
   * (a transient cloud error) doesn't silently kill the loop for the session's remaining life.
   *
   * Disabled by `pollMs: 0`, and never started when `autoRealtime:false` — a host that opted out of
   * SDK-managed connectivity gets no background traffic. Also declines to re-arm once the bring-up
   * that armed it has been superseded, so a poll that fires as the client shuts down can't resurrect
   * the loop after teardown.
   */
  private schedulePoll(epoch = this.realtimeEpoch): void {
    const every = this.opts.pollMs ?? DEFAULT_POLL_MS;
    if (every <= 0 || epoch !== this.realtimeEpoch) return;
    this.pollTimer.arm(every, () => {
      void this.pollOnce().finally(() => this.schedulePoll(epoch));
    });
  }

  /** The effective cloud poll interval in ms — the configured {@link EufyMegaOptions.pollMs} or the default. */
  get pollIntervalMs(): number {
    return this.opts.pollMs ?? DEFAULT_POLL_MS;
  }

  /**
   * Change the cloud poll interval at runtime; `ms` is the gap between polls, `0` disables polling.
   *
   * Takes effect immediately: the pending tick is cancelled and the loop re-armed at the new interval
   * (or left cancelled for `0`). Unlike the constructor {@link EufyMegaOptions.pollMs}, this can be
   * changed after login.
   */
  setPollInterval(ms: number): void {
    this.opts.pollMs = ms;
    this.pollTimer.cancel();
    this.schedulePoll();
  }

  /**
   * One poll pass: re-read the device list, land what moved on the live devices, announce every property
   * whose value changed, and emit a semantic event for every param that changed value since the last pass.
   *
   * `propertyChanged` is the generic channel this exists for: most readable members arrive only as a
   * cloud param and no push carries them, so re-reading was the only way a caller could learn one had
   * moved and re-reading cannot say WHEN. A capability's own `source:"poll"` mapping is beside it, for a
   * state that carries something a bare property change cannot (`contact.ts` maps the contact param as a
   * third transport for a state its push and its station notify also report).
   *
   * Each change is decoded against the reporting device's capabilities, the same argument the push path
   * passes: a param id claimed by more than one capability cannot be resolved without it, so a poll
   * event declared on a contested id would be declared and then silently never emitted.
   *
   * Also emits `deviceState` for each device the diff reports as having re-reported. That is tracked
   * apart from the param diff because the two are different facts: the cloud can re-stamp a param with
   * an unchanged VALUE, which is no state change to report but is fresh proof the device is alive. A
   * device absent from the previous pass is skipped — first sight is discovery, not a transition;
   * {@link deviceState} answers an initial reading.
   */
  private async pollOnce(): Promise<void> {
    try {
      const diff = await this.registry.pollChanges();
      for (const dev of diff.added) this.emit("deviceAdded", dev);
      for (const dev of diff.removed) this.emit("deviceRemoved", dev);
      this.applyPolledParams(diff.params);
      for (const change of diff.params)
        for (const out of decodeCapabilityEvent({ source: "poll", ...change }, this.capsForEvent(change.deviceSn)))
          this.emitSemantic(out.event, out.payload, { refresh: out.refresh });
      for (const dev of diff.reported) this.emit("deviceState", this.stateOf(dev));
      for (const change of diff.params) await this.widenCapabilities(change.deviceSn);
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * Land a poll pass's CHANGES on every live {@link Device} and announce what moved, BEFORE anything
   * else derived from them is emitted.
   *
   * Ordered that way because live state is the map every capability getter reads: a listener reading a
   * getter inside a poll event handler has to see the value that event is about. The read-through
   * freshness policy cannot stand in for this — it fires on a READ of a stale value and hands that read
   * the stale one, so a value nothing happens to read is never refreshed by it.
   *
   * The CHANGES, not the whole post-change map {@link ParamChange} also carries. That map is there so an
   * event decode can read sibling params; applying it would revert every id a realtime report made
   * fresher, because {@link DeviceRegistry.applyRealtimeParams} keeps a report apart from the cloud
   * record's params — the cloud list carries the pre-report value long after the device volunteered the
   * new one, so an open door reads as closed on the next pass that sees anything on that device move.
   *
   * That precedence is the reason a moved id is also RETIRED from the report map
   * ({@link DeviceRegistry.retireRealtimeParams}). The report outranks the cloud only while it is the
   * fresher half, and a diff on that id is the cloud stating a transition of its own — so left in place
   * the report would outrank it forever, and the next join of the two halves would revert this pass's
   * value and announce the revert. Retired for EVERY device the diff touched, not only a live one: the
   * join also feeds the `Device` a later {@link getDevice} builds, which no live entry exists for yet.
   */
  private applyPolledParams(changes: readonly ParamChange[]): void {
    const byDevice = new Map<string, RawParams>();
    for (const change of changes) {
      const params = byDevice.get(change.deviceSn) ?? {};
      params[change.paramType] = change.to;
      byDevice.set(change.deviceSn, params);
    }
    for (const [sn, params] of byDevice) {
      this.registry.retireRealtimeParams(sn, Object.keys(params).map(Number));
      const device = this.liveDeviceToAnnounce(sn);
      if (device) this.applyAndAnnounce(device, params);
    }
  }

  /**
   * The live {@link Device} for a serial, for a path that is about to ANNOUNCE against it — reporting
   * once when one the caller asked for has since been collected.
   *
   * An announcement carries the value read out of that device's own live state, so a collected device
   * cannot be announced for, and the caller is the only thing keeping one alive — {@link liveDevices} is
   * weak by contract. Losing announcements that way fails in the three worst ways at once: it is
   * non-deterministic (it turns on when the collector runs, so it holds in development and stops under
   * memory pressure), silent (no error, the events simply cease), and non-local (the obligation is on
   * {@link getDevice}, the symptom shows on `propertyChanged`).
   *
   * Neither alternative is available: re-deriving the value outside live state is two answers for one
   * reading, which is the disagreement the announcement exists to remove, and keeping every device alive
   * here reverses this map's own invariant. So it is LOUD.
   *
   * Reported only for a serial the caller DID ask for, since one never fetched has no object by definition
   * and was never owed an announcement — reporting those would name most of the account on every pass. The
   * dead entry is dropped as it is reported, which is what makes it once: a device let go on purpose must
   * not narrate every inbound signal for the rest of the session, and a later {@link getDevice} re-registers
   * the serial and resumes announcing.
   *
   * Deliberately not routed through {@link reportError}: nothing in this SDK failed, so it must not reach a
   * host's `error` handling. It is a usage fact, reported at `warn`.
   */
  private liveDeviceToAnnounce(sn: string): Device | undefined {
    const held = this.liveDevices.get(sn);
    if (!held) return undefined;
    const device = held.deref();
    if (device) return device;
    this.liveDevices.delete(sn);
    this.opts.logger?.warn?.(
      `[eufy] ${sn}: the Device handed to this caller has been garbage-collected, so its propertyChanged ` +
        `announcements have stopped. Keep a reference to every Device you want them for; getDevice(sn) resumes them.`,
    );
    return undefined;
  }

  /**
   * Apply a param map to one live {@link Device} and announce every property it moved, one
   * `propertyChanged` each. The one place the two halves are joined, shared by all three inbound paths
   * that reach live state.
   *
   * The device decides which of the changed names it will stand behind and what value each carries
   * ({@link Device.announcements}), so this stays a fan-out: no capability name, no member id, and no
   * second conversion of a wire value that could disagree with the getter beside it.
   *
   * Only a device a caller is HOLDING is announced for, because the announced value is read out of that
   * device's own live state and a serial nobody asked for has none. Resolving one on demand could not
   * help: a device built from the already-updated record has nothing to diff against, so the pass that
   * created it could never be the pass it announces. Such a device's liveness still reaches a host as
   * `deviceState`.
   *
   * Echoes of the SDK's own writes are announced rather than suppressed. An inbound path cannot tell a
   * change it caused from one an external actor caused, and suppressing on that guess is unsound, not
   * merely conservative: if a user also changes the value in the vendor app inside the window, the real
   * external change is the one lost — a wrong state held indefinitely, against one redundant idempotent
   * re-read.
   */
  private applyAndAnnounce(device: Device, params: RawParams): void {
    for (const change of device.announcements(device.applyParams(params)))
      this.emitSemantic("propertyChanged", { deviceSn: device.sn, ...change });
  }

  /**
   * Re-resolve a device a caller is holding, in case fresher evidence granted it a capability.
   *
   * A capability is granted on evidence the device reports, so one resolved before it had reported a
   * param lacks the capability that param proves — permanently, for that object, even once the value
   * starts arriving. This closes the gap for the `Device` instances already handed out: on new
   * evidence they gain the accessor, bound, without the caller re-fetching.
   *
   * Only widens, never retracts, and re-binds only when something was actually gained, so the common
   * poll costs one set comparison. Best-effort: a device that has been dropped, or a re-bind that
   * fails, must not break the poll loop for every other device.
   *
   * The whole record goes in, never a field-by-field copy of it: since this path only ever ADDS, a
   * field left behind here re-grants what the first resolution deliberately withheld — an attached
   * camera would take back the hub's guard mode on the first param change the poll saw.
   */
  private async widenCapabilities(sn: string): Promise<void> {
    const dev = this.liveDevices.get(sn)?.deref();
    if (!dev) return;
    try {
      const gained = dev.reresolve(await this.registry.record(sn));
      if (!gained.length) return;
      const ctx = await this.commandContext(sn);
      dev.bindActions(
        ctx,
        this.commandSinkFor(sn),
        this.mediaProviderFor(sn),
        this.ff09SettingsReaderFor(sn, ctx),
        rawDpCodec,
      );
      this.boundParamIds.set(sn, ctx.paramIds);
      this.emit("deviceCapabilities", { deviceSn: sn, gained, capabilities: [...dev.capabilities] });
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * Open the P2P session for ONE device's station, and nothing else.
   *
   * Auto-realtime warms every wired station on the account, which is what a host driving a
   * fleet wants. A caller that needs exactly one station does not: an unreachable station broadcasts a
   * local lookup to `255.255.255.255` **once a second for the full connect timeout** and sends a PPCS
   * lookup to every cloud address in the same tick, so warming a fleet to talk to one camera is a
   * burst of broadcast and NAT churn on the user's network for stations nobody asked about. Pair this
   * with `autoRealtime: false` to open only what is being used.
   *
   * Resolves when the station is connected; rejects on its connect timeout. Best-effort and idempotent
   * — an already-open session resolves immediately.
   */
  async connectStation(deviceSn: string, signal?: AbortSignal): Promise<void> {
    if (!this.registry.list().length) await this.getDevices();
    await this.p2p.ensureStation(this.p2p.stationKeyOf(deviceSn), signal);
  }

  /** Eagerly open P2P sessions for WIRED stations only (persistent — they don't drain). Battery
   *  stations stay closed until an on-demand open. Best-effort per station. */
  private async warmWiredP2P(
    readiness = createPlaneReadiness(),
    signal?: AbortSignal,
  ): Promise<RealtimePlaneReadiness> {
    const wired = new Set<string>();
    for (const d of this.registry.p2pDevices()) {
      const key = this.p2p.stationKeyOf(d.sn);
      if (this.stationPower(key) === "wired") wired.add(key);
    }
    readiness.required = wired.size;
    readiness.pending = wired.size;
    await Promise.all(
      [...wired].map((sn) =>
        this.p2p.ensureStation(sn, signal).then(
          () => {
            readiness.ready++;
            readiness.pending--;
          },
          (_error) => {
            if (signal?.aborted) return;
            readiness.failed++;
            readiness.pending--;
          },
        ),
      ),
    );
    return readiness;
  }

  /**
   * A station's power tier for the P2P lifecycle: a HomeBase/station is `"wired"` (persistent); a
   * standalone device is `"battery"` iff its resolved capabilities include `battery`, else `"wired"`.
   * Keyed on the STATION's own power, never a child's (a battery cam attached to a wired HomeBase draws
   * from the base's persistent session). Reads capabilities on the client side — no model type leaks to
   * transport (the router only ever sees the `"wired"|"battery"` string).
   */
  private stationPower(parentSn: string): PowerTier {
    const d = this.registry.list().find((x) => x.sn === parentSn);
    if (!d) return "wired";
    if (d.deviceClass === "homebase") return "wired";
    const raw = (d.raw ?? {}) as Record<string, any>;
    const caps = resolveDevice({
      deviceType: typeof raw.device_type === "number" ? (raw.device_type as number) : undefined,
      model: d.model,
      category: d.category,
      params: d.params ?? {},
    }).capabilities;
    return caps.includes("battery") ? "battery" : "wired";
  }

  /**
   * Speculatively open the P2P session of the station behind `deviceSn`, if the caller opted this
   * semantic event in — so a stream or talkback opened right after a doorbell ring or a detection starts
   * warm instead of paying a cold open.
   *
   * Four gates. `autoRealtime: false` means the SDK opens nothing on its own initiative at all;
   * {@link EufyMegaOptions.prewarmEvents} must name the event, and it names none by default, which is
   * what makes pre-warm opt-in; the station must be one the account actually reports; and its power tier
   * must be one {@link EufyMegaOptions.prewarmTiers} allows.
   *
   * The tier is resolved for the STATION whose session would open, which is why an attached camera is
   * judged by its base — {@link P2PCommandRouter.stationKeyOf} is the single source of that mapping, and
   * {@link stationPower} of the tier. A station with no record of its own is declined rather than
   * pre-warmed: {@link stationPower} answers `"wired"` for one it cannot find, because the tier it feeds
   * the session lifecycle must always be an answer — and taking that answer here is how a battery camera
   * gets pre-warmed under a `"wired"`-only opt-in.
   *
   * Best-effort and unawaited: a pre-warm nobody uses must cost the caller nothing, so a failed open
   * surfaces on `error` like any other background transport failure.
   */
  private prewarmForEvent(event: string, deviceSn: string): void {
    if (this.opts.autoRealtime === false) return;
    if (!this.prewarmEvents.has(event)) return;
    const station = this.p2p.stationKeyOf(deviceSn);
    if (!this.registry.list().some((device) => device.sn === station)) return;
    if (!this.prewarmTiers.has(this.stationPower(station))) return;
    void this.p2p.prewarm(station, this.opts.prewarmMs);
  }

  /**
   * Connect a secure-MQTT transport for one credential scope (appliances: vacuum, light, plug,
   * display) using credentials fetched from the cloud, and return it **connected but not installed**:
   * {@link ensureMqttStarted} owns installing it, subscribing devices, and the epoch check, so that
   * lifecycle lives in exactly one place. Only ever called through {@link ensureMqttStarted}.
   *
   * Identified by a client id built from this client's `openudid`, not by the certificate's name:
   * that name is `{user_id}-{app_name}`, which every client on the account shares per line, and a
   * duplicate client id is a takeover the broker resolves by evicting the incumbent. The id shape is
   * the app's own (`android-{app_name}-{uid}-{uuid}-{ts}`, see {@link buildAppShapedClientId}), which
   * the broker grants on the `eufy_security` credential.
   *
   * It separates two clients exactly as far as their `openudid` does: a caller that supplies none
   * gets the value derived from the account, which every such client shares — the same condition
   * under which their logins already displace each other (`MegaClientConfig.openudid`).
   *
   * A client id the broker REFUSES falls back to the certificate's name, since a shared channel beats
   * none, and that transport then keeps that name until {@link disconnect}. Only a refusal: a connect
   * that fails for any other reason rejects the bring-up, which clears its memo in
   * {@link ensureMqttStarted} so the next one asks under this client's own id again — a dropped
   * socket must not be what moves a process onto the shared name for good.
   */
  private async startMqtt(scope: MqttScope): Promise<SecureMqtt> {
    const auth = this.mega.auth;
    if (!auth) throw new Error("login() first");
    if (!this.registry.list().length) await this.getDevices();

    const creds = await this.getUserMqttInfo(mqttAppName(scope));
    const ownClientId = buildAppShapedClientId({
      appName: creds.app_name ?? mqttAppName(scope) ?? "eufy_mega",
      uid: creds.user_id ?? auth.userId,
      mqttUuid: mqttUuidFrom(this.mega.openudid),
    });
    try {
      return await this.connectMqtt(creds, ownClientId);
    } catch (e) {
      if (!isNotAuthorized(e)) throw e;
      this.opts.logger?.warn(
        "[smqtt] the broker refused this client's own id; connecting under the certificate's name, which " +
          "another client signed in to this account takes over",
        e,
      );
      return await this.connectMqtt(creds);
    }
  }

  /**
   * Connect one secure-MQTT transport under `clientId`, or under the certificate's own name when it is
   * omitted, and wire its decode and fan-out. See {@link startMqtt} for which id is used and why.
   *
   * The fan-out is wired once the connection stands, so an attempt that is discarded — a client id the
   * broker refuses, a socket that dies mid-handshake — never reports a connection a consumer never had;
   * the connect it just completed is announced here instead. Errors raised while connecting are held
   * only to keep an emitter without an `error` listener from throwing, and are reported once the
   * transport is one a consumer owns.
   *
   * The inbound decode is gated by the reporting device's own capabilities, so one line's decoder never
   * runs against another's traffic, and the DP frame is unwrapped here — the layer that may import the
   * transport — so a capability reads tags without owning any framing.
   */
  private async connectMqtt(creds: SecureMqttCredentials, clientId?: string): Promise<SecureMqtt> {
    const transport = new SecureMqtt({ credentials: creds, clientId, logger: this.opts.logger });

    const whileConnecting: unknown[] = [];
    const hold = (e: unknown): void => void whileConnecting.push(e);
    transport.on("error", hold);
    await transport.connect();
    transport.off("error", hold);

    transport.on("connect", () => this.emit("connect"));
    transport.on("disconnect", (r) => this.emit("disconnect", r));
    transport.on("message", (m) => {
      this.emit("message", m); // raw MQTT message (low-level escape hatch)
      if (m.deviceSn) {
        const dev = this.registry.list().find((d) => d.sn === m.deviceSn);
        if (dev?.category === "eufy_home_tuya") {
          const dps = parseTuyaDpReport(m.raw);
          if (dps) {
            this.tuyaDpRouter.deliver(m.deviceSn, dps);
            return;
          }
        }
      }
      if (m.deviceSn) {
        // The map stream. A protocol-41 message is nothing else, so it stops here rather than being
        // walked by DP parsers that would each correctly decline it.
        const frame = parseBizMapFrame(m.raw);
        if (frame) {
          this.emit("mapFrame", { deviceSn: m.deviceSn, frame });
          this.applyMapFrame(m.deviceSn, frame);
          return;
        }
      }
      if (m.topic) this.processAvailabilityMessage(m.topic, m.raw);
      const signal = {
        source: "mqtt" as const,
        deviceSn: m.deviceSn,
        topic: m.topic,
        raw: m.raw,
        frame: parseDpMessage(m.raw),
        dpParams: parseAiotDpReport(m.raw),
      };
      const caps = m.deviceSn ? this.capsForEvent(m.deviceSn) : undefined;
      this.applyRealtimeReport(m.deviceSn, decodeCapabilityState(signal, caps));
      for (const out of decodeCapabilityEvent(signal, caps))
        this.emitSemantic(out.event, out.payload, { edge: true, refresh: out.refresh });
    });
    transport.on("error", (e) => this.reportError(e));

    this.emit("connect");
    for (const e of whileConnecting) this.reportError(e);
    return transport;
  }

  /**
   * Subscribe the devices on one credential scope; a failing subscribe is reported, not fatal (one
   * unreachable device must not stop the rest of the roster from coming up).
   */
  private async subscribeMqttDevices(scope: MqttScope, transport: SecureMqtt): Promise<void> {
    for (const d of this.getMqttDevices().filter((dev) => mqttScopeFor(dev) === scope)) {
      try {
        await transport.subscribeDevice(d);
        await this.sendRealtimeInit(d.sn);
        // For Tuya clean-line devices, poll cached DPs immediately after subscribe so the
        // capability getters have state before the first realtime push arrives.
        if (d.category === "eufy_home_tuya") {
          this.tuya
            .fetchDps(d.sn)
            .then((dps) => {
              if (dps) this.tuyaDpRouter.deliver(d.sn, dps);
            })
            .catch((e) => this.reportError(e));
        }
      } catch (e) {
        this.reportError(e);
      }
    }
  }

  /**
   * Send whatever a device's capabilities want sent once its realtime channel is up — for a line whose
   * state is pushed on change with no heartbeat, the request that makes its state readable before the
   * first write. Best-effort: reported, never fatal, since a device that ignores it is only left with
   * the state it would have had anyway.
   */
  private async sendRealtimeInit(sn: string): Promise<void> {
    const caps = this.registry.capabilitiesForDevice(sn);
    if (!caps || !needsRealtimeInit(caps)) return;
    const cmds = buildRealtimeInit(caps, await this.commandContext(sn));
    if (!cmds.length) return;
    const sink = this.commandSinkFor(sn);
    for (const cmd of cmds) await sink.dispatch(cmd);
  }

  /**
   * The open P2P sessions, by key. P2P is auto-managed: wired stations are warmed at login, battery
   * stations open on demand (command / stream, or an opted-in event pre-warm) and idle-detach — so this
   * map grows and shrinks over time.
   *
   * A station's own session is keyed by its serial, and `p2pConnect(stationSn)` / `p2pClose(stationSn)`
   * track those. A station serving more than one camera at once also holds a session per extra camera,
   * keyed `<stationSn>#live:<channel>` — these carry media alone and raise no connection events, because
   * a station announces its state to every client that connects and reporting each copy would double
   * every event the station's own session already delivers.
   */
  getP2pSessions(): Map<string, P2PSession> {
    return this.p2p.getSessions();
  }

  /**
   * The liveness facts for one device — see {@link DeviceState}. Facts, not an `online` verdict: "how
   * long is too long" is a threshold that belongs to the caller, and it differs per device class.
   *
   * The `deviceState` event announces when a device reports in.
   */
  deviceState(sn: string): DeviceState {
    const dev = this.registry.list().find((d) => d.sn === sn);
    return dev ? this.stateOf(dev) : { sn, stationSn: this.p2p.stationKeyOf(sn) };
  }

  /**
   * Return the latest explicit availability observation for `sn`, or `undefined` when no verified
   * vendor signal has been observed. This never derives a state from {@link DeviceState.lastSeenMs},
   * connection silence, P2P lifecycle, operation failures or caller-selected timeouts.
   */
  deviceAvailability(sn: string): AvailabilityObservation | undefined {
    return this.availabilityObservations.get(sn);
  }

  /** Decode a verified wire signal, then assign its device-availability semantics at the client seam. */
  private processAvailabilityMessage(topic: string, raw: unknown): void {
    const signal = parseStateInfoSignal(topic, raw);
    if (!signal) return;
    this.applyAvailabilityObservation({
      entity: { kind: "device", sn: signal.deviceSn },
      availability: signal.status ? "available" : "unavailable",
      source: { transport: "smqtt", signal: "state-info" },
      scope: "device",
      ...(signal.observedAt === undefined ? {} : { observedAt: signal.observedAt }),
      ...(signal.sequence === undefined ? {} : { sequence: signal.sequence }),
      receivedAt: Date.now(),
    });
  }

  /**
   * Retain one authoritative observation per device and emit only state transitions. When both the
   * previous and incoming envelopes supply ordering evidence, an older message cannot overwrite newer
   * device truth. Exact duplicate ordering cannot reverse state. If comparable vendor ordering is
   * absent, handler arrival order defines which explicit observation is later. A same-state observation
   * still refreshes the retained evidence without re-emitting.
   */
  private applyAvailabilityObservation(observation: AvailabilityObservation): void {
    const sn = observation.entity.sn;
    const previous = this.availabilityObservations.get(sn);
    if (previous) {
      const sameSource =
        previous.source.transport === observation.source.transport &&
        previous.source.signal === observation.source.signal;
      const bothTimed = previous.observedAt !== undefined && observation.observedAt !== undefined;
      if (bothTimed && observation.observedAt! < previous.observedAt!) return;
      if (sameSource && (!bothTimed || observation.observedAt === previous.observedAt)) {
        if (
          previous.sequence !== undefined &&
          observation.sequence !== undefined &&
          observation.sequence < previous.sequence
        ) {
          return;
        }
        if (
          previous.sequence !== undefined &&
          observation.sequence === previous.sequence &&
          observation.availability !== previous.availability
        ) {
          return;
        }
      }
    }

    this.availabilityObservations.set(sn, observation);
    if (previous?.availability !== observation.availability) this.emit("availability", observation);
  }

  /**
   * The {@link DeviceState} for a device record already in hand — the shape {@link deviceState} returns
   * once it has resolved the serial, reused by the poll loop so emitting for a batch of devices doesn't
   * re-scan the roster per device.
   */
  private stateOf(dev: EufyDevice): DeviceState {
    return { sn: dev.sn, stationSn: this.p2p.stationKeyOf(dev.sn), lastSeenMs: dev.lastSeenMs };
  }

  /**
   * The capability set to disambiguate an inbound push/poll id with, or `undefined` when the serial is
   * unknown. Push ids are namespaced per device family, so the same integer means different things on
   * different hardware; `decodeEvent` needs the device's capabilities to pick the right mapping and
   * deliberately stays silent rather than guessing when it can't.
   */
  private capsForEvent(deviceSn: string | undefined): ReadonlySet<Capability> | undefined {
    return deviceSn ? this.registry.capabilitiesForDevice(deviceSn) : undefined;
  }

  /**
   * **Write** a device property. Asks the capability modules to build the command for this
   * `(name, value)` — the module owns how THIS device applies it. No `(name, value)` recipe → the
   * device doesn't support the property, so we throw {@link CapabilityNotSupportedError} rather than
   * a silent no-op. On success the device echoes the new state back as a param update — read it with
   * {@link getDevice} to confirm.
   *
   * @param sn device serial.
   * @param name property name (e.g. "light", "brightness", "enabled").
   * @param value desired value.
   *
   * @example
   * ```ts
   * await eufy.setProperty(sn, "brightness", 50);
   * await eufy.setProperty(sn, "light", true);
   * ```
   */
  async setProperty(sn: string, name: string, value: boolean | number | string): Promise<void> {
    // WRITE path. Every property resolves through the
    // capability modules: the module picks the right command variant for THIS device (JSON control
    // vs direct-binary vs burst, which param id), and the sink routes it to the transport
    // (HomeBase-vs-standalone handled downstream). No cascade. P2P write is fire-and-forget, so a
    // missing recipe must throw, not silently no-op.
    const ctx = await this.commandContext(sn);
    const cmd = buildCapabilityCommand(name, value, ctx);
    // No module produced a command for this (device, action) → the device doesn't support it.
    // Throw instead of silently no-op'ing (the P2P write path is fire-and-forget).
    if (!cmd) throw new CapabilityNotSupportedError(sn, name);
    await this.commandSinkFor(sn).dispatch(cmd);
  }

  /**
   * Restart a HomeBase.
   *
   * **HomeBases only** — restart is a hub operation, so a non-HomeBase serial (a camera, an NVR)
   * throws rather than doing nothing. The hub drops its connection and returns after a minute or two,
   * so everything behind it is briefly offline. Verified on real hardware.
   */
  async reboot(sn: string): Promise<void> {
    const ctx = await this.commandContext(sn);
    if (!isHomeBase({ deviceType: ctx.deviceType, model: ctx.model })) {
      throw new Error(
        `reboot: ${sn} is not a HomeBase (deviceType ${ctx.deviceType ?? "?"}, model ${ctx.model ?? "?"}) — ` +
          `restart is a hub-only operation`,
      );
    }
    await this.p2p.rebootStation(sn);
  }

  /**
   * Build the {@link CommandContext} for a device: the evidence a capability uses to resolve a
   * command variant (channel, codec, deviceType, model, reported param/DP ids) plus the RESOLVED
   * capability set that gates command building.
   *
   * Resolves from the same fresh `DeviceRegistry.record` (`get_device_param_list` overlay +
   * category) and `resolveDevice` that {@link getDevice} uses, so the capability set here is byte-for-byte
   * what `device.has(cap)` / `buildActions` saw — a command is never rejected for a capability the
   * device model advertises.
   *
   * `paramIds` is cloud params UNION whatever the device reported over realtime — it is the evidence
   * gate behind the typed read getters, so a line whose state only ever arrives live still advertises
   * exactly the reads it has.
   */
  private async fetchDpCatalog(model: string): Promise<DpCatalog> {
    const cached = this.dpCatalogCache.get(model);
    if (cached) return cached;
    try {
      const raw = await this.mega.getProductDataPoint(model);
      const catalog = parseDpCatalog(raw);
      this.dpCatalogCache.set(model, catalog);
      return catalog;
    } catch {
      this.dpCatalogCache.set(model, EMPTY_DP_CATALOG);
      return EMPTY_DP_CATALOG;
    }
  }

  private async commandContext(sn: string): Promise<CommandContext> {
    const rec = await this.registry.record(sn);
    // Resolve the record synchronously from the registry (already loaded by `record()`) — the same
    // single lookup the command sink uses, and it never opens a transport just to read a record.
    const dev = this.registry.require(sn);
    const raw = (dev.raw ?? {}) as Record<string, any>;
    const rawChannel = raw.device_channel;
    const channel = typeof rawChannel === "number" ? rawChannel : 0;
    const member = (raw.member ?? {}) as Record<string, any>;
    const resolved = resolveDevice(rec);
    const dpCatalog =
      (resolved.codec === "vacuum" || resolved.codec === "mower") && rec.model
        ? await this.fetchDpCatalog(rec.model)
        : undefined;
    return {
      channel,
      codec: resolved.codec,
      deviceType: rec.deviceType,
      model: rec.model,
      category: dev.category,
      serial: sn,
      // Identity metadata for `info`, for a host's device-registry surface. `name` = the app-shown
      // device_name (registry's `name`), not the resolved codec/inferred name. firmware/hardware come
      // straight off the device record: `main_sw_version` / `main_hw_version` — the same fields the v6
      // app maps to `firmware_main_version` / `hardware_version`. `undefined` when the record omits them.
      name: dev.name,
      firmwareVersion: recordString(raw, "main_sw_version"),
      hardwareVersion: recordString(raw, "main_hw_version"),
      firmwareSubVersion: recordString(raw, "sec_sw_version"),
      macAddress: recordString(raw, "wifi_mac"),
      updateAvailable: raw.needUpdate === true || raw.needUpdate === 1 || raw.needUpdate === "1",
      paramIds: new Set([...Object.keys(rec.params), ...Object.keys(rec.dpParams ?? {})].map(Number)),
      capabilities: new Set(resolved.capabilities),
      // Member identity for ff09-* command devices (see core/contracts Ff09Identity).
      adminUserId: typeof member.admin_user_id === "string" ? member.admin_user_id : undefined,
      shortUserId: typeof member.short_user_id === "string" ? member.short_user_id : undefined,
      accountName: this.mega.accountName || undefined,
      // The same claim the command sink routes on — a capability gates its P2P-only variants (e.g.
      // setRainMode) on this. Keyed on the P2P stack's own predicate (a usable `p2p_did` endpoint).
      hasP2p: P2PCommandRouter.claimsDevice(dev),
      // Topology as the record states it: a parent that isn't the device itself means HomeBase-attached.
      homeBaseAttached: !!raw.parent_sn && raw.parent_sn !== dev.sn,
      dpCatalog,
    };
  }

  /**
   * **Generic P2P request/reply query** — sends a `SET_PAYLOAD` sub-command and resolves with the
   * reply frame's `payload`. Transport-only escape hatch (the router owns the wire); the caller owns
   * the sub-command id and the reply shape (e.g. the doorbell's 6237 quick-response list).
   * @internal
   */
  p2pQuery(sn: string, subCmd: number, opts: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    return this.p2p.p2pQuery(sn, subCmd, opts);
  }

  /**
   * Connect FCM push — the always-on, server-initiated channel that delivers event + **thumbnail**
   * notifications (motion/person/doorbell/package, each with a thumbnail URL). Independent of
   * MQTT/P2P. On first run it registers a push token, tells the eufy cloud to push to it, then holds
   * the socket. With a `pushStore`, the token + seen ids persist so later runs just reconnect. Emits:
   *   - `push(event)` — normalised `PushEvent` (deviceSn, eventType, eventName,
   *     thumbnailUrl, cipher, payload, raw)
   *   - `pushRaw(raw)` — the raw `RawPushMessage`
   *   - `pushConnect` / `pushDisconnect`
   *
   * Started automatically by {@link ensureRealtime} after login. A semantic event the caller opted into
   * via {@link EufyMegaOptions.prewarmEvents} — none by default — also speculatively pre-warms that
   * camera's P2P session, so a following stream or talkback starts warm; {@link prewarmForEvent} owns that
   * decision, and the router stays event-agnostic.
   *
   * Returns the connected client rather than installing it. Registration can outlive a `disconnect()`,
   * and {@link ensureRealtime} owns the decision of whether a finished bring-up is still the current
   * one — so this never overwrites a channel a later login already brought up.
   */
  private async startPush(signal?: AbortSignal): Promise<PushClient> {
    if (!this.mega.auth) throw new Error("login() first");
    const store = this.opts.pushStore ?? new MemoryFcmStore();
    let persisted = store.load();
    if (!persisted) {
      const creds = await new FcmRegistrar(this.opts.logger).register();
      persisted = { creds, persistentIds: [] };
      store.save(persisted);
    }
    const persistedCreds = persisted.creds;

    // Tell the eufy cloud to push this account's events to our token (best-effort
    // — the MCS socket still receives even if this call's exact shape drifts).
    try {
      await this.mega.registerPushToken(persisted.creds.fcmToken);
    } catch (e) {
      this.reportError(e);
    }

    const client = new PushClient(persisted.creds, this.opts.logger);
    client.setPersistentIds(persisted.persistentIds);
    client.on("connect", () => this.emit("pushConnect"));
    client.on("disconnect", () => this.emit("pushDisconnect"));
    client.on("message", (raw: RawPushMessage) => this.emit("pushRaw", raw));
    client.on("push", (ev: PushEvent) => {
      // Enrich the transport-neutral push with its human event label (the transport stays
      // capability-blind — the id→name mapping is a model concern).
      if (ev.eventName === undefined && ev.eventType != null) ev.eventName = detectionName(ev.eventType);
      if (ev.thumbnailCandidate) void this.observeStoredImage(ev.thumbnailCandidate);
      this.emit("push", ev); // raw normalized push (low-level escape hatch)
      // Capabilities map the push eventType → a semantic event (motion / doorbellPress / lockState…).
      const signal = {
        source: "push" as const,
        eventType: ev.eventType,
        eventName: ev.eventName,
        deviceSn: ev.deviceSn,
        stationSn: ev.stationSn,
        thumbnailUrl: ev.thumbnailUrl,
        payload: ev.payload as Record<string, unknown>,
      };
      for (const out of decodeCapabilityEvent(signal, this.capsForEvent(ev.deviceSn))) {
        this.emitSemantic(out.event, out.payload, { edge: true, refresh: out.refresh });
        const dsn = (out.payload.deviceSn as string | undefined) ?? ev.deviceSn;
        if (dsn) this.prewarmForEvent(out.event, dsn);
      }
      store.save({ creds: persistedCreds, persistentIds: client.getPersistentIds() });
    });
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        client.off("connect", onConnect);
        client.off("error", onError);
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        client.close();
        reject(error);
      };
      const onAbort = () => {
        cleanup();
        client.close();
        reject(new RealtimeStartupSupersededError());
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      client.once("connect", onConnect);
      client.once("error", onError);
      client.connect();
    });
    client.on("error", (e) => this.reportError(e));
    return client;
  }

  /** Admit only exact, account-known devices with resolved snapshot evidence into the passive store. */
  private async observeStoredImage(candidate: NonNullable<PushEvent["thumbnailCandidate"]>): Promise<void> {
    if (!this.storedImages || candidate.attribution.kind !== "device") return;
    const account = this.mega.auth?.userId;
    if (!account) return;
    try {
      if (!this.registry.list().length) await this.registry.getDevices();
      if (this.mega.auth?.userId !== account) return;
      const caps = this.registry.capabilitiesForDevice(candidate.attribution.deviceSn);
      if (caps && hasProvidedAction(caps, "snapshotStored")) {
        this.storedImages.observe(candidate.attribution.deviceSn, candidate.url);
      }
    } catch (e) {
      this.reportError(e);
    }
  }

  /**
   * Tear down every realtime channel: close the secure-MQTT transport, all P2P sessions, and the FCM
   * push socket. Idempotent — safe to call when nothing is connected. Leaves the login session intact
   * (call {@link login} again to reconnect without re-authenticating).
   */
  async disconnect(): Promise<void> {
    this.realtimeEpoch++;
    this.stateTransitions.clear();
    this.commandRefreshes.clear();
    if (this.realtimeGeneration) {
      const generation = this.realtimeGeneration;
      generation.superseded = readinessSnapshot(generation.result ?? generation.readiness, "superseded");
      generation.abort.abort();
      this.settleRealtimeGeneration(generation, "superseded");
    }
    await this.teardownRealtime();
  }

  /**
   * Disconnect and forget every installed secure-MQTT transport.
   *
   * Clearing both installed transports and their in-flight memos lets the next successful login own a
   * fresh set. Individual stale attempts retain their epoch guard and close only the transport they
   * created, so they cannot clear a successor generation's map.
   */
  private async closeMqttTransports(): Promise<void> {
    await Promise.all([...this.transports.values()].map((t) => t.disconnect()));
    this.transports.clear();
    this.mqttReady.clear();
  }

  /**
   * Close every realtime channel and stop the poll loop.
   *
   * Safe to run twice: each channel is cleared as it closes. The edge-trigger's memory of announced
   * states goes with them: it describes what was announced over a connection that no longer exists,
   * and keeping it would suppress the first report after a reconnect as a duplicate — leaving nothing
   * announced until the state next physically changes.
   */
  private async teardownRealtime(): Promise<void> {
    this.pollTimer.cancel();
    this.lastStateAnnounced.clear();
    await this.closeMqttTransports();
    await this.p2p.closeAll();
    this.pushClient?.close();
    this.pushClient = undefined;
  }

  /** True if a usable session (restored from store or freshly logged in) is held. */
  get loggedIn(): boolean {
    return this.mega.loggedIn;
  }

  /** Tear down realtime, clear passive media, and forget the persisted login session. */
  async logout(): Promise<void> {
    await this.disconnect();
    this.clearSession();
  }

  /** Forget the persisted session (forces a fresh login + 2FA next time) and clear account-owned media. */
  clearSession(): void {
    this.storedImages?.clear();
    this.storedImageAccount = undefined;
    this.mega.clearSession();
  }
}
