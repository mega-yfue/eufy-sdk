/**
 * RTC command router — drives a **HomeBase Professional S1 (T9000)** over the portal's WebRTC data
 * channel instead of P2P.
 *
 * The T9000 has no reachable P2P endpoint (every `device.set` over P2P times out), but it accepts the
 * app/portal's control channel: sign → WS join → scall → SDP answer → ICE → DTLS → SCTP data channels,
 * with commands riding `WebrtcDataChannel` as portal packets (see `portal-packet.ts`).
 *
 * ⚠️ ICE policy MUST be `relay` (or `all` with the relay reachable): the hub completes DTLS **only
 * through TURN**. On a host-only pair ICE connects and the DTLS handshake times out, every time
 * (measured on firmware 4.4.0.4, 2026-09-25 — a full night of negatives that all traced back to a
 * host-only default). The relay is granted by the hub itself in the scall `status:100` reply.
 *
 * What rides here today is the `set-payload` envelope (`1350` SET_PAYLOAD, inner
 * `{account_id, cmd, mValue3, payload}`) on the station channel `255` — the exact frame the app sends
 * for arming (`cmd 1224`, `{mode_type, user_name}`), ✅ verified live end-to-end on a T9000 4.4.0.4
 * (2026-09-25 23:55): ACK `1350 err=0`, `1151` MODE_SWITCH pushed back, cloud state updated within 1 s.
 * Other command kinds are refused with a clear error rather than silently misrouted.
 *
 * One session per station, reused across commands and closed after {@link RtcCommandRouterDeps.idleCloseMs}
 * of inactivity. Sends on a session are serialised, because the `1350` ACK carries no inner `cmd` to
 * correlate on: the first ACK after a send belongs to that send.
 */
import type { Command } from "../../core/contracts.js";
import type { EufyDevice } from "../../core/types.js";
import type { Logger } from "../../core/logger.js";
import { RtcSession, type RtcSessionOptions } from "./session.js";
import { buildPortalPacket, parsePortalPacket, SegmentCounter } from "./portal-packet.js";
import { RtcLive, type RtcLiveConsumer } from "./live.js";
import { openReadableFromConsumer } from "../p2p/readable-egress.js";
import type { Consumer } from "../p2p/shared-live-source.js";
import { jpegGeometry } from "../p2p/media.js";
import { LiveSnapshotUnavailableError, type MediaProvider, type LiveStreamConsumer } from "../../core/contracts.js";
import { spawn } from "node:child_process";
import { PORTAL_CMD_SET_PAYLOAD, PORTAL_STATION_CHANNEL } from "./commands.js";

export interface RtcIdentity {
  authToken: string;
  userId: string;
  /** The cloud `user_id` the gtoken derives from (falls back to `userId`). */
  accountUserId?: string;
  /** The `gtoken` header value, when the caller already derives it (same as its HTTP calls). */
  gtoken?: string;
}

export interface RtcCommandRouterDeps {
  /** The logged-in session's credentials; `undefined` while logged out. */
  identity: () => RtcIdentity | undefined;
  /** The mega shard the account signs on (`"ie-pr"`, `"eu-pr"`, `"us-pr"`) — picks the smart host. */
  shard: () => string;
  /** ISO country sent on the sign request (default `US`). */
  country?: string;
  /** The acting account name commands attribute themselves to (`user_name`). */
  accountName: () => string;
  /** Resolve a device record by serial (model, adminUserId, stationSn). */
  findDevice: (sn: string) => EufyDevice | undefined;
  logger?: Logger;
  /** `relay` (default) or `all`. Never `host-only` — see the module doc. */
  icePolicy?: "relay" | "all";
  /** How long a command waits for its `1350` ACK (default 8 s). */
  ackTimeoutMs?: number;
  /**
   * How long to wait for the session to come up (default 12 s). A healthy hub answers in ~2 s; the
   * default sits under the ~15 s timeout a typical host applies to a service call, so a hub outage
   * surfaces as this router's own error rather than the caller's timeout.
   */
  connectTimeoutMs?: number;
  /** Close an idle station session after this long (default 60 s). */
  idleCloseMs?: number;
  onError?: (e: Error) => void;
  /** ffmpeg for the live still (default `ffmpeg` on PATH). */
  ffmpegPath?: string;
  ffmpegLogLevel?: string;
  /** Session factory (tests inject a fake). */
  createSession?: (opts: RtcSessionOptions) => RtcSession;
}

interface StationSession {
  session: RtcSession;
  seg: SegmentCounter;
  ready: Promise<void>;
  /** Serialises sends so ACKs can't be attributed to the wrong command. */
  queue: Promise<unknown>;
  idle?: ReturnType<typeof setTimeout>;
  /** Holders (a live view) that keep the session from idle-closing. */
  leases: number;
}

export class RtcCommandRouter {
  private readonly sessions = new Map<string, StationSession>();
  private readonly lives = new Map<string, RtcLive>();

  constructor(private readonly deps: RtcCommandRouterDeps) {}

  /** A T9000 station itself. Attached cameras keep their own (P2P) path for now. */
  static claimsDevice(dev: EufyDevice): boolean {
    return /^T9000/i.test(dev.model ?? "") && (!dev.stationSn || dev.stationSn === dev.sn);
  }

  /** A camera attached to a T9000 station: its live view rides the station's control channel. */
  static claimsMedia(dev: EufyDevice, stationOf: (sn: string) => EufyDevice | undefined): boolean {
    if (!dev.stationSn || dev.stationSn === dev.sn) return false;
    const station = stationOf(dev.stationSn);
    return !!station && RtcCommandRouter.claimsDevice(station);
  }

  async dispatchCommand(sn: string, cmd: Command): Promise<void> {
    if (cmd.kind !== "set-payload") {
      throw new Error(`rtc: ${cmd.kind} is not routable over the T9000 control channel yet (only set-payload)`);
    }
    const dev = this.deps.findDevice(sn);
    const identity = this.deps.identity();
    if (!identity) throw new Error(`rtc: not logged in, cannot drive ${sn}`);
    // Same identity the P2P router attributes station writes to: the record's member id, else the login.
    const member = ((dev?.raw ?? {}) as { member?: { admin_user_id?: unknown } }).member;
    const adminUserId = (typeof member?.admin_user_id === "string" && member.admin_user_id) || identity.userId;
    const st = await this.stationSession(sn, adminUserId, identity);
    // A station-scoped command rides the broadcast channel; a device-scoped one keeps its own.
    const channel = !dev?.stationSn || dev.stationSn === sn ? PORTAL_STATION_CHANNEL : cmd.channel;
    const segment = st.seg.next();
    const packet = buildPortalPacket({
      commandId: PORTAL_CMD_SET_PAYLOAD,
      channel,
      segment,
      payload: { account_id: adminUserId, cmd: cmd.cmd, mValue3: cmd.mValue3 ?? 0, payload: cmd.payload },
    });
    const run = st.queue.then(() => this.sendAwaitAck(sn, st, packet, cmd.cmd, segment));
    st.queue = run.catch(() => undefined);
    return run;
  }

  /** Tear down every station session (logout / shutdown). */
  close(): void {
    this.lives.clear();
    for (const [sn, st] of this.sessions) {
      if (st.idle) clearTimeout(st.idle);
      try {
        st.session.close();
      } catch {
        /* already gone */
      }
      this.sessions.delete(sn);
    }
  }

  private sendAwaitAck(
    sn: string,
    st: StationSession,
    packet: Buffer,
    innerCmd: number,
    segment: number,
  ): Promise<void> {
    const timeoutMs = this.deps.ackTimeoutMs ?? 8_000;
    return new Promise<void>((resolve, reject) => {
      const onData = (frame: Buffer, linkType: number) => {
        const p = parsePortalPacket(frame, linkType);
        // The hub's ACK repeats the request's segment — correlate on it, since a live view shares this session.
        if (!p || p.commandId !== PORTAL_CMD_SET_PAYLOAD || !p.isResponse || p.segment !== segment) return;
        cleanup();
        if (p.errCode && p.errCode !== 0) {
          reject(new Error(`rtc: ${sn} rejected cmd ${innerCmd} (err ${p.errCode})`));
        } else {
          this.deps.logger?.debug?.(`[rtc] ${sn} cmd ${innerCmd} acked`);
          resolve();
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error(`rtc: ${sn} session closed while waiting for cmd ${innerCmd} ACK`));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`rtc: ${sn} cmd ${innerCmd} ACK timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        st.session.off("commandData", onData);
        st.session.off("close", onClose);
        this.touch(sn, st);
      };
      st.session.on("commandData", onData);
      st.session.on("close", onClose);
      if (!st.session.sendCommand(packet)) {
        cleanup();
        reject(new Error(`rtc: ${sn} command channel not open, cmd ${innerCmd} not sent`));
      }
    });
  }

  private async stationSession(sn: string, adminUserId: string, identity: RtcIdentity): Promise<StationSession> {
    const existing = this.sessions.get(sn);
    if (existing) {
      await existing.ready;
      if (existing.session.isConnected) {
        this.touch(sn, existing);
        return existing;
      }
      this.drop(sn, existing);
    }
    const session = (this.deps.createSession ?? ((o: RtcSessionOptions) => new RtcSession(o)))({
      authToken: identity.authToken,
      userId: identity.userId,
      accountUserId: identity.accountUserId,
      gtoken: identity.gtoken,
      stationSn: sn,
      adminUserId,
      shard: this.deps.shard() as never,
      country: this.deps.country ?? "US",
      channelId: 0,
      logger: this.deps.logger,
      peer: { logger: this.deps.logger, icePolicy: this.deps.icePolicy ?? "relay" },
    });
    const connectTimeoutMs = this.deps.connectTimeoutMs ?? 12_000;
    const ready = this.bringUp(sn, session, connectTimeoutMs);
    const st: StationSession = { session, seg: new SegmentCounter(), ready, queue: Promise.resolve(), leases: 0 };
    session.on("error", (e) => this.deps.onError?.(e));
    session.on("close", () => {
      if (this.sessions.get(sn) === st) this.sessions.delete(sn);
    });
    this.sessions.set(sn, st);
    try {
      await ready;
    } catch (e) {
      this.drop(sn, st);
      throw e;
    }
    this.touch(sn, st);
    return st;
  }

  /**
   * One bounded bring-up: the session is up when its command channel opens, and it fails — with the
   * session closed and every listener gone — when `connect()` throws, the session closes first, or the
   * deadline passes. A single promise, so an early failure cannot leave a second one rejecting unheard.
   */
  private bringUp(sn: string, session: RtcSession, connectTimeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.off("connected", onConnected);
        session.off("close", onClose);
        if (err) {
          try {
            session.close();
          } catch {
            /* already gone */
          }
          reject(err);
        } else {
          this.deps.logger?.info?.(`[rtc] ${sn} command channel up (${this.deps.icePolicy ?? "relay"})`);
          resolve();
        }
      };
      const onConnected = () => finish();
      const onClose = () => finish(new Error(`rtc: ${sn} session closed before the command channel opened`));
      const timer = setTimeout(
        () => finish(new Error(`rtc: ${sn} did not come up within ${connectTimeoutMs}ms`)),
        connectTimeoutMs,
      );
      session.once("connected", onConnected);
      session.once("close", onClose);
      Promise.resolve()
        .then(() => session.connect())
        .catch((e: unknown) => finish(e instanceof Error ? e : new Error(String(e))));
    });
  }

  private touch(sn: string, st: StationSession): void {
    if (st.idle) clearTimeout(st.idle);
    if (st.leases > 0) return; // a live view holds the session open
    const idleMs = this.deps.idleCloseMs ?? 60_000;
    st.idle = setTimeout(() => this.drop(sn, st), idleMs);
    st.idle.unref?.();
  }

  /**
   * The station's session for media that must ride the SAME session as the commands (one RTC session per
   * account), with a lease that keeps it from idle-closing until released.
   */
  async sessionFor(
    stationSn: string,
  ): Promise<{ session: RtcSession; seg: SegmentCounter; accountId: string; release: () => void }> {
    const dev = this.deps.findDevice(stationSn);
    const identity = this.deps.identity();
    if (!identity) throw new Error(`rtc: not logged in, cannot open ${stationSn}`);
    const member = ((dev?.raw ?? {}) as { member?: { admin_user_id?: unknown } }).member;
    const accountId = (typeof member?.admin_user_id === "string" && member.admin_user_id) || identity.userId;
    const st = await this.stationSession(stationSn, accountId, identity);
    st.leases++;
    if (st.idle) clearTimeout(st.idle);
    let released = false;
    return {
      session: st.session,
      seg: st.seg,
      accountId,
      release: () => {
        if (released) return;
        released = true;
        st.leases = Math.max(0, st.leases - 1);
        this.touch(stationSn, st);
      },
    };
  }

  /** The live view of a camera on a T9000, one per (station, channel), started/stopped with its consumers. */
  private async liveFor(sn: string): Promise<RtcLive> {
    const dev = this.deps.findDevice(sn);
    if (!dev?.stationSn) throw new Error(`rtc live: ${sn} is not attached to a station`);
    const raw = (dev.raw ?? {}) as { device_channel?: unknown };
    const channel = typeof raw.device_channel === "number" ? raw.device_channel : Number(raw.device_channel);
    if (!Number.isInteger(channel)) throw new Error(`rtc live: ${sn} has no device_channel`);
    const existing = this.lives.get(sn);
    if (existing?.active) return existing;
    const lease = await this.sessionFor(dev.stationSn);
    const live = new RtcLive({
      session: lease.session,
      seg: lease.seg,
      stationSn: dev.stationSn,
      channel,
      accountId: lease.accountId,
      logger: this.deps.logger,
      onIdle: () => {
        if (this.lives.get(sn) === live) this.lives.delete(sn);
        lease.release();
      },
    });
    this.lives.set(sn, live);
    return live;
  }

  /**
   * A {@link MediaProvider} for a camera on a T9000: live video over the station's control channel
   * (HEVC Annex B). Recording, talkback and P2P queries have no wire here yet and are refused.
   */
  mediaProviderFor(sn: string): MediaProvider {
    const unsupported = (what: string) =>
      new Error(`${what} is not available for a T9000 camera over the control channel`);
    const attach = async (): Promise<RtcLiveConsumer> => (await this.liveFor(sn)).attach();
    const openReadable: NonNullable<MediaProvider["openReadable"]> = async (opts) => {
      const consumer = await attach();
      const readable = openReadableFromConsumer(consumer as unknown as Consumer, opts);
      opts?.signal?.addEventListener("abort", () => readable.destroy(), { once: true });
      return readable;
    };
    return {
      live: async (): Promise<LiveStreamConsumer> => attach(),
      openReadable,
      snapshotLive: async (opts) => {
        const timeoutMs = opts?.timeoutMs ?? 15_000;
        const readable = await openReadable();
        const args = [
          "-hide_banner",
          "-loglevel",
          this.deps.ffmpegLogLevel ?? "error",
          "-f",
          "hevc",
          "-i",
          "pipe:0",
          "-frames:v",
          "1",
          "-f",
          "image2",
          "pipe:1",
        ];
        const ff = spawn(this.deps.ffmpegPath ?? "ffmpeg", args, { stdio: ["pipe", "pipe", "ignore"] });
        const chunks: Buffer[] = [];
        const jpeg = await new Promise<Buffer>((resolve, reject) => {
          const timer = setTimeout(() => {
            ff.kill("SIGKILL");
            reject(new LiveSnapshotUnavailableError("no-keyframe", `no keyframe decoded within ${timeoutMs}ms`));
          }, timeoutMs);
          ff.stdout.on("data", (c: Buffer) => chunks.push(c));
          ff.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
          ff.on("close", () => {
            clearTimeout(timer);
            const out = Buffer.concat(chunks);
            out.length
              ? resolve(out)
              : reject(new LiveSnapshotUnavailableError("undecodable-burst", "ffmpeg produced no image"));
          });
          readable.on("error", () => ff.stdin.end());
          readable.pipe(ff.stdin);
        }).finally(() => readable.destroy());
        const geometry = jpegGeometry(jpeg);
        if (!geometry)
          throw new LiveSnapshotUnavailableError("undecodable-burst", "decoded image has no JPEG geometry");
        return { jpeg, ...geometry };
      },
      record: async () => {
        throw unsupported("record");
      },
      recordFragments: () => {
        throw unsupported("recordFragments");
      },
      talkback: async () => {
        throw unsupported("talkback");
      },
      p2pQuery: async () => {
        throw unsupported("p2pQuery");
      },
      p2pControlQuery: async () => {
        throw unsupported("p2pControlQuery");
      },
    } as MediaProvider;
  }

  private drop(sn: string, st: StationSession): void {
    if (st.idle) clearTimeout(st.idle);
    if (this.sessions.get(sn) === st) this.sessions.delete(sn);
    try {
      st.session.close();
    } catch {
      /* already gone */
    }
  }
}
