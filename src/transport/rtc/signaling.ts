/**
 * The T9000's signalling channel: the WebSocket through which a client and a HomeBase S1 Pro agree on a
 * WebRTC session. It is the wire the security.eufy.com web client uses (`/v1/rtc/ws/join`), and the hub
 * accepts it from any client presenting the account's mega token.
 *
 * Sequence:
 *
 *   1. `GET https://<smart host>/v1/smart/nvr/ws/sign` with the mega token → a `sign` blob.
 *   2. WebSocket to `wss://<smart host>/v1/rtc/ws/join?reqtype=nvr`, subprotocols `["v1", <base64url
 *      JSON>]` carrying the cluster region, station serial, token, `gtoken` and the sign. HTTP headers on
 *      the upgrade alone are refused: the JSON subprotocol is what authenticates.
 *   3. `action 1` auth on open; `action 3` session messages after: `scall` (start), `info` (SDP and
 *      trickle ICE), `ack`, `hangup`. Every session message carries an HMAC-SHA256 `account` over
 *      `channelId + adminUserId + ts`, keyed by the token.
 *
 * Region is two values: the HTTP sign request names the account's **country** (`Web-Country`), the
 * WebSocket payload names the **cluster**, the shard prefix uppercased (`ie-pr` → `IE`). The smart host
 * is `security-smart` for `us` and `security-smart-<prefix>` for any other shard.
 *
 * `fetch` and the `WebSocket` constructor are injectable.
 */

import { EventEmitter } from "node:events";
import { createHmac, randomUUID } from "node:crypto";
import { noopLogger, type Logger } from "../../core/logger.js";

const RTC_WS_PATH = "/v1/rtc/ws/join?reqtype=nvr";
const RTC_SIGN_PATH = "/v1/smart/nvr/ws/sign";
/** The portal's origin; the sign endpoint and the socket upgrade both check it. */
export const PORTAL_ORIGIN = "https://security.eufy.com";
/** The hub drops an idle signalling socket after ~83 s; re-sending auth inside that keeps it. */
export const SIGNALING_KEEPALIVE_MS = 25_000;
/** How long the socket has to open after the sign. */
export const SIGNALING_CONNECT_TIMEOUT_MS = 15_000;
/** The `source` every message carries, as the portal sends it. */
const SOURCE = "WEB";

/** Outer wire envelope. */
export interface RtcWsEnvelope {
  msgid: string;
  data: string;
}

/** Inner message (the envelope's `data`, JSON-parsed). */
export interface RtcInnerMessage {
  code?: number;
  action?: number;
  sessionId?: string;
  sn?: string;
  subSn?: string;
  channelId?: number;
  isResponse?: number;
  dataType?: string;
  source?: string;
  ts?: number;
  data?: string;
  msgid?: string;
}

/** What a socket event carries; only the fields each event type fills are read. */
export interface SignalingSocketEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

/** The subset of a `WebSocket` the client uses. */
export interface SignalingSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: SignalingSocketEvent) => void): void;
}

export interface SignalingSocketInit {
  /** The subprotocols; slot 2 carries the base64url auth JSON. */
  protocols: string[];
  /** The upgrade Origin, which the server checks like the sign call. */
  origin: string;
}
export type SignalingSocketFactory = (url: string, init: SignalingSocketInit) => SignalingSocket;

export interface RtcSignalingOptions {
  /** Full SDP (`call`) or compact SDP (`scall`, the default). */
  signalingMode?: "call" | "scall";
  /** The mega session's auth token. */
  authToken: string;
  /** The `gtoken` header value the mega session's authed HTTP calls carry. */
  gtoken: string;
  stationSn: string;
  /** The station's `member.admin_user_id`, the account the session HMAC names. */
  adminUserId: string;
  /** The mega shard the account lives on; picks the host and the cluster name. */
  shard: string;
  /** The account's ISO country, sent on the sign request (`Web-Country`). */
  country: string;
  fetch?: typeof fetch;
  createSocket?: SignalingSocketFactory;
  logger?: Logger;
  now?: () => number;
  makeMsgId?: () => string;
}

export interface RtcSignalingEvents {
  message: [inner: RtcInnerMessage, envelope: RtcWsEnvelope];
  open: [];
  close: [code: number, reason: string];
  error: [err: Error];
}

/** The portal's `account` field: HMAC-SHA256 of `channelId + adminUserId + ts`, keyed by the token. */
export function sessionAccount(channelId: number, adminUserId: string, ts: number, authToken: string): string {
  return createHmac("sha256", authToken).update(`${channelId}${adminUserId}${ts}`).digest("hex");
}

const WS_OPEN = 1;

/**
 * Node's global WebSocket (undici) takes an options object with `headers`. Unlike a browser it sends no
 * Origin of its own, and the smart host rejects an upgrade without one.
 */
const defaultSocket: SignalingSocketFactory = (url, init) =>
  new WebSocket(url, {
    protocols: init.protocols,
    headers: { Origin: init.origin },
  } as unknown as string[]) as unknown as SignalingSocket;

export class RtcSignalingClient extends EventEmitter<RtcSignalingEvents> {
  private ws?: SignalingSocket;
  private sign?: string;
  private keepalive?: NodeJS.Timeout;
  private readonly wsUrl: string;
  private readonly signUrl: string;
  private readonly wsRegion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly createSocket: SignalingSocketFactory;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly makeMsgId: () => string;

  constructor(private readonly opts: RtcSignalingOptions) {
    super();
    const prefix = (opts.shard.split("-")[0] || "us").toLowerCase();
    const smartHost = prefix === "us" ? "security-smart.eufylife.com" : `security-smart-${prefix}.eufylife.com`;
    this.wsUrl = `wss://${smartHost}${RTC_WS_PATH}`;
    this.signUrl = `https://${smartHost}${RTC_SIGN_PATH}`;
    this.wsRegion = prefix.toUpperCase();
    this.fetchImpl = opts.fetch ?? fetch;
    this.createSocket = opts.createSocket ?? defaultSocket;
    this.logger = opts.logger ?? noopLogger;
    this.now = opts.now ?? Date.now;
    this.makeMsgId = opts.makeMsgId ?? (() => randomUUID().replace(/-/g, ""));
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  /** Step 1: the sign blob the socket and every auth message carry. A non-JSON body is reported by status. */
  async fetchSign(): Promise<string> {
    const res = await this.fetchImpl(this.signUrl, {
      headers: {
        "Web-Country": this.opts.country.toUpperCase(),
        "X-Auth-Token": this.opts.authToken,
        "App-Name": "eufy_mega",
        "Model-Type": "WEB",
        GToken: this.opts.gtoken,
        Origin: PORTAL_ORIGIN,
      },
    });
    const body = ((await res.json().catch(() => ({}))) ?? {}) as { code?: number; data?: string; msg?: string };
    if (!res.ok || body.code !== 0 || !body.data) {
      throw new Error(
        `RTC sign for ${this.opts.stationSn} refused: HTTP ${res.status} code ${body.code ?? "?"} ${body.msg ?? ""}`.trim(),
      );
    }
    this.sign = body.data;
    return body.data;
  }

  /**
   * Step 2: open the socket and send the first auth; resolves on `open`. A socket that closes or errors
   * before it ever opened rejects, so the call always settles.
   */
  async connect(): Promise<void> {
    if (this.ws) return;
    const sign = this.sign ?? (await this.fetchSign());
    const auth = {
      region: this.wsRegion,
      type: "NVR",
      sn: this.opts.stationSn,
      token: this.opts.authToken,
      gtoken: this.opts.gtoken,
      sign,
      appName: "eufy_mega",
      modelType: "WEB",
    };
    const protocols = ["v1", Buffer.from(JSON.stringify(auth)).toString("base64url")];
    this.logger.debug(`[rtc] ${this.opts.stationSn} signalling connect ${this.wsUrl}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`RTC signalling connect timeout after ${SIGNALING_CONNECT_TIMEOUT_MS}ms`));
        this.close();
      }, SIGNALING_CONNECT_TIMEOUT_MS);
      const ws = this.createSocket(this.wsUrl, { protocols, origin: PORTAL_ORIGIN });
      this.ws = ws;
      let opened = false;
      ws.addEventListener("open", () => {
        opened = true;
        clearTimeout(timer);
        this.sendAuth(sign);
        this.startKeepalive();
        this.emit("open");
        resolve();
      });
      ws.addEventListener("message", (ev) => {
        void this.handleWireMessage(ev.data);
      });
      ws.addEventListener("close", (ev) => {
        clearTimeout(timer);
        this.stopKeepalive();
        this.ws = undefined;
        const code = ev.code ?? 1006;
        const reason = ev.reason ?? "";
        this.logger.debug(`[rtc] ${this.opts.stationSn} signalling closed ${code} ${reason}`);
        if (!opened) reject(new Error(`RTC signalling closed before open: ${code} ${reason}`.trim()));
        this.emit("close", code, reason);
      });
      ws.addEventListener("error", (ev) => {
        clearTimeout(timer);
        const detail = (ev as { error?: { message?: string; code?: string }; message?: string } | undefined) ?? {};
        const cause = detail.error?.message ?? detail.error?.code ?? detail.message ?? "";
        reject(new Error(`RTC signalling socket error${cause ? ": " + cause : ""}`));
      });
    });
  }

  /** `action 1`, also what keeps the socket alive when re-sent. */
  sendAuth(sign?: string): void {
    const s = sign ?? this.sign;
    if (!s) throw new Error("RTC signalling: no sign to authenticate with");
    this.sendEnvelope("0", {
      code: 200,
      action: 1,
      data: s,
      sn: this.opts.stationSn,
      source: SOURCE,
      ts: Math.floor(this.now() / 1000),
    });
  }

  /**
   * `action 3`, a session message on channel 0, the hub's own session; `scall` opens the negotiation.
   * `subSn` is empty for the hub's session.
   */
  sendSession(dataType: string, payload: Record<string, unknown> = {}): void {
    const channelId = 0;
    const ts = Math.floor(this.now() / 1000);
    const inner = {
      code: 200,
      action: 3,
      sessionId: this.sign,
      sn: this.opts.stationSn,
      subSn: "",
      channelId,
      isResponse: 0,
      dataType,
      source: SOURCE,
      ts,
      data: JSON.stringify({
        timestamp: ts,
        account: sessionAccount(channelId, this.opts.adminUserId, ts, this.opts.authToken),
        ...payload,
      }),
    };
    this.sendEnvelope(`${this.opts.authToken}_${this.makeMsgId()}`, inner);
  }

  sendCall(): void {
    this.sendSession(this.opts.signalingMode ?? "scall");
  }

  sendAck(): void {
    this.sendSession("ack");
  }

  /** The SDP answer, encoded for the negotiated call format, in an `info`. */
  sendInfoSdp(sdp: string): void {
    this.sendSession("info", { sdp });
  }

  /** Trickle a candidate on the session's channel, like its SDP answer. An empty candidate ends them. */
  sendInfoCandidate(candidate: string): void {
    this.sendSession("info", { candidate });
  }

  sendHangup(): void {
    this.sendSession("hangup");
  }

  close(): void {
    this.stopKeepalive();
    const ws = this.ws;
    this.ws = undefined;
    try {
      ws?.close();
    } catch {
      /* already gone */
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive();
    this.keepalive = setInterval(() => {
      if (!this.isOpen) return;
      try {
        this.sendAuth();
      } catch (e) {
        this.logger.warn(`[rtc] ${this.opts.stationSn} signalling keepalive failed`, e);
      }
    }, SIGNALING_KEEPALIVE_MS);
    this.keepalive.unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = undefined;
  }

  private sendEnvelope(msgid: string, inner: Record<string, unknown>): void {
    if (!this.isOpen || !this.ws) throw new Error("RTC signalling not connected");
    const envelope: RtcWsEnvelope = { msgid, data: JSON.stringify(inner) };
    this.ws.send(JSON.stringify(envelope));
  }

  private async handleWireMessage(raw: unknown): Promise<void> {
    let text: string;
    if (typeof raw === "string") text = raw;
    else if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
    else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString("utf8");
    else if (typeof (raw as Blob)?.text === "function") text = await (raw as Blob).text();
    else return;
    let envelope: RtcWsEnvelope;
    let inner: RtcInnerMessage;
    try {
      envelope = JSON.parse(text) as RtcWsEnvelope;
      if (typeof envelope?.data !== "string") return;
      inner = JSON.parse(envelope.data) as RtcInnerMessage;
    } catch {
      return;
    }
    this.emit("message", inner, envelope);
  }
}
