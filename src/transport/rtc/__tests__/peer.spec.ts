import { describe, expect, it, vi } from "vitest";
import type { DataChannel, PeerConnection, RtcConfig } from "node-datachannel";
import { COMMAND_CHANNEL, DATA_CHANNEL_LABELS, RtcPeer } from "../peer.js";
import { ANKER_MAX_MESSAGE_SIZE, scallJsonToSdp, sdpToScallJson } from "../scall-sdp.js";

/** The slice of `DataChannel` the peer drives. */
class FakeDc {
  open = false;
  sent: Buffer[] = [];
  private cbs: Record<string, ((...a: never[]) => void) | undefined> = {};
  constructor(
    readonly label: string,
    readonly config?: { id?: number },
  ) {}
  getLabel(): string {
    return this.label;
  }
  isOpen(): boolean {
    return this.open;
  }
  sendResult = true;
  sendMessageBinary(buffer: Buffer | Uint8Array): boolean {
    this.sent.push(Buffer.from(buffer));
    return this.sendResult;
  }
  close(): void {
    this.open = false;
  }
  onOpen(cb: () => void): void {
    this.cbs.open = cb;
  }
  onClosed(cb: () => void): void {
    this.cbs.closed = cb;
  }
  onError(cb: (err: string) => void): void {
    this.cbs.error = cb as never;
  }
  onMessage(cb: (msg: string | Buffer | ArrayBuffer) => void): void {
    this.cbs.message = cb as never;
  }
  fireOpen(): void {
    this.open = true;
    (this.cbs.open as (() => void) | undefined)?.();
  }
  fireMessage(msg: Buffer): void {
    (this.cbs.message as ((m: Buffer) => void) | undefined)?.(msg);
  }
  fireClosed(): void {
    this.open = false;
    (this.cbs.closed as (() => void) | undefined)?.();
  }
}

/** The slice of `PeerConnection` the peer drives. */
class FakePc {
  readonly channels: FakeDc[] = [];
  remote?: { sdp: string; type: string };
  candidates: Array<[string, string]> = [];
  closed = false;
  local: { type: string; sdp: string } | null = null;
  private cbs: Record<string, ((...a: never[]) => void) | undefined> = {};
  close(): void {
    this.closed = true;
  }
  setRemoteDescription(sdp: string, type: "offer" | "answer"): void {
    this.remote = { sdp, type };
  }
  localDescription(): { type: string; sdp: string } | null {
    return this.local;
  }
  addRemoteCandidate(candidate: string, mid: string): void {
    this.candidates.push([candidate, mid]);
  }
  createDataChannel(label: string, config?: { id?: number }): DataChannel {
    const dc = new FakeDc(label, config);
    this.channels.push(dc);
    return dc as unknown as DataChannel;
  }
  onLocalDescription(cb: (sdp: string, type: string) => void): void {
    this.cbs.local = cb as never;
  }
  onLocalCandidate(cb: (candidate: string, mid: string) => void): void {
    this.cbs.cand = cb as never;
  }
  onStateChange(cb: (state: string) => void): void {
    this.cbs.state = cb as never;
  }
  onGatheringStateChange(cb: (state: string) => void): void {
    this.cbs.gather = cb as never;
  }
  onDataChannel(cb: (dc: DataChannel) => void): void {
    this.cbs.dc = cb as never;
  }
  fireLocalAnswer(sdp: string): void {
    (this.cbs.local as ((s: string, t: string) => void) | undefined)?.(sdp, "answer");
  }
  fireLocalCandidate(c: string): void {
    (this.cbs.cand as ((c: string, m: string) => void) | undefined)?.(c, "2");
  }
  fireGathering(state: string): void {
    (this.cbs.gather as ((s: string) => void) | undefined)?.(state);
  }
  fireState(state: string): void {
    (this.cbs.state as ((s: string) => void) | undefined)?.(state);
  }
}

const HOST = "1 1 udp 2130706431 192.0.2.10 47470 typ host";
const RELAY = "3 1 udp 16777215 203.0.113.20 50612 typ relay raddr 0.0.0.0 rport 0";
const TURN = { turn_addr: "t", turn_port: 3478, turn_user: "u", turn_password: "p" };
const OFFER = scallJsonToSdp({
  setup: "actpass",
  ice: { ufrag: "u", pwd: "p", fingerprint: "ab" },
  candidate: [HOST, RELAY],
});
const ANSWER =
  "v=0\r\na=setup:passive\r\na=ice-ufrag:x\r\na=ice-pwd:y\r\na=fingerprint:sha-256 aa:bb\r\na=max-message-size:65536\r\n";

function setup(iceTransportPolicy?: "relay" | "all") {
  let pc!: FakePc;
  let config!: RtcConfig;
  const peer = new RtcPeer({
    iceTransportPolicy,
    createPeer: (_name, cfg) => {
      config = cfg;
      pc = new FakePc();
      return pc as unknown as PeerConnection;
    },
  });
  return { peer, pc: () => pc, config: () => config };
}

describe("RtcPeer", () => {
  it("allows direct candidates while retaining the granted TURN servers", async () => {
    const { peer, pc, config } = setup("all");
    const candidates: string[] = [];
    peer.on("iceCandidate", (c) => candidates.push(c));
    await peer.init(TURN);
    expect(config().iceTransportPolicy).toBe("all");
    expect(config().iceServers).toHaveLength(2);
    pc().fireLocalCandidate(HOST);
    pc().fireLocalCandidate(RELAY);
    peer.addRemoteCandidate(HOST);
    const answer = peer.handleRemoteOffer(OFFER);
    pc().fireLocalAnswer(ANSWER);
    await answer;
    expect(candidates).toEqual([HOST, RELAY]);
    expect(pc().candidates.some(([c]) => c === HOST)).toBe(true);
    peer.close();
  });

  it("uses the native application mid for queued and later ICE candidates", async () => {
    const { peer, pc } = setup("all");
    await peer.init(TURN);
    peer.addRemoteCandidate(HOST);
    const answering = peer.handleRemoteOffer(OFFER.replace("a=mid:2", "a=mid:data"));
    pc().fireLocalAnswer(ANSWER);
    await answering;
    peer.addRemoteCandidate(RELAY);
    expect(pc().candidates).toEqual([
      [HOST, "data"],
      [RELAY, "data"],
    ]);
    peer.close();
  });

  it("builds a relay-only peer on the hub's TURN grant, with the hub's max message size", async () => {
    const { peer, config } = setup();
    await peer.init({ ...TURN, alt_turn_addr: "t2", alt_turn_port: 3479 });
    expect(config().iceTransportPolicy).toBe("relay");
    expect(config().maxMessageSize).toBe(ANKER_MAX_MESSAGE_SIZE);
    expect(
      config().iceServers.map((s) => (typeof s === "string" ? s : `${s.relayType}@${s.hostname}:${s.port}`)),
    ).toEqual(["TurnUdp@t:3478", "TurnTcp@t:3478", "TurnUdp@t2:3479", "TurnTcp@t2:3479"]);
  });

  it("answers the hub's offer: pins it passive, declares the portal's channels on even ids, pins the size", async () => {
    const { peer, pc } = setup();
    await peer.init(TURN);
    const answering = peer.handleRemoteOffer(OFFER);
    expect(pc().channels.map((c) => c.label)).toEqual([...DATA_CHANNEL_LABELS]);
    expect(pc().channels.map((c) => c.config?.id)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(pc().remote?.type).toBe("offer");
    expect(pc().remote?.sdp).toContain("a=setup:passive");
    expect(pc().remote?.sdp).not.toContain("a=setup:actpass");
    pc().fireLocalAnswer(ANSWER);
    const answer = await answering;
    expect(answer).toContain(`a=max-message-size:${ANKER_MAX_MESSAGE_SIZE}`);
    expect(sdpToScallJson(answer)).toEqual({
      setup: "passive",
      ice: { ufrag: "x", pwd: "y", fingerprint_type: "sha-256", fingerprint: "aabb" },
    });
  });

  it("uses an answer the native peer already produced, and times out when it never does", async () => {
    const early = setup();
    await early.peer.init(TURN);
    early.pc().local = { type: "answer", sdp: ANSWER };
    await expect(early.peer.handleRemoteOffer(OFFER)).resolves.toContain("a=setup:passive");
    vi.useFakeTimers();
    try {
      const { peer, pc } = setup();
      await peer.init(TURN);
      const settled = expect(peer.handleRemoteOffer(OFFER)).rejects.toThrow(/local SDP answer/);
      await vi.advanceTimersByTimeAsync(15_000);
      await settled;
      expect(pc().closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("queues remote candidates until the offer is applied, and keeps only relay ones both ways", async () => {
    const { peer, pc } = setup();
    await peer.init(TURN);
    peer.addRemoteCandidate(HOST);
    peer.addRemoteCandidate(RELAY);
    expect(pc().candidates).toEqual([]);
    const answering = peer.handleRemoteOffer(OFFER);
    pc().fireLocalAnswer(ANSWER);
    await answering;
    expect(pc().candidates).toEqual([[RELAY, "2"]]);
    peer.addRemoteCandidate("4 1 udp 16777215 203.0.113.21 5 typ relay");
    expect(pc().candidates).toHaveLength(2);
    const local: string[] = [];
    peer.on("iceCandidate", (c) => local.push(c));
    pc().fireLocalCandidate(HOST);
    pc().fireLocalCandidate(RELAY);
    pc().fireLocalCandidate("");
    expect(local).toEqual([RELAY]);
    const done = vi.fn();
    peer.on("iceGatheringComplete", done);
    pc().fireGathering("in-progress");
    pc().fireGathering("complete");
    pc().fireGathering("complete");
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("opens the command path once the channel opens, sends through the framer, and surfaces inbound frames", async () => {
    const { peer, pc } = setup();
    await peer.init(TURN);
    const answering = peer.handleRemoteOffer(OFFER);
    pc().fireLocalAnswer(ANSWER);
    await answering;
    const cmd = pc().channels.find((c) => c.label === COMMAND_CHANNEL)!;
    expect(peer.sendCommand(Buffer.from("XZYH-not-open-yet!"))).toBe(false);
    const opened = vi.fn();
    peer.on("commandChannelOpen", opened);
    cmd.fireOpen();
    expect(opened).toHaveBeenCalledTimes(1);
    const packet = Buffer.from("XZYHcommand");
    expect(peer.sendCommand(packet)).toBe(true);
    expect(cmd.sent).toHaveLength(1);
    expect(cmd.sent[0]!.subarray(0, 4).toString()).toBe("PTCS");
    const frames: Array<[string, number]> = [];
    peer.on("data", (frame, lt) => frames.push([frame.toString(), lt]));
    cmd.fireMessage(Buffer.from("XZYHreply-16-bytes"));
    const notify = pc().channels.find((c) => c.label === "notify")!;
    notify.fireMessage(Buffer.from("XZYHpush--16-bytes"));
    const video = pc().channels.find((c) => c.label === "video")!;
    video.fireMessage(Buffer.from("XZYHvideo-16-byte!"));
    video.fireMessage(Buffer.from("raw"));
    // Every channel feeds the framer: a bare portal packet passes through as a command frame, and a
    // three-byte message is neither a portal packet nor a PTCS one.
    expect(frames).toEqual([
      ["XZYHreply-16-bytes", 1],
      ["XZYHpush--16-bytes", 1],
      ["XZYHvideo-16-byte!", 1],
    ]);
    const states: string[] = [];
    peer.on("connectionState", (s) => states.push(s));
    pc().fireState("connected");
    expect(states).toEqual(["connected"]);
    peer.close();
    expect(pc().closed).toBe(true);
    expect(peer.sendCommand(packet)).toBe(false);
  });

  it("rejects a pending local answer when the peer is closed instead of dropping it", async () => {
    const { peer } = setup();
    await peer.init(TURN);
    const answering = peer.handleRemoteOffer(OFFER);
    peer.close();
    await expect(answering).rejects.toThrow(/closed while waiting for the local SDP answer/);
  });

  it("announces the command channel closing so a caller stops believing it is ready", async () => {
    const { peer, pc } = setup();
    await peer.init(TURN);
    const answering = peer.handleRemoteOffer(OFFER);
    pc().fireLocalAnswer(ANSWER);
    await answering;
    const cmd = pc().channels.find((c) => c.label === COMMAND_CHANNEL)!;
    cmd.fireOpen();
    const closed = vi.fn();
    peer.on("commandChannelClosed", closed);
    // a non-command channel closing says nothing about the session
    pc()
      .channels.find((c) => c.label === "notify")!
      .fireClosed();
    expect(closed).not.toHaveBeenCalled();
    cmd.fireClosed();
    expect(closed).toHaveBeenCalledTimes(1);
    expect(peer.sendCommand(Buffer.from("XZYHafter-close-"))).toBe(false);
    cmd.fireClosed();
    expect(closed).toHaveBeenCalledTimes(1); // once, not per event
  });

  it("reports a refused native send as a failed command instead of a silent success", async () => {
    const { peer, pc } = setup();
    await peer.init(TURN);
    const answering = peer.handleRemoteOffer(OFFER);
    pc().fireLocalAnswer(ANSWER);
    await answering;
    const cmd = pc().channels.find((c) => c.label === COMMAND_CHANNEL)!;
    cmd.fireOpen();
    expect(peer.sendCommand(Buffer.from("XZYHok----------"))).toBe(true);
    cmd.sendResult = false; // the native channel refuses the wire packet
    expect(peer.sendCommand(Buffer.from("XZYHrefused-----"))).toBe(false);
  });

  it("refuses to work before init and to handle two offers at once", async () => {
    const { peer, pc } = setup();
    await expect(peer.handleRemoteOffer(OFFER)).rejects.toThrow(/not initialised/);
    await peer.init(TURN);
    const first = peer.handleRemoteOffer(OFFER);
    await expect(peer.handleRemoteOffer(OFFER)).rejects.toThrow(/already handling/);
    pc().fireLocalAnswer(ANSWER);
    await first;
  });
});
