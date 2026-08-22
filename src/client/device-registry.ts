/**
 * DeviceRegistry — the device list/record/capability-resolution collaborator behind {@link EufyMega}.
 *
 * The facade owns orchestration + event fan-out; this owns the resolution logic: fetching + merging
 * the (house-scoped, quirky) device list, overlaying a fresh param list per device, and resolving which
 * capability set a P2P frame's (station, channel) belongs to (a hot-path cache). Isolated here so the
 * tricky bits are unit-testable with a fake `mega` — the facade stays pure wiring. It never names a
 * capability or a wire; it maps records to the model's `resolveDevice`/`inspectParams`.
 */
import { MegaHttpClient } from "../transport/http/mega-client.js";
import { classifyDevice, type DeviceClass, type EufyDevice, type RealtimeKind } from "../core/types.js";
import { inspectParams, resolveDevice, type Capability, type Codec, type DeviceInspection } from "../model/index.js";

/** The device-record shape {@link EufyMega.getDevice}/`commandContext` resolve a serial to. */
export interface DeviceRecord {
  deviceType?: number;
  model?: string;
  category?: string;
  /** The app-shown device name (`device_name`); see {@link CloudRecord.name}. */
  name?: string;
  /** Parent HomeBase serial when attached (topology signal; see {@link CloudRecord.parentSn}). */
  parentSn?: string;
  params: Record<number, string>;
  /** Per-param `update_time` in **unix seconds** (see {@link EufyDevice.paramUpdatedAt}). */
  paramUpdatedAt: Record<number, number>;
  /**
   * State the device reported over its realtime wire, as ids in its own param namespace.
   *
   * Kept apart from {@link params} rather than merged into it because the two differ in provenance and
   * staleness: cloud params are a slow server-side heartbeat snapshot, these are the device's own live
   * report. Capability detection reads only `params`, so a realtime id can never steer which
   * capabilities a device is judged to have.
   */
  dpParams?: Record<number, string>;
}

/**
 * One param that changed value between two polls — the input the facade turns into a
 * `source:"poll"` inbound signal. Carries the whole post-change param map so a capability that needs
 * sibling params to interpret the change can read them.
 */
export interface ParamChange {
  deviceSn: string;
  paramType: number;
  from: string;
  to: string;
  params: Record<number, string>;
}

/**
 * What one poll pass observed: params whose value moved, devices that joined or left the account, and
 * devices that merely re-reported. All four come from a single device-list fetch.
 */
export interface PollDiff {
  params: ParamChange[];
  added: EufyDevice[];
  removed: EufyDevice[];
  /**
   * Devices whose {@link EufyDevice.lastSeenMs} advanced since the previous pass — fresh proof the
   * device is alive, tracked apart from {@link params} because the cloud can re-stamp a param with an
   * unchanged VALUE. That is no state change to report, but it is a liveness signal. A device seen for
   * the first time is absent here: first sight is discovery, not a transition.
   */
  reported: EufyDevice[];
}

/** One `{param_type, param_value, update_time}` entry as the cloud delivers it, in either param list. */
interface RawParam {
  param_type?: number;
  param_value?: unknown;
  update_time?: unknown;
}

/**
 * Merge a raw param array into `params` (value) + `paramUpdatedAt` (freshness), in place.
 *
 * `update_time` is the wire's own **unix-seconds** stamp and is optional per entry, so a param without
 * one contributes a value and no timestamp rather than a zero — a fake `0` would read as "last seen in
 * 1970" and poison {@link lastSeenMsOf}. An entry with no `param_value` is skipped entirely rather than
 * stringified: `"undefined"` would be indistinguishable from a real value, and the id would still land
 * in `ctx.paramIds` and evidence-gate a typed read into existence. Shared by both param sources (the
 * device list and the per-device live list) so the two can never drift apart.
 */
function mergeParams(
  raw: readonly RawParam[] | undefined,
  params: Record<number, string>,
  paramUpdatedAt: Record<number, number>,
): void {
  for (const p of raw ?? []) {
    if (!p || p.param_type == null || p.param_value == null) continue;
    params[p.param_type] = String(p.param_value);
    const ts = Number(p.update_time);
    if (Number.isFinite(ts) && ts > 0) paramUpdatedAt[p.param_type] = ts;
  }
}

/**
 * The freshest param timestamp as **milliseconds**, or `undefined` when nothing was stamped — the
 * derivation behind {@link EufyDevice.lastSeenMs}. Converts from the wire's seconds exactly once, here.
 */
function lastSeenMsOf(paramUpdatedAt: Record<number, number>): number | undefined {
  let newest = 0;
  for (const ts of Object.values(paramUpdatedAt)) if (ts > newest) newest = ts;
  return newest > 0 ? newest * 1000 : undefined;
}

/**
 * A resolved {@link Codec} → the coarse {@link DeviceClass} a host groups by.
 *
 * Derived rather than listed: `codecForType` already owns the DeviceType space and treats camera as the
 * residual bucket, so a newly-released SKU classifies correctly with no edit here. `lock`, `keypad` and
 * `light` collapse to `"other"` because `DeviceClass` is intentionally coarse — a host that needs
 * the precise kind reads the capabilities.
 */
const CLASS_BY_CODEC: Record<Codec, DeviceClass> = {
  station: "homebase",
  camera: "camera",
  sensor: "sensor",
  vacuum: "vacuum",
  mower: "mower",
  lock: "other",
  keypad: "other",
  light: "light",
  printer: "printer",
};

/**
 * The coarse {@link DeviceClass} for a resolved codec, given how the device is driven.
 *
 * `camera` is the codec space's RESIDUAL bucket — anything in the security DeviceType range that no
 * other rule claimed, plus the final fallback for a record nothing recognised. That default is right
 * for a P2P device (the security ecosystem really is overwhelmingly cameras) and wrong for anything
 * else: a home appliance on secure MQTT that reaches the fallback is unclassified, not a camera. Those
 * report `"other"` rather than a confident wrong answer, on the same grounds as never shipping a
 * guessed param — a host can tell "we don't know" from "we know it's a camera".
 */
function deviceClassOf(codec: Codec, realtime: RealtimeKind): DeviceClass {
  const cls = CLASS_BY_CODEC[codec];
  return cls === "camera" && realtime !== "p2p" ? "other" : cls;
}

export interface DeviceRegistryDeps {
  mega: MegaHttpClient;
  /** Surface a non-fatal fetch error (a house/body query that failed) without aborting the merge. */
  onError: (e: unknown) => void;
}

export class DeviceRegistry {
  private readonly mega: MegaHttpClient;
  private readonly onError: (e: unknown) => void;
  private devices: EufyDevice[] = [];
  /** Per-(station, channel) capability cache for {@link capabilitiesForFrame}; `null` = negative hit. */
  private readonly frameCapsCache = new Map<string, ReadonlySet<Capability> | null>();
  /**
   * Serials whose per-device param overlay has been refused. The call is owner-gated, so on a shared or
   * member account it fails for the whole life of the client — retrying it every refresh spends a request
   * to learn the same thing, and the answer is reported once rather than on every read.
   */
  private readonly overlayRefused = new Set<string>();
  /** Per-serial capability cache for {@link capabilitiesForDevice}; `null` = negative hit. */
  private readonly deviceCapsCache = new Map<string, ReadonlySet<Capability> | null>();
  /** Per-serial realtime state, keyed by param id in the device's own namespace (see {@link DeviceRecord.dpParams}). */
  private readonly dpParams = new Map<string, Record<number, string>>();
  /** Callers blocked in {@link awaitRealtimeState}, released by the device's first report. */
  private readonly stateWaiters = new Map<string, Set<() => void>>();
  /**
   * Whether the last {@link getDevices} lost at least one query. The house-scoped fetch tolerates a
   * failing house/body call so a partial outage still yields devices — but the result is then a
   * SUBSET, and treating a missing device as removed would tell a host to delete a live one.
   */
  private lastRefreshPartial = false;
  /**
   * The roster {@link pollChanges} last diffed against, and whether it was complete.
   *
   * Held separately from {@link devices} because that cache is refreshed by anything that needs a
   * device — a host's own `getDevices()`, a command sink resolving a serial before an on-demand P2P
   * open. Diffing the shared cache in place would let any of those silently absorb the delta, and the
   * next poll would then see an unchanged account and emit nothing. `undefined` = never polled.
   */
  private pollSnapshot?: { devices: Map<string, EufyDevice>; complete: boolean };

  constructor(deps: DeviceRegistryDeps) {
    this.mega = deps.mega;
    this.onError = deps.onError;
  }

  /** The current device cache (last {@link getDevices} result). */
  list(): EufyDevice[] {
    return this.devices;
  }

  /**
   * List + classify devices across all houses (mega API). Each device is tagged
   * with its API backend + realtime transport (see classifyDevice). Camera/
   * HomeBase records still appear here for inventory; driving them is P2P.
   *
   * A failing house/body query is tolerated so a partial outage still yields devices — but the result
   * is then a SUBSET, and devices it didn't return are KEPT from the previous list rather than dropped.
   * Replacing wholesale would empty the cache during an outage, breaking every serial lookup the
   * command sink and event fan-out depend on, and would then present the whole account as newly
   * discovered once the next refresh succeeded. {@link lastRefreshPartial} records that this happened.
   */
  async getDevices(): Promise<EufyDevice[]> {
    // get_devs_list is quirkily house-scoped: the bare {} call returns a set
    // that the per-house calls may NOT, and vice-versa. Query {} AND every
    // house_id, then merge + dedupe by serial.
    const bodies: Array<object> = [{}];
    let partial = false;
    try {
      const houses = await this.mega.post<{ house_infos?: Array<{ house_id: string }> }>(
        "house",
        "/app/house/get_house_list",
      );
      for (const h of houses.house_infos ?? []) bodies.push({ house_id: h.house_id });
    } catch (e) {
      partial = true;
      this.onError(e);
    }

    const seen = new Map<string, EufyDevice>();
    for (const body of bodies) {
      let res: { devices?: any[] };
      try {
        res = await this.mega.post<{ devices?: any[] }>("house", "/app/house/get_devs_list", body);
      } catch (e) {
        partial = true;
        this.onError(e);
        continue;
      }
      for (const raw of res.devices ?? []) {
        if (!raw?.device_sn) continue;
        const c = classifyDevice(raw);
        const params: Record<number, string> = {};
        const paramUpdatedAt: Record<number, number> = {};
        mergeParams(raw.params, params, paramUpdatedAt);
        const codec = resolveDevice({
          deviceType: raw.device_type,
          model: raw.device_model,
          category: raw.category,
          params,
        }).codec;
        seen.set(raw.device_sn, {
          sn: raw.device_sn,
          name: raw.device_name ?? raw.device_alias_name ?? raw.alias_name,
          model: raw.device_model,
          stationSn: raw.station_sn,
          p2pDid: raw.p2p_did,
          params,
          paramUpdatedAt,
          lastSeenMs: lastSeenMsOf(paramUpdatedAt),
          raw,
          deviceClass: deviceClassOf(codec, c.realtime),
          ...c,
        });
      }
    }
    this.lastRefreshPartial = partial;
    if (partial) for (const prev of this.devices) if (!seen.has(prev.sn)) seen.set(prev.sn, prev);
    this.devices = [...seen.values()];
    // Device list changed → drop stale (station,channel)→caps and serial→caps entries. Params feed
    // capability resolution, so a refresh can legitimately change a device's capability set.
    this.frameCapsCache.clear();
    this.deviceCapsCache.clear();
    return this.devices;
  }

  /**
   * Re-fetch the device list once and report what changed: params whose VALUE moved, plus devices that
   * joined or left the account.
   *
   * Diffs the bulk list rather than polling devices one by one — `getDevices()` already refreshes the
   * whole account in one house-scoped pass, so per-device fetching would multiply requests for the same
   * data, and roster changes fall out of the same response for free.
   *
   * A param is a change only if it existed before with a different value. Newly-appeared params and
   * every param of a newly-appeared device are NOT changes: a device showing up for the first time is
   * discovery (reported as `added`), and treating its whole param set as changes would fire a burst of
   * phantom state events on the first poll.
   *
   * Both halves of the roster diff are gated on the baseline being trustworthy, in opposite directions.
   * `removed` is suppressed when THIS refresh was {@link lastRefreshPartial} — a failed house query
   * yields a subset of the account, and reporting those absences as removals would tell a host to
   * delete devices that are simply unqueried. `added` is suppressed when the PREVIOUS snapshot was
   * incomplete, for the mirror-image reason: a device missing from a partial baseline is not new, and
   * announcing it would present a chunk of an existing account as freshly discovered.
   *
   * The very first pass reports no additions at all — the whole account is the baseline, not a
   * pairing burst. A host enumerating what exists calls {@link getDevices}.
   */
  async pollChanges(): Promise<PollDiff> {
    const base = this.pollSnapshot;
    const params: ParamChange[] = [];
    const added: EufyDevice[] = [];
    const reported: EufyDevice[] = [];
    const devices = await this.getDevices();
    for (const dev of devices) {
      const prev = base?.devices.get(dev.sn);
      if (!prev) {
        if (base?.complete) added.push(dev);
        continue;
      }
      if (dev.lastSeenMs !== undefined && (prev.lastSeenMs === undefined || dev.lastSeenMs > prev.lastSeenMs))
        reported.push(dev);
      const now = dev.params ?? {};
      const was = prev.params ?? {};
      for (const [key, to] of Object.entries(now)) {
        const paramType = Number(key);
        const from = was[paramType];
        if (from !== undefined && from !== to) params.push({ deviceSn: dev.sn, paramType, from, to, params: now });
      }
    }
    const present = new Set(devices.map((d) => d.sn));
    const removed =
      this.lastRefreshPartial || !base ? [] : [...base.devices.values()].filter((d) => !present.has(d.sn));
    this.pollSnapshot = { devices: new Map(devices.map((d) => [d.sn, d])), complete: !this.lastRefreshPartial };
    return { params, added, removed, reported };
  }

  /** Devices driven over eufy secure-MQTT — named positively (not "everything that isn't P2P"), so a
   * device on another realtime plane (e.g. a printer's `ankermake-mqtt`) is not swept onto this one. */
  mqttDevices(): EufyDevice[] {
    return this.devices.filter((d) => d.realtime === "smqtt");
  }

  /** Devices that require P2P (cameras/HomeBases). */
  p2pDevices(): EufyDevice[] {
    return this.devices.filter((d) => d.realtime === "p2p");
  }

  /**
   * Resolve a serial to its cached {@link EufyDevice}, **throwing if it isn't loaded** — the loud
   * synchronous lookup the facade's command sink uses before asking a transport stack whether it claims
   * the device (`P2PCommandRouter.claimsDevice` / `MqttCommandRouter.claimsDevice`). A routing decision
   * must never fall back on a missing record (an unknown serial silently routing to the wrong transport
   * would misroute a fire-and-forget command with no error). Registry owns record resolution; the
   * transport stacks own the claim predicate over the record.
   */
  require(sn: string): EufyDevice {
    const dev = this.devices.find((d) => d.sn === sn);
    if (!dev) {
      throw new Error(`device ${sn} not loaded (have: ${this.devices.map((d) => d.sn).join(", ") || "none"})`);
    }
    return dev;
  }

  /**
   * Resolve a serial to a {@link DeviceRecord} with current params: starts from the device-list params, then
   * overlays a fresh `get_device_param_list` when that call is available to this account.
   *
   * The overlay is **owner-gated** — a shared or member account is refused it for every device — so when it
   * is unavailable the device list is re-fetched instead. That list is not owner-gated and carries the same
   * `{param_type, param_value, update_time}`, which makes it the fallback the overlay's own contract names.
   * Without it this method answered from a cached list it only ever loaded once, so a read-through refresh
   * re-applied the same values with a fresh timestamp and no observation could change for the life of the
   * client — indistinguishable, to a caller, from a device that simply never changed.
   *
   * Shared by {@link EufyMega.getDevice} / {@link EufyMega.inspectDevice} / `commandContext`.
   */
  async record(sn: string): Promise<DeviceRecord> {
    if (!this.devices.length) await this.getDevices();
    else if (this.overlayRefused.has(sn)) await this.getDevices();
    let dev = this.devices.find((d) => d.sn === sn);
    if (!dev) throw new Error(`device ${sn} not found (have: ${this.devices.map((d) => d.sn).join(", ")})`);

    const params: Record<number, string> = { ...(dev.params ?? {}) };
    const paramUpdatedAt: Record<number, number> = { ...(dev.paramUpdatedAt ?? {}) };
    if (!this.overlayRefused.has(sn)) {
      try {
        const live = await this.mega.getDeviceParamList<{ params?: RawParam[] }>(sn);
        mergeParams(live.params, params, paramUpdatedAt);
      } catch (error) {
        this.overlayRefused.add(sn);
        this.onError(error);
        await this.getDevices();
        dev = this.devices.find((d) => d.sn === sn) ?? dev;
        Object.assign(params, dev.params ?? {});
        Object.assign(paramUpdatedAt, dev.paramUpdatedAt ?? {});
      }
    }

    const raw = dev.raw as Record<string, unknown> | undefined;
    const deviceType = typeof raw?.["device_type"] === "number" ? (raw["device_type"] as number) : undefined;
    const station = this.stationOf(dev);
    return {
      deviceType,
      model: dev.model,
      category: dev.category,
      name: dev.name,
      parentSn: station === sn ? undefined : station,
      params,
      paramUpdatedAt,
      dpParams: this.dpParams.get(sn),
    };
  }

  /**
   * Record state a device reported over its realtime wire, merging into whatever it last reported.
   *
   * Merged rather than replaced because a report can be partial — a status frame that omits a field is
   * silent about it, not asserting it went away. Marks the device seen and drops its capability cache,
   * since a newly-reported id can widen the evidence-gated read surface.
   */
  applyRealtimeParams(sn: string, params: Record<number, string>): void {
    if (!Object.keys(params).length) return;
    this.dpParams.set(sn, { ...this.dpParams.get(sn), ...params });
    const dev = this.devices.find((d) => d.sn === sn);
    if (dev) dev.lastSeenMs = Date.now();
    this.deviceCapsCache.delete(sn);
    const waiters = this.stateWaiters.get(sn);
    if (waiters) {
      this.stateWaiters.delete(sn);
      for (const resolve of waiters) resolve();
    }
  }

  /** Whether this device has reported any realtime state yet. */
  hasRealtimeState(sn: string): boolean {
    return !!this.dpParams.get(sn);
  }

  /**
   * Resolve once this device reports realtime state, or after `timeoutMs` — whichever comes first.
   *
   * Exists because the typed read getters are evidence-gated at BIND time: a device resolved before its
   * first report gets no getters, and would keep none however much state arrived afterwards. Resolving
   * (not rejecting) on timeout keeps a silent device merely read-less rather than unusable.
   */
  awaitRealtimeState(sn: string, timeoutMs: number): Promise<void> {
    if (this.hasRealtimeState(sn) || timeoutMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.stateWaiters.get(sn)?.delete(done);
        resolve();
      }, timeoutMs);
      timer.unref?.();
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const set = this.stateWaiters.get(sn) ?? new Set();
      set.add(done);
      this.stateWaiters.set(sn, set);
    });
  }

  /**
   * Inspect one device by serial: resolve its codec/capabilities, cross-reference every reported
   * `param_type` against the param dictionary, and emit a paste-ready `registry.ts` row plus
   * dictionary snippets for anything unknown. The enrichment tool — run it on a new/unconfirmed
   * device and send back the export to grow the device catalog.
   */
  async inspectDevice(sn: string): Promise<DeviceInspection> {
    return inspectParams(await this.record(sn), sn);
  }

  /** Inspect every owned device (the bulk enrichment export). */
  async inspectAllDevices(): Promise<DeviceInspection[]> {
    if (!this.devices.length) await this.getDevices();
    const out: DeviceInspection[] = [];
    for (const d of this.devices) out.push(await this.inspectDevice(d.sn));
    return out;
  }

  /**
   * The serial of the device a P2P frame belongs to, resolved by the same `(station, channel)` pair
   * as {@link capabilitiesForFrame} — the identity half of the same question.
   *
   * A frame-sourced semantic event carries the STATION only, which cannot say which attached device
   * reported it: a station fans several same-kind sensors out by channel, so two entry sensors on one
   * hub would emit indistinguishable events. The facade enriches the payload with this.
   */
  serialForFrame(stationSn: string, channel: number): string | undefined {
    return this.deviceForFrame(stationSn, channel)?.sn;
  }

  /**
   * The parent station a device's frames arrive under.
   *
   * `parent_sn` on the cloud record is the field that is actually populated for a HomeBase-attached
   * device — `stationSn` is frequently absent (observed empty on every attached sensor of a T8010),
   * so keying on it alone silently resolves an attached device to ITSELF and no frame ever matches.
   * Mirrors the router's own session-keying precedence, which is the source of truth for which
   * station a device's traffic belongs to. Answering the device's OWN serial is what "stands alone"
   * means, so this is also the topology signal `record()`/`capsOf` hand the resolver.
   */
  private stationOf(dev: EufyDevice): string {
    const raw = (dev.raw ?? {}) as Record<string, any>;
    return raw.parent_sn && raw.parent_sn !== dev.sn ? (raw.parent_sn as string) : (dev.stationSn ?? dev.sn);
  }

  /**
   * The device a `(station, channel)` pair refers to — a station fans out to attached devices by
   * `device_channel`, while a standalone device is its own station at channel 0.
   *
   * A device claims a channel only when its record actually STATES one. Treating a missing
   * `device_channel` as 0 turns every such device into a rival claimant for channel 0, where a
   * station legitimately has an attached device already, and the winner is then decided by cloud list
   * order — so the same frame resolves to different devices across refreshes. The resolved serial now
   * decides where realtime state is written, not just which decoders may run, so an ambiguous answer
   * writes one device's params onto another.
   *
   * An attached device that names the channel wins over the station itself, which is what a station
   * fanning traffic out by channel means; the station answers for channel 0 only when nothing is
   * attached there, which is also the standalone case (a device is its own station).
   */
  private deviceForFrame(stationSn: string, channel: number): EufyDevice | undefined {
    const attached = this.devices.find((d) => {
      const stated = (d.raw as Record<string, any> | undefined)?.device_channel;
      return typeof stated === "number" && stated === channel && d.sn !== stationSn && this.stationOf(d) === stationSn;
    });
    if (attached) return attached;
    return channel === 0 ? this.devices.find((d) => d.sn === stationSn) : undefined;
  }

  /**
   * Resolve the capability set of the device a P2P frame belongs to — the `(station, channel)` pair
   * (a station fans out to attached devices by `device_channel`; a standalone device is its own
   * station at channel 0). Used to gate the p2p-frame escape-hatch decoders.
   *
   * Runs on the P2P data hot path, so it is synchronous over the already-cached device list (no
   * await / network) and memoized per (station, channel). Returns `undefined` when the device can't
   * be resolved yet — the caller then falls back to running every module.
   */

  capabilitiesForFrame(stationSn: string, channel: number): ReadonlySet<Capability> | undefined {
    const key = `${stationSn}:${channel}`;
    const cached = this.frameCapsCache.get(key);
    if (cached !== undefined) return cached ?? undefined;

    const dev = this.deviceForFrame(stationSn, channel);
    if (!dev) {
      this.frameCapsCache.set(key, null); // negative-cache; getDevices() clears it on refresh
      return undefined;
    }
    const caps = this.capsOf(dev);
    this.frameCapsCache.set(key, caps);
    return caps;
  }

  /**
   * The capability set of a device by serial — the disambiguator for **push / poll** events, whose ids
   * are namespaced per device family and therefore collide across families (a SmartDrop's tamper id is
   * a HomeBase's alarm id). Same role {@link capabilitiesForFrame} plays for P2P frames, keyed by
   * serial because a push carries `deviceSn` rather than a (station, channel).
   *
   * Synchronous over the cached device list and memoized; `undefined` when the serial isn't loaded, so
   * a caller can tell "device has no such capability" from "device unknown" and refuse to guess.
   */
  capabilitiesForDevice(sn: string): ReadonlySet<Capability> | undefined {
    const cached = this.deviceCapsCache.get(sn);
    if (cached !== undefined) return cached ?? undefined;
    const dev = this.devices.find((d) => d.sn === sn);
    if (!dev) {
      this.deviceCapsCache.set(sn, null);
      return undefined;
    }
    const caps = this.capsOf(dev);
    this.deviceCapsCache.set(sn, caps);
    return caps;
  }

  /** Resolve a record's capabilities the way `getDevice` does, so gating matches `device.has()`. */
  private capsOf(dev: EufyDevice): ReadonlySet<Capability> {
    const raw = (dev.raw ?? {}) as Record<string, any>;
    const station = this.stationOf(dev);
    return new Set(
      resolveDevice({
        deviceType: raw.device_type,
        model: dev.model,
        category: dev.category,
        parentSn: station === dev.sn ? undefined : station,
        params: dev.params ?? {},
      }).capabilities,
    );
  }
}
