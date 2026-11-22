/**
 * RTC command router: drives a station the vendor app connects natively over the app's own RTC client.
 *
 * One {@link RtcSignalClient} per station, logged in on first use and kept, as the app keeps one client per hub.
 * Commands ride the PRIV1 call's KCP data channel ({@link priv1}), placed on the first command; a live view places a
 * PM call of its own ({@link pmIce}, {@link RtcPmLiveStream}). Both seal under the station's one
 * {@link RtcCommandCounter}.
 *
 * `set-payload` rides `1350`, JSON `{account_id, cmd, mValue3, payload}`; `set-json` rides `1700`, JSON
 * `{account_id, cmd, commandType, data}`; on channel 255 for the station, the device's own channel for an attached
 * one. Other command kinds are refused. A command waits for the data channel in 20 ms steps, as the app's
 * `getRtcFileChannelConnectedStatus` wait does, and settles on its reply, which is not an observation of the
 * resulting state. A wait that runs out drops the data channel (or, before login, the station), so the next command
 * starts over.
 *
 * The station's database: a `1350` with inner `1306` (CMD_DATABASE) answers a table and inner `1308`
 * (CMD_DATABASE_IMAGE) a stored image, each as the station's notify under that command id, matched by its content
 * (`transaction`, `file`) since the notify stream carries other reports between them.
 *
 * The station serves one live view at a time: a second camera is refused while the first one's view has consumers.
 */
import { setTimeout as sleep } from "node:timers/promises";
import {
  LiveSnapshotUnavailableError,
  type Command,
  type LiveStreamHandle,
  type MediaProvider,
  type SharedSourceHints,
  type AbortableCall,
} from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";
import { abortable } from "../abortable.js";
import { captureSnapshotFromShared } from "../p2p/media.js";
import {
  CMD_DATABASE,
  CMD_DATABASE_IMAGE,
  DB_QUERY,
  DB_TABLE_TIMEOUT_MS,
  fullTableQuery,
} from "../p2p/database-wire.js";
import { openReadableFromConsumer } from "../p2p/readable-egress.js";
import { SharedLiveSource, attachUnlessAborted } from "../p2p/shared-live-source.js";
import { RtcCallType } from "./call.js";
import { cmdGcm, kcpMulti, priv1, type RtcCommandCounter, type RtcDataChannel } from "./data-channel.js";
import { pmIce } from "./ice.js";
import { RtcPmLiveStream, mediaGcm } from "./pm-live.js";
import { RtcSignalClient, type RtcSignalOptions } from "./signal-client.js";

const STATION_CHANNEL = 255;
/** ponytail: one bound for login + data channel; the app's per-request `time_out` is not pinned. */
const CONNECT_TIMEOUT_MS = 20_000;

/** Where a command goes: the station's RTC inputs, and whether it addresses the station or a device on it. */
export interface RtcRoute {
  stationSn: string;
  /** True for a device attached to the station, which keeps the command's own channel. */
  attached: boolean;
  /** The station's `member.admin_user_id`, the payload's `account_id`; the logged-in user when absent. */
  adminUserId?: string;
  /** The station record's `p2p_did`, `p2p_license` and first IPv4 `signaling_servers` host. */
  did: string;
  lic: string;
  host: string;
  /** The station's `main_sw_version` with its dots removed. */
  version: number;
  /** The station's `webrtc_sdk_version`. */
  sdkVersion?: string;
}

/** The camera a live view is for, on its station's route. */
export interface RtcLiveRoute extends RtcRoute {
  cameraSn: string;
  /** The camera's `device_channel` on the station. */
  channel: number;
  /**
   * The `1350` JSON texts that start and stop the view: a CALLER INPUT until the bundle data carries the RTC
   * player's `open_live_stream` / `close_live_stream` frames. Without them the view is refused.
   */
  live?: { start: string; stop: string };
}

export interface RtcCommandRouterDeps {
  /** The logged-in user's id (the app's `user_uuid`); `undefined` while logged out. */
  userId: () => string | undefined;
  /** This install's stable id, the app's `app_id`. */
  appId: string;
  logger?: Logger;
  onError?: (e: Error) => void;
  /** ffmpeg for the live still (`ffmpeg` on PATH by default). */
  ffmpegPath?: string;
  /** The native layers, replaceable in a spec. */
  layers?: { signal?: (o: RtcSignalOptions) => RtcSignalClient; priv1?: typeof priv1; pmIce?: typeof pmIce };
}

interface Station {
  signal: RtcSignalClient;
  ready: Promise<void>;
  counter: RtcCommandCounter;
  data?: RtcDataChannel;
}

class StationStreamBusyError extends Error {
  constructor(stationSn: string, servingSn: string) {
    super(`rtc live: ${stationSn} is serving ${servingSn}; the station streams one camera at a time`);
    this.name = "StationStreamBusyError";
  }
}

/** The command kinds the data channel frames — `set-payload` over `1350`, `set-json` over `1700`. */
export const RTC_CONTROL_COMMAND_KINDS: ReadonlySet<Command["kind"]> = new Set<Command["kind"]>([
  "set-payload",
  "set-json",
]);
const isRtcControlCommand = (cmd: Command): cmd is Extract<Command, { kind: "set-payload" | "set-json" }> =>
  RTC_CONTROL_COMMAND_KINDS.has(cmd.kind);

export class RtcCommandRouter {
  private readonly stations = new Map<string, Station>();
  private readonly lives = new Map<string, { cameraSn: string; source: SharedLiveSource }>();
  private lastTransaction = 0;

  constructor(private readonly deps: RtcCommandRouterDeps) {}

  async dispatchCommand(route: RtcRoute, cmd: Command): Promise<void> {
    if (!isRtcControlCommand(cmd))
      throw new Error(`rtc: ${cmd.kind} is not routable over the RTC data channel (only set-payload or set-json)`);
    const account_id = this.accountId(route);
    const json =
      cmd.kind === "set-json"
        ? { account_id, cmd: cmd.param, commandType: cmd.param, data: cmd.data }
        : { account_id, cmd: cmd.cmd, mValue3: cmd.mValue3 ?? 0, payload: cmd.payload };
    const data = await this.dataChannel(route);
    await data.command(
      cmd.kind === "set-json" ? 1700 : 1350,
      JSON.stringify(json),
      route.attached ? cmd.channel : STATION_CHANNEL,
    );
  }

  /**
   * Query one on-station table and answer its rows: inner `{cmd: 1306, payload: {cmd: 10000, table, payload,
   * transaction}}`, answered by the notify echoing `transaction`. Rejects with the station's `msg` on a non-zero
   * `mIntRet`, when `signal` aborts, and when `timeoutMs` (default {@link DB_TABLE_TIMEOUT_MS}) passes.
   */
  readTable(
    route: RtcRoute,
    table: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<unknown[]> {
    this.lastTransaction = Math.max(Date.now(), this.lastTransaction + 1);
    const transaction = String(this.lastTransaction);
    const payload = { cmd: DB_QUERY.FULL_TABLE, table, payload: fullTableQuery(), transaction };
    return this.read(route, CMD_DATABASE, payload, opts, (body) => {
      if (String(body.transaction) !== transaction) return undefined;
      if (typeof body.mIntRet === "number" && body.mIntRet !== 0)
        throw new Error(`rtc: ${route.stationSn} refused ${table}: ${body.msg ?? body.mIntRet} (${body.mIntRet})`);
      return Array.isArray(body.data) ? body.data : undefined;
    });
  }

  /** Fetch one stored image by its on-station path: inner `{cmd: 1308, payload: [{file}]}`, answered `{file, content}`. */
  readImage(
    route: RtcRoute,
    filePath: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Buffer> {
    return this.read(route, CMD_DATABASE_IMAGE, [{ file: filePath }], opts, (body) =>
      body.file === filePath && typeof body.content === "string" ? Buffer.from(body.content, "base64") : undefined,
    );
  }

  /**
   * Bring the station's data channel up now, so a command fires without a cold connect. The station stays connected
   * until {@link close}, so the disposer has nothing to release.
   */
  keepWarm(route: RtcRoute): () => void {
    this.dataChannel(route).catch((e: unknown) => this.deps.onError?.(e instanceof Error ? e : new Error(String(e))));
    return () => undefined;
  }

  /** Live view, a readable feed and a live still of a camera over a PM call. Recording has no wire here. */
  mediaProviderFor(route: RtcLiveRoute): MediaProvider {
    return {
      live: (opts) => this.withLiveSource(route, opts ?? {}, (source) => attachUnlessAborted(source, opts?.signal)),
      openReadable: (opts) =>
        this.withLiveSource(route, opts ?? {}, (source) =>
          openReadableFromConsumer(attachUnlessAborted(source, opts?.signal), opts),
        ),
      snapshotLive: (opts) =>
        this.withLiveSource(route, opts ?? {}, (source) =>
          captureSnapshotFromShared(source, { ...opts, logger: this.deps.logger, ffmpegPath: this.deps.ffmpegPath }),
        ).catch((e: unknown) => {
          if (!(e instanceof StationStreamBusyError)) throw e;
          throw new LiveSnapshotUnavailableError("source-failed", e.message, { cause: e });
        }),
      record: async () => {
        throw new Error(`record is not available for ${route.cameraSn} over RTC`);
      },
    };
  }

  /** Tear every station down (logout / shutdown), each live source first so its stop still goes out. */
  close(): void {
    for (const live of this.lives.values()) live.source.dispose();
    this.lives.clear();
    for (const sn of [...this.stations.keys()]) this.drop(sn);
  }

  private accountId(route: RtcRoute): string {
    const id = route.adminUserId || this.deps.userId();
    if (!id) throw new Error(`rtc: not logged in, cannot drive ${route.stationSn}`);
    return id;
  }

  /** The station's client, created and started on first use. */
  private station(route: RtcRoute): Station {
    const sn = route.stationSn;
    const known = this.stations.get(sn);
    if (known) return known;
    const userId = this.deps.userId();
    if (!userId) throw new Error(`rtc: not logged in, cannot reach ${sn}`);
    const { did, lic, host } = route;
    const signal = (this.deps.layers?.signal ?? ((o) => new RtcSignalClient(o)))({
      sn,
      did,
      lic,
      host,
      userId,
      appId: this.deps.appId,
    });
    const ready = new Promise<void>((resolve, reject) => {
      signal.once("login", () => resolve());
      signal.once("failure", () => reject(new Error(`rtc: ${sn} refused the signalling login`)));
    });
    ready.catch(() => undefined);
    const st: Station = { signal, ready, counter: { word: 0x01020304 } };
    this.stations.set(sn, st);
    signal.start().catch((e: unknown) => this.deps.onError?.(e instanceof Error ? e : new Error(String(e))));
    return st;
  }

  /** The station's connected data channel, its PRIV1 call placed once the signalling is logged in. */
  private async dataChannel(route: RtcRoute, signal?: AbortSignal): Promise<RtcDataChannel> {
    const sn = route.stationSn;
    const st = this.station(route);
    const deadline = AbortSignal.any([AbortSignal.timeout(CONNECT_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    try {
      await abortable(st.ready, deadline);
      const flag = kcpMulti(sn, route.sdkVersion) ? 3 : 0;
      const data = (st.data ??= (this.deps.layers?.priv1 ?? priv1)(st.signal, {
        sn,
        version: route.version,
        flag,
        counter: st.counter,
      }));
      while (!data.connected) await sleep(20, undefined, { signal: deadline });
      return data;
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      const stage = st.data ? "data channel did not connect" : "signalling did not log in";
      if (st.data) {
        st.data.close();
        st.data = undefined;
      } else this.drop(sn);
      throw new Error(`rtc: ${sn} ${stage} within ${CONNECT_TIMEOUT_MS} ms`, { cause: e });
    }
  }

  /** Send a `1350` with inner `cmd` on the station channel and answer the first notify of `cmd` that `pick` claims. */
  private async read<T>(
    route: RtcRoute,
    cmd: number,
    payload: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal },
    pick: (body: Record<string, unknown>) => T | undefined,
  ): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? DB_TABLE_TIMEOUT_MS;
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(opts.signal ? [opts.signal] : [])]);
    const data = await this.dataChannel(route, opts.signal);
    const json = JSON.stringify({ account_id: this.accountId(route), cmd, mValue3: 0, payload });
    return new Promise<T>((resolve, reject) => {
      const settle = (fn: () => void) => {
        data.off("notify", onNotify).off("close", onClose);
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onNotify = (id: number, body: Buffer) => {
        if (id !== cmd) return;
        try {
          const value = pick(JSON.parse(body.toString()) as Record<string, unknown>);
          if (value !== undefined) settle(() => resolve(value));
        } catch (e) {
          if (!(e instanceof SyntaxError)) settle(() => reject(e));
        }
      };
      const onClose = () =>
        settle(() => reject(new Error(`rtc: ${route.stationSn} data channel closed before cmd ${cmd} answered`)));
      const onAbort = () =>
        settle(() =>
          reject(
            opts.signal?.aborted
              ? opts.signal.reason
              : new Error(`rtc: ${route.stationSn} cmd ${cmd} not answered within ${timeoutMs} ms`),
          ),
        );
      data.on("notify", onNotify).once("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
      data.command(1350, json, STATION_CHANNEL).catch(() => undefined);
    });
  }

  /**
   * Hand `use` the station's live source for this camera in the same turn it is created or reused, so a consumer it
   * attaches is counted before another caller looks. Another camera whose source has consumers refuses this one; one
   * with none is disposed and the slot taken.
   */
  private async withLiveSource<T>(
    route: RtcLiveRoute,
    opts: SharedSourceHints & AbortableCall,
    use: (source: SharedLiveSource) => T,
  ): Promise<Awaited<T>> {
    opts.signal?.throwIfAborted();
    const live = route.live;
    if (!live) throw new Error(`rtc live: no RTC start frame for ${route.cameraSn} in the bundle data`);
    const sn = route.stationSn;
    this.refuseIfWatched(route);
    const st = this.station(route);
    await abortable(
      st.ready,
      AbortSignal.any([AbortSignal.timeout(CONNECT_TIMEOUT_MS), ...(opts.signal ? [opts.signal] : [])]),
    );
    this.refuseIfWatched(route);
    const current = this.lives.get(sn);
    if (current && current.cameraSn !== route.cameraSn) {
      this.lives.delete(sn);
      current.source.dispose();
    }
    let entry = this.lives.get(sn);
    if (!entry) {
      const source: SharedLiveSource = new SharedLiveSource({
        makeStream: () => this.pmStream(route, st, live),
        label: `${sn}#${route.channel}`,
        logger: this.deps.logger,
        powered: opts.powered,
        preBufferSeconds: opts.preBufferSeconds,
        onStopped: () => {
          if (this.lives.get(sn)?.source === source) this.lives.delete(sn);
        },
      });
      entry = { cameraSn: route.cameraSn, source };
      this.lives.set(sn, entry);
    }
    return await use(entry.source);
  }

  private refuseIfWatched(route: RtcLiveRoute): void {
    const current = this.lives.get(route.stationSn);
    if (current && current.cameraSn !== route.cameraSn && current.source.consumerCount > 0)
      throw new StationStreamBusyError(route.stationSn, current.cameraSn);
  }

  /** One live view on a fresh PM call; its ICE closes and the call hangs up when the view stops or fails. */
  private pmStream(route: RtcLiveRoute, st: Station, live: { start: string; stop: string }): LiveStreamHandle {
    const call = st.signal.call(RtcCallType.PM);
    const agent = (this.deps.layers?.pmIce ?? pmIce)(st.signal, call);
    const stream = new RtcPmLiveStream(agent, {
      call,
      gcm: mediaGcm(route.stationSn, route.version),
      cmdGcm: cmdGcm(route.stationSn, route.version),
      channel: route.channel,
      ...live,
      counter: st.counter,
      logger: this.deps.logger,
    });
    const end = () => {
      agent.close();
      st.signal.hangup(call.uuid);
    };
    return stream.once("stop", end).once("error", end);
  }

  private drop(sn: string): void {
    const st = this.stations.get(sn);
    this.stations.delete(sn);
    st?.data?.close();
    st?.signal.close();
  }
}
