/**
 * The T9000's signalling channel — the WebSocket through which a client and a HomeBase S1 Pro agree on
 * a WebRTC session. This is the wire security.eufy.com's web client uses (`/v1/rtc/ws/join`), which the
 * hub accepts from any client that presents the account's mega token, so it needs nothing the SDK does
 * not already hold after login.
 *
 * Sequence, as reversed from the portal and confirmed live on US and FR hubs
 * (genomez/eufy-security-client, MIT):
 *
 *   1. `GET https://<smart host>/v1/smart/nvr/ws/sign` with the mega token → a `sign` blob.
 *   2. WebSocket to `wss://<smart host>/v1/rtc/ws/join?reqtype=nvr`, subprotocols `["v1", <base64url
 *      JSON>]` carrying region, station serial, token, `gtoken` (md5 of the ACCOUNT user_id, not the ap_cloud one) and the sign. HTTP
 *      headers on the upgrade alone are refused — the JSON subprotocol is what authenticates.
 *   3. `action 1` auth on open; `action 3` session messages after: `scall` (start), `info` (SDP and
 *      trickle ICE), `ack`, `hangup`. Every session message carries an HMAC-SHA256 `account` over
 *      `channelId + adminUserId + ts`, keyed by the token.
 *
 * Region is two different things and the portal sends both: the HTTP sign request names the account's
 * **country** (`Web-Country: FR`), the WebSocket payload names the **cluster** (`region: "EU"`). Sending
 * the country in the cluster slot authenticates the sign and then fails the socket — that is exactly the
 * mismatch that cost an FR tester ten builds, so the two are separate options here and both derive from
 * the mega session's shard by default.
 *
 * `fetch` and the `WebSocket` constructor are injectable so the whole exchange is testable offline.
 */

import { EventEmitter } from "node:events";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { noopLogger, type Logger } from "../../core/logger.js";

export type RtcRegionShard = "eu-pr" | "ie-pr" | "us-pr";

/** The signalling host per mega shard — the global one serves US, EU accounts have their own. */
export const SMART_HOST_BY_SHARD: Readonly<Record<RtcRegionShard, string>> = {
  "us-pr": "security-smart.eufylife.com",
  "eu-pr": "security-smart-eu.eufylife.com",
  // Ireland has its OWN smart host, not the eu one — verified 200/bizcode 0 on a live CH account.
  "ie-pr": "security-smart-ie.eufylife.com",
};

/**
 * The smart host for a shard, deriving `security-smart-<prefix>` for any shard not in the table (us is
 * the bare host). So a shard we have not seen still gets its regional host instead of failing.
 */
export function smartHostForShard(shard: string): string {
  if (shard in SMART_HOST_BY_SHARD) return SMART_HOST_BY_SHARD[shard as RtcRegionShard];
  const prefix = shard.split("-")[0]?.toLowerCase();
  return !prefix || prefix === "us" ? "security-smart.eufylife.com" : `security-smart-${prefix}.eufylife.com`;
}

/** The cluster name the WebSocket payload wants per shard. */
/**
 * The cluster name the WebSocket subprotocol payload wants: the shard prefix uppercased. Verified
 * live — an `ie-pr` account gets WS 101 with `"IE"` and 400 with `"EU"`, so this is NOT an EU-family
 * grouping, it is the shard's own region letter (us-pr → US, eu-pr → EU, ie-pr → IE).
 */
export function wsRegionForShard(shard: string): string {
  return (shard.split("-")[0] || "us").toUpperCase();
}

export const RTC_WS_PATH = "/v1/rtc/ws/join?reqtype=nvr";
export const RTC_SIGN_PATH = "/v1/smart/nvr/ws/sign";
/** The portal's origin; the sign endpoint checks it. */
export const PORTAL_ORIGIN = "https://security.eufy.com";
/** The hub drops an idle signalling socket after ~83 s; the portal re-sends auth well inside that. */
export const SIGNALING_KEEPALIVE_MS = 25_000;

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

/** The subset of a browser/undici `WebSocket` the client uses — what a test doubles. */
/** What a socket event carries; only the fields each event type actually fills are read. */
export interface SignalingSocketEvent {
  data?: unknown;
  code?: number;
  reason?: string;
}

export interface SignalingSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (ev: SignalingSocketEvent) => void): void;
}

export interface SignalingSocketInit {
  /** The subprotocols; slot 2 carries the base64url auth JSON. */
  protocols: string[];
  /** The upgrade Origin — the portal sends it and the server checks it, like the sign call. */
  origin: string;
}
export type SignalingSocketFactory = (url: string, init: SignalingSocketInit) => SignalingSocket;

export interface RtcSignalingOptions {
  /** The mega session's auth token. */
  authToken: string;
  /**
   * The mega session's user id — the `ap_cloud_user_id` the scall `account` HMAC and `subSn` path use.
   * NOTE: this is NOT necessarily the id `gtoken` hashes — see `gtoken` / `accountUserId`.
   */
  userId: string;
  /**
   * The eufy ACCOUNT user_id, whose md5 is the `gtoken` the portal sends. On accounts where the login
   * reply carries a separate `ap_cloud_user_id`, this differs from {@link userId}, and hashing the wrong
   * one is a silent sign rejection. Defaults to {@link userId}; overridden by an explicit {@link gtoken}.
   */
  accountUserId?: string;
  /** The gtoken to send verbatim, when it is known directly (e.g. read from a live session). */
  gtoken?: string;
  stationSn: string;
  /**
   * The camera the session is for, when it is a per-camera (live) session rather than the hub's own —
   * the portal sends it on every session message as `subSn`, empty for the hub.
   */
  subSn?: string;
  /** The station's `member.admin_user_id`, the account the session HMAC names. */
  adminUserId: string;
  /** The mega shard the account lives on; picks the host and the cluster name. */
  shard: RtcRegionShard;
  /** The account's ISO country, sent on the sign request (`Web-Country`). */
  country: string;
  /** Overrides for the shard-derived defaults. */
  smartHost?: string;
  wsRegion?: string;
  /** `WEB` (the portal) or `APP`; the hub accepts both. */
  source?: string;
  connectTimeoutMs?: number;
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

/** Raised when the sign endpoint refuses the token; the caller decides whether to re-login. */
export class RtcSignError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly apiCode: number | undefined,
  ) {
    super(message);
    this.name = "RtcSignError";
  }

  /** A 401 whose text says the token is gone — the portal's own wording for a revoked mega session. */
  get tokenRevoked(): boolean {
    const text = this.message.toLowerCase();
    return this.httpStatus === 401 && text.includes("token") && /not exist|does not exist|kicked out/.test(text);
  }
}

export function gtokenFromUserId(userId: string): string {
  return createHash("md5").update(userId).digest("hex");
}

export function base64urlJson(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** The portal's `account` field: HMAC-SHA256 of `channelId + adminUserId + ts`, keyed by the token. */
export function sessionAccount(channelId: number, adminUserId: string, ts: number, authToken: string): string {
  return createHmac("sha256", authToken).update(`${channelId}${adminUserId}${ts}`).digest("hex");
}

const WS_OPEN = 1;

export class RtcSignalingClient extends EventEmitter<RtcSignalingEvents> {
  private ws?: SignalingSocket;
  private sign?: string;
  private keepalive?: NodeJS.Timeout;
  private readonly smartHost: string;
  private readonly wsRegion: string;
  private readonly source: string;
  private readonly gtoken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly createSocket: SignalingSocketFactory;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly makeMsgId: () => string;

  constructor(private readonly opts: RtcSignalingOptions) {
    super();
    this.smartHost = opts.smartHost ?? smartHostForShard(opts.shard);
    this.wsRegion = opts.wsRegion ?? wsRegionForShard(opts.shard);
    this.source = opts.source ?? "WEB";
    this.gtoken = opts.gtoken ?? gtokenFromUserId(opts.accountUserId ?? opts.userId);
    this.fetchImpl = opts.fetch ?? fetch;
    this.createSocket =
      opts.createSocket ??
      ((url, init) =>
        // Node's global WebSocket (undici) takes an options object with `headers`; browsers send Origin
        // for us, Node does not, and the smart host rejects the upgrade without it.
        new WebSocket(url, {
          protocols: init.protocols,
          headers: { Origin: init.origin },
        } as unknown as string[]) as unknown as SignalingSocket);
    this.logger = opts.logger ?? noopLogger;
    this.now = opts.now ?? Date.now;
    this.makeMsgId = opts.makeMsgId ?? (() => randomUUID().replace(/-/g, ""));
  }

  get wsUrl(): string {
    return `wss://${this.smartHost}${RTC_WS_PATH}`;
  }

  get signUrl(): string {
    return `https://${this.smartHost}${RTC_SIGN_PATH}`;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  /** Step 1 — the sign blob the socket and every auth message carry. */
  async fetchSign(): Promise<string> {
    const res = await this.fetchImpl(this.signUrl, {
      headers: {
        "Web-Country": this.opts.country.toUpperCase(),
        "X-Auth-Token": this.opts.authToken,
        "App-Name": "eufy_mega",
        "Model-Type": "WEB",
        GToken: this.gtoken,
        Origin: PORTAL_ORIGIN,
      },
    });
    let body: { code?: number; data?: string; msg?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* a non-JSON body is reported through the status below */
    }
    if (!res.ok || body.code !== 0 || !body.data) {
      throw new RtcSignError(
        `RTC sign for ${this.opts.stationSn} refused: HTTP ${res.status} ${body.msg ?? ""}`.trim(),
        res.status,
        body.code,
      );
    }
    this.sign = body.data;
    return body.data;
  }

  /** The base64url JSON that authenticates the socket (subprotocol slot 2). */
  subprotocolPayload(sign: string): Record<string, unknown> {
    return {
      region: this.wsRegion,
      type: "NVR",
      sn: this.opts.stationSn,
      token: this.opts.authToken,
      gtoken: this.gtoken,
      sign,
      appName: "eufy_mega",
      modelType: "WEB",
    };
  }

  /** Step 2 — open the socket and send the first auth; resolves on `open`. */
  async connect(): Promise<void> {
    if (this.ws) return;
    const sign = this.sign ?? (await this.fetchSign());
    const protocols = ["v1", base64urlJson(this.subprotocolPayload(sign))];
    const timeoutMs = this.opts.connectTimeoutMs ?? 15_000;
    this.logger.debug(`[rtc] ${this.opts.stationSn} signalling connect ${this.wsUrl}`);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`RTC signalling connect timeout after ${timeoutMs}ms`));
        this.close();
      }, timeoutMs);
      const ws = this.createSocket(this.wsUrl, { protocols, origin: PORTAL_ORIGIN });
      this.ws = ws;
      // A socket that closes or errors before it ever opened has to SETTLE connect(); clearing the
      // timer alone would leave the caller awaiting a promise nothing can resolve.
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

  /** `action 1` — also what keeps the socket alive when re-sent. */
  sendAuth(sign?: string): void {
    const s = sign ?? this.sign;
    if (!s) throw new Error("RTC signalling: no sign to authenticate with");
    this.sendEnvelope("0", {
      code: 200,
      action: 1,
      data: s,
      sn: this.opts.stationSn,
      source: this.source,
      ts: Math.floor(this.now() / 1000),
    });
  }

  /** `action 3` — a session message; `scall` opens the negotiation. */
  sendSession(dataType: string, payload: Record<string, unknown> = {}, channelId = 0): void {
    const ts = Math.floor(this.now() / 1000);
    const inner = {
      code: 200,
      action: 3,
      sessionId: this.sign,
      sn: this.opts.stationSn,
      subSn: this.opts.subSn ?? "",
      channelId,
      isResponse: 0,
      dataType,
      source: this.source,
      ts,
      data: JSON.stringify({
        timestamp: ts,
        account: sessionAccount(channelId, this.opts.adminUserId, ts, this.opts.authToken),
        ...payload,
      }),
    };
    this.sendEnvelope(`${this.opts.authToken}_${this.makeMsgId()}`, inner);
  }

  sendCall(channelId = 0): void {
    this.sendSession("scall", {}, channelId);
  }

  sendAck(channelId = 0): void {
    this.sendSession("ack", {}, channelId);
  }

  /** SDP (as scall JSON text) rides channel 0 in an `info`. */
  sendInfoSdp(scallJson: string, channelId = 0): void {
    this.sendSession("info", { sdp: scallJson }, channelId);
  }

  /**
   * Trickle a candidate on the session's own channel — the portal sends every candidate on the same
   * channelId as its SDP answer, not on a fixed channel. The default is the command channel; callers
   * with a non-zero session pass their own. An empty candidate is end-of-candidates.
   */
  sendInfoCandidate(candidate: string, channelId = 0): void {
    this.sendSession("info", { candidate }, channelId);
  }

  sendHangup(channelId = 0): void {
    this.sendSession("hangup", {}, channelId);
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
