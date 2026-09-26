import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { RtcPeer, TurnConfig } from "../peer.js";
import { scallJsonToSdp } from "../scall-sdp.js";
import { RtcSession } from "../session.js";
import type { RtcInnerMessage, RtcSignalingClient } from "../signaling.js";

class FakeSignaling extends EventEmitter {
  isOpen = false;
  fetchSign = vi.fn(async () => "SIGN");
  connect = vi.fn(async () => {
    this.isOpen = true;
  });
  sendCall = vi.fn();
  sendAck = vi.fn();
  sendInfoSdp = vi.fn();
  sendInfoCandidate = vi.fn();
  sendHangup = vi.fn();
  close = vi.fn(() => {
    this.isOpen = false;
  });
  /** What the hub would send: an inner message with `data` as JSON text. */
  hub(inner: Omit<RtcInnerMessage, "data"> & { data?: Record<string, unknown> }): void {
    this.emit("message", { ...inner, data: inner.data ? JSON.stringify(inner.data) : undefined } as RtcInnerMessage);
  }
}

class FakePeer extends EventEmitter {
  init = vi.fn(async (_turn?: TurnConfig) => {});
  handleRemoteOffer = vi.fn(async (sdp: string) => `ANSWER<${sdp.length}>`);
  answerAsScallJson = vi.fn((sdp: string) => JSON.stringify({ answer: sdp }));
  addRemoteCandidate = vi.fn();
  sendCommand = vi.fn(() => true);
  close = vi.fn();
  isCommandChannelReady = false;
}

const TURN: TurnConfig = { turn_addr: "13.248.157.102", turn_port: 3478, turn_user: "u", turn_password: "p" };
const HUB_SDP = {
  setup: "actpass",
  ice: { ufrag: "a", pwd: "b", fingerprint: "cd" },
  candidate: ["1 1 udp 1 192.168.178.142 1 typ host"],
};

function setup(overrides: { maxCallRetries?: number } = {}) {
  const sig = new FakeSignaling();
  const peer = new FakePeer();
  const sleeps: number[] = [];
  const session = new RtcSession({
    authToken: "T",
    userId: "u",
    stationSn: "T9000P2026220AA6",
    adminUserId: "a",
    shard: "eu-pr",
    country: "IT",
    createSignaling: () => sig as unknown as RtcSignalingClient,
    createPeer: () => peer as unknown as RtcPeer,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    authTimeoutMs: 100,
    ...overrides,
  });
  const errors: Error[] = [];
  session.on("error", (e) => errors.push(e));
  return { sig, peer, session, sleeps, errors };
}

async function authenticated(s: ReturnType<typeof setup>) {
  const connecting = s.session.connect();
  await vi.waitFor(() => expect(s.sig.connect).toHaveBeenCalled());
  s.sig.hub({ action: 1, code: 200 });
  await connecting;
  return s;
}

const flush = () => new Promise((r) => setImmediate(r));

describe("RtcSession", () => {
  it("signs, connects, waits for auth, then calls", async () => {
    const s = setup();
    const connecting = s.session.connect();
    await vi.waitFor(() => expect(s.sig.connect).toHaveBeenCalled());
    expect(s.sig.fetchSign).toHaveBeenCalledTimes(1);
    expect(s.sig.sendCall).not.toHaveBeenCalled();
    s.sig.hub({ action: 3, code: 200, dataType: "scall", data: { status: 100, turn: TURN } }); // not auth
    s.sig.hub({ action: 1, code: 200 });
    await connecting;
    expect(s.sig.sendCall).toHaveBeenCalledWith(0);
  });

  it("times out when the hub never authenticates", async () => {
    const s = setup();
    await expect(s.session.connect()).rejects.toThrow(/auth timeout/);
  });

  it("runs the whole exchange: grant → offer → answer → trickle → ack → open", async () => {
    const s = await authenticated(setup());
    const turn = vi.fn();
    s.session.on("turn", turn);
    s.sig.hub({ action: 3, dataType: "scall", data: { status: 100, turn: TURN } });
    await flush();
    expect(turn).toHaveBeenCalledWith(TURN);
    expect(s.peer.init).toHaveBeenCalledWith(TURN);

    s.sig.hub({ action: 3, dataType: "info", data: { sdp: JSON.stringify(HUB_SDP) } });
    await flush();
    const offered = s.peer.handleRemoteOffer.mock.calls[0]![0];
    expect(offered).toContain("a=ice-ufrag:a");
    expect(offered).toBe(scallJsonToSdp(HUB_SDP, () => Number(offered.match(/o=- (\d+)/)![1])));
    expect(s.sig.sendInfoSdp).toHaveBeenCalledWith(JSON.stringify({ answer: `ANSWER<${offered.length}>` }), 0);
    // A second offer is ignored.
    s.sig.hub({ action: 3, dataType: "info", data: { sdp: JSON.stringify(HUB_SDP) } });
    await flush();
    expect(s.peer.handleRemoteOffer).toHaveBeenCalledTimes(1);

    s.sig.hub({ action: 3, dataType: "info", data: { candidate: "1 1 udp 1 192.168.178.142 2 typ host" } });
    s.sig.hub({
      action: 3,
      dataType: "info",
      data: { format: "CANDIDATE", value: "1 1 udp 1 192.168.178.142 3 typ host" },
    });
    s.sig.hub({ action: 3, dataType: "info", data: { candidate: "" } });
    await flush();
    expect(s.peer.addRemoteCandidate.mock.calls.map((c) => c[0])).toEqual([
      "1 1 udp 1 192.168.178.142 2 typ host",
      "1 1 udp 1 192.168.178.142 3 typ host",
    ]);

    s.peer.emit("iceCandidate", "our-host");
    s.peer.emit("iceGatheringComplete");
    // Candidates ride the session's own channel (0 here) — the same channel the SDP answer and ack use,
    // matching the portal, not a fixed channel 1.
    expect(s.sig.sendInfoCandidate.mock.calls).toEqual([
      ["our-host", 0],
      ["", 0],
    ]);

    s.sig.hub({ action: 3, dataType: "scall", data: { status: 200 } });
    await flush();
    expect(s.sig.sendAck).toHaveBeenCalledWith(0);

    const connected = vi.fn();
    s.session.on("connected", connected);
    s.peer.emit("commandChannelOpen");
    s.peer.emit("commandChannelOpen");
    expect(connected).toHaveBeenCalledTimes(1);
    expect(s.session.isConnected).toBe(true);

    const frames: Array<[string, number]> = [];
    const media: Array<[string, number]> = [];
    s.session.on("commandData", (f, lt) => frames.push([f.toString(), lt]));
    s.session.on("mediaData", (f, lt) => media.push([f.toString(), lt]));
    s.peer.emit("data", "notify", Buffer.from("XZYH"), 3);
    s.peer.emit("data", "video", Buffer.from("v"), 5);
    s.peer.emit("data", "playback", Buffer.from("p"), 4);
    expect(frames).toEqual([["XZYH", 3]]);
    expect(media).toEqual([
      ["v", 5],
      ["p", 4],
    ]);
    expect(s.session.sendCommand(Buffer.from("XZYH"))).toBe(true);
    expect(s.errors).toEqual([]);
  });

  it("initialises the peer without TURN when the hub offers before it grants", async () => {
    const s = await authenticated(setup());
    s.sig.hub({ action: 3, dataType: "info", data: { format: "SDP", value: JSON.stringify(HUB_SDP) } });
    await flush();
    expect(s.peer.init).toHaveBeenCalledWith();
    expect(s.peer.handleRemoteOffer).toHaveBeenCalledTimes(1);
  });

  it("backs off and calls again on 486/408, then gives up", async () => {
    const s = await authenticated(setup({ maxCallRetries: 2 }));
    s.sig.hub({ action: 3, dataType: "scall", data: { status: 486 } });
    await flush();
    expect(s.sig.sendHangup).toHaveBeenCalledTimes(1);
    expect(s.peer.close).toHaveBeenCalledTimes(1);
    expect(s.sleeps).toEqual([10_000]);
    expect(s.sig.sendCall).toHaveBeenCalledTimes(2);
    s.sig.hub({ action: 3, dataType: "scall", data: { status: 408 } });
    await flush();
    expect(s.sleeps).toEqual([10_000, 15_000]);
    expect(s.sig.sendCall).toHaveBeenCalledTimes(3);
    s.sig.hub({ action: 3, dataType: "scall", data: { status: 486 } });
    await flush();
    expect(s.sig.sendCall).toHaveBeenCalledTimes(3);
    expect(s.errors.map((e) => e.message)).toEqual(["RTC scall 486 after 2 retries"]);
  });

  it("reports a lost peer or socket as close, and close() hangs up both sides once", async () => {
    const s = await authenticated(setup());
    const closed = vi.fn();
    s.session.on("close", closed);
    s.peer.emit("commandChannelOpen");
    s.peer.emit("connectionState", "failed");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(s.session.isConnected).toBe(false);
    s.session.close();
    s.session.close();
    expect(s.sig.sendHangup).toHaveBeenCalledTimes(1);
    expect(s.sig.close).toHaveBeenCalledTimes(1);
    expect(s.peer.close).toHaveBeenCalledTimes(1);
    s.sig.emit("close", 1000, "");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("stops reporting connected when the command channel closes under a live peer", async () => {
    const s = await authenticated(setup());
    const closed = vi.fn();
    s.session.on("close", closed);
    s.peer.emit("commandChannelOpen");
    expect(s.session.isConnected).toBe(true);
    s.peer.emit("commandChannelClosed");
    expect(s.session.isConnected).toBe(false);
    expect(closed).toHaveBeenCalledTimes(1);
    s.peer.emit("commandChannelClosed");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("surfaces a handler failure as an error instead of an unhandled rejection", async () => {
    const s = await authenticated(setup());
    s.peer.init.mockRejectedValueOnce(new Error("no native module"));
    s.sig.hub({ action: 3, dataType: "scall", data: { status: 100, turn: TURN } });
    await flush();
    expect(s.errors.map((e) => e.message)).toEqual(["no native module"]);
  });
});
