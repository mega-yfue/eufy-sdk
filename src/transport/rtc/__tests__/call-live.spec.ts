import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { PeerConnection, RtcConfig, Track } from "node-datachannel";
import type { LiveVideoFrame } from "../../../core/contracts.js";
import { H264Depacketizer, RtcCallLiveStream } from "../call-live.js";
import { RtcSession } from "../session.js";
import type { RtcInnerMessage, RtcSignalingClient } from "../signaling.js";

const rtp = (seq: number, payload: number[] | Buffer, marker = false, pt = 99) => {
  const h = Buffer.alloc(12);
  h[0] = 0x80;
  h[1] = (marker ? 0x80 : 0) | pt;
  h.writeUInt16BE(seq, 2);
  h.writeUInt32BE(9000, 4);
  return Buffer.concat([h, Buffer.from(payload)]);
};

describe("H264Depacketizer", () => {
  it("joins STAP-A and FU-A into one Annex-B access unit on the marker", () => {
    const units: Buffer[] = [];
    const d = new H264Depacketizer((u) => units.push(u));
    d.push(rtp(1, [24, 0, 2, 0x67, 1, 0, 2, 0x68, 2]));
    d.push(rtp(2, [0x7c, 0x85, 9, 9]));
    d.push(rtp(3, [0x7c, 0x45, 8], true));
    expect(units).toHaveLength(1);
    expect(units[0].toString("hex")).toBe("0000000167010000000168020000000165090908");
  });

  it("drops a unit with a sequence gap and ignores RTCP", () => {
    const units: Buffer[] = [];
    const d = new H264Depacketizer((u) => units.push(u));
    d.push(rtp(10, [0x7c, 0x85, 1]));
    d.push(rtp(12, [0x7c, 0x45, 2], true));
    d.push(rtp(0, [0x81, 0xc8], true, 72));
    d.push(rtp(13, [0x61, 5], true));
    expect(units.map((u) => u.toString("hex"))).toEqual(["000000016105"]);
  });
});

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
  doorbell(inner: Omit<RtcInnerMessage, "data"> & { data?: Record<string, unknown> }): void {
    this.emit("message", { ...inner, data: inner.data ? JSON.stringify(inner.data) : undefined } as RtcInnerMessage);
  }
}

class FakeTrack {
  private cb?: (msg: Buffer) => void;
  constructor(private readonly id: string) {}
  mid(): string {
    return this.id;
  }
  onMessage(cb: (msg: Buffer) => void): void {
    this.cb = cb;
  }
  fire(msg: Buffer): void {
    this.cb?.(msg);
  }
}

/** The slice of the native peer a media-track `RtcPeer` drives; it answers as soon as the offer is set. */
class FakeNativePeer {
  remote?: string;
  candidates: Array<[string, string]> = [];
  channels = 0;
  closed = false;
  readonly tracks = new Map<string, FakeTrack>();
  private local: { type: string; sdp: string } | null = null;
  private onTrackCb?: (t: Track) => void;
  private onStateCb?: (s: string) => void;
  setRemoteDescription(sdp: string): void {
    this.remote = sdp;
    for (const mid of ["0", "1"]) {
      const track = new FakeTrack(mid);
      this.tracks.set(mid, track);
      this.onTrackCb?.(track as unknown as Track);
    }
    this.local = { type: "answer", sdp: ANSWER };
  }
  localDescription(): { type: string; sdp: string } | null {
    return this.local;
  }
  addRemoteCandidate(candidate: string, mid: string): void {
    this.candidates.push([candidate, mid]);
  }
  createDataChannel(): never {
    this.channels++;
    throw new Error("a media-track peer declares no data channel");
  }
  close(): void {
    this.closed = true;
  }
  onLocalDescription(): void {}
  onLocalCandidate(): void {}
  onGatheringStateChange(): void {}
  onDataChannel(): void {}
  onStateChange(cb: (s: string) => void): void {
    this.onStateCb = cb;
  }
  onTrack(cb: (t: Track) => void): void {
    this.onTrackCb = cb;
  }
  state(s: string): void {
    this.onStateCb?.(s);
  }
}

const ANSWER = "v=0\r\na=setup:active\r\na=ice-ufrag:x\r\na=ice-pwd:y\r\na=fingerprint:sha-256 aa:bb\r\n";
const OFFER = [
  "v=0",
  "o=- 1 1 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0 1 2",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=mid:0",
  "a=setup:actpass",
  "m=video 9 UDP/TLS/RTP/SAVPF 99",
  "a=mid:1",
  "a=setup:actpass",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
  "a=mid:2",
  "a=setup:actpass",
  "a=sctp-port:5000",
  "",
].join("\r\n");
/** An x264-generated main-profile SPS for 1024x768, its PPS, and an IDR slice header. */
const SPS = Buffer.from("674d401feca020030d8088000003000800000300f078c18cb0", "hex");
const PPS = Buffer.from("68ee3c80", "hex");
const IDR = Buffer.from("6588840021", "hex");

function setup() {
  const sig = new FakeSignaling();
  const native: FakeNativePeer[] = [];
  const session = new RtcSession({
    signalingMode: "call",
    authToken: "T",
    gtoken: "G",
    stationSn: "T8000P0000000002",
    adminUserId: "a",
    shard: "eu-pr",
    country: "IT",
    createSignaling: () => sig as unknown as RtcSignalingClient,
    peer: {
      iceTransportPolicy: "all",
      mediaTrack: true,
      createPeer: (_name: string, _config: RtcConfig) => {
        const pc = new FakeNativePeer();
        native.push(pc);
        return pc as unknown as PeerConnection;
      },
    },
  });
  const stream = new RtcCallLiveStream(session);
  const frames: LiveVideoFrame[] = [];
  const errors: Error[] = [];
  stream.on("video", (f) => frames.push(f));
  stream.on("error", (e) => errors.push(e));
  return { sig, native, session, stream, frames, errors };
}

describe("RtcCallLiveStream", () => {
  it("places the call, answers the doorbell's offer and emits its video track as frames", async () => {
    const s = setup();
    s.stream.start();
    await vi.waitFor(() => expect(s.sig.connect).toHaveBeenCalled());
    s.sig.doorbell({ action: 1, code: 200 });
    await vi.waitFor(() => expect(s.sig.sendCall).toHaveBeenCalledOnce());

    s.sig.doorbell({
      action: 3,
      dataType: "call",
      data: { status: 100, turn: { turn_addr: "203.0.113.30", turn_port: 3478, turn_user: "u", turn_password: "p" } },
    });
    s.sig.doorbell({ action: 3, dataType: "call", data: { status: 200 } });
    s.sig.doorbell({ action: 3, dataType: "info", data: { format: "SDP", value: OFFER } });
    s.sig.doorbell({
      action: 3,
      dataType: "info",
      data: { format: "CANDIDATE", value: "candidate:1 1 udp 1 192.0.2.10 1 typ host" },
    });

    await vi.waitFor(() => expect(s.sig.sendInfoSdp).toHaveBeenCalledExactlyOnceWith(ANSWER));
    expect(s.sig.sendAck).toHaveBeenCalledOnce();
    const pc = s.native[0]!;
    expect(pc.remote).toContain("a=group:BUNDLE 0 1\r\n");
    expect(pc.remote).toContain("m=application 0 UDP/DTLS/SCTP webrtc-datachannel");
    expect(pc.remote).toContain("a=setup:passive");
    expect(pc.channels).toBe(0);
    await vi.waitFor(() => expect(pc.candidates).toEqual([["candidate:1 1 udp 1 192.0.2.10 1 typ host", "0"]]));

    pc.state("connected");

    pc.tracks.get("0")!.fire(rtp(1, [0x65, 1], true, 111));
    pc.tracks.get("1")!.fire(rtp(1, SPS));
    pc.tracks.get("1")!.fire(rtp(2, PPS));
    pc.tracks.get("1")!.fire(rtp(3, IDR, true));
    expect(s.frames).toHaveLength(1);
    expect(s.frames[0]).toMatchObject({
      codec: "h264",
      keyframe: true,
      width: 0,
      height: 0,
      sourceTimestamp: 9000,
    });
    expect(s.frames[0]!.data).toEqual(
      Buffer.concat([Buffer.from([0, 0, 0, 1]), SPS, Buffer.from([0, 0, 0, 1]), PPS, Buffer.from([0, 0, 0, 1]), IDR]),
    );

    s.stream.stop();
    expect(s.sig.sendHangup).toHaveBeenCalledOnce();
    expect(pc.closed).toBe(true);
    expect(s.errors).toEqual([]);
  });

  it("fails the stream when the peer fails before it connects", async () => {
    const s = setup();
    s.stream.start();
    await vi.waitFor(() => expect(s.sig.connect).toHaveBeenCalled());
    s.sig.doorbell({ action: 1, code: 200 });
    s.sig.doorbell({
      action: 3,
      dataType: "call",
      data: { status: 100, turn: { turn_addr: "203.0.113.30", turn_port: 3478, turn_user: "u", turn_password: "p" } },
    });
    await vi.waitFor(() => expect(s.native).toHaveLength(1));
    s.native[0]!.state("failed");
    expect(s.errors.map((e) => e.message)).toEqual(["rtc call: session closed"]);
  });
});
