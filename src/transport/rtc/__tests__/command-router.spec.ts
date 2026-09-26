import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import { RtcCommandRouter, type RtcCommandRouterDeps } from "../command-router.js";
import type { RtcSession, RtcSessionOptions } from "../session.js";
import { buildPortalHeader, parsePortalHeader, PORTAL_HEADER_LENGTH } from "../portal-packet.js";
import { PORTAL_CMD_SET_PAYLOAD, PORTAL_STATION_CHANNEL } from "../commands.js";

/** A stand-in for RtcSession: comes up on connect(), answers every send with a 1350 ACK unless told not to. */
class FakeSession extends EventEmitter {
  connected = false;
  closed = false;
  sent: Buffer[] = [];
  /** What to do with a sent packet: "ack" (default), "nack" (errCode 1), "silent", or "close". */
  behaviour: "ack" | "nack" | "silent" | "close" = "ack";
  /** How connect() behaves: come up (default), throw, or never answer. */
  static connectMode: "up" | "throw" | "never" | "hang" = "up";
  constructor(readonly opts: RtcSessionOptions) {
    super();
  }
  get isConnected(): boolean {
    return this.connected && !this.closed;
  }
  async connect(): Promise<void> {
    if (FakeSession.connectMode === "throw") throw new Error("sign refused");
    // "never": connect() resolves but the session never emits `connected`.
    // "hang": connect() itself never settles — the deadline must still fire.
    if (FakeSession.connectMode === "never") return;
    if (FakeSession.connectMode === "hang") return new Promise<void>(() => {});
    queueMicrotask(() => {
      this.connected = true;
      this.emit("connected");
    });
  }
  /** Inject an ACK for an arbitrary segment, as a hub answering late would. */
  ackSegment(segment: number): void {
    const body = Buffer.alloc(4);
    this.emit(
      "commandData",
      Buffer.concat([buildPortalHeader(PORTAL_CMD_SET_PAYLOAD, body.length, PORTAL_STATION_CHANNEL, segment, 1), body]),
      1,
    );
  }
  sendCommand(pkt: Buffer): boolean {
    if (!this.isConnected) return false;
    this.sent.push(pkt);
    if (this.behaviour === "ack" || this.behaviour === "nack") {
      // The hub's ACK on the wire: response header repeating the request's segment + body whose first
      // int32 LE is the error code.
      const segment = parsePortalHeader(pkt)!.segment;
      const body = Buffer.alloc(4);
      body.writeInt32LE(this.behaviour === "nack" ? 1 : 0, 0);
      const ack = Buffer.concat([
        buildPortalHeader(PORTAL_CMD_SET_PAYLOAD, body.length, PORTAL_STATION_CHANNEL, segment, 1),
        body,
      ]);
      queueMicrotask(() => this.emit("commandData", ack, 1));
    } else if (this.behaviour === "close") {
      queueMicrotask(() => this.close());
    }
    return true;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.connected = false;
    this.emit("close");
  }
}

const SN = "T9000P0000000001";
const station = {
  sn: SN,
  model: "T9000",
  stationSn: SN,
  raw: { member: { admin_user_id: "adminid" } },
} as unknown as EufyDevice;

function makeRouter(over: Partial<RtcCommandRouterDeps> = {}) {
  const sessions: FakeSession[] = [];
  const router = new RtcCommandRouter({
    identity: () => ({ authToken: "tok", userId: "uid", accountUserId: "acct", gtoken: "g" }),
    shard: () => "ie-pr",
    country: "CH",
    accountName: () => "Home Assistant",
    findDevice: (sn) => (sn === SN ? station : undefined),
    createSession: (opts) => {
      const s = new FakeSession(opts);
      sessions.push(s);
      return s as unknown as RtcSession;
    },
    ackTimeoutMs: 50,
    connectTimeoutMs: 200,
    ...over,
  });
  return { router, sessions };
}

/** Decode a request the router sent: header fields + the JSON body (a request body is plain JSON). */
const sent = (buf: Buffer) => ({
  ...parsePortalHeader(buf)!,
  body: JSON.parse(buf.subarray(PORTAL_HEADER_LENGTH).toString("utf8")) as Record<string, unknown>,
});

const arming = (mode: number) => ({
  kind: "set-payload" as const,
  cmd: 1224,
  payload: { mode_type: mode, user_name: "Home Assistant" },
  channel: 0,
  mValue3: 0,
});

describe("RtcCommandRouter", () => {
  it("claims a T9000 station itself, not other hubs nor cameras attached to it", () => {
    expect(RtcCommandRouter.claimsDevice(station)).toBe(true);
    expect(
      RtcCommandRouter.claimsDevice({ sn: "T8030X", model: "T8030", stationSn: "T8030X" } as unknown as EufyDevice),
    ).toBe(false);
    expect(
      RtcCommandRouter.claimsDevice({ sn: "T8410C", model: "T8410", stationSn: SN } as unknown as EufyDevice),
    ).toBe(false);
  });

  it("refuses command kinds it cannot carry instead of misrouting them", async () => {
    const { router, sessions } = makeRouter();
    await expect(
      router.dispatchCommand(SN, { kind: "set-param", param: 1, value: 1, form: "auto", channel: 0 } as never),
    ).rejects.toThrow(/only set-payload/);
    expect(sessions).toHaveLength(0);
  });

  it("sends the app's 1350 envelope on the station channel with relay ICE and resolves on the ACK", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(SN, arming(1));
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.opts.stationSn).toBe(SN);
    expect(s.opts.adminUserId).toBe("adminid");
    expect(s.opts.gtoken).toBe("g");
    expect(s.opts.shard).toBe("ie-pr");
    expect(s.opts.peer?.icePolicy).toBe("relay");
    expect(s.sent).toHaveLength(1);
    const p = sent(s.sent[0]!);
    expect(p.commandId).toBe(PORTAL_CMD_SET_PAYLOAD);
    expect(p.channel).toBe(PORTAL_STATION_CHANNEL);
    expect(p.isResponse).toBe(0);
    expect(p.body).toEqual({
      account_id: "adminid",
      cmd: 1224,
      mValue3: 0,
      payload: { mode_type: 1, user_name: "Home Assistant" },
    });
  });

  it("reuses the station session across commands and serialises them", async () => {
    const { router, sessions } = makeRouter();
    await Promise.all([router.dispatchCommand(SN, arming(1)), router.dispatchCommand(SN, arming(2))]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sent).toHaveLength(2);
    expect(sent(sessions[0]!.sent[0]!).body).toMatchObject({ payload: { mode_type: 1 } });
    expect(sent(sessions[0]!.sent[1]!).body).toMatchObject({ payload: { mode_type: 2 } });
    // distinct segments, never 0 (the portal reserves it)
    expect(sent(sessions[0]!.sent[0]!).segment).not.toBe(sent(sessions[0]!.sent[1]!).segment);
  });

  it("rejects an ACK that carries a non-zero error code", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(SN, arming(1));
    sessions[0]!.behaviour = "nack";
    await expect(router.dispatchCommand(SN, arming(2))).rejects.toThrow(/rejected cmd 1224 \(err 1\)/);
  });

  it("rejects when the hub never ACKs, and when the session drops mid-flight", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(SN, arming(1));
    sessions[0]!.behaviour = "silent";
    await expect(router.dispatchCommand(SN, arming(2))).rejects.toThrow(/ACK timed out/);
    const { router: r2, sessions: s2 } = makeRouter();
    await r2.dispatchCommand(SN, arming(1));
    s2[0]!.behaviour = "close";
    await expect(r2.dispatchCommand(SN, arming(2))).rejects.toThrow(/session closed/);
  });

  it("does not let a late ACK for a timed-out command complete the next one", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(SN, arming(1));
    const s = sessions[0]!;
    s.behaviour = "silent";
    await expect(router.dispatchCommand(SN, arming(2))).rejects.toThrow(/ACK timed out/);
    const timedOut = sent(s.sent[1]!).segment;
    // B is in flight on the same session when A's ACK finally arrives: B must NOT resolve on it.
    const b = router.dispatchCommand(SN, arming(3));
    await new Promise((r) => setTimeout(r, 5));
    s.ackSegment(timedOut);
    await expect(b).rejects.toThrow(/ACK timed out/);
    expect(s.sent).toHaveLength(3); // nothing was replayed
  });

  it("fails the bring-up once, with the session closed, when connect() throws or never comes up", async () => {
    FakeSession.connectMode = "throw";
    try {
      const { router, sessions } = makeRouter();
      await expect(router.dispatchCommand(SN, arming(1))).rejects.toThrow(/sign refused/);
      expect(sessions[0]!.closed).toBe(true);
      FakeSession.connectMode = "never";
      const { router: r2, sessions: s2 } = makeRouter({ connectTimeoutMs: 30 });
      await expect(r2.dispatchCommand(SN, arming(1))).rejects.toThrow(/did not come up within 30ms/);
      expect(s2[0]!.closed).toBe(true);
      // connect() that never settles at all: the bounded bring-up's deadline still fires and closes it
      FakeSession.connectMode = "hang";
      const { router: r3, sessions: s3 } = makeRouter({ connectTimeoutMs: 30 });
      await expect(r3.dispatchCommand(SN, arming(1))).rejects.toThrow(/did not come up within 30ms/);
      expect(s3[0]!.closed).toBe(true);
      // the deadline has passed and the session is gone: a retry opens a fresh one instead of reusing it
      FakeSession.connectMode = "up";
      await r2.dispatchCommand(SN, arming(1));
      expect(s2).toHaveLength(2);
    } finally {
      FakeSession.connectMode = "up";
    }
  });

  it("opens a fresh session after the previous one closed", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(SN, arming(1));
    sessions[0]!.close();
    await router.dispatchCommand(SN, arming(2));
    expect(sessions).toHaveLength(2);
  });

  it("refuses to drive anything while logged out, and tears every session down on close()", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(SN, arming(1));
    router.close();
    expect(sessions[0]!.closed).toBe(true);
    const { router: out } = makeRouter({ identity: () => undefined });
    await expect(out.dispatchCommand(SN, arming(1))).rejects.toThrow(/not logged in/);
    vi.restoreAllMocks();
  });
});
