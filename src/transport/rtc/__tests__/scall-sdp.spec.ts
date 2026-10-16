import { describe, expect, it } from "vitest";
import {
  ANKER_MAX_MESSAGE_SIZE,
  HUB_SDP_MID,
  iceCandidateType,
  midOf,
  pinMaxMessageSize,
  rejectDataSection,
  scallJsonToSdp,
  sdpToScallJson,
  toWireCandidate,
} from "../scall-sdp.js";

const HUB_JSON = {
  setup: "actpass",
  ice: {
    ufrag: "abcd",
    pwd: "p4ssw0rdp4ssw0rdp4ssw0rd",
    fingerprint_type: "sha-256",
    fingerprint: "0a1b2c3d",
  },
  candidate: [
    "1 1 udp 2130706431 192.0.2.10 47470 typ host",
    "2 1 udp 1694498815 203.0.113.10 47470 typ srflx raddr 192.0.2.10 rport 47470",
  ],
};

describe("scall JSON → SDP", () => {
  it("rebuilds the one-m-line SCTP offer the portal template describes", () => {
    const sdp = scallJsonToSdp(HUB_JSON, () => 1234);
    expect(sdp.startsWith("v=0\r\no=- 1234 1 IN IP4 127.0.0.1\r\ns=Anker Webrtc Stream\r\n")).toBe(true);
    expect(sdp).toContain(`a=group:BUNDLE ${HUB_SDP_MID}\r\n`);
    expect(sdp).toContain("m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n");
    expect(sdp).toContain(`a=mid:${HUB_SDP_MID}\r\n`);
    expect(sdp).toContain("a=ice-ufrag:abcd\r\n");
    expect(sdp).toContain("a=ice-pwd:p4ssw0rdp4ssw0rdp4ssw0rd\r\n");
    expect(sdp).toContain("a=fingerprint:sha-256 0a:1b:2c:3d\r\n");
    expect(sdp).toContain("a=setup:actpass\r\n");
    expect(sdp).toContain("a=sctp-port:5000\r\n");
    expect(sdp).toContain(`a=max-message-size:${ANKER_MAX_MESSAGE_SIZE}\r\n`);
    expect(sdp).toContain(`a=candidate:${HUB_JSON.candidate[0]}\r\n`);
    expect(sdp.endsWith("\r\n")).toBe(true);
  });

  it("defaults setup to actpass and fingerprint type to sha-256", () => {
    const sdp = scallJsonToSdp({ ice: { fingerprint: "ff" } });
    expect(sdp).toContain("a=fingerprint:sha-256 ff\r\n");
    expect(sdp).toContain("a=setup:actpass\r\n");
    expect(sdp).not.toContain("a=ice-ufrag");
  });
});

describe("SDP → scall JSON", () => {
  it("round-trips the hub JSON through SDP, colons stripped back out of the fingerprint", () => {
    const back = sdpToScallJson(scallJsonToSdp(HUB_JSON));
    expect(back.ice).toEqual(HUB_JSON.ice);
    expect(back.candidate).toEqual(HUB_JSON.candidate);
    // actpass is not a role: the hub wants a concrete one, so it is omitted.
    expect(back.setup).toBeUndefined();
  });

  it("keeps a concrete DTLS role", () => {
    expect(sdpToScallJson("a=setup:passive\r\na=ice-ufrag:x\r\n").setup).toBe("passive");
  });
});

describe("candidate helpers", () => {
  it("names the candidate type", () => {
    expect(iceCandidateType(HUB_JSON.candidate[0]!)).toBe("host");
    expect(iceCandidateType(HUB_JSON.candidate[1]!)).toBe("srflx");
    expect(iceCandidateType("garbage")).toBe("unknown");
  });

  it("pins the max message size to the hub's", () => {
    expect(pinMaxMessageSize("a=max-message-size:65536\r\n")).toBe(`a=max-message-size:${ANKER_MAX_MESSAGE_SIZE}\r\n`);
  });
});

describe("toWireCandidate", () => {
  it("carries the attribute's value, the way the hub sends its own", () => {
    // libdatachannel hands out the SDP line; the portal protocol carries what follows `a=`.
    expect(toWireCandidate("a=candidate:2 1 UDP 2114977535 192.0.2.20 54012 typ host")).toBe(
      "candidate:2 1 UDP 2114977535 192.0.2.20 54012 typ host",
    );
    // Already in wire form, or an end-of-candidates marker: unchanged.
    expect(toWireCandidate("candidate:1 1 udp 2122317823 192.0.2.10 47336 typ host")).toBe(
      "candidate:1 1 udp 2122317823 192.0.2.10 47336 typ host",
    );
    expect(toWireCandidate("")).toBe("");
  });
});

describe("media offer helpers", () => {
  const offer = [
    "v=0",
    "a=group:BUNDLE 0 1 2",
    "m=audio 9 UDP/TLS/RTP/SAVPF 111",
    "a=mid:0",
    "m=video 9 UDP/TLS/RTP/SAVPF 99",
    "a=mid:1",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "a=mid:2",
    "a=sctp-port:5000",
    "",
  ].join("\r\n");

  it("finds the mid of each kind of m-section", () => {
    expect(midOf(offer, "audio")).toBe("0");
    expect(midOf(offer, "video")).toBe("1");
    expect(midOf(offer, "application")).toBe("2");
    expect(midOf("v=0\r\n", "video")).toBeUndefined();
  });

  it("rejects the data channel and drops it from BUNDLE, leaving the media untouched", () => {
    const out = rejectDataSection(offer).split("\r\n");
    expect(out).toContain("a=group:BUNDLE 0 1");
    expect(out).toContain("m=application 0 UDP/DTLS/SCTP webrtc-datachannel");
    expect(out).toContain("m=video 9 UDP/TLS/RTP/SAVPF 99");
    expect(out).toContain("m=audio 9 UDP/TLS/RTP/SAVPF 111");
  });

  it("leaves an offer without a data channel as it is", () => {
    const media = "v=0\r\na=group:BUNDLE 0\r\nm=video 9 UDP/TLS/RTP/SAVPF 99\r\na=mid:0\r\n";
    expect(rejectDataSection(media)).toBe(media);
  });
});
