/**
 * FCM/MCS push client — holds a persistent TLS connection to Google's MCS
 * (mtalk.google.com:5228), logs in with the check-in androidId/securityToken,
 * heartbeats, and decodes DataMessageStanza pushes into eufy PushEvents.
 *
 * Implements Google's FCM/MCS push protocol; live-verified against real account pushes.
 */
import { EventEmitter } from "node:events";
import tls from "node:tls";
import { mcsRoot } from "./proto.js";
import { MessageTag } from "./message-tags.js";
import { McsParser } from "./parser.js";
import type {
  FcmCredentials,
  McsMessage,
  PushEvent,
  PushPayload,
  RawPushMessage,
  ThumbnailCandidate,
} from "./types.js";
import { noopLogger, type Logger } from "../../core/logger.js";

const HOST = "mtalk.google.com";
const PORT = 5228;
const MCS_VERSION = 41;
const HEARTBEAT_MS = 5 * 60 * 1000;
const SILENCE_MS = HEARTBEAT_MS + 60 * 1000;

function readNullTerminated(buf: Buffer): string {
  const i = buf.indexOf(0);
  return buf.toString("utf8", 0, i === -1 ? buf.length : i);
}

function nonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The levels of a decoded push, outermost first: the envelope, then each nested `payload` in turn,
 * JSON-parsed where it arrives as a string. The descent stops at the first level without an object
 * `payload`, so it holds however deep the wire nests the detail. A `payload` that is present but not an
 * object (unparseable text, a scalar) ends the walk with an empty detail level, as a malformed body
 * yields no fields.
 */
function payloadLevels(env: Record<string, unknown>): Record<string, unknown>[] {
  const levels = [env];
  for (let level = env; level.payload != null;) {
    let next: unknown = level.payload;
    if (typeof next === "string") {
      try {
        next = JSON.parse(next);
      } catch {
        next = undefined;
      }
    }
    level = typeof next === "object" && next ? (next as Record<string, unknown>) : {};
    levels.push(level);
  }
  return levels;
}

/**
 * Normalises a decoded eufy envelope without consulting device semantics; semantic event names remain unset.
 *
 * The detail (`event_type`, `pic_url`, `cipher`) is read from the deepest level of
 * `payloadLevels`; identity (`device_sn`, `station_sn`) is gathered from every level, deepest
 * first, so a serial is found whichever level the push carries it on.
 * @internal
 */
export function normalizePushEvent(raw: RawPushMessage): PushEvent {
  const env = raw.payload ?? {};
  const levels = payloadLevels(env);
  const p = levels[levels.length - 1] as PushPayload;
  const deepestFirst = [...levels].reverse();
  const deviceClaims = deepestFirst.map((l) => l.device_sn).filter(nonemptyString);
  const levelStations = deepestFirst.map((l) => l.station_sn).filter(nonemptyString);
  const stationClaims = nonemptyString(p.s) ? [...levelStations, p.s] : levelStations;
  const eventType = (p.event_type ?? p.a) as number | undefined;
  const url = nonemptyString(p.pic_url) ? p.pic_url : nonemptyString(p.thumbnail) ? p.thumbnail : undefined;
  let thumbnailCandidate: ThumbnailCandidate | undefined;
  if (url) {
    const deviceSn = deviceClaims[0];
    const stationSn = stationClaims[0];
    thumbnailCandidate = {
      url,
      attribution:
        deviceSn && deviceClaims.every((claim) => claim === deviceSn)
          ? { kind: "device", deviceSn }
          : deviceClaims.length === 0 && stationSn
            ? {
                kind: "station",
                ...(stationClaims.every((claim) => claim === stationSn) ? { stationSn } : {}),
              }
            : { kind: "ambiguous" },
    };
  }
  return {
    deviceSn: deviceClaims[0] ?? (nonemptyString(p.s) ? p.s : undefined),
    stationSn: levelStations[0],
    eventType,
    thumbnailUrl: (p.pic_url ?? p.thumbnail) as string | undefined,
    thumbnailCandidate,
    cipher: (p.cipher ?? p.k) as number | undefined,
    payload: p,
    raw,
  };
}

export class PushClient extends EventEmitter {
  /** Consecutive MCS login rejections tolerated (self-healing propagation) before surfacing an error. */
  private static readonly MAX_LOGIN_FAILURES = 3;
  private socket?: tls.TLSSocket;
  private readonly parser = new McsParser();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private currentDelay = 0;
  private persistentIds: string[] = [];
  private loggedIn = false;
  private closing = false;
  /** Timestamp (ms) of the last inbound MCS frame — the liveness signal the heartbeat checks. */
  private lastRxMs = 0;
  /** Consecutive MCS login rejections — transient ones self-heal via reconnect (see {@link onMessage}). */
  private loginFailures = 0;

  constructor(
    private readonly creds: FcmCredentials,
    private readonly logger: Logger = noopLogger,
  ) {
    super();
    this.parser.on("message", (m: McsMessage) => this.onMessage(m));
  }

  /** Persistent ids already seen (set this from storage to avoid re-delivery). */
  setPersistentIds(ids: string[]): void {
    this.persistentIds = ids;
  }
  getPersistentIds(): string[] {
    return this.persistentIds;
  }

  /**
   * Open the MCS connection and log in.
   *
   * `servername` is passed explicitly: Node sends SNI only when told to, never deriving it from `host`,
   * and this endpoint answers a connection without SNI with a self-signed certificate naming
   * `invalid2.invalid` — which now fails the handshake rather than being accepted. Verification matters
   * because the login request carries the account's `securityToken`, and an unverified peer could both
   * read it and inject forged pushes into the event path.
   */
  connect(): void {
    this.closing = false;
    this.parser.reset();
    this.loggedIn = false;
    const socket = tls.connect(PORT, HOST, { servername: HOST });
    this.socket = socket;
    socket.setKeepAlive(true);
    socket.on("secureConnect", () => {
      this.logger.debug("[push] TLS connected, sending login");
      socket.write(this.buildLoginRequest());
    });
    socket.on("data", (d: Buffer) => this.parser.handleData(d));
    socket.on("close", () => this.onClose());
    socket.on("error", (e) => {
      this.logger.warn(`[push] socket error: ${e.message}`);
      this.emit("error", e);
    });
  }

  private buildLoginRequest(): Buffer {
    const LoginRequest = mcsRoot().lookupType("mcs_proto.LoginRequest");
    const hexAndroidId = BigInt(this.creds.androidId).toString(16);
    const obj = {
      adaptiveHeartbeat: false,
      authService: 2,
      authToken: this.creds.securityToken,
      id: "chrome-63.0.3234.0",
      domain: "mcs.android.com",
      deviceId: `android-${hexAndroidId}`,
      networkType: 1,
      resource: this.creds.androidId,
      user: this.creds.androidId,
      useRmq2: true,
      setting: [{ name: "new_vc", value: "1" }],
      clientEvent: [],
      receivedPersistentId: this.persistentIds,
    };
    const buf = LoginRequest.encodeDelimited(obj).finish();
    return Buffer.concat([Buffer.from([MCS_VERSION, MessageTag.LoginRequest]), buf]);
  }

  private buildHeartbeatPing(): Buffer {
    const Ping = mcsRoot().lookupType("mcs_proto.HeartbeatPing");
    const buf = Ping.encodeDelimited({}).finish();
    return Buffer.concat([Buffer.from([MessageTag.HeartbeatPing]), buf]);
  }

  private buildHeartbeatAck(lastStreamId?: number): Buffer {
    const Ack = mcsRoot().lookupType("mcs_proto.HeartbeatAck");
    const obj = lastStreamId ? { lastStreamIdReceived: lastStreamId } : {};
    const buf = Ack.encodeDelimited(obj).finish();
    return Buffer.concat([Buffer.from([MessageTag.HeartbeatAck]), buf]);
  }

  private onMessage(m: McsMessage): void {
    this.lastRxMs = Date.now();
    switch (m.tag) {
      case MessageTag.LoginResponse:
        if (m.object?.error) {
          this.onLoginError(m.object.error);
        } else {
          this.loggedIn = true;
          this.currentDelay = 0;
          this.loginFailures = 0;
          this.startHeartbeat();
          this.logger.debug("[push] logged in");
          this.emit("connect");
        }
        break;
      case MessageTag.DataMessageStanza:
        this.handleDataMessage(m.object);
        break;
      case MessageTag.HeartbeatPing:
        if (this.socket) this.socket.write(this.buildHeartbeatAck(m.object?.lastStreamIdReceived));
        break;
      case MessageTag.HeartbeatAck:
        break;
      case MessageTag.Close:
        this.logger.debug("[push] server sent Close");
        this.socket?.destroy();
        break;
    }
  }

  /**
   * Handle an MCS `LoginResponse` carrying an error. Google occasionally rejects the FIRST login right
   * after check-in (`wrong_secret`) while the freshly-registered androidId/securityToken propagates —
   * it succeeds on the very next attempt. So a login rejection is treated as **transient**: log it and
   * close the socket to let the existing backoff reconnect retry with the same creds, rather than
   * surfacing a self-healing blip as a host-facing `error`. Only once it persists past
   * {@link MAX_LOGIN_FAILURES} consecutive attempts (creds genuinely stale) is it emitted as `error`.
   */
  private onLoginError(error: unknown): void {
    this.loginFailures++;
    const msg = `MCS login error: ${JSON.stringify(error)}`;
    if (this.loginFailures >= PushClient.MAX_LOGIN_FAILURES) {
      this.emit("error", new Error(`${msg} (after ${this.loginFailures} attempts)`));
    } else {
      this.logger.warn(`[push] ${msg} — retrying (attempt ${this.loginFailures})`);
    }
    this.socket?.destroy(); // → onClose → scheduleReconnect
  }

  /**
   * Decode one MCS `DataMessageStanza` into a {@link RawPushMessage} and the normalised event.
   *
   * `payload` carries the whole app_data envelope, with its `payload` entry (base64 of NUL-terminated
   * JSON) parsed in place: the envelope's own keys, `device_sn` and `station_sn` among them, sit beside
   * that entry.
   */
  private handleDataMessage(object: any): void {
    if (object?.persistentId) this.persistentIds.push(object.persistentId);
    const data: Record<string, any> = {};
    for (const kv of object?.appData ?? []) {
      if (kv.key === "payload") {
        const json = readNullTerminated(Buffer.from(kv.value, "base64"));
        try {
          data.payload = JSON.parse(json);
        } catch {
          data.payload = json;
        }
      } else {
        data[kv.key] = kv.value;
      }
    }
    const raw: RawPushMessage = {
      id: object?.id,
      from: object?.from,
      to: object?.to,
      category: object?.category,
      persistentId: object?.persistentId,
      ttl: object?.ttl,
      sent: object?.sent,
      payload: data,
    };
    this.emit("message", raw);
    const event = normalizePushEvent(raw);
    if (event) this.emit("push", event);
  }

  /**
   * Ping on an interval, and detect a half-open socket. MCS answers every `HeartbeatPing` with a
   * `HeartbeatAck`, so {@link SILENCE_MS} with no inbound frame means the link is dead (a write to a
   * half-open socket does not error for a long time, often never). We close it so {@link onClose}
   * reconnects, rather than keep writing pings into the void.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || !this.loggedIn) return;
      if (Date.now() - this.lastRxMs >= SILENCE_MS) {
        this.logger.debug("[push] no inbound within a heartbeat window — reconnecting");
        this.socket.destroy();
        return;
      }
      this.socket.write(this.buildHeartbeatPing());
    }, HEARTBEAT_MS);
  }
  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private onClose(): void {
    this.stopHeartbeat();
    this.loggedIn = false;
    this.emit("disconnect");
    if (!this.closing) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = this.currentDelay === 0 ? 5000 : this.currentDelay;
    if (this.currentDelay < 60000) this.currentDelay += 10000;
    else if (this.currentDelay < 600000) this.currentDelay += 60000;
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.closing) this.connect();
    }, delay);
  }

  close(): void {
    this.closing = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.destroy();
    this.socket = undefined;
  }
}
