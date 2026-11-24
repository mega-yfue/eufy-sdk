/**
 * RTC command router: drives a station the vendor app connects natively over the app's own RTC client.
 *
 * One {@link RtcSignalClient} per station, logged in on first use and kept, as the app keeps one client per hub.
 * Commands ride the PRIV1 call's KCP data channel ({@link priv1}), placed on the first command; a live view places a
 * PM call of its own ({@link pmIce}, {@link RtcPmLiveStream}). Both seal under the station's one
 * {@link RtcCommandCounter}.
 *
 * Commands go as the app's RTC sender frames them ({@link RtcCommandRouter.dispatchCommand}). A command waits for the
 * data channel in 20 ms steps, as the app's `getRtcFileChannelConnectedStatus` wait does, and settles on its reply,
 * which is not an observation of the resulting state. A wait that runs out drops the data channel (before login, the
 * station's client keeps retrying as the app's does); a data channel that closes (its KCP detect or watchdog failing, {@link RtcDataChannel.detect}) is
 * dropped too, and the next command places a fresh PRIV1 call, as the app's request wait re-calls a disconnected file
 * channel, after the app's backoff from the third failure on.
 *
 * The station's database: a `1350` with inner `1306` (CMD_DATABASE) answers a table and inner `1308`
 * (CMD_DATABASE_IMAGE) a stored image, each as the station's notify under that command id, matched by its content
 * (`transaction`, `file`) since the notify stream carries other reports between them.
 *
 * The station serves one live view at a time: a second camera is refused while the first one's view has consumers.
 */
import { createECDH, randomInt } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CommandResultError,
  LiveSnapshotUnavailableError,
  type Command,
  type TalkbackHandle,
  type AacEncoder,
  type MediaProvider,
  type SessionFrame,
  type SharedSourceHints,
  type AbortableCall,
} from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";
import { abortable } from "../abortable.js";
import { P2PDataType, parseDataFrameHeader } from "../p2p/codec.js";
import { CommandType } from "../p2p/commands.js";
import { decodeFrame } from "../p2p/frame.js";
import type { P2PFrame } from "../p2p/p2p-session.js";
import { captureSnapshotFromShared } from "../p2p/media.js";
import {
  CMD_DATABASE,
  CMD_DATABASE_IMAGE,
  DB_QUERY,
  DB_TABLE_TIMEOUT_MS,
  fullTableQuery,
} from "../p2p/database-wire.js";
import { openReadableFromConsumer } from "../p2p/readable-egress.js";
import { SharedLiveSource, attachUnlessAborted, type Consumer } from "../p2p/shared-live-source.js";
import { Talkback } from "../p2p/talkback.js";
import { buildDirectBinaryBody, buildStringBody, renderFrame, setPayloadJson } from "../p2p/write-commands.js";
import { RtcCallType } from "./call.js";
import { cmdGcm, kcpMulti, priv1, type RtcCommandCounter, type RtcDataChannel } from "./data-channel.js";
import { pmIce } from "./ice.js";
import { RtcPmLiveStream, mediaGcm, type RtcLiveCommand } from "./pm-live.js";
import { RtcSignalClient, type RtcSignalOptions, type RtcToken } from "./signal-client.js";

const STATION_CHANNEL = 255;
/** ponytail: one bound for login + data channel; the app's per-request `time_out` is not pinned. */
const CONNECT_TIMEOUT_MS = 20_000;

/** Where a command goes: the station's RTC inputs, and whether it addresses the station or a device on it. */
export interface RtcRoute {
  stationSn: string;
  /** True for a device attached to the station, which keeps the command's own channel. */
  attached: boolean;
  /** The payload's `account_id`: the target record's stated `admin_user_id`; the logged-in user when absent. */
  adminUserId?: string;
  /** The station record's member account id, which a command stating `stationAccount` carries instead. */
  stationAccountId?: string;
  /** The station record's `p2p_did`, `p2p_license` and first IPv4 `signaling_servers` host. */
  did: string;
  lic: string;
  host: string;
  /** Its first host-name `signaling_servers` entry. */
  domain?: string;
  /** The station's `main_sw_version` with its dots removed. */
  version: number;
  /** The station's `webrtc_sdk_version`. */
  sdkVersion?: string;
}

/** A live frame with the `rtc_type` its bundle parser gave it (`rtcSendRoute`, absent 0). */
export type RtcLiveFrame = SessionFrame & {
  rtcSendRoute?: number;
  /** The request window its bundle descriptor states (`timeout`, ms), within which the app's request must succeed. */
  timeoutMs?: number;
};

/** The camera a live view is for, on its station's route. */
export interface RtcLiveRoute extends RtcRoute {
  cameraSn: string;
  /** The camera's `device_channel` on the station. */
  channel: number;
  /**
   * The bundle frames the app's RTC player starts and stops the view with, without which the view is refused, and its
   * talkback with, without which there is no talkback.
   */
  live?: Record<"start" | "stop", RtcLiveFrame> & Partial<Record<"talkStart" | "talkStop", RtcLiveFrame>>;
  /** The camera's lens ids (its param 9240 sensor list, in order) when it has any: its view is the lens page. */
  sensors?: readonly number[];
}

export interface RtcCommandRouterDeps {
  /** The logged-in user's id (the app's `user_uuid`); `undefined` while logged out. */
  userId: () => string | undefined;
  /** This install's stable id, the app's `app_id`. */
  appId: string;
  /** Each station's signalling cache (the app's `sp_webrtc` and `sp_webrtc_servers`), read at start and written on a change. */
  tokens?: { get(sn: string): RtcToken | undefined; set(sn: string, token: RtcToken): void };
  logger?: Logger;
  onError?: (e: Error) => void;
  /** ffmpeg for the live still (`ffmpeg` on PATH by default). */
  ffmpegPath?: string;
  /** Each station notify off the data channel, read as a P2P frame is: the app hands both to one receiver. */
  onFrame?: (stationSn: string, frame: P2PFrame) => void;
  /** The native layers, replaceable in a spec. */
  layers?: { signal?: (o: RtcSignalOptions) => RtcSignalClient; priv1?: typeof priv1; pmIce?: typeof pmIce };
}

interface Station {
  signal: RtcSignalClient;
  ready: Promise<void>;
  counter: RtcCommandCounter;
  /** The event-stream flag, `rtc_get_stream_flag(ctx, 1)` (ctx+61): 0 until first used. */
  flag: number;
  data?: RtcDataChannel;
  /** The app's PRIV1 `call_fail_count` and `scall_sleep` end (ms): see {@link RtcCommandRouter.dataChannel}. */
  fails: number;
  sleepUntil: number;
}

class StationStreamBusyError extends Error {
  constructor(stationSn: string, servingSn: string) {
    super(`rtc live: ${stationSn} is serving ${servingSn}; the station streams one camera at a time`);
    this.name = "StationStreamBusyError";
  }
}

/**
 * The app's RTC sender (`cmd_sender_send_command`) frames a native command by its id, over the same ids and groups
 * as its P2P sender: `A` `[u32 channel][u32 value][account_id → 128]` on the device channel, `B` `[u32 value]
 * [account_id → 128]` on 255, `C` that on the device channel, `I` `[u32 channel][u32 value]` on the device channel,
 * `J` `[u32 value][u32 value_sub]` on 255, `E` the JSON text (on the device channel for 1204, 1271 and 1350, else
 * 255), `G` the P2P string body ({@link buildStringBody}) and a fresh P-256 public key on 255. Every other id is
 * framed some other way, sent nowhere, or not implemented (-103).
 */
const NATIVE_GROUPS: Record<string, readonly number[]> = {
  A: [
    1011, 1015, 1017, 1019, 1035, 1045, 1056, 1145, 1146, 1152, 1200, 1207, 1210, 1213, 1214, 1226, 1227, 1229, 1230,
    1233, 1236, 1240, 1241, 1243, 1246, 1272, 1273, 1275, 1400, 1401, 1402, 1403, 1408, 1409, 1410, 1412, 1413, 1506,
    1507, 1607, 1609, 1610, 1611, 1702, 1703, 1704, 1705, 1706, 1707, 1708, 1709,
  ],
  B: [
    1029, 1034, 1036, 1043, 1057, 1203, 1218, 1219, 1220, 1221, 1222, 1223, 1224, 1232, 1234, 1235, 1237, 1238, 1248,
    1253, 1257, 1269, 1800,
  ],
  C: [1249, 1250, 1251, 1252, 9258],
  E: [1060, 1204, 1254, 1255, 1256, 1258, 1259, 1260, 1261, 1262, 1264, 1271, 1350, 1404],
  G: [1025, 1132, 1215, 1216, 1217, 1414],
  I: [1013, 1202, 1205, 1206],
  J: [1026, 1164, 1201],
};
const nativeGroup = (id: number) => Object.keys(NATIVE_GROUPS).find((g) => NATIVE_GROUPS[g]!.includes(id));
const JSON_ON_DEVICE_CHANNEL = [1204, 1271, 1350];

/** A reply's code as the app's `ack_processor_process_response` reads it: its first int32, 0 for an empty body. */
const replyCode = (reply: Buffer) => (reply.length >= 4 ? reply.readInt32LE(0) : 0);

const u32s = (...v: number[]) => Buffer.from(new Uint32Array(v.map((x) => x >>> 0)).buffer);

/**
 * The app's `rtc_crypto_get_ecc_crypto`: a fresh P-256 key pair per command (`GenerateKeyForECC`, micro-ecc), its
 * 64-byte public key (X ‖ Y) as 128 upper-case hex characters. ponytail: the private half, which the app keeps on the
 * device context, is dropped: nothing the SDK sends reads it back.
 */
const eccPublicHex = () =>
  Buffer.from(createECDH("prime256v1").generateKeys().subarray(1).toString("hex").toUpperCase());

export class RtcCommandRouter {
  private readonly stations = new Map<string, Station>();
  private readonly lives = new Map<string, { cameraSn: string; source: SharedLiveSource; stream?: RtcPmLiveStream }>();
  private readonly talking = new Set<string>();
  /** The app's `RtcLivePlayerBridge.msgIdMap`: the last live `msg_id` per station, process-wide. */
  private readonly msgIds = new Map<string, number>();
  private lastTransaction = 0;

  constructor(private readonly deps: RtcCommandRouterDeps) {}

  /**
   * Send a command as the app's RTC sender frames it: `set-payload` as `1350` ({@link setPayloadJson}), `set-json` as
   * `1700` `{commandType, data}`, both on 255 for the station and the device's channel for an attached one; the native
   * kinds by their id's group in {@link NATIVE_GROUPS}. Refused: a kind or id the app's RTC sender does not frame, a
   * lock-sealed payload, a payload with a header counter. Answers `true` on the station's reply, as the app's RTC
   * bridge waits for it (`ack_reader_get_ack`): its first int32 is the code, and a non-zero one rejects with a
   * {@link CommandResultError}, as does no reply within the data channel's wait.
   */
  async dispatchCommand(route: RtcRoute, cmd: Command): Promise<boolean> {
    const { id, body, channel } = this.frame(route, cmd);
    const data = await this.dataChannel(route);
    const code = replyCode(await data.command(id, body, channel));
    if (code !== 0) throw new CommandResultError(route.stationSn, id, code, 20_000);
    return true;
  }

  private frame(route: RtcRoute, cmd: Command): { id: number; body: string | Buffer; channel: number } {
    const own = (channel: number) => (route.attached ? channel : STATION_CHANNEL);
    switch (cmd.kind) {
      case "set-json":
        return {
          id: 1700,
          body: JSON.stringify({ commandType: cmd.param, data: cmd.data }),
          channel: own(cmd.channel),
        };
      case "set-payload": {
        if (cmd.lock || cmd.counter) break;
        const { channel, mValue3, unzip } = cmd;
        const body = setPayloadJson(cmd.cmd, cmd.payload, {
          accountId: this.accountId(route, cmd.stationAccount),
          channel,
          mValue3,
          unzip,
        });
        return { id: 1350, body, channel: own(channel) };
      }
      case "set-json-raw": {
        if (nativeGroup(cmd.cmd) !== "E") break;
        const body = JSON.stringify({ account_id: this.accountId(route, cmd.stationAccount), ...cmd.data });
        return { id: cmd.cmd, body, channel: JSON_ON_DEVICE_CHANNEL.includes(cmd.cmd) ? cmd.channel : STATION_CHANNEL };
      }
      case "p2p-string": {
        if (nativeGroup(cmd.cmd) !== "G") break;
        const body = Buffer.concat([
          buildStringBody(cmd.channel, cmd.value, this.accountId(route, cmd.stationAccount), cmd.int),
          eccPublicHex(),
        ]);
        return { id: cmd.cmd, body, channel: STATION_CHANNEL };
      }
      case "p2p-int-string": {
        const { cmd: id, form, value, channel } = cmd;
        if (form && nativeGroup(id) === "J") return { id, body: u32s(cmd.valueSub, value), channel: STATION_CHANNEL };
        if (!form && nativeGroup(id) === "I") return { id, body: u32s(channel, value), channel };
        break;
      }
      case "set-param":
      case "p2p-station-scalar": {
        const { value, channel, stationAccount } = cmd;
        const id = cmd.kind === "set-param" ? cmd.param : cmd.cmd;
        const account = this.accountId(route, stationAccount);
        const group = nativeGroup(id);
        if (group === "I") return { id, body: u32s(channel, value), channel };
        if (cmd.kind === "set-param" && cmd.form) break;
        if (group === "A") return { id, body: buildDirectBinaryBody(value, account, channel), channel };
        if (group === "B" || group === "C")
          return {
            id,
            body: buildDirectBinaryBody(value, account),
            channel: group === "B" ? STATION_CHANNEL : channel,
          };
      }
    }
    const id = "cmd" in cmd ? cmd.cmd : "param" in cmd ? cmd.param : "";
    throw new Error(`rtc: ${cmd.kind} ${id} is not framed by the app's RTC sender`);
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
    return this.readJson(route, CMD_DATABASE, payload, opts, (body) => {
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
    return this.readJson(route, CMD_DATABASE_IMAGE, [{ file: filePath }], opts, (body) =>
      body.file === filePath && typeof body.content === "string" ? Buffer.from(body.content, "base64") : undefined,
    );
  }

  /**
   * Read a camera's live RTSP URL as the app's URL read goes over RTC: one publish switch `1145` value 1 on the
   * camera's channel, answered on the data channel, settled by the station's notify on that channel under `1145` or
   * `1146` (`isNotifyMatches`) carrying the `rtsp://` text; a refusal ends it. Bounded by `timeoutMs` (30 s).
   */
  readRtspUrl(
    route: RtcRoute,
    channel: number,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<string> {
    const nas = [CommandType.CMD_NAS_SWITCH, CommandType.CMD_NAS_TEST];
    const send = () => this.dispatchCommand(route, { kind: "set-param", param: nas[0]!, value: 1, channel });
    return this.read(route, nas, send, { timeoutMs: 30_000, ...opts }, (body, head) => {
      const url = body.toString("latin1").split("\0")[0]!;
      return head[12] === channel && url.startsWith("rtsp://") ? url : undefined;
    });
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
      ...(route.live?.talkStart && { talkback: (opts) => this.openTalkback(route, opts ?? {}) }),
    };
  }

  /**
   * Talk to a camera as the app's RTC player does, inside its live view: once the view shows video, `start_intercom`
   * goes out, and once it succeeds (its `ANKE` answer, or its answer on the data channel) one 20 ms Opus packet per
   * write follows on the view's PM call ({@link RtcPmLiveStream.sendAudio}), paced by {@link Talkback}; audio before
   * that is dropped, as the app's mic track stays off. A failed start is reported as `error` and leaves the talkback
   * open and silent, as the app's player sits in its Failed state: `stop_intercom` goes out only when it is stopped or
   * its view ends, as the app's `stopTalk` / `release` send it from any state but Idle. The view is held while talking
   * and ends the talkback with it. One talkback per station: its PM call carries one audio track.
   */
  private async openTalkback(
    route: RtcLiveRoute,
    opts: SharedSourceHints & { encoder?: AacEncoder },
  ): Promise<TalkbackHandle> {
    const sn = route.stationSn;
    if (this.talking.has(sn)) throw new Error(`talkback: ${sn} is already talking; stop it before starting another`);
    const { talkStart, talkStop } = route.live!;
    const pm = () => this.lives.get(sn)?.stream;
    let consumer: Consumer | undefined;
    let speaking = false;
    const talk: Talkback = new Talkback(
      {
        sendFrame: (frame) => {
          const st = this.stations.get(sn);
          const sent = st && pm()?.command(this.liveCommand(route, st, frame, 0));
          if (frame !== talkStart) return;
          void (sent ?? Promise.resolve(false)).then((ok) => {
            if (ok) return void (speaking = true);
            const e = new Error(`talkback: ${route.cameraSn} did not take start_intercom`);
            if (talk.listenerCount("error")) talk.emit("error", e);
            else this.deps.logger?.warn(e.message);
          });
        },
        sendAudioFrame: (_channel, packet) => speaking && pm()?.sendAudio(packet),
      },
      {
        channel: route.channel,
        start: talkStart!,
        stop: talkStop!,
        encoder: opts.encoder,
        releaseMedia: () => consumer?.stop(),
        logger: this.deps.logger,
      },
    );
    this.talking.add(sn);
    talk.on("stop", () => this.talking.delete(sn));
    try {
      consumer = await this.withLiveSource(route, opts, (source) => source.attach());
      await new Promise<void>((resolve, reject) => {
        const settle = (e?: Error) => {
          consumer!.off("video", onVideo).off("error", settle).off("stop", onStop);
          if (e) reject(e);
          else resolve();
        };
        const onVideo = () => settle();
        const onStop = () => settle(new Error(`talkback: ${route.cameraSn}'s live view stopped`));
        consumer!.on("video", onVideo).on("error", settle).on("stop", onStop);
      });
      consumer.on("stop", () => void talk.stop());
      consumer.on(
        "error",
        (e) => void (talk.listenerCount("error") ? talk.emit("error", e) : this.deps.logger?.warn(e.message)),
      );
      consumer.on("budget", (notice) => talk.emit("budget", notice));
      return talk.start("opus");
    } catch (e) {
      this.talking.delete(sn);
      consumer?.stop();
      throw e;
    }
  }

  /** Tear every station down (logout / shutdown), each live source first so its stop still goes out. */
  close(): void {
    for (const live of this.lives.values()) live.source.dispose();
    this.lives.clear();
    for (const sn of [...this.stations.keys()]) this.drop(sn);
  }

  private accountId(route: RtcRoute, station?: true): string {
    const id = (station ? route.stationAccountId : route.adminUserId) ?? this.deps.userId();
    if (id === undefined) throw new Error(`rtc: not logged in, cannot drive ${route.stationSn}`);
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
      domain: route.domain,
      userId,
      appId: this.deps.appId,
      token: this.deps.tokens?.get(sn),
    });
    signal.on("token", (t) => this.deps.tokens?.set(sn, t));
    const ready = new Promise<void>((resolve) => signal.once("login", () => resolve()));
    const st: Station = { signal, ready, counter: { word: 0x01020304 }, flag: 0, fails: 0, sleepUntil: 0 };
    this.stations.set(sn, st);
    signal.start().catch((e: unknown) => this.deps.onError?.(e instanceof Error ? e : new Error(String(e))));
    return st;
  }

  /**
   * The station's connected data channel, its PRIV1 call placed once the signalling is logged in. A channel that
   * closes counts a failure, which the station's answer to a PRIV1 call clears; from the third failure on, the next
   * call waits as the app's `scall_sleep` does: 20 s, then 50 s, then 100 s, each plus 0 to 9 s.
   */
  private async dataChannel(route: RtcRoute, signal?: AbortSignal): Promise<RtcDataChannel> {
    const sn = route.stationSn;
    const st = this.station(route);
    const deadline = AbortSignal.any([AbortSignal.timeout(CONNECT_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    let loggedIn = false;
    try {
      await abortable(st.ready, deadline);
      loggedIn = true;
      const flag = kcpMulti(sn, route.sdkVersion) ? 3 : 0;
      if (!st.data) await sleep(Math.max(0, st.sleepUntil - Date.now()), undefined, { signal: deadline });
      let data = st.data;
      if (!data) {
        const placed =
          (data =
          st.data =
            (this.deps.layers?.priv1 ?? priv1)(st.signal, {
              sn,
              version: route.version,
              flag,
              counter: st.counter,
              answered: () => (st.fails = 0),
            }));
        placed.on("notify", (_cmd, body, head) =>
          this.deps.onFrame?.(sn, decodeFrame(sn, parseDataFrameHeader(head), body, body, P2PDataType.DATA)),
        );
        placed.once("close", () => {
          if (st.data === placed) st.data = undefined;
          const n = st.fails++;
          if (n >= 2) st.sleepUntil = Date.now() + 1000 * (randomInt(10) + (n === 2 ? 20 : n === 3 ? 50 : 100));
        });
      }
      while (!data.connected) await sleep(20, undefined, { signal: deadline });
      return data;
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      const stage = loggedIn ? "data channel did not connect" : "signalling did not log in";
      if (loggedIn && st.data) {
        st.data.close();
        st.data = undefined;
      }
      throw new Error(`rtc: ${sn} ${stage} within ${CONNECT_TIMEOUT_MS} ms`, { cause: e });
    }
  }

  /** Send a `1350` with inner `cmd` on the station channel and answer the first JSON notify of `cmd` that `pick` claims. */
  private async readJson<T>(
    route: RtcRoute,
    cmd: number,
    payload: unknown,
    opts: { timeoutMs?: number; signal?: AbortSignal },
    pick: (body: Record<string, unknown>) => T | undefined,
  ): Promise<T> {
    const json = setPayloadJson(cmd, payload, { accountId: this.accountId(route), channel: STATION_CHANNEL });
    const send = (data: RtcDataChannel) => data.command(1350, json, STATION_CHANNEL).catch(() => undefined);
    return this.read(route, [cmd], send, opts, (body) => {
      try {
        return pick(JSON.parse(body.toString()) as Record<string, unknown>);
      } catch (e) {
        if (e instanceof SyntaxError) return undefined;
        throw e;
      }
    });
  }

  /** Arm a wait on the station's notifies under `cmds`, then `send`; answer the first one `pick` claims. */
  private async read<T>(
    route: RtcRoute,
    cmds: readonly number[],
    send: (data: RtcDataChannel) => Promise<unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal },
    pick: (body: Buffer, head: Buffer) => T | undefined,
  ): Promise<T> {
    const cmd = cmds[0];
    const timeoutMs = opts.timeoutMs ?? DB_TABLE_TIMEOUT_MS;
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(opts.signal ? [opts.signal] : [])]);
    const data = await this.dataChannel(route, opts.signal);
    return new Promise<T>((resolve, reject) => {
      const settle = (fn: () => void) => {
        data.off("notify", onNotify).off("close", onClose);
        signal.removeEventListener("abort", onAbort);
        fn();
      };
      const onNotify = (id: number, body: Buffer, head: Buffer) => {
        if (!cmds.includes(id)) return;
        try {
          const value = pick(body, head);
          if (value !== undefined) settle(() => resolve(value));
        } catch (e) {
          settle(() => reject(e));
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
      send(data).catch((e: unknown) => settle(() => reject(e)));
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
        makeStream: () => (entry!.stream = this.pmStream(route, st, live, opts.entryType ?? 0)),
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
  private pmStream(
    route: RtcLiveRoute,
    st: Station,
    live: Record<"start" | "stop", RtcLiveFrame>,
    entryType: number,
  ): RtcPmLiveStream {
    const call = st.signal.call(RtcCallType.PM);
    const agent = (this.deps.layers?.pmIce ?? pmIce)(st.signal, call);
    const stream = new RtcPmLiveStream(agent, {
      call,
      gcm: mediaGcm(route.stationSn, route.version),
      cmdGcm: cmdGcm(route.stationSn, route.version),
      start: () => this.liveCommand(route, st, live.start, entryType),
      stop: () => this.liveCommand(route, st, live.stop, entryType),
      counter: st.counter,
      logger: this.deps.logger,
    });
    const end = () => {
      agent.close();
      st.signal.hangup(call.uuid);
    };
    return stream.once("stop", end).once("error", end);
  }

  /**
   * A live frame as the app's RTC sender frames it ({@link renderFrame}), its page the one
   * `LiveParamHelper.getLiveParams` builds: `$chnList` one `{cameraType: 0, chn, index, sensor}` per lens (index 0 for lens 0, else 1) on the lens page,
   * else the single-camera page's one `{cameraType: 0, chn, index: 0, sensor: 0}` (camera id `CameraFixed`), and
   * `$cameraType` 0; `$msgId` the next `getNextMsgId` of the player's parent (1 to 255, then 1 again): the station, or
   * the camera itself on a lens page (a sensor device's parent), `$entryType` the view's. Header byte 14 is the
   * station's event-stream flag for a `1700` of inner `1000`, moved on per use as `rtc_get_stream_flag` does (10 when
   * `(flag + 5) & 0xff < 15`, else up one), else 0.
   *
   * It goes over `ANKE` or the data channel as the app's RTC sender (`cmd_sender_send_command`) routes it on the
   * station's context, `rtc_type` the frame's `rtcSendRoute` (absent 0): a `1350` when it is 1, or with inner 1003 or
   * 1004 on an `is_specific_device_model` station; a `1700` of inner 1000 to 1002 when it is 1 or the station is
   * `is_livecmd_support_media_rtcp` (a T8223, T8224 or T8030 above its {@link cmdGcm} floor); a `1004` when it is 1 or
   * the station is `is_rtcp_solo` (a T8223/T8224 by its key mode, the same floor); anything else over the data channel.
   */
  private liveCommand(route: RtcLiveRoute, st: Station, frame: RtcLiveFrame, entryType: number): RtcLiveCommand {
    const sn = route.stationSn;
    const parent = route.sensors ? route.cameraSn : sn;
    const { cmd, body, header } = renderFrame(frame, route.channel, this.accountId(route), {
      $chnList: () =>
        (route.sensors ?? [0]).map((s) => ({ cameraType: 0, chn: route.channel, index: s === 0 ? 0 : 1, sensor: s })),
      $cameraType: () => 0,
      $msgId: () => this.msgIds.set(parent, ((this.msgIds.get(parent) ?? 0) % 255) + 1).get(parent),
      $entryType: () => entryType,
      // `RtcLivePlayerBridge` starts with the camera's stated admin, else `""`; the envelope keeps esiotkit's.
      $userId: () => route.adminUserId ?? "",
    });
    const bump = cmd === 1700 && frame.subCmd === 1000;
    if (bump) st.flag = ((st.flag + 5) & 0xff) < 15 ? 10 : st.flag + 1;
    const flag = bump ? st.flag : 0;
    // ponytail: the native's 900-byte RTCP ceiling is not checked; every live frame is far below it.
    const type = frame.rtcSendRoute === 1;
    const floor = /^T(8223|8224|8030)/.test(sn) && cmdGcm(sn, route.version);
    const solo = /^T(8180|8172|8215|8170|86C1|8174|8L60|8217|8404)/.test(sn) || (floor && !sn.startsWith("T8030"));
    const inner = frame.subCmd ?? (frame.payload as { cmd?: number } | undefined)?.cmd;
    const rtcp =
      cmd === 1350
        ? type || ((inner === 1003 || inner === 1004) && (solo || /^T(8030|8N00|9000|7000|8040)/.test(sn)))
        : cmd === 1700
          ? inner !== undefined && inner >= 1000 && inner <= 1002 && (type || floor)
          : cmd === 1004 && (type || solo);
    const send = async () => {
      try {
        const window = frame.timeoutMs ? AbortSignal.timeout(frame.timeoutMs) : undefined;
        const d = st.data?.connected ? st.data : await this.dataChannel(route, window);
        return replyCode(await abortable(d.command(cmd, body, header, flag), window)) === 0;
      } catch (e) {
        this.deps.logger?.warn(`[rtc] ${sn} live ${cmd} over the data channel: ${String(e)}`);
        return false;
      }
    };
    return { cmd, body, channel: header, flag, ...(!rtcp && { send }) };
  }

  private drop(sn: string): void {
    const st = this.stations.get(sn);
    this.stations.delete(sn);
    st?.data?.close();
    st?.signal.close();
  }
}
