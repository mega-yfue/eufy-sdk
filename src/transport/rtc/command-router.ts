/**
 * RTC command router: drives a station over the portal's WebRTC data channel instead of P2P.
 *
 * The T9000 answers no P2P lookup, but it accepts the portal's control channel: sign → WS join → scall →
 * SDP answer → ICE over the relay the hub grants → DTLS → SCTP data channels, with commands riding
 * `WebrtcDataChannel` as portal packets (see {@link buildPortalPacket}).
 *
 * `set-payload` rides the `1350` SET_PAYLOAD envelope, inner `{account_id, cmd, mValue3, payload}`;
 * `set-json` rides the `1700` CONTROL_PAYLOAD envelope, inner `{account_id, cmd, commandType, data}`.
 * A command to the station goes on the station channel `255`; an attached device's command shares the
 * station's session and keeps the device's channel. Other command kinds are refused.
 *
 * One session per station, reused across commands and closed after {@link IDLE_CLOSE_MS} without one.
 * Sends on a session are serialised; an ACK is correlated by its outer command and segment, since it
 * carries no inner command. An ACK is not an observation of the resulting state.
 */
import type { Command } from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";
import { RtcSession, type RtcSessionOptions } from "./session.js";
import { buildPortalPacket, parsePortalPacket, PortalLinkType, SegmentCounter } from "./portal-packet.js";

/** The SET_PAYLOAD envelope. */
const PORTAL_CMD_SET_PAYLOAD = 1350;
/** The CONTROL_PAYLOAD envelope for a commandType/data request. */
const PORTAL_CMD_CONTROL_PAYLOAD = 1700;
/** The envelope carrying a correlated JSON control result. */
const PORTAL_CMD_NOTIFY_PAYLOAD = 1351;
/** The channel a station-wide command is addressed to. */
const PORTAL_STATION_CHANNEL = 255;

/** How long a command waits for its envelope ACK. */
const ACK_TIMEOUT_MS = 8_000;
/**
 * How long a session has to come up. A healthy hub answers in ~2 s; the bound sits under the ~15 s a
 * service call is commonly given, so a hub outage surfaces as this router's error.
 */
const CONNECT_TIMEOUT_MS = 12_000;
/** An idle station session is closed after this long. */
const IDLE_CLOSE_MS = 60_000;

export interface RtcIdentity {
  authToken: string;
  userId: string;
  /** The `gtoken` header value the mega session's authed HTTP calls carry. */
  gtoken: string;
}

/** Where a command goes: the station's session, and whether it addresses the station or a device on it. */
export interface RtcRoute {
  /** The station's signaling exchange; defaults to compact SDP. */
  signalingMode?: "call" | "scall";
  /** Candidate policy used by the station's exchange; defaults to relay-only. */
  iceTransportPolicy?: "relay" | "all";
  stationSn: string;
  /**
   * The station's `member.admin_user_id`, the account the session and the payload name; the logged-in
   * user when the station's record carries none.
   */
  adminUserId?: string;
  /** True for a device attached to the station, which keeps the command's own channel. */
  attached: boolean;
}

export interface RtcCommandRouterDeps {
  /** The logged-in session's credentials; `undefined` while logged out. */
  identity: () => RtcIdentity | undefined;
  /** The mega shard the account signs on (`"ie-pr"`, `"eu-pr"`, `"us-pr"`); picks the smart host. */
  shard: () => string;
  /** ISO country sent on the sign request (default `US`). */
  country?: string;
  logger?: Logger;
  onError?: (e: Error) => void;
  createSession?: (opts: RtcSessionOptions) => RtcSession;
}

interface StationSession {
  session: RtcSession;
  seg: SegmentCounter;
  ready: Promise<void>;
  /** Serialises sends so ACKs can't be attributed to the wrong command. */
  queue: Promise<unknown>;
  idle?: ReturnType<typeof setTimeout>;
}

export class RtcCommandRouter {
  private readonly sessions = new Map<string, StationSession>();

  constructor(private readonly deps: RtcCommandRouterDeps) {}

  async dispatchCommand(route: RtcRoute, cmd: Command): Promise<void> {
    if (cmd.kind !== "set-payload" && cmd.kind !== "set-json") {
      throw new Error(`rtc: ${cmd.kind} is not routable over the RTC control channel (only set-payload or set-json)`);
    }
    const identity = this.deps.identity();
    if (!identity) throw new Error(`rtc: not logged in, cannot drive ${route.stationSn}`);
    const { stationSn } = route;
    const adminUserId = route.adminUserId || identity.userId;
    const channel = route.attached ? cmd.channel : PORTAL_STATION_CHANNEL;
    const st = await this.stationSession(route, adminUserId, identity);
    const outerCmd = cmd.kind === "set-json" ? PORTAL_CMD_CONTROL_PAYLOAD : PORTAL_CMD_SET_PAYLOAD;
    const innerCmd = cmd.kind === "set-json" ? cmd.param : cmd.cmd;
    const payload =
      cmd.kind === "set-json"
        ? { account_id: adminUserId, cmd: cmd.param, commandType: cmd.param, data: cmd.data }
        : { account_id: adminUserId, cmd: cmd.cmd, mValue3: cmd.mValue3 ?? 0, payload: cmd.payload };
    const segment = st.seg.next();
    const packet = buildPortalPacket({ commandId: outerCmd, channel, segment, payload });
    const run = st.queue.then(() => this.sendAwaitAck(stationSn, st, packet, outerCmd, innerCmd, channel, segment));
    st.queue = run.catch(() => undefined);
    return run;
  }

  /** Tear down every station session (logout / shutdown). */
  close(): void {
    for (const [sn, st] of this.sessions) this.drop(sn, st);
  }

  /**
   * Completes on the command ACK or a correlated control-result notification. The notification must
   * match the request channel, parameter and segment and contain a structured payload. Receipt does
   * not establish physical actuation. The command is sent once, bounded by {@link ACK_TIMEOUT_MS}.
   */
  private sendAwaitAck(
    sn: string,
    st: StationSession,
    packet: Buffer,
    outerCmd: number,
    innerCmd: number,
    channel: number,
    segment: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onData = (frame: Buffer, linkType: number) => {
        const p = parsePortalPacket(frame, linkType);
        if (!p || p.segment !== segment) return;
        const acknowledgement = linkType === PortalLinkType.COMMAND && p.commandId === outerCmd && !!p.isResponse;
        const d = p.data as { payload?: unknown } | null | undefined;
        const notification =
          outerCmd === PORTAL_CMD_CONTROL_PAYLOAD &&
          linkType === PortalLinkType.NOTIFY &&
          p.commandId === PORTAL_CMD_NOTIFY_PAYLOAD &&
          p.isResponse === 0 &&
          p.channel === channel &&
          p.cmd === innerCmd &&
          typeof d?.payload === "object" &&
          d.payload !== null;
        if (!acknowledgement && !notification) return;
        cleanup();
        if (acknowledgement && p.errCode !== 0) {
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
        reject(new Error(`rtc: ${sn} cmd ${innerCmd} ACK timed out after ${ACK_TIMEOUT_MS}ms`));
      }, ACK_TIMEOUT_MS);
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

  private async stationSession(route: RtcRoute, adminUserId: string, identity: RtcIdentity): Promise<StationSession> {
    const sn = route.stationSn;
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
      gtoken: identity.gtoken,
      stationSn: sn,
      adminUserId,
      shard: this.deps.shard(),
      country: this.deps.country ?? "US",
      logger: this.deps.logger,
      signalingMode: route.signalingMode,
      peer: { logger: this.deps.logger, iceTransportPolicy: route.iceTransportPolicy },
    });
    const ready = this.bringUp(sn, session);
    const st: StationSession = { session, seg: new SegmentCounter(), ready, queue: Promise.resolve() };
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
   * One bounded bring-up: the session is up when its command channel opens, and it fails, with the
   * session closed and every listener gone, when `connect()` throws, the session closes first, or
   * {@link CONNECT_TIMEOUT_MS} passes. A single promise, so an early failure cannot leave a second one
   * rejecting unheard.
   */
  private bringUp(sn: string, session: RtcSession): Promise<void> {
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
          this.deps.logger?.info?.(`[rtc] ${sn} command channel up`);
          resolve();
        }
      };
      const onConnected = () => finish();
      const onClose = () => finish(new Error(`rtc: ${sn} session closed before the command channel opened`));
      const timer = setTimeout(
        () => finish(new Error(`rtc: ${sn} did not come up within ${CONNECT_TIMEOUT_MS}ms`)),
        CONNECT_TIMEOUT_MS,
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
    st.idle = setTimeout(() => this.drop(sn, st), IDLE_CLOSE_MS);
    st.idle.unref?.();
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
