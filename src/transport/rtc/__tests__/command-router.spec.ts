import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { RtcCommandRouter, type RtcCommandRouterDeps, type RtcRoute } from "../command-router.js";
import type { RtcSession, RtcSessionOptions } from "../session.js";
import { buildPortalHeader, parsePortalHeader, PortalLinkType, PORTAL_HEADER_LENGTH } from "../portal-packet.js";

const PORTAL_CMD_SET_PAYLOAD = 1350;
const PORTAL_STATION_CHANNEL = 255;
const ACK_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 12_000;

/** Run `fn` on fake timers, so the router's fixed deadlines can be crossed without waiting them out. */
async function onFakeTimers(fn: () => Promise<void>): Promise<void> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await fn();
  } finally {
    vi.useRealTimers();
  }
}

/** Await `promise` to reject with `pattern` once `ms` of fake time has passed. */
async function rejectsAfter(promise: Promise<unknown>, pattern: RegExp | string, ms: number): Promise<void> {
  const settled = expect(promise).rejects.toThrow(pattern);
  await vi.advanceTimersByTimeAsync(ms);
  await settled;
}

/** A stand-in for RtcSession that repeats the sent outer envelope and segment in its ACK. */
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
  ackSegment(segment: number, commandId = PORTAL_CMD_SET_PAYLOAD, linkType: number = PortalLinkType.COMMAND): void {
    const body = Buffer.alloc(4);
    this.emit(
      "commandData",
      Buffer.concat([buildPortalHeader(commandId, body.length, PORTAL_STATION_CHANNEL, segment, 1), body]),
      linkType,
    );
  }
  sendCommand(pkt: Buffer): boolean {
    if (!this.isConnected) return false;
    this.sent.push(pkt);
    if (this.behaviour === "ack" || this.behaviour === "nack") {
      // The hub's ACK on the wire: response header repeating the request's segment + body whose first
      // int32 LE is the error code.
      const { segment, commandId } = parsePortalHeader(pkt)!;
      const body = Buffer.alloc(4);
      body.writeInt32LE(this.behaviour === "nack" ? 1 : 0, 0);
      const ack = Buffer.concat([buildPortalHeader(commandId, body.length, PORTAL_STATION_CHANNEL, segment, 1), body]);
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
/** A command to the station itself, and one to a device attached to it. */
const ST: RtcRoute = { stationSn: SN, adminUserId: "adminid", attached: false };
const CAM: RtcRoute = { stationSn: SN, adminUserId: "adminid", attached: true };

function makeRouter(over: Partial<RtcCommandRouterDeps> = {}) {
  const sessions: FakeSession[] = [];
  const router = new RtcCommandRouter({
    identity: () => ({ authToken: "tok", userId: "uid", gtoken: "g" }),
    shard: () => "ie-pr",
    country: "CH",
    createSession: (opts) => {
      const s = new FakeSession(opts);
      sessions.push(s);
      return s as unknown as RtcSession;
    },
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
  it.each([
    [undefined, undefined],
    ["call", "all"],
    ["call", "relay"],
    ["scall", "relay"],
  ] as const)("passes signaling=%s and ICE=%s to the station session", async (signalingMode, iceTransportPolicy) => {
    const { router, sessions } = makeRouter();
    try {
      await router.dispatchCommand({ ...ST, signalingMode, iceTransportPolicy }, arming(1));
      expect(sessions[0]!.opts.signalingMode).toBe(signalingMode);
      expect(sessions[0]!.opts.peer?.iceTransportPolicy).toBe(iceTransportPolicy);
      expect(sessions[0]!.sent).toHaveLength(1);
      expect(sent(sessions[0]!.sent[0]!).body).toMatchObject({ cmd: 1224, payload: { mode_type: 1 } });
    } finally {
      router.close();
    }
  });

  it("refuses command kinds it cannot carry instead of misrouting them", async () => {
    const { router, sessions } = makeRouter();
    await expect(
      router.dispatchCommand(ST, { kind: "set-param", param: 1, value: 1, form: "auto", channel: 0 } as never),
    ).rejects.toThrow(/only set-payload/);
    expect(sessions).toHaveLength(0);
  });

  it("sends the app's 1350 envelope on the station channel and resolves on the ACK", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(ST, arming(1));
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.opts.stationSn).toBe(SN);
    expect(s.opts.adminUserId).toBe("adminid");
    expect(s.opts.gtoken).toBe("g");
    expect(s.opts.shard).toBe("ie-pr");
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

  it("names the logged-in user when the route carries no admin id", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand({ stationSn: SN, attached: false }, arming(1));
    expect(sessions[0]!.opts.adminUserId).toBe("uid");
    expect(sent(sessions[0]!.sent[0]!).body.account_id).toBe("uid");
  });

  it("reuses the station session across commands and serialises them", async () => {
    const { router, sessions } = makeRouter();
    await Promise.all([router.dispatchCommand(ST, arming(1)), router.dispatchCommand(ST, arming(2))]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sent).toHaveLength(2);
    expect(sent(sessions[0]!.sent[0]!).body).toMatchObject({ payload: { mode_type: 1 } });
    expect(sent(sessions[0]!.sent[1]!).body).toMatchObject({ payload: { mode_type: 2 } });
    // distinct segments, never 0 (the portal reserves it)
    expect(sent(sessions[0]!.sent[0]!).segment).not.toBe(sent(sessions[0]!.sent[1]!).segment);
  });

  it("shares the parent session and identity across station and attached-device envelopes", async () => {
    const { router, sessions } = makeRouter();
    try {
      await Promise.all([
        router.dispatchCommand(CAM, { kind: "set-json", param: 1400, data: { value: 1 }, channel: 2 }),
        router.dispatchCommand(ST, arming(1)),
        router.dispatchCommand(CAM, {
          kind: "set-payload",
          cmd: 1234,
          payload: { value: 0 },
          channel: 2,
          mValue3: 7,
        }),
      ]);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]!.opts.stationSn).toBe(SN);
      expect(sessions[0]!.opts.adminUserId).toBe("adminid");
      const packets = sessions[0]!.sent.map(sent);
      expect(packets.map((p) => p.channel)).toEqual([2, 255, 2]);
      expect(packets.map((p) => p.commandId)).toEqual([1700, 1350, 1350]);
      expect(packets[0]!.body).toEqual({ account_id: "adminid", cmd: 1400, commandType: 1400, data: { value: 1 } });
      expect(packets[2]!.body).toEqual({ account_id: "adminid", cmd: 1234, mValue3: 7, payload: { value: 0 } });
      expect(new Set(packets.map((p) => p.segment)).size).toBe(3);
    } finally {
      router.close();
    }
  });

  it("accepts a control result notification correlated by channel, parameter and segment", async () => {
    const { router, sessions } = makeRouter();
    try {
      await router.dispatchCommand(ST, arming(1));
      const session = sessions[0]!;
      session.behaviour = "silent";
      const operation = router.dispatchCommand(CAM, {
        kind: "set-json",
        param: 6030,
        data: { cmd_type: 1, rotate_type: 1, zoom: 1 },
        channel: 2,
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
      const header = sent(session.sent[1]!);
      const body = Buffer.from(JSON.stringify({ cmd: 6030, payload: { limit: 0 } }));
      session.emit("commandData", Buffer.concat([buildPortalHeader(1351, body.length, 2, header.segment, 0), body]), 3);
      await operation;
      expect(session.sent).toHaveLength(2);
      expect(session.closed).toBe(false);
    } finally {
      router.close();
    }
  });

  it.each([
    { label: "wrong segment", segment: 99 },
    { label: "unsolicited segment", segment: 0 },
    { label: "wrong channel", channel: 3 },
    { label: "wrong parameter", param: 6034 },
    { label: "wrong envelope", envelope: 1700 },
    { label: "command link", link: 1 },
    { label: "response flag", response: 1 },
    { label: "missing payload", payload: undefined },
    { label: "null payload", payload: null },
    { label: "scalar payload", payload: 1 },
  ])("does not complete a control command on $label", (over) =>
    onFakeTimers(async () => {
      const { router, sessions } = makeRouter();
      try {
        await router.dispatchCommand(ST, arming(1));
        const session = sessions[0]!;
        session.behaviour = "silent";
        const operation = router.dispatchCommand(CAM, {
          kind: "set-json",
          param: 6030,
          data: { cmd_type: 1, rotate_type: 1, zoom: 1 },
          channel: 2,
        });
        const assertion = expect(operation).rejects.toThrow("ACK timed out");
        await vi.waitFor(() => expect(session.sent).toHaveLength(2));
        const header = sent(session.sent[1]!);
        const cfg = {
          segment: header.segment,
          channel: 2,
          param: 6030,
          envelope: 1351,
          link: 3,
          response: 0,
          payload: { limit: 0 },
          ...over,
        };
        const body = Buffer.from(JSON.stringify({ cmd: cfg.param, payload: cfg.payload }));
        session.emit(
          "commandData",
          Buffer.concat([buildPortalHeader(cfg.envelope, body.length, cfg.channel, cfg.segment, cfg.response), body]),
          cfg.link,
        );
        await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS);
        await assertion;
        expect(session.sent).toHaveLength(2);
        expect(session.listenerCount("commandData")).toBe(0);
        expect(session.closed).toBe(false);
      } finally {
        router.close();
      }
    }),
  );

  it("requires a command-link ACK with the matching outer envelope and segment without replay", async () => {
    const { router, sessions } = makeRouter();
    try {
      await router.dispatchCommand(ST, arming(1));
      const session = sessions[0]!;
      session.behaviour = "silent";
      let settled = false;
      const pending = router.dispatchCommand(CAM, { kind: "set-json", param: 1400, data: {}, channel: 2 }).then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(session.sent).toHaveLength(2));
      const segment = sent(session.sent[1]!).segment;
      session.ackSegment(segment, PORTAL_CMD_SET_PAYLOAD);
      session.ackSegment(segment + 1, 1700);
      session.ackSegment(segment, 1700, PortalLinkType.NOTIFY);
      expect(session.listenerCount("commandData")).toBe(1);
      await Promise.resolve();
      expect(settled).toBe(false);
      session.ackSegment(segment, 1700);
      await pending;
      expect(session.sent).toHaveLength(2);
    } finally {
      router.close();
    }
  });

  it("rejects an ACK that carries a non-zero error code", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(ST, arming(1));
    sessions[0]!.behaviour = "nack";
    await expect(router.dispatchCommand(ST, arming(2))).rejects.toThrow(/rejected cmd 1224 \(err 1\)/);
  });

  it("rejects when the hub never ACKs, and when the session drops mid-flight", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(ST, arming(1));
    sessions[0]!.behaviour = "silent";
    await onFakeTimers(() => rejectsAfter(router.dispatchCommand(ST, arming(2)), /ACK timed out/, ACK_TIMEOUT_MS));
    const { router: r2, sessions: s2 } = makeRouter();
    await r2.dispatchCommand(ST, arming(1));
    s2[0]!.behaviour = "close";
    await expect(r2.dispatchCommand(ST, arming(2))).rejects.toThrow(/session closed/);
  });

  it("does not let a late ACK for a timed-out command complete the next one", () =>
    onFakeTimers(async () => {
      const { router, sessions } = makeRouter();
      await router.dispatchCommand(ST, arming(1));
      const s = sessions[0]!;
      s.behaviour = "silent";
      await rejectsAfter(router.dispatchCommand(ST, arming(2)), /ACK timed out/, ACK_TIMEOUT_MS);
      const timedOut = sent(s.sent[1]!).segment;
      // B is in flight on the same session when A's ACK finally arrives: B must NOT resolve on it.
      const b = router.dispatchCommand(ST, arming(3));
      await vi.waitFor(() => expect(s.sent).toHaveLength(3));
      s.ackSegment(timedOut);
      await rejectsAfter(b, /ACK timed out/, ACK_TIMEOUT_MS);
      expect(s.sent).toHaveLength(3); // nothing was replayed
    }));

  it("fails the bring-up once, with the session closed, when connect() throws or never comes up", async () => {
    FakeSession.connectMode = "throw";
    try {
      const { router, sessions } = makeRouter();
      await expect(router.dispatchCommand(ST, arming(1))).rejects.toThrow(/sign refused/);
      expect(sessions[0]!.closed).toBe(true);
      FakeSession.connectMode = "never";
      const { router: r2, sessions: s2 } = makeRouter();
      const late = new RegExp(`did not come up within ${CONNECT_TIMEOUT_MS}ms`);
      await onFakeTimers(() => rejectsAfter(r2.dispatchCommand(ST, arming(1)), late, CONNECT_TIMEOUT_MS));
      expect(s2[0]!.closed).toBe(true);
      // connect() that never settles at all: the bounded bring-up's deadline still fires and closes it
      FakeSession.connectMode = "hang";
      const { router: r3, sessions: s3 } = makeRouter();
      await onFakeTimers(() => rejectsAfter(r3.dispatchCommand(ST, arming(1)), late, CONNECT_TIMEOUT_MS));
      expect(s3[0]!.closed).toBe(true);
      // the deadline has passed and the session is gone: a retry opens a fresh one instead of reusing it
      FakeSession.connectMode = "up";
      await r2.dispatchCommand(ST, arming(1));
      expect(s2).toHaveLength(2);
    } finally {
      FakeSession.connectMode = "up";
    }
  });

  it("opens a fresh session after the previous one closed", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(ST, arming(1));
    sessions[0]!.close();
    await router.dispatchCommand(ST, arming(2));
    expect(sessions).toHaveLength(2);
  });

  it("refuses to drive anything while logged out, and tears every session down on close()", async () => {
    const { router, sessions } = makeRouter();
    await router.dispatchCommand(ST, arming(1));
    router.close();
    expect(sessions[0]!.closed).toBe(true);
    const { router: out } = makeRouter({ identity: () => undefined });
    await expect(out.dispatchCommand(ST, arming(1))).rejects.toThrow(/not logged in/);
    vi.restoreAllMocks();
  });
});
