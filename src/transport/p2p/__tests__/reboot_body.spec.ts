import { vi } from "vitest";
import { buildDirectBinaryBody } from "../write-commands.js";
import { connectedSession, onFakeTime, routerWithSession, ACCOUNT_ID, STATION_SN } from "./session-fixtures.js";
import { P2P_ENVELOPE } from "../envelope.js";

/**
 * The RESTART_HUB (reboot) frame body, pinned against the real capture.
 *
 * Ground truth: a capture of the app's own "Restart" (2026-08-03) showed the station a
 * level-2 frame on channel 255, outer cmd 1034, whose body was `[u32 value=0][account_id ASCII,
 * zero-padded]` — and it rebooted the hub. `EufyMega.reboot` sends exactly this via the router's
 * station-scalar path (`buildDirectBinaryBody(0, accountId)` → `sendRawLevel2Bytes(..., 255, 1034,
 * 8)`), so this locks the body shape and the id.
 */
describe("RESTART_HUB reboot frame", () => {
  // Synthetic: the assertions are about the body SHAPE — 132 bytes, the field offset, the zero
  // padding — so only the 40-character length is load-bearing, never the value.
  const ACCOUNT = "0".repeat(40);

  it("uses the station-scalar (no-channel) body shape", () => {
    expect(P2P_ENVELOPE.RESTART_HUB).toBe(1034);

    const body = buildDirectBinaryBody(0, ACCOUNT); // value 0 — exactly what the captured frame carried
    // 4-byte value + 128-byte account field = the 132-byte station-scalar body (hub alarm volume shares it).
    expect(body.length).toBe(132);
    expect(body.readUInt32LE(0)).toBe(0);
    expect(body.subarray(4, 4 + ACCOUNT.length).toString("ascii")).toBe(ACCOUNT);
    // account field is zero-padded, not truncated or channel-prefixed.
    expect(body.subarray(4 + ACCOUNT.length).every((b) => b === 0)).toBe(true);
  });

  it("is NOT the channel-prefixed direct-binary shape (that's the device-channel controls)", () => {
    // A device control (e.g. PIR 1011) passes an explicit channel → an 8-byte prefix; the hub restart
    // does not. Guarding the distinction that the wrong shape would silently pass on the wire.
    const withChannel = buildDirectBinaryBody(0, ACCOUNT, 0);
    expect(withChannel.length).toBe(136);
    expect(buildDirectBinaryBody(0, ACCOUNT).length).toBe(132);
  });
});

/**
 * A keyless session — a standalone camera, which never negotiates a level-2 key — gets the captured body
 * sealed level-1, since a level-2 frame cannot be built without the key.
 */
describe("RESTART_HUB on a keyless session", () => {
  it("sends the captured body sealed level-1 on channel 255, replayed", async () => {
    const session = Object.assign(connectedSession(false), {
      sendRawLevel2Bytes: vi.fn(() => true),
      sendRawLevel1Bytes: vi.fn(() => true),
    });
    await onFakeTime(() => routerWithSession(session).rebootStation(STATION_SN));
    expect(session.sendRawLevel2Bytes).not.toHaveBeenCalled();
    expect(session.sendRawLevel1Bytes).toHaveBeenCalledWith(
      buildDirectBinaryBody(0, ACCOUNT_ID),
      255,
      P2P_ENVELOPE.RESTART_HUB,
    );
    expect(session.sendRawLevel1Bytes.mock.calls.length).toBeGreaterThan(1);
  });
});
