import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  PORTAL_ORIGIN,
  RtcSignalingClient,
  sessionAccount,
  type RtcSignalingOptions,
  type SignalingSocket,
  type SignalingSocketEvent,
} from "../signaling.js";

class FakeSocket implements SignalingSocket {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  private listeners: Record<string, Array<(ev: SignalingSocketEvent) => void>> = {};

  constructor(
    readonly url: string,
    readonly protocols: string[],
    readonly origin?: string,
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.fire("close", { code: 1000, reason: "bye" });
  }

  addEventListener(type: string, listener: (ev: SignalingSocketEvent) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  open(): void {
    this.readyState = 1;
    this.fire("open");
  }

  receive(data: unknown): void {
    this.fire("message", { data });
  }

  private fire(type: string, ev: SignalingSocketEvent = {}): void {
    for (const l of this.listeners[type] ?? []) l(ev);
  }
}

/** `connect()` fetches the sign before it opens a socket, so the socket appears a tick later. */
async function socketOf(sockets: FakeSocket[]): Promise<FakeSocket> {
  await vi.waitFor(() => expect(sockets).toHaveLength(1));
  return sockets[0]!;
}

async function opened(c: RtcSignalingClient, sockets: FakeSocket[]): Promise<FakeSocket> {
  const connecting = c.connect();
  const s = await socketOf(sockets);
  s.open();
  await connecting;
  return s;
}

function okSign(sign = "SIGNBLOB"): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ code: 0, data: sign }),
  })) as unknown as typeof fetch;
}

function client(overrides: Partial<RtcSignalingOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const c = new RtcSignalingClient({
    authToken: "TOKEN",
    gtoken: "GTOKEN",
    stationSn: "T9000P0000000001",
    adminUserId: "admin-1",
    shard: "eu-pr",
    country: "it",
    fetch: okSign(),
    createSocket: (url, init) => {
      const s = new FakeSocket(url, init.protocols, init.origin);
      sockets.push(s);
      return s;
    },
    now: () => 1_790_000_000_000,
    makeMsgId: () => "deadbeef",
    ...overrides,
  });
  return { c, sockets };
}

/** What the client signs at and connects to, and the auth JSON it puts in the subprotocol. */
async function wire(overrides: Partial<RtcSignalingOptions> = {}) {
  const fetchImpl = okSign("S");
  const { c, sockets } = client({ fetch: fetchImpl, ...overrides });
  const s = await opened(c, sockets);
  const signUrl = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
  const auth = JSON.parse(Buffer.from(s.protocols[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  return { signUrl, wsUrl: s.url, auth, headers: (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] };
}

describe("region rules", () => {
  it("derives host and cluster from the mega shard, and sends the country only on the sign request", async () => {
    const eu = await wire();
    expect(eu.signUrl).toBe("https://security-smart-eu.eufylife.com/v1/smart/nvr/ws/sign");
    expect(eu.wsUrl).toBe("wss://security-smart-eu.eufylife.com/v1/rtc/ws/join?reqtype=nvr");
    expect(eu.auth.region).toBe("EU");
    const us = await wire({ shard: "us-pr", country: "US" });
    expect(us.signUrl).toContain("//security-smart.eufylife.com/");
    expect(us.auth.region).toBe("US");
  });

  it("serves the ie-pr shard from its own smart host with cluster IE, and any other prefix alike", async () => {
    const ie = await wire({ shard: "ie-pr", country: "CH" });
    expect(ie.signUrl).toBe("https://security-smart-ie.eufylife.com/v1/smart/nvr/ws/sign");
    expect(ie.auth.region).toBe("IE");
    const de = await wire({ shard: "de-pr", country: "DE" });
    expect(de.signUrl).toBe("https://security-smart-de.eufylife.com/v1/smart/nvr/ws/sign");
    expect(de.auth.region).toBe("DE");
  });

  it("sends the session's gtoken verbatim on the sign and in the socket payload", async () => {
    const w = await wire({ gtoken: "VERBATIM" });
    expect((w.headers as RequestInit).headers).toMatchObject({ GToken: "VERBATIM" });
    expect(w.auth.gtoken).toBe("VERBATIM");
  });

  it("sends the portal's sign headers exactly", async () => {
    const fetchImpl = okSign();
    const { c } = client({ fetch: fetchImpl });
    await c.fetchSign();
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://security-smart-eu.eufylife.com/v1/smart/nvr/ws/sign");
    expect(init.headers).toEqual({
      "Web-Country": "IT",
      "X-Auth-Token": "TOKEN",
      "App-Name": "eufy_mega",
      "Model-Type": "WEB",
      GToken: "GTOKEN",
      Origin: PORTAL_ORIGIN,
    });
  });

  it("reports a refused sign with its HTTP status and API code", async () => {
    const refused = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ code: 26000, msg: "token not exist" }),
    })) as unknown as typeof fetch;
    const { c } = client({ fetch: refused });
    await expect(c.fetchSign()).rejects.toThrow("refused: HTTP 401 code 26000 token not exist");
  });
});

describe("socket handshake", () => {
  it("authenticates through the subprotocol and sends action 1 on open", async () => {
    const { c, sockets } = client();
    const connecting = c.connect();
    const s = await socketOf(sockets);
    expect(s.url).toBe("wss://security-smart-eu.eufylife.com/v1/rtc/ws/join?reqtype=nvr");
    expect(s.protocols[0]).toBe("v1");
    expect(JSON.parse(Buffer.from(s.protocols[1]!, "base64url").toString("utf8"))).toEqual({
      region: "EU",
      type: "NVR",
      sn: "T9000P0000000001",
      token: "TOKEN",
      gtoken: "GTOKEN",
      sign: "SIGNBLOB",
      appName: "eufy_mega",
      modelType: "WEB",
    });
    expect(s.protocols[1]).not.toMatch(/[+/=]/);
    expect(s.origin).toBe("https://security.eufy.com");
    s.open();
    await connecting;
    expect(s.sent).toHaveLength(1);
    const env = JSON.parse(s.sent[0]!) as { msgid: string; data: string };
    expect(env.msgid).toBe("0");
    expect(JSON.parse(env.data)).toEqual({
      code: 200,
      action: 1,
      data: "SIGNBLOB",
      sn: "T9000P0000000001",
      source: "WEB",
      ts: 1_790_000_000,
    });
    c.close();
    expect(s.closed).toBe(true);
  });

  it("signs every session message with the portal's HMAC and a token-prefixed msgid", async () => {
    const { c, sockets } = client();
    const s = await opened(c, sockets);
    c.sendCall();
    c.sendInfoSdp('{"setup":"passive"}');
    c.sendInfoCandidate("");
    const [, call, sdp, eoc] = s.sent.map((m) => JSON.parse(m) as { msgid: string; data: string });
    expect(call!.msgid).toBe("TOKEN_deadbeef");
    const inner = JSON.parse(call!.data) as Record<string, unknown>;
    expect(inner).toMatchObject({
      code: 200,
      action: 3,
      sessionId: "SIGNBLOB",
      sn: "T9000P0000000001",
      subSn: "",
      channelId: 0,
      isResponse: 0,
      dataType: "scall",
      source: "WEB",
      ts: 1_790_000_000,
    });
    const data = JSON.parse(inner.data as string) as Record<string, unknown>;
    expect(data.timestamp).toBe(1_790_000_000);
    expect(data.account).toBe(createHmac("sha256", "TOKEN").update("0admin-11790000000").digest("hex"));
    expect(data.account).toBe(sessionAccount(0, "admin-1", 1_790_000_000, "TOKEN"));
    expect(JSON.parse((JSON.parse(sdp!.data) as { data: string }).data)).toMatchObject({ sdp: '{"setup":"passive"}' });
    const eocInner = JSON.parse(eoc!.data) as { channelId: number; data: string };
    expect(eocInner.channelId).toBe(0);
    expect(JSON.parse(eocInner.data)).toMatchObject({ candidate: "" });
  });

  it("parses the double-encoded envelope and ignores junk", async () => {
    const { c, sockets } = client();
    const s = await opened(c, sockets);
    const seen: unknown[] = [];
    c.on("message", (inner) => seen.push(inner));
    const inner = { code: 200, action: 3, dataType: "scall", data: JSON.stringify({ status: 100 }) };
    s.receive(JSON.stringify({ msgid: "x", data: JSON.stringify(inner) }));
    s.receive(Buffer.from(JSON.stringify({ msgid: "y", data: JSON.stringify({ action: 1, code: 200 }) })));
    s.receive("not json");
    s.receive(JSON.stringify({ msgid: "z" }));
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual([inner, { action: 1, code: 200 }]);
  });

  it("settles connect() when the socket closes before it ever opened", async () => {
    const { c, sockets } = client();
    const connecting = c.connect();
    const s = await socketOf(sockets);
    s.close();
    await expect(connecting).rejects.toThrow(/closed before open/);
  });

  it("refuses to send before the socket is open and reports a closed socket", async () => {
    const { c, sockets } = client();
    expect(() => c.sendCall()).toThrow(/not connected/);
    const s = await opened(c, sockets);
    const closed = vi.fn();
    c.on("close", closed);
    s.close();
    expect(closed).toHaveBeenCalledWith(1000, "bye");
    expect(c.isOpen).toBe(false);
  });
});
