/**
 * WebRTC media receiver for eufy cameras — the **peer + media** half, decoupled from signaling.
 *
 * NOTE: HomeBase + attached cameras stream over **ThroughTek PPCS, not WebRTC** — for those, use
 * `LiveStream`/`startLiveStream()`, not this module. This receiver
 * is for **WebRTC-class devices** (newer NVR / HomeBase-3 / S-series / standalone, non-empty
 * `webrtc_sdk_version`), which deliver standard **WebRTC** (DTLS-SRTP): H.264 (some models H.265) +
 * Opus. Pair it with the `leo_rtc` signaling (`protocol.ts`/`crypto.ts`/`obfuscate.ts`). You feed it
 * SDP + ICE from whatever signaling layer you use, it
 * terminates DTLS-SRTP, depacketizes the inbound RTP, and renders the stream to a **playable file**
 * (MP4/MKV via a spawned `ffmpeg`) — or, if ffmpeg is missing, to a raw Annex-B `.h264` / `.opus`
 * stream the caller can play.
 *
 * The camera typically answers (`a=setup:actpass`), so the supported flow is **app-as-offerer**:
 * `createOffer()` → send to camera → `setRemoteDescription(answer)`; trickle ICE both ways via
 * `addRemoteCandidate()` and the `onLocalCandidate` callback.
 *
 * Built on **werift** (pure-TS WebRTC for Node). werift's depacketizer covers H.264/Opus natively;
 * H.265 lacks a built-in depacketizer, so we do a minimal RFC 7798 (HEVC) depacketization here.
 */
import { type ChildProcess } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
// werift is imported TYPE-ONLY here (fully erased from the JS) and loaded LAZILY at runtime via
// {@link loadWerift}. Nothing in this module's public surface (only the engine-free
// `createWebRtcPeer` factory + plain option/codec types are exported) references a werift value or
// type, so the engine never appears in the emitted `.d.ts` and a HomeBase/PPCS-only host never pays
// its ~620ms import cost. CI greps `dist/**/*.d.ts` to keep it that way.
import type { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack, RtpPacket } from "werift";
import type { WebRTCPeerHandle, WebRTCIceCandidate, WebRTCSessionDescription } from "../../core/contracts.js";
import { ffmpegAvailable, spawnFfmpeg, type FfmpegLevel } from "../ffmpeg.js";
import type { Logger } from "../../core/logger.js";

/** The werift module shape, loaded on demand. */
type Werift = typeof import("werift");
let weriftPromise: Promise<Werift> | undefined;

/** Memoized lazy import of the WebRTC engine — the ONLY runtime reference to werift. */
function loadWerift(): Promise<Werift> {
  return (weriftPromise ??= import("werift"));
}

/**
 * Construct a WebRTC peer, lazy-loading the engine on first use. This is the ONLY public door to the
 * WebRTC media path — it returns the engine-free {@link WebRTCPeerHandle} so the concrete peer (and
 * werift's type surface) stays internal.
 */
export async function createWebRtcPeer(opts: WebRTCPeerOptions = {}): Promise<WebRTCPeerHandle> {
  const werift = await loadWerift();
  return new WebRTCPeer(werift, opts);
}

/** Codec payload-type assignments. Defaults match what the eufy app advertises in its SDP offer. */
export interface CodecConfig {
  /** H.264 payload type (eufy: 99). */
  h264Pt: number;
  /** H.265/HEVC payload type (eufy: 97), or undefined to not offer H.265. */
  h265Pt?: number;
  /** Opus payload type (eufy: 111). */
  opusPt: number;
  /** H.264 `profile-level-id` fmtp (eufy: 42e01f = constrained-baseline 3.1). */
  h264ProfileLevelId: string;
}

/** Default codec set, byte-matched to the eufy v6 app's WebRTC offer. */
export const EUFY_CODECS: CodecConfig = {
  h264Pt: 99,
  h265Pt: 97,
  opusPt: 111,
  h264ProfileLevelId: "42e01f",
};

export interface WebRTCPeerOptions {
  /**
   * STUN/TURN servers. eufy on a LAN is usually direct via host candidates, so this is optional;
   * pass servers delivered by the signaling layer (TRYING/ANSWER) when the camera is remote.
   */
  iceServers?: { urls: string; username?: string; credential?: string }[];
  /** Codec / payload-type configuration. Defaults to {@link EUFY_CODECS}. */
  codecs?: Partial<CodecConfig>;
  /**
   * Output target. If a `path` is given, media is written there:
   *   - `.mp4` / `.mkv` → muxed via a spawned `ffmpeg` (falls back to raw if ffmpeg is absent).
   *   - `.h264` / `.265` / `.opus` → raw elementary stream, no ffmpeg needed.
   * If omitted, no file is written: {@link WebRTCPeerHandle} carries no track hook — a track's engine
   * type is werift's, which the handle exists to keep out of the public surface — so inbound media is
   * received and discarded. Give a path to keep it.
   */
  outputPath?: string;
  /** Force the raw-file path even if ffmpeg is present (useful for debugging). */
  forceRaw?: boolean;
  /** Include loopback/host addresses in ICE gathering (needed for two-peer localhost tests). */
  iceAdditionalHostAddresses?: string[];
  /** Diagnostics sink. Omit for silence; ffmpeg stderr is forwarded here at `[ffmpeg]` debug level. */
  logger?: Logger;
  /** ffmpeg's own `-loglevel` for the container mux. Default `"error"`; raise to diagnose the mux. */
  ffmpegLogLevel?: FfmpegLevel;
  /**
   * The ffmpeg executable to mux the container with. Default: the bare name, looked up on `PATH`. Both
   * the availability check that selects the mux and the mux itself resolve this one value, so a host
   * that ships its own build gets a container rather than a silent fall back to a raw stream.
   */
  ffmpegPath?: string;
}

type TrackKind = "video" | "audio";

/** Identifies the elementary codec of an inbound track for depacketization/muxing. */
type MediaCodec = "h264" | "h265" | "opus" | "unknown";

/**
 * Sinks one inbound media track: depacketizes its RTP into elementary frames and either pipes them
 * into a shared `ffmpeg` mux or writes a raw elementary stream. One per inbound track.
 */
class TrackSink {
  /** Packets accumulated for the current frame (same RTP timestamp), flushed on the marker bit. */
  private frameBuffer: RtpPacket[] = [];
  private frameTimestamp?: number;

  constructor(
    readonly kind: TrackKind,
    readonly codec: MediaCodec,
    private readonly write: (data: Buffer, isKeyframe: boolean) => void,
    /** werift's depacketizer, injected from the lazily-loaded engine. */
    private readonly dePacketizeRtpPackets: Werift["dePacketizeRtpPackets"],
  ) {}

  /** Feed one inbound RTP packet; emits depacketized elementary frames via the writer. */
  push(packet: RtpPacket): void {
    if (this.codec === "h265") {
      const frame = depacketizeH265(packet);
      if (frame) this.write(frame.data, frame.isKeyframe);
      return;
    }
    const weriftCodec = this.codec === "h264" ? "MPEG4/ISO/AVC" : this.codec === "opus" ? "OPUS" : undefined;
    if (!weriftCodec) return;

    // Opus: one packet == one frame, depacketize immediately.
    if (this.codec === "opus") {
      const out = this.dePacketizeRtpPackets(weriftCodec, [packet]);
      if (out.data.length > 0) this.write(out.data, out.isKeyframe);
      return;
    }

    // H.264: accumulate all RTP packets of one access unit (same timestamp), then depacketize the
    // whole group at once so FU-A fragments reassemble correctly. The marker bit ends the AU.
    if (this.frameTimestamp !== undefined && packet.header.timestamp !== this.frameTimestamp) {
      this.flush(weriftCodec);
    }
    this.frameTimestamp = packet.header.timestamp;
    this.frameBuffer.push(packet);
    if (packet.header.marker) this.flush(weriftCodec);
  }

  private flush(weriftCodec: "MPEG4/ISO/AVC" | "OPUS"): void {
    if (this.frameBuffer.length === 0) return;
    const packets = this.frameBuffer.sort((a, b) => seqDelta(a.header.sequenceNumber, b.header.sequenceNumber));
    const out = this.dePacketizeRtpPackets(weriftCodec, packets);
    if (out.data.length > 0) this.write(out.data, out.isKeyframe);
    this.frameBuffer = [];
    this.frameTimestamp = undefined;
  }
}

/** Signed 16-bit sequence-number delta for ordering RTP packets within a frame (handles wrap). */
function seqDelta(a: number, b: number): number {
  return ((a - b + 0x8000) & 0xffff) - 0x8000;
}

/**
 * A WebRTC peer that receives a eufy camera's media and renders it to a playable file. INTERNAL —
 * construct it via {@link createWebRtcPeer} (which lazy-loads the engine) and hold it as the
 * engine-free {@link WebRTCPeerHandle}; the concrete class is never exported.
 *
 * @example
 * ```ts
 * const peer = await createWebRtcPeer({ outputPath: "/tmp/live.mp4" });
 * peer.onLocalCandidate = (c) => signaling.send(c);
 * const offer = await peer.createOffer();
 * signaling.send(offer);                              // → camera
 * await peer.setRemoteDescription(answerSdp, "answer"); // ← camera (answer)
 * signaling.onCandidate((c) => peer.addRemoteCandidate(c));
 * // ... later
 * await peer.close();
 * ```
 */
class WebRTCPeer implements WebRTCPeerHandle {
  /** The underlying werift peer connection (internal — never exposed on the public handle). */
  private readonly pc: RTCPeerConnection;
  /** Called for each locally-gathered ICE candidate (trickle). Wire this to your signaling layer. */
  onLocalCandidate?: (candidate: WebRTCIceCandidate) => void;
  /** Called for each inbound media track once negotiated (internal file/muxer sink drives itself). */
  onTrack?: (track: MediaStreamTrack, kind: TrackKind, codec: MediaCodec) => void;
  /** Called when the peer-connection state changes. */
  onConnectionStateChange?: (state: string) => void;

  private readonly codecs: CodecConfig;
  private readonly opts: WebRTCPeerOptions;
  private readonly sinks: TrackSink[] = [];
  private ffmpeg?: ChildProcess;
  private rawStreams = new Map<TrackKind, WriteStream>();
  private closed = false;

  constructor(
    private readonly werift: Werift,
    opts: WebRTCPeerOptions = {},
  ) {
    this.opts = opts;
    this.codecs = { ...EUFY_CODECS, ...opts.codecs };

    const video: RTCRtpCodecParameters[] = [
      new werift.RTCRtpCodecParameters({
        mimeType: "video/H264",
        clockRate: 90000,
        payloadType: this.codecs.h264Pt,
        // packetization-mode=1 (non-interleaved FU-A) + the eufy profile-level-id.
        parameters: `level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=${this.codecs.h264ProfileLevelId}`,
        rtcpFeedback: [
          { type: "nack" },
          { type: "nack", parameter: "pli" },
          { type: "goog-remb" },
          { type: "transport-cc" },
        ],
      }),
    ];
    if (this.codecs.h265Pt !== undefined) {
      video.push(
        new werift.RTCRtpCodecParameters({
          mimeType: "video/H265",
          clockRate: 90000,
          payloadType: this.codecs.h265Pt,
          rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }, { type: "transport-cc" }],
        }),
      );
    }
    const audio: RTCRtpCodecParameters[] = [
      new werift.RTCRtpCodecParameters({
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
        payloadType: this.codecs.opusPt,
        parameters: "minptime=10;useinbandfec=1",
        rtcpFeedback: [{ type: "transport-cc" }],
      }),
    ];

    this.pc = new werift.RTCPeerConnection({
      codecs: { video, audio },
      iceServers: opts.iceServers ?? [],
      iceAdditionalHostAddresses: opts.iceAdditionalHostAddresses,
      // eufy advertises ice2 + trickle; werift trickles by default.
    });

    this.pc.onIceCandidate.subscribe((candidate) => {
      if (!candidate || !this.onLocalCandidate) return;
      this.onLocalCandidate({
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? undefined,
        sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
      });
    });

    this.pc.connectionStateChange.subscribe((state) => {
      this.onConnectionStateChange?.(state);
    });

    this.pc.onTrack.subscribe((track) => {
      this.handleInboundTrack(track);
    });
  }

  /**
   * Build the SDP offer for the app-as-offerer flow. Adds recv-only video + audio transceivers
   * (we only consume the camera's media), so the camera answers with `sendonly`.
   */
  async createOffer(): Promise<WebRTCSessionDescription> {
    this.pc.addTransceiver("video", { direction: "recvonly" });
    this.pc.addTransceiver("audio", { direction: "recvonly" });
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return { type: "offer", sdp: this.pc.localDescription!.sdp };
  }

  /**
   * Apply the remote description. Use after sending an offer (camera's answer), or first when the
   * camera is the offerer — in the latter case follow with {@link createAnswer}.
   */
  async setRemoteDescription(sdp: string, type: "offer" | "answer"): Promise<void> {
    await this.pc.setRemoteDescription({ type, sdp });
  }

  /** Build an SDP answer (camera-as-offerer flow). Call after `setRemoteDescription(offer, "offer")`. */
  async createAnswer(): Promise<WebRTCSessionDescription> {
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    return { type: "answer", sdp: this.pc.localDescription!.sdp };
  }

  /** Add a remote ICE candidate (trickle ICE) received from the signaling layer. */
  async addRemoteCandidate(candidate: WebRTCIceCandidate): Promise<void> {
    await this.pc.addIceCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
    });
  }

  /** Tear down the peer, flush and close the file/ffmpeg sink. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pc.close().catch(() => undefined);
    if (this.ffmpeg) {
      this.ffmpeg.stdin?.end();
      await new Promise<void>((resolve) => {
        this.ffmpeg!.once("close", () => resolve());
        // Don't hang forever if ffmpeg is wedged.
        setTimeout(resolve, 3000).unref?.();
      });
    }
    for (const s of this.rawStreams.values()) s.end();
  }

  // --- internals ---------------------------------------------------------

  private handleInboundTrack(track: MediaStreamTrack): void {
    const kind: TrackKind = track.kind === "audio" ? "audio" : "video";
    const codec = this.codecOf(track, kind);
    const sink = new TrackSink(kind, codec, this.makeWriter(kind, codec), this.werift.dePacketizeRtpPackets);
    this.sinks.push(sink);
    track.onReceiveRtp.subscribe((rtp) => sink.push(rtp));
    this.onTrack?.(track, kind, codec);
  }

  private codecOf(track: MediaStreamTrack, kind: TrackKind): MediaCodec {
    const mime = track.codec?.mimeType?.toLowerCase() ?? "";
    if (kind === "audio") return mime.includes("opus") ? "opus" : "unknown";
    if (mime.includes("h265") || mime.includes("hevc")) return "h265";
    if (mime.includes("h264") || mime.includes("avc")) return "h264";
    return "unknown";
  }

  /**
   * Returns a writer for a track's depacketized frames. Picks the ffmpeg mux when the output is a
   * container (.mp4/.mkv) and ffmpeg is present; otherwise writes a raw elementary stream.
   */
  private makeWriter(kind: TrackKind, codec: MediaCodec): (data: Buffer, isKeyframe: boolean) => void {
    const path = this.opts.outputPath;
    if (!path) return () => undefined;

    const isContainer = /\.(mp4|mkv|mov|webm)$/i.test(path);
    const useFfmpeg = isContainer && !this.opts.forceRaw && ffmpegAvailable(this.opts.ffmpegPath);

    if (useFfmpeg) {
      // Only video is muxed through ffmpeg here (single-input pipe); audio gets a raw sidecar so
      // nothing is silently dropped. (A full A/V mux would need two named pipes — out of scope.)
      if (kind === "video") {
        const ff = this.ensureFfmpeg(codec, path);
        return (data) => {
          if (ff.stdin && !ff.stdin.destroyed) ff.stdin.write(data);
        };
      }
      const ext = codec === "opus" ? "opus" : "audio";
      return this.rawWriter("audio", path.replace(/\.[^.]+$/, `.${ext}`));
    }

    // Raw elementary-stream fallback.
    const ext = codec === "h264" ? "h264" : codec === "h265" ? "265" : codec === "opus" ? "opus" : "bin";
    const rawPath = isContainer ? path.replace(/\.[^.]+$/, `.${kind === "audio" ? "opus" : ext}`) : path;
    return this.rawWriter(kind, rawPath);
  }

  private rawWriter(kind: TrackKind, path: string): (data: Buffer) => void {
    let stream = this.rawStreams.get(kind);
    if (!stream) {
      stream = createWriteStream(path);
      this.rawStreams.set(kind, stream);
    }
    return (data: Buffer) => {
      stream!.write(data);
    };
  }

  private ensureFfmpeg(codec: MediaCodec, outputPath: string): ChildProcess {
    if (this.ffmpeg) return this.ffmpeg;
    const inputFormat = codec === "h265" ? "hevc" : "h264";
    // Read an Annex-B elementary stream on stdin, copy the bitstream into the container (no re-encode).
    const args = ["-fflags", "+genpts", "-f", inputFormat, "-i", "pipe:0", "-c:v", "copy", "-y", outputPath];
    const ff = spawnFfmpeg(args, {
      logger: this.opts.logger,
      level: this.opts.ffmpegLogLevel,
      path: this.opts.ffmpegPath,
      stdio: ["pipe", "ignore", "pipe"],
    });
    ff.stdin?.on("error", () => undefined); // EPIPE if ffmpeg dies — swallow
    this.ffmpeg = ff;
    return ff;
  }
}

/**
 * Minimal RFC 7798 (HEVC/H.265 over RTP) depacketizer — werift has no built-in H.265 depacketizer.
 * Handles single-NAL packets and Fragmentation Units (FU); Aggregation Packets (AP) are passed
 * through as a best-effort single NAL. Emits one Annex-B NAL (`00 00 00 01` start code + NAL) at a
 * time. Stateless per packet for the common single-NAL case; FU reassembly is kept in module state.
 *
 * NB: this is best-effort for viewing; for production H.265 prefer a hardware/codec-aware muxer.
 */
const ANNEXB_START = Buffer.from([0x00, 0x00, 0x00, 0x01]);
let h265FuBuffer: Buffer | null = null;
let h265FuType = 0;

function depacketizeH265(packet: RtpPacket): { data: Buffer; isKeyframe: boolean } | undefined {
  const p = packet.payload;
  if (p.length < 2) return undefined;
  // HEVC NAL header: F(1) | Type(6) | LayerId(6) | TID(3) — type is bits 1..6 of the first byte.
  const nalType = (p[0] >> 1) & 0x3f;

  // 49 = Fragmentation Unit (FU).
  if (nalType === 49) {
    if (p.length < 3) return undefined;
    const fuHeader = p[2];
    const start = (fuHeader & 0x80) !== 0;
    const end = (fuHeader & 0x40) !== 0;
    const fuType = fuHeader & 0x3f;
    if (start) {
      h265FuType = fuType;
      // Reconstruct the NAL header from the FU's type, preserving layer/TID from the FU payload header.
      const nalHeader = Buffer.from([(p[0] & 0x81) | (fuType << 1), p[1]]);
      h265FuBuffer = Buffer.concat([nalHeader, p.subarray(3)]);
    } else if (h265FuBuffer) {
      h265FuBuffer = Buffer.concat([h265FuBuffer, p.subarray(3)]);
    }
    if (end && h265FuBuffer) {
      const data = Buffer.concat([ANNEXB_START, h265FuBuffer]);
      h265FuBuffer = null;
      return { data, isKeyframe: isH265Keyframe(h265FuType) };
    }
    return undefined;
  }

  // 48 = Aggregation Packet (AP): emit the contained NALs back-to-back, each with a start code.
  if (nalType === 48) {
    let off = 2;
    const nals: Buffer[] = [];
    let keyframe = false;
    while (off + 2 <= p.length) {
      const size = p.readUInt16BE(off);
      off += 2;
      if (off + size > p.length) break;
      const nal = p.subarray(off, off + size);
      off += size;
      if (nal.length >= 1) keyframe = keyframe || isH265Keyframe((nal[0] >> 1) & 0x3f);
      nals.push(ANNEXB_START, nal);
    }
    if (nals.length === 0) return undefined;
    return { data: Buffer.concat(nals), isKeyframe: keyframe };
  }

  // Single NAL unit packet.
  return { data: Buffer.concat([ANNEXB_START, p]), isKeyframe: isH265Keyframe(nalType) };
}

/** HEVC IRAP picture NAL types (BLA/IDR/CRA = 16..23) mark a keyframe. */
function isH265Keyframe(nalType: number): boolean {
  return nalType >= 16 && nalType <= 23;
}
