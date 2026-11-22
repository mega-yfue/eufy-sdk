import { createDecipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { MAGIC_WORD } from "../codec.js";
import { withGcmKey } from "./session-fixtures.js";

/**
 * The live stop frame follows the session topology, as the start does.
 *
 * Captured from the app closing an own-session camera's live view (2026-10-04): after each close it sends a
 * direct `1004` at signCode 8 whose sealed body is 36 bytes, the size of a 4-byte plaintext. Measured on the
 * same camera, a direct 1004 carrying the channel as a `uint32` ended the stream within a second, while the
 * `1350`-wrapped `{cmd:1004}` left it streaming for as long as it was watched.
 */
const KEY32 = Buffer.alloc(32, 7);

function session(): { session: P2PSession; sent: Buffer[] } {
  const built = new P2PSession({ stationSn: "T8000P0000000000", p2pDid: "XXXXXXX-000000-XXXXX" });
  const sent: Buffer[] = [];
  const internals = built as unknown as { socket: { send: (buf: Buffer) => void }; connectAddress: object };
  internals.socket = { send: vi.fn((buf: Buffer) => void sent.push(Buffer.from(buf))) };
  internals.connectAddress = { host: "<cam-lan-ip>", port: 32100 };
  withGcmKey(built, KEY32);
  return { session: built, sent };
}

/** The frame from its `XZYH` magic onward. */
function frameOf(datagram: Buffer): Buffer {
  return datagram.subarray(datagram.indexOf(Buffer.from(MAGIC_WORD)));
}

/** Open `tag(16) ‖ nonce(12) ‖ sub-header(4) ‖ ciphertext` by literal offsets, not the session's own cipher. */
function openLevel2(sealed: Buffer): Buffer {
  const d = createDecipheriv("aes-256-gcm", KEY32, sealed.subarray(16, 28));
  d.setAAD(Buffer.from("eufy security"));
  d.setAuthTag(sealed.subarray(0, 16));
  return Buffer.concat([d.update(sealed.subarray(32)), d.final()]);
}

describe("live stop", () => {
  it("sends an own-session camera the direct 1004 whose whole plaintext is the channel as a uint32", () => {
    const { session: s, sent } = session();
    s.stopLiveMedia(0, "account", false);

    expect(sent).toHaveLength(1);
    const f = frameOf(sent[0]);
    expect(f.readUInt16LE(4)).toBe(1004);
    expect(f[13]).toBe(8);
    const sealed = f.subarray(16);
    expect(sealed.length).toBe(36);
    expect(openLevel2(sealed)).toEqual(Buffer.from([0x00, 0x00, 0x00, 0x00]));
  });

  it("keeps the 1350-wrapped {cmd:1004} for a HomeBase-attached camera", () => {
    const { session: s, sent } = session();
    s.stopLiveMedia(0, "account", true);

    const f = frameOf(sent[0]);
    expect(f.readUInt16LE(4)).toBe(1350);
    expect(JSON.parse(openLevel2(f.subarray(16)).toString())).toMatchObject({ cmd: 1004, mChannel: 0 });
  });
});
