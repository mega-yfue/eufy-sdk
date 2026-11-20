import { describe, expect, it, vi } from "vitest";
import { connectedSession, routerWithSession, ACCOUNT_ID, DEVICE_SN, type FakeP2PSession } from "./session-fixtures.js";

const CMD_NAS_SWITCH = 1145;
const CMD_NAS_TEST = 1146;

interface FakeSession extends FakeP2PSession {
  sendIntStringCommand: ReturnType<typeof vi.fn>;
  sendRawLevel2Bytes: ReturnType<typeof vi.fn>;
}

/** A fake station session with both send wires spied, keyed (level-2) or not (standalone level-1). */
function session(hasLevel2Key: boolean): FakeSession {
  const s = connectedSession(hasLevel2Key) as FakeSession;
  s.sendIntStringCommand = vi.fn((commandId: number, _v: number, _vs: number, _a: string, channel: number) =>
    queueMicrotask(() => s.emit("commandResult", { code: 0, channel, commandId })),
  );
  s.sendRawLevel2Bytes = vi.fn(() => true);
  return s;
}

describe("P2PCommandRouter.readReportedRtspUrl", () => {
  it("provokes the publish switch and the livestream, then returns the pushed URL", async () => {
    vi.useFakeTimers();
    try {
      const s = session(false); // a standalone camera negotiates no level-2 key → the int-string wire
      const router = routerWithSession(s);
      const read = router.readReportedRtspUrl(DEVICE_SN);
      await vi.advanceTimersByTimeAsync(500); // both provokes have gone out, the test after the switch's answer

      expect(s.sendIntStringCommand).toHaveBeenCalledWith(CMD_NAS_SWITCH, 1, 1, ACCOUNT_ID, 1);
      expect(s.sendIntStringCommand).toHaveBeenCalledWith(CMD_NAS_TEST, 1, 1, ACCOUNT_ID, 1);

      s.emit("rtspUrl", { channel: 1, url: "rtsp://u:p@host/live0" });
      await expect(read).resolves.toBe("rtsp://u:p@host/live0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes the provoke through the session level decision — a keyed station uses its level-2 wire", async () => {
    // The fix for the HomeBase-attached read that never answered: a keyed session publishes 1145 on
    // its level-2 seal, so the provoke must ride that wire, not a pinned level-1 int-string frame.
    vi.useFakeTimers();
    try {
      const s = session(true); // holds a level-2 key
      const router = routerWithSession(s);
      const read = router.readReportedRtspUrl(DEVICE_SN);
      await vi.advanceTimersByTimeAsync(500);

      expect(s.sendRawLevel2Bytes).toHaveBeenCalled();
      expect(s.sendIntStringCommand, "a keyed station must not get the level-1 form").not.toHaveBeenCalled();

      s.emit("rtspUrl", { channel: 1, url: "rtsp://u:p@host/live0" });
      await expect(read).resolves.toBe("rtsp://u:p@host/live0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a push for another channel on the multiplexed station session", async () => {
    vi.useFakeTimers();
    try {
      const s = session(false);
      const router = routerWithSession(s);
      const read = router.readReportedRtspUrl(DEVICE_SN);
      await vi.advanceTimersByTimeAsync(0); // arm the single listener

      // One persistent listener, so a wrong-channel push and the right one can land in the same turn —
      // no re-arm gap between them to lose the second.
      s.emit("rtspUrl", { channel: 2, url: "rtsp://wrong-camera/live0" });
      s.emit("rtspUrl", { channel: 1, url: "rtsp://right-camera/live0" });
      await expect(read).resolves.toBe("rtsp://right-camera/live0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves undefined and leaves no listener when nothing answers before the deadline", async () => {
    vi.useFakeTimers();
    try {
      const s = session(false);
      const router = routerWithSession(s);
      const read = router.readReportedRtspUrl(DEVICE_SN);
      await vi.advanceTimersByTimeAsync(60_000); // past the read deadline

      await expect(read).resolves.toBeUndefined();
      expect(s.listenerCount("rtspUrl"), "a timed-out read must not leak a listener on the session").toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not provoke a device that has no account id", async () => {
    const s = session(false);
    const router = routerWithSession(s, { accountId: "" });

    await expect(router.readReportedRtspUrl(DEVICE_SN)).resolves.toBeUndefined();
    expect(s.sendIntStringCommand).not.toHaveBeenCalled();
    expect(s.sendRawLevel2Bytes).not.toHaveBeenCalled();
    expect(s.listenerCount("rtspUrl")).toBe(0);
  });

  it("resolves undefined when the station session cannot be resolved", async () => {
    const s = session(false);
    const router = routerWithSession(s, { register: false }); // nothing registered → no session to open

    await expect(router.readReportedRtspUrl(DEVICE_SN)).resolves.toBeUndefined();
    expect(s.sendIntStringCommand).not.toHaveBeenCalled();
  });
});
