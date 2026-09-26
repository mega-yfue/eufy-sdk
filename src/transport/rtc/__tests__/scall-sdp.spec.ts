import { describe, expect, it } from "vitest";
import {
  ANKER_MAX_MESSAGE_SIZE,
  HUB_SDP_MID,
  iceCandidateType,
  keepHostCandidates,
  pinMaxMessageSize,
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
    "1 1 udp 2130706431 192.168.178.142 47470 typ host",
    "2 1 udp 1694498815 93.48.234.159 47470 typ srflx raddr 192.168.178.142 rport 47470",
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
  it("names the candidate type and keeps only host lines", () => {
    expect(iceCandidateType(HUB_JSON.candidate[0]!)).toBe("host");
    expect(iceCandidateType(HUB_JSON.candidate[1]!)).toBe("srflx");
    expect(iceCandidateType("garbage")).toBe("unknown");
    const sdp = scallJsonToSdp(HUB_JSON);
    const hostOnly = keepHostCandidates(sdp);
    expect(hostOnly).toContain("typ host");
    expect(hostOnly).not.toContain("typ srflx");
    expect(hostOnly.endsWith("\r\n")).toBe(true);
  });

  it("pins the max message size to the hub's", () => {
    expect(pinMaxMessageSize("a=max-message-size:65536\r\n")).toBe(`a=max-message-size:${ANKER_MAX_MESSAGE_SIZE}\r\n`);
  });
});

describe("toWireCandidate", () => {
  it("carries the attribute's value, the way the hub sends its own", () => {
    // libdatachannel hands out the SDP line; the portal protocol carries what follows `a=`.
    expect(toWireCandidate("a=candidate:2 1 UDP 2114977535 192.168.178.162 54012 typ host")).toBe(
      "candidate:2 1 UDP 2114977535 192.168.178.162 54012 typ host",
    );
    // Already in wire form, or an end-of-candidates marker: unchanged.
    expect(toWireCandidate("candidate:1 1 udp 2122317823 192.168.178.142 47336 typ host")).toBe(
      "candidate:1 1 udp 2122317823 192.168.178.142 47336 typ host",
    );
    expect(toWireCandidate("")).toBe("");
  });
});
