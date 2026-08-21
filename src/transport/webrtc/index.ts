/**
 * eufy v6 WebRTC video — signaling protocol primitives + device params.
 *
 * SCOPE: this module is for **WebRTC-class devices only** (newer NVR / HomeBase-3 / S-series /
 * standalone, non-empty `webrtc_sdk_version`). HomeBase + attached cameras stream over **ThroughTek
 * PPCS, not WebRTC** — use `LiveStream`/`startLiveStream()` for those. This module implements the
 * eufy "leo_rtc" **signaling** wire format (separate UDP/TCP socket, `XZYH` framing, AES-128-GCM
 * `TAG‖IV‖CT` bodies, NewRTCProtocol obfuscation envelope); the media itself is terminated by an
 * off-the-shelf WebRTC stack (werift) — see `peer.ts` (`WebRTCPeer`).
 *
 * Status: the signaling does NOT ride PPCS — it uses a separate UDP/TCP socket to `signaling_servers`
 * (in the device-list record, `params.ts`). These are
 * implemented & tested against the disassembly: XZYH frame codec (`protocol.ts`), AES-128-GCM body
 * `TAG‖IV‖CT` (`crypto.ts`), the NewRTCProtocol obfuscation envelope (`obfuscate.ts`), and the
 * `WebRTCPeer` DTLS-SRTP media terminator (`peer.ts`). The ONE remaining gap is a single live-view
 * capture: the cloud webrtc-token REST call (returns `aes_key`/`contact_id`/`addr`/`rtc_token`),
 * the signaling transport+port, the 4-byte GCM reserved slot, and the LOGIN body schema.
 */
export * from "./protocol.js";
export * from "./crypto.js";
export * from "./obfuscate.js";
export * from "./params.js";
// Only the engine-free door + plain option/codec types — NOT the concrete `WebRTCPeer` (which carries
// werift's type surface). `createWebRtcPeer()` returns the core `WebRTCPeerHandle`, and the engine is
// lazy-loaded on first construction, so importing this barrel does not pull werift into memory.
export { createWebRtcPeer, EUFY_CODECS, type CodecConfig, type WebRTCPeerOptions } from "./peer.js";
