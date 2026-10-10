import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { RtcPeer, TurnConfig } from "../peer.js";
import { scallJsonToSdp, sdpToScallJson } from "../scall-sdp.js";
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
  handleRemoteOffer = vi.fn(async (_sdp: string) => ANSWER);
  addRemoteCandidate = vi.fn();
  sendCommand = vi.fn(() => true);
  close = vi.fn();
  isCommandChannelReady = false;
}

const ANSWER = "v=0\r\na=setup:active\r\na=ice-ufrag:x\r\na=ice-pwd:y\r\na=fingerprint:sha-256 aa:bb\r\n";
const TURN: TurnConfig = { turn_addr: "203.0.113.30", turn_port: 3478, turn_user: "u", turn_password: "p" };
const HUB_SDP = {
  setup: "actpass",
  ice: { ufrag: "a", pwd: "b", fingerprint: "cd" },
  candidate: ["1 1 udp 1 192.0.2.10 1 typ host"],
};

function setup(signalingMode?: "call" | "scall") {
  const sig = new FakeSignaling();
  const peer = new FakePeer();
  const session = new RtcSession({
    signalingMode,
    authToken: "T",
    gtoken: "G",
    stationSn: "T9000P0000000001",
    adminUserId: "a",
    shard: "eu-pr",
    country: "IT",
    createSignaling: () => sig as unknown as RtcSignalingClient,
    createPeer: () => peer as unknown as RtcPeer,
  });
  const errors: Error[] = [];
  session.on("error", (e) => errors.push(e));
  return { sig, peer, session, errors };
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
  it.each(["native", "compact"])("preserves the full answer in call mode after a %s offer", async (format) => {
    const s = await authenticated(setup("call"));
    const native =
      ANSWER +
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:data\r\na=sctp-port:5000\r\na=max-message-size:262144\r\na=ice-options:trickle\r\n";
    s.peer.handleRemoteOffer.mockResolvedValue(native);
    s.sig.hub({ action: 3, dataType: "call", data: { status: 100, turn: TURN } });
    s.sig.hub({ action: 3, dataType: "info", data: { sdp: format === "native" ? native : JSON.stringify(HUB_SDP) } });
    await flush();
    expect(s.peer.handleRemoteOffer).toHaveBeenCalledOnce();
    if (format === "native") expect(s.peer.handleRemoteOffer).toHaveBeenCalledWith(native);
    expect(s.sig.sendInfoSdp).toHaveBeenCalledWith(native);
    expect(s.errors).toEqual([]);
    s.session.close();
  });

  it("signs, connects, waits for auth, then calls", async () => {
    const s = setup();
    const connecting = s.session.connect();
    await vi.waitFor(() => expect(s.sig.connect).toHaveBeenCalled());
    expect(s.sig.fetchSign).toHaveBeenCalledTimes(1);
    expect(s.sig.sendCall).not.toHaveBeenCalled();
    s.sig.hub({ action: 3, code: 200, dataType: "scall", data: { status: 100, turn: TURN } }); // not auth
    s.sig.hub({ action: 1, code: 200 });
    await connecting;
    expect(s.sig.sendCall).toHaveBeenCalledTimes(1);
  });

  it("times out when the hub never authenticates", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const connecting = s.session.connect();
      const settled = expect(connecting).rejects.toThrow(/auth timeout/);
      await vi.advanceTimersByTimeAsync(15_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a connect() still waiting for auth when the session is closed", async () => {
    vi.useFakeTimers();
    try {
      const s = setup();
      const connecting = s.session.connect();
      const settled = expect(connecting).rejects.toThrow(/closed while waiting for signalling auth/);
      await vi.waitFor(() => expect(s.sig.connect).toHaveBeenCalled());
      s.session.close();
      await settled;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("places no call when the session is closed between the auth and connect() resuming", async () => {
    const s = setup();
    const connecting = s.session.connect();
    await vi.waitFor(() => expect(s.sig.connect).toHaveBeenCalled());
    s.sig.hub({ action: 1, code: 200 });
    queueMicrotask(() => s.session.close());
    await expect(connecting).rejects.toThrow(/closed before the call was placed/);
    expect(s.sig.sendCall).not.toHaveBeenCalled();
  });

  it("opens no socket when the session is closed while the sign fetch is pending", async () => {
    const s = setup();
    let releaseSign!: (sign: string) => void;
    s.sig.fetchSign.mockImplementationOnce(() => new Promise<string>((resolve) => (releaseSign = resolve)));
    const connecting = s.session.connect();
    s.session.close();
    releaseSign("SIGN");
    await expect(connecting).rejects.toThrow(/closed before the call was placed/);
    expect(s.sig.connect).not.toHaveBeenCalled();
  });

  it("runs the whole exchange: grant → offer → answer → trickle → ack → open", async () => {
    const s = await authenticated(setup());
    s.sig.hub({ action: 3, dataType: "scall", data: { status: 100, turn: TURN } });
    await flush();
    expect(s.peer.init).toHaveBeenCalledWith(TURN);

    s.sig.hub({ action: 3, dataType: "info", data: { sdp: JSON.stringify(HUB_SDP) } });
    await flush();
    const offered = s.peer.handleRemoteOffer.mock.calls[0]![0];
    expect(offered).toContain("a=ice-ufrag:a");
    expect(offered).toBe(scallJsonToSdp(HUB_SDP, () => Number(offered.match(/o=- (\d+)/)![1])));
    expect(s.sig.sendInfoSdp).toHaveBeenCalledWith(JSON.stringify(sdpToScallJson(ANSWER)));
    // A second offer is ignored.
    s.sig.hub({ action: 3, dataType: "info", data: { sdp: JSON.stringify(HUB_SDP) } });
    await flush();
    expect(s.peer.handleRemoteOffer).toHaveBeenCalledTimes(1);

    s.sig.hub({ action: 3, dataType: "info", data: { candidate: "1 1 udp 1 192.0.2.10 2 typ host" } });
    s.sig.hub({
      action: 3,
      dataType: "info",
      data: { format: "CANDIDATE", value: "1 1 udp 1 192.0.2.10 3 typ host" },
    });
    s.sig.hub({ action: 3, dataType: "info", data: { candidate: "" } });
    await flush();
    expect(s.peer.addRemoteCandidate.mock.calls.map((c) => c[0])).toEqual([
      "1 1 udp 1 192.0.2.10 2 typ host",
      "1 1 udp 1 192.0.2.10 3 typ host",
    ]);

    s.peer.emit("iceCandidate", "our-host");
    s.peer.emit("iceGatheringComplete");
    expect(s.sig.sendInfoCandidate.mock.calls).toEqual([["our-host"], [""]]);

    s.sig.hub({ action: 3, dataType: "scall", data: { status: 200 } });
    await flush();
    expect(s.sig.sendAck).toHaveBeenCalledTimes(1);

    const connected = vi.fn();
    s.session.on("connected", connected);
    s.peer.emit("commandChannelOpen");
    s.peer.emit("commandChannelOpen");
    expect(connected).toHaveBeenCalledTimes(1);
    expect(s.session.isConnected).toBe(true);

    const frames: Array<[string, number]> = [];
    s.session.on("commandData", (f, lt) => frames.push([f.toString(), lt]));
    s.peer.emit("data", Buffer.from("XZYH"), 3);
    expect(frames).toEqual([["XZYH", 3]]);
    expect(s.session.sendCommand(Buffer.from("XZYH"))).toBe(true);
    expect(s.errors).toEqual([]);
  });

  it("reports an offer that arrives before the relay grant and answers the one after it", async () => {
    const s = await authenticated(setup());
    s.sig.hub({ action: 3, dataType: "info", data: { format: "SDP", value: JSON.stringify(HUB_SDP) } });
    await flush();
    expect(s.peer.init).not.toHaveBeenCalled();
    expect(s.peer.handleRemoteOffer).not.toHaveBeenCalled();
    expect(s.errors.map((e) => e.message)).toEqual(["RTC T9000P0000000001 offered before granting a relay"]);
    s.sig.hub({ action: 3, dataType: "scall", data: { status: 100, turn: TURN } });
    s.sig.hub({ action: 3, dataType: "info", data: { format: "SDP", value: JSON.stringify(HUB_SDP) } });
    await flush();
    expect(s.peer.handleRemoteOffer).toHaveBeenCalledTimes(1);
  });

  it.each([486, 408])("fails the session on scall %s instead of calling again", async (status) => {
    const s = await authenticated(setup());
    const closed = vi.fn();
    s.session.on("close", closed);
    s.sig.hub({ action: 3, dataType: "scall", data: { status } });
    await flush();
    expect(s.sig.sendCall).toHaveBeenCalledTimes(1);
    expect(s.errors.map((e) => e.message)).toEqual([`RTC T9000P0000000001 scall answered ${status}`]);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(s.sig.close).toHaveBeenCalledTimes(1);
  });

  it("announces close once when the caller closes it, so a waiter is released at once", async () => {
    const s = await authenticated(setup());
    s.peer.emit("commandChannelOpen");
    const closed = vi.fn();
    s.session.on("close", closed);
    s.session.close();
    expect(closed).toHaveBeenCalledTimes(1);
    s.sig.emit("close", 1000, "");
    s.peer.emit("commandChannelClosed");
    expect(closed).toHaveBeenCalledTimes(1);
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
