# transport/rtc — the HomeBase S1 Pro (T9000) command channel

**Owns:** the WebRTC transport a T9000 speaks. The S1 Pro does not do PPCS with anyone — not the app,
not this SDK (mega-yfue/eufy-sdk#221: zero `0xf1xx` frames in a capture of the official app against
one, ICMP port-unreachable on `:32108`, and a cloud lookup pool that never answers). Its control plane
is a WebRTC data channel, signalled through the same WebSocket the security.eufy.com web client uses.

**Sequence** (`session.ts`):

```
GET  /v1/smart/nvr/ws/sign                       mega token → sign blob            signaling.ts
WSS  /v1/rtc/ws/join?reqtype=nvr                 subprotocol ["v1", base64url(JSON)]
     action 1 (auth)  →  action 3 scall          the hub grants: {status:100, turn}
     ← info {sdp}     the hub's offer as scall JSON      scall-sdp.ts
     → info {sdp}     our answer                         peer.ts (node-datachannel, answerer)
     ↔ info {candidate}   trickle ICE, host-only on a LAN
DTLS → SCTP → data channels: WebrtcDataChannel (commands), notify, …
     portal packet  "XZYH" + 16-byte header + JSON      portal-packet.ts
     PTCS framing   28-byte header, fixed 828-byte packets ptcs-framer.ts
```

**Region is two things.** The sign request carries the account _country_ (`Web-Country: IT`); the
socket payload carries the _cluster_ (`region: "EU"`). Both derive from the mega shard: `eu-pr` →
`security-smart-eu.eufylife.com` + `EU`, `us-pr` → `security-smart.eufylife.com` + `US`. Mixing them
authenticates the sign and then fails the socket.

**ICE is host-only by default.** The hub also offers TURN and a server-reflexive candidate; both pass
STUN checks but neither completes DTLS on current firmware, so a nomination race loses ~31 s. Host
candidates only settles on the direct LAN pair, which is what the phone does on the same network.

**PTCS is clean-room.** The portal wraps every packet in a packetiser it ships as WebAssembly
(`libsctp`); `ptcs-framer.ts` is written from that module's observed input/output and reproduces its
packets byte for byte (`__tests__/fixtures/ptcs-vectors.json`). Nothing of Anker's module is here.

**Evidence** for the whole path: genomez/eufy-security-client `T9000-testing` (MIT), which runs this
exact exchange in production on US and FR hubs — guard mode, camera privacy, floodlights over the
command channel. What no one has driven yet is the `video` / `idr` channels: live view stays open.

**Seams.** `fetch`, the `WebSocket` constructor, the native peer and the framer are all injectable,
so every spec here runs offline. The only native dependency is `node-datachannel` (libdatachannel),
which ships musl and glibc prebuilds for the platforms the bridge image runs on.

**Not here yet:** the command router branch that turns a `Command` into a portal packet and hands it
to an `RtcSession` for a `STATION_9000`, and the inbound bridge that lifts notify frames into
`P2PFrame`s. Those follow once the exchange is confirmed live on this SDK's login.
