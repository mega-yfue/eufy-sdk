import { EventEmitter } from "node:events";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { LiveSnapshotUnavailableError } from "../../../core/contracts.js";
import { RtcCommandRouter, type RtcCommandRouterDeps, type RtcLiveRoute, type RtcRoute } from "../command-router.js";
import type { RtcSession, RtcSessionOptions } from "../session.js";
import { buildPortalHeader, parsePortalHeader, PortalLinkType, PORTAL_HEADER_LENGTH } from "../portal-packet.js";
import { PORTAL_KEEPALIVE, PORTAL_KEEPALIVE_MS } from "../portal-keepalive.js";

const PORTAL_CMD_SET_PAYLOAD = 1350;
const PORTAL_STATION_CHANNEL = 255;
const ACK_TIMEOUT_MS = 8_000;
const CONNECT_TIMEOUT_MS = 12_000;
const IDLE_CLOSE_MS = 60_000;
const DB_TABLE_TIMEOUT_MS = 15_000;

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
  raw: Buffer[] = [];
  /** Whether a raw keepalive is echoed back as the hub does (default) or goes unanswered. */
  echoKeepalive = true;
  /** What to do with a sent packet: "ack" (default), "nack" (errCode 1), "silent", or "close". */
  behaviour: "ack" | "nack" | "silent" | "close" = "ack";
  /** How connect() behaves: come up (default), throw, never answer, or close with a peer failure. */
  static connectMode: "up" | "throw" | "never" | "hang" | "peer-fails" = "up";
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
    if (FakeSession.connectMode === "peer-fails") {
      queueMicrotask(() => {
        const err = new Error("could not load the native peer", { cause: new Error("module missing") });
        this.emit("error", err);
        this.closed = true;
        this.emit("close", err);
      });
      return;
    }
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
  sendRaw(bytes: Buffer): boolean {
    this.raw.push(bytes);
    if (this.isConnected && this.echoKeepalive) queueMicrotask(() => this.emit("keepaliveEcho"));
    return this.isConnected;
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
  payload: { mode_type: mode, user_name: "someone+tag" },
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
      payload: { mode_type: 1, user_name: "someone+tag" },
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

  it("rejects a command at once with the failure that closed the session during bring-up", async () => {
    FakeSession.connectMode = "peer-fails";
    try {
      const onError = vi.fn();
      const { router, sessions } = makeRouter({ onError });
      await onFakeTimers(async () => {
        const result = router.dispatchCommand(ST, arming(1)).then(
          () => undefined,
          (e: unknown) => e,
        );
        await vi.advanceTimersByTimeAsync(0);
        const err = (await result) as Error;
        expect(err).toBeInstanceOf(Error);
        expect(err.message).toBe("could not load the native peer");
        expect((err.cause as Error).message).toBe("module missing");
      });
      expect(sessions[0]!.sent).toHaveLength(0);
      expect(onError).toHaveBeenCalledOnce();
    } finally {
      FakeSession.connectMode = "up";
    }
  });

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

describe("RtcCommandRouter live view", () => {
  const cam = (cameraSn: string, channel: number): RtcLiveRoute => ({ ...CAM, cameraSn, channel });
  const ORTO = cam("T8000P0000000002", 2);
  const PORCH = cam("T8000P0000000003", 3);
  /** The live starts (inner cmd 1003) a session carried. */
  const starts = (s: FakeSession) => s.sent.map(sent).filter((p) => p.body.cmd === 1003);
  /** The live stops (inner cmd 1004) a session carried. */
  const stops = (s: FakeSession) => s.sent.map(sent).filter((p) => p.body.cmd === 1004);
  /** A `1300` IDR on the play slot: the 22-byte media header (length, stream type 1, 1920x1080), then the video. */
  const idr = () => {
    const video = Buffer.from("000000012601af0e", "hex");
    const header = Buffer.alloc(22);
    header.writeUInt32LE(video.length, 0);
    header[5] = 1;
    header.writeUInt16LE(1920, 10);
    header.writeUInt16LE(1080, 12);
    const body = Buffer.concat([header, video]);
    return Buffer.concat([buildPortalHeader(1300, body.length, 101, 0, 0), body]);
  };
  const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

  it("shares one pull between concurrent viewers of the same camera", async () => {
    const { router, sessions } = makeRouter();
    try {
      const media = router.mediaProviderFor(ORTO);
      const [a, b] = await Promise.all([media.live(), media.live()]);
      expect(sessions).toHaveLength(1);
      expect(starts(sessions[0]!)).toHaveLength(1);
      a.stop();
      b.stop();
    } finally {
      router.close();
    }
  });

  it("refuses a second camera on the same station while the first one's view is up", async () => {
    const { router } = makeRouter();
    try {
      const viewer = await router.mediaProviderFor(ORTO).live();
      await expect(router.mediaProviderFor(PORCH).live()).rejects.toThrow(/streams one camera at a time/);
      viewer.stop();
    } finally {
      router.close();
    }
  });

  it("refuses a second camera's live still as a source failure, so a retained still can answer", async () => {
    const { router } = makeRouter();
    try {
      const viewer = await router.mediaProviderFor(ORTO).live();
      const still = router.mediaProviderFor(PORCH).snapshotLive();
      await expect(still).rejects.toBeInstanceOf(LiveSnapshotUnavailableError);
      await expect(still).rejects.toMatchObject({ reason: "source-failed", retryable: true });
      await expect(router.mediaProviderFor(PORCH).live()).rejects.not.toBeInstanceOf(LiveSnapshotUnavailableError);
      viewer.stop();
    } finally {
      router.close();
    }
  });

  it("ends the viewers when the router closes, sending the stop before the session goes", async () => {
    const { router, sessions } = makeRouter();
    const viewer = await router.mediaProviderFor(ORTO).live();
    sessions[0]!.emit("mediaData", idr());
    const stopped = vi.fn();
    const failed = vi.fn();
    viewer.on("stop", stopped);
    viewer.on("error", failed);
    router.close();
    expect(stopped).toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(stops(sessions[0]!)).toHaveLength(1);
    expect(sessions[0]!.closed).toBe(true);
  });

  it("bounds a battery camera's view to its budget, and leaves a wired one unbounded", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { router, sessions } = makeRouter();
    try {
      const battery = await router.mediaProviderFor(ORTO).live({ powered: "battery" });
      const notice = vi.fn();
      battery.on("budget", notice);
      sessions[0]!.emit("mediaData", idr());
      await vi.advanceTimersByTimeAsync(45_000);
      expect(notice).toHaveBeenCalledTimes(1);
      battery.stop();
      router.close();
      const wired = makeRouter();
      const viewer = await wired.router.mediaProviderFor(ORTO).live();
      const unbounded = vi.fn();
      viewer.on("budget", unbounded);
      wired.sessions[0]!.emit("mediaData", idr());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(unbounded).not.toHaveBeenCalled();
      viewer.stop();
      wired.router.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("frees the station for another camera when the only caller gave up during the bring-up", async () => {
    const { router } = makeRouter();
    try {
      const gaveUp = new AbortController();
      const pending = router.mediaProviderFor(ORTO).live({ signal: gaveUp.signal });
      gaveUp.abort(new Error("caller left"));
      await expect(pending).rejects.toThrow("caller left");
      await nextTurn();
      await nextTurn();
      const viewer = await router.mediaProviderFor(PORCH).live();
      viewer.stop();
    } finally {
      router.close();
    }
  });

  it("honours an abort that lands during the bring-up, and one that came before the call", async () => {
    const { router } = makeRouter();
    try {
      const media = router.mediaProviderFor(ORTO);
      const early = new AbortController();
      early.abort(new Error("caller gave up"));
      await expect(media.live({ signal: early.signal })).rejects.toThrow("caller gave up");
      const late = new AbortController();
      const pending = media.live({ signal: late.signal });
      late.abort(new Error("caller left"));
      await expect(pending).rejects.toThrow("caller left");
    } finally {
      router.close();
    }
  });

  it("lets another camera take the station while the first one's pull only lingers", async () => {
    const { router } = makeRouter();
    try {
      const viewer = await router.mediaProviderFor(ORTO).live();
      viewer.stop();
      const next = await router.mediaProviderFor(PORCH).live();
      next.stop();
    } finally {
      router.close();
    }
  });

  it("refuses a caller whose abort lands after the source resolved, leaving the viewer in place", async () => {
    const { router } = makeRouter();
    try {
      const media = router.mediaProviderFor(ORTO);
      const viewer = await media.live();
      const controller = new AbortController();
      const pending = media.live({ signal: controller.signal });
      queueMicrotask(() => controller.abort(new Error("caller left")));
      await expect(pending).rejects.toThrow("caller left");
      await expect(router.mediaProviderFor(PORCH).live()).rejects.toThrow(/streams one camera at a time/);
      viewer.stop();
    } finally {
      router.close();
    }
  });

  it("answers a live still whose stream fails as a source failure", async () => {
    const sessions: FakeSession[] = [];
    const { router } = makeRouter({
      createSession: (opts) => {
        const session = new FakeSession(opts);
        session.behaviour = "nack";
        sessions.push(session);
        return session as unknown as RtcSession;
      },
    });
    try {
      const still = router.mediaProviderFor(ORTO).snapshotLive();
      await expect(still).rejects.toBeInstanceOf(LiveSnapshotUnavailableError);
      await expect(still).rejects.toMatchObject({ reason: "source-failed" });
      expect(starts(sessions[0]!)).toHaveLength(1);
    } finally {
      router.close();
    }
  });

  it("has no wire for recording and leaves the optional media members absent", async () => {
    const { router } = makeRouter();
    const media = router.mediaProviderFor(ORTO);
    await expect(media.record(5)).rejects.toThrow(/record is not available/);
    expect(media.recordFragments).toBeUndefined();
    expect(media.talkback).toBeUndefined();
    expect(media.p2pQuery).toBeUndefined();
    expect(media.p2pControlQuery).toBeUndefined();
  });
});

describe("RtcCommandRouter keepWarm", () => {
  /** Run `fn` on fake timers covering the idle-close timeout and the keepalive interval. */
  async function onWarmTimers(fn: () => Promise<void>): Promise<void> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    try {
      await fn();
    } finally {
      vi.useRealTimers();
    }
  }

  /** Drain the pending microtasks so an in-flight warm bring-up settles without advancing the clock. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  it("opens the session and sends the portal keepalive on it at the ~29 s cadence", () =>
    onWarmTimers(async () => {
      const { router, sessions } = makeRouter();
      try {
        router.keepWarm(ST);
        await settle();
        expect(sessions).toHaveLength(1);
        const s = sessions[0]!;
        expect(s.raw).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
        expect(s.raw).toHaveLength(1);
        expect(s.raw[0]).toEqual(PORTAL_KEEPALIVE);
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
        expect(s.raw).toHaveLength(2);
      } finally {
        router.close();
      }
    }));

  it("suppresses the idle-close while warm, where a non-warm session is dropped", () =>
    onWarmTimers(async () => {
      const warm = makeRouter();
      try {
        warm.router.keepWarm(ST);
        await settle();
        const s = warm.sessions[0]!;
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS * 2);
        expect(s.closed).toBe(false);
      } finally {
        warm.router.close();
      }
      const plain = makeRouter();
      try {
        await plain.router.dispatchCommand(ST, arming(1));
        const s = plain.sessions[0]!;
        expect(s.closed).toBe(false);
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS);
        expect(s.closed).toBe(true);
      } finally {
        plain.router.close();
      }
    }));

  it("stops the keepalive and resumes the idle-close once the hold is disposed", () =>
    onWarmTimers(async () => {
      const { router, sessions } = makeRouter();
      try {
        const dispose = router.keepWarm(ST);
        await settle();
        const s = sessions[0]!;
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
        expect(s.raw).toHaveLength(1);
        dispose();
        const after = s.raw.length;
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS * 2);
        expect(s.raw).toHaveLength(after);
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS);
        expect(s.closed).toBe(true);
      } finally {
        router.close();
      }
    }));

  it("is idempotent: a second call arms no second keepalive timer", () =>
    onWarmTimers(async () => {
      const { router, sessions } = makeRouter();
      try {
        const first = router.keepWarm(ST);
        const second = router.keepWarm(ST);
        expect(second).toBe(first);
        await settle();
        expect(sessions).toHaveLength(1);
        const s = sessions[0]!;
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
        expect(s.raw).toHaveLength(1);
      } finally {
        router.close();
      }
    }));

  it("clears the keepalive when the session closes, and a later command opens a fresh one", () =>
    onWarmTimers(async () => {
      const { router, sessions } = makeRouter();
      try {
        router.keepWarm(ST);
        await settle();
        const s = sessions[0]!;
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
        expect(s.raw).toHaveLength(1);
        s.close();
        const after = s.raw.length;
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS * 2);
        expect(s.raw).toHaveLength(after);
        await router.dispatchCommand(ST, arming(1));
        expect(sessions).toHaveLength(2);
      } finally {
        router.close();
      }
    }));

  it("leaves no close listener on the session once a hold is disposed, across repeated cycles", () =>
    onWarmTimers(async () => {
      const { router, sessions } = makeRouter();
      try {
        await router.dispatchCommand(ST, arming(1));
        const s = sessions[0]!;
        const before = s.listenerCount("close");
        for (let i = 0; i < 12; i++) {
          const dispose = router.keepWarm(ST);
          await settle();
          dispose();
        }
        expect(sessions).toHaveLength(1);
        expect(s.listenerCount("close")).toBe(before);
      } finally {
        router.close();
      }
    }));

  it("arms no keepalive when disposed before the bring-up finishes, and the session idle-closes", () =>
    onWarmTimers(async () => {
      const { router, sessions } = makeRouter();
      try {
        const dispose = router.keepWarm(ST);
        dispose();
        await settle();
        expect(sessions).toHaveLength(1);
        const s = sessions[0]!;
        expect(s.closed).toBe(false);
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
        expect(s.raw).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - PORTAL_KEEPALIVE_MS);
        expect(s.closed).toBe(true);
        expect(s.raw).toHaveLength(0);
      } finally {
        router.close();
      }
    }));

  it("clears the hold and reports a failed bring-up, and a later keepWarm opens a fresh session", () =>
    onWarmTimers(async () => {
      const onError = vi.fn();
      const { router, sessions } = makeRouter({ onError });
      FakeSession.connectMode = "throw";
      try {
        const first = router.keepWarm(ST);
        await settle();
        expect(onError).toHaveBeenCalledOnce();
        expect(onError.mock.calls[0]![0]).toBeInstanceOf(Error);
        expect((onError.mock.calls[0]![0] as Error).message).toMatch(/sign refused/);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]!.closed).toBe(true);
        FakeSession.connectMode = "up";
        const second = router.keepWarm(ST);
        expect(second).not.toBe(first);
        await settle();
        expect(sessions).toHaveLength(2);
        const s = sessions[1]!;
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
        expect(s.raw).toEqual([PORTAL_KEEPALIVE]);
      } finally {
        FakeSession.connectMode = "up";
        router.close();
      }
    }));

  it("keeps the session while each keepalive is echoed, and drops it on the tick after one goes unechoed", () =>
    onWarmTimers(async () => {
      const warn = vi.fn();
      const { router, sessions } = makeRouter({ logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } });
      try {
        router.keepWarm(ST);
        await settle();
        const s = sessions[0]!;
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS * 3);
        expect(s.raw).toHaveLength(3);
        expect(s.closed).toBe(false);
        s.echoKeepalive = false;
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
        expect(s.raw).toHaveLength(4);
        expect(s.closed).toBe(false);
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
        expect(s.closed).toBe(true);
        expect(s.raw).toHaveLength(4);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unechoed/));
        expect(s.listenerCount("keepaliveEcho")).toBe(0);
      } finally {
        router.close();
      }
    }));

  it("clears the hold once an unechoed keepalive drops the session, so keepWarm and a command open a fresh one", () =>
    onWarmTimers(async () => {
      const { router, sessions } = makeRouter();
      try {
        const first = router.keepWarm(ST);
        await settle();
        sessions[0]!.echoKeepalive = false;
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS * 2);
        expect(sessions[0]!.closed).toBe(true);
        const second = router.keepWarm(ST);
        expect(second).not.toBe(first);
        await settle();
        expect(sessions).toHaveLength(2);
        await router.dispatchCommand(ST, arming(1));
        expect(sessions).toHaveLength(2);
        expect(sessions[1]!.sent).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(PORTAL_KEEPALIVE_MS);
        expect(sessions[1]!.raw).toEqual([PORTAL_KEEPALIVE]);
      } finally {
        router.close();
      }
    }));

  it("refuses to warm a station while logged out, holding nothing", () =>
    onWarmTimers(async () => {
      const { router, sessions } = makeRouter({ identity: () => undefined });
      try {
        expect(() => router.keepWarm(ST)).toThrow(`rtc: not logged in, cannot warm ${SN}`);
        await settle();
        expect(sessions).toHaveLength(0);
      } finally {
        router.close();
      }
    }));
});

describe("RtcCommandRouter on a media-track route", () => {
  const DOORBELL: RtcRoute = {
    stationSn: "T8000P0000000002",
    adminUserId: "adminid",
    attached: false,
    signalingMode: "call",
    iceTransportPolicy: "all",
    mediaTrack: true,
  };

  it("refuses a command without opening a session", async () => {
    const { router, sessions } = makeRouter();
    await expect(router.dispatchCommand(DOORBELL, arming(1))).rejects.toThrow("serves media only");
    expect(sessions).toHaveLength(0);
  });

  it("places a call on a media-track session of its own for a live view, and hangs it up on close", async () => {
    const { router, sessions } = makeRouter();
    await router.trackMediaProviderFor(DOORBELL).live();
    await vi.waitFor(() => expect(sessions).toHaveLength(1));
    expect(sessions[0]!.opts).toMatchObject({
      stationSn: "T8000P0000000002",
      adminUserId: "adminid",
      signalingMode: "call",
      peer: { iceTransportPolicy: "all", mediaTrack: true },
    });
    router.close();
    expect(sessions[0]!.closed).toBe(true);
  });

  it("builds the station's live source from the first caller's hints", async () => {
    const { router } = makeRouter();
    await router.trackMediaProviderFor(DOORBELL).live({ powered: "battery", preBufferSeconds: 10 });
    const sources = (router as unknown as { callSources: Map<string, { opts: Record<string, unknown> }> }).callSources;
    expect(sources.get("T8000P0000000002")!.opts).toMatchObject({ powered: "battery", preBufferSeconds: 10 });
    router.close();
  });
});

describe("RtcCommandRouter database reads", () => {
  const TABLE = "history_record_info";
  const THUMB = "/zx/hdd_data0/Camera030000/event/202603/20260305/20260305081500_thumb.jpg";
  const JPEG = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(60, 0x5a),
    Buffer.from([0xff, 0xd9]),
  ]);
  const ROWS = [
    { device_sn: "T8000P0000000002", record_id: 41, start_time: "20260305081500", thumb_path: THUMB },
    { device_sn: "T8000P0000000002", record_id: 40, start_time: "20260305080000", thumb_path: THUMB },
  ];
  /** A notify-link frame as the hub sends it: a portal packet, zstd-compressed unless `plain`. */
  const notify = (commandId: number, body: unknown, plain = false): Buffer => {
    const json = Buffer.from(JSON.stringify(body), "utf8");
    const pkt = Buffer.concat([buildPortalHeader(commandId, json.length, PORTAL_STATION_CHANNEL, 0, 0), json]);
    return plain ? pkt : zstdCompressSync(pkt);
  };
  /** The unrelated station report the notify link carries between replies. */
  const codecReport = () => notify(1351, { cmd: 1366, payload: { codec: 1, channel: 2 } }, true);
  /** A read's request as sent, once the session carried it. */
  const request = async (s: FakeSession) => {
    await vi.waitFor(() => expect(s.sent).toHaveLength(1));
    return sent(s.sent[0]!);
  };

  it("reads a table: the 1306 query on the station channel, answered by the compressed notify frame", async () => {
    const { router, sessions } = makeRouter();
    try {
      const read = router.readTable(ST, TABLE);
      const s = sessions[0]!;
      const p = await request(s);
      expect(p.commandId).toBe(PORTAL_CMD_SET_PAYLOAD);
      expect(p.channel).toBe(PORTAL_STATION_CHANNEL);
      const inner = p.body.payload as Record<string, unknown>;
      expect(p.body).toMatchObject({ account_id: "adminid", cmd: 1306, mValue3: 0 });
      expect(inner).toMatchObject({ cmd: 10000, table: TABLE, payload: { count: 2000, need_ai: 1, res_unzip: 1 } });
      expect(inner.transaction).toMatch(/^\d{13,}$/);
      s.emit("commandData", codecReport(), PortalLinkType.NOTIFY);
      s.emit(
        "commandData",
        notify(1306, { cmd: 10000, table: TABLE, transaction: "1", data: [] }),
        PortalLinkType.NOTIFY,
      );
      s.emit(
        "commandData",
        notify(1306, { cmd: 10000, count: 2, table: TABLE, transaction: inner.transaction, data: ROWS, mIntRet: 0 }),
        PortalLinkType.NOTIFY,
      );
      expect(await read).toEqual(ROWS);
      expect(s.listenerCount("commandData")).toBe(0);
    } finally {
      router.close();
    }
  });

  it("rejects a table read with the hub's message when it refuses the query", async () => {
    const { router, sessions } = makeRouter();
    try {
      const read = router.readTable(ST, TABLE);
      const s = sessions[0]!;
      const inner = (await request(s)).body.payload as Record<string, unknown>;
      const refused = {
        cmd: 10000,
        mIntRet: -6001,
        msg: "ERROR_ARGUMENT",
        table: TABLE,
        transaction: inner.transaction,
      };
      s.emit("commandData", notify(1306, refused, true), PortalLinkType.NOTIFY);
      await expect(read).rejects.toThrow(/refused history_record_info: ERROR_ARGUMENT \(-6001\)/);
    } finally {
      router.close();
    }
  });

  it("rejects a table read the hub never answers, and one the hub's ACK refuses", async () => {
    await onFakeTimers(async () => {
      const { router, sessions } = makeRouter();
      try {
        const read = router.readTable(ST, TABLE);
        const assertion = expect(read).rejects.toThrow(new RegExp(`reply timed out after ${DB_TABLE_TIMEOUT_MS}ms`));
        await request(sessions[0]!);
        await vi.advanceTimersByTimeAsync(DB_TABLE_TIMEOUT_MS);
        await assertion;
        expect(sessions[0]!.listenerCount("commandData")).toBe(0);
      } finally {
        router.close();
      }
    });
    const { router, sessions } = makeRouter();
    try {
      await router.dispatchCommand(ST, arming(1));
      sessions[0]!.behaviour = "nack";
      await expect(router.readTable(ST, TABLE)).rejects.toThrow(/rejected cmd 1306 \(err 1\)/);
    } finally {
      router.close();
    }
  });

  it("fetches a stored image: the 1308 request, answered by the compressed frame naming its path", async () => {
    const { router, sessions } = makeRouter();
    try {
      const read = router.readImage(ST, THUMB);
      const s = sessions[0]!;
      const p = await request(s);
      expect(p.commandId).toBe(PORTAL_CMD_SET_PAYLOAD);
      expect(p.channel).toBe(PORTAL_STATION_CHANNEL);
      expect(p.body).toEqual({ account_id: "adminid", cmd: 1308, mValue3: 0, payload: [{ file: THUMB }] });
      const other = THUMB.replace("081500", "080000");
      s.emit("commandData", codecReport(), PortalLinkType.NOTIFY);
      s.emit("commandData", notify(1308, { file: other, content: Buffer.alloc(8, 1).toString("base64") }), 3);
      s.emit("commandData", notify(1308, { file: THUMB, content: JPEG.toString("base64") }), PortalLinkType.NOTIFY);
      expect((await read).equals(JPEG)).toBe(true);
      expect(s.listenerCount("commandData")).toBe(0);
    } finally {
      router.close();
    }
  });

  it("serialises a read behind the station's other sends and honours the caller's abort", async () => {
    const { router, sessions } = makeRouter();
    try {
      await router.dispatchCommand(ST, arming(1));
      const s = sessions[0]!;
      s.behaviour = "silent";
      const command = router.dispatchCommand(ST, arming(2));
      const read = router.readImage(ST, THUMB);
      await vi.waitFor(() => expect(s.sent).toHaveLength(2));
      expect(s.sent).toHaveLength(2);
      s.ackSegment(sent(s.sent[1]!).segment);
      await command;
      await vi.waitFor(() => expect(s.sent).toHaveLength(3));
      expect(sent(s.sent[2]!).body.cmd).toBe(1308);
      s.emit("commandData", notify(1308, { file: THUMB, content: JPEG.toString("base64") }), PortalLinkType.NOTIFY);
      expect((await read).equals(JPEG)).toBe(true);
      const control = new AbortController();
      const aborted = router.readTable(ST, TABLE, { signal: control.signal });
      await vi.waitFor(() => expect(s.sent).toHaveLength(4));
      control.abort(new Error("caller left"));
      await expect(aborted).rejects.toThrow("caller left");
      expect(s.listenerCount("commandData")).toBe(0);
    } finally {
      router.close();
    }
  });

  it("does not answer a read with the late reply to an abandoned read of the same table", async () => {
    const { router, sessions } = makeRouter();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_767_225_600_000);
    try {
      const control = new AbortController();
      const first = router.readTable(ST, TABLE, { signal: control.signal });
      const s = sessions[0]!;
      const firstInner = (await request(s)).body.payload as Record<string, unknown>;
      control.abort(new Error("caller left"));
      await expect(first).rejects.toThrow("caller left");
      const second = router.readTable(ST, TABLE);
      await vi.waitFor(() => expect(s.sent).toHaveLength(2));
      const secondInner = sent(s.sent[1]!).body.payload as Record<string, unknown>;
      expect(secondInner.transaction).not.toBe(firstInner.transaction);
      s.emit("commandData", notify(1306, { cmd: 10000, table: TABLE, data: ROWS }), PortalLinkType.NOTIFY);
      s.emit(
        "commandData",
        notify(1306, { cmd: 10000, table: TABLE, transaction: firstInner.transaction, data: ROWS }),
        PortalLinkType.NOTIFY,
      );
      s.emit(
        "commandData",
        notify(1306, { cmd: 10000, table: TABLE, transaction: secondInner.transaction, data: [ROWS[0]] }),
        PortalLinkType.NOTIFY,
      );
      expect(await second).toEqual([ROWS[0]]);
    } finally {
      now.mockRestore();
      router.close();
    }
  });

  it("rejects a read at once when its caller aborts while it waits behind another send, and never sends it", async () => {
    const { router, sessions } = makeRouter();
    try {
      await router.dispatchCommand(ST, arming(1));
      const s = sessions[0]!;
      s.behaviour = "silent";
      const pending = router.readTable(ST, TABLE);
      await vi.waitFor(() => expect(s.sent).toHaveLength(2));
      const control = new AbortController();
      const queued = router.readImage(ST, THUMB, { signal: control.signal });
      await new Promise((resolve) => setImmediate(resolve));
      control.abort(new Error("caller left"));
      await expect(queued).rejects.toThrow("caller left");
      const pendingInner = sent(s.sent[1]!).body.payload as Record<string, unknown>;
      s.emit(
        "commandData",
        notify(1306, { cmd: 10000, table: TABLE, transaction: pendingInner.transaction, data: ROWS }),
        PortalLinkType.NOTIFY,
      );
      expect(await pending).toEqual(ROWS);
      await new Promise((resolve) => setImmediate(resolve));
      expect(s.sent).toHaveLength(2);
    } finally {
      router.close();
    }
  });
});
