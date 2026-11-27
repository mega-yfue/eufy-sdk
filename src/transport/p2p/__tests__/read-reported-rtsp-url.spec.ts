import { describe, expect, it, vi } from "vitest";
import { buildDirectBinaryBody } from "../write-commands.js";
import { connectedSession, routerWithSession, ACCOUNT_ID, DEVICE_SN, type FakeP2PSession } from "./session-fixtures.js";

const CMD_NAS_SWITCH = 1145;

interface FakeSession extends FakeP2PSession {
  sendBytes: ReturnType<typeof vi.fn>;
}

/** A fake station session whose device answers each send with code 0. */
function session(hasLevel2Key: boolean): FakeSession {
  const s = connectedSession(hasLevel2Key) as FakeSession;
  s.sendBytes = vi.fn((_body: Buffer, channel: number, commandId: number) => {
    queueMicrotask(() => s.emit("commandResult", { code: 0, channel, commandId }));
    return true;
  });
  return s;
}

describe("P2PCommandRouter.readReportedRtspUrl", () => {
  it("sends the publish switch alone and returns the pushed URL before the switch's answer, as the app does", async () => {
    vi.useFakeTimers();
    try {
      const s = connectedSession(false) as FakeSession;
      s.sendBytes = vi.fn(() => true); // the station never answers the switch
      const router = routerWithSession(s);
      const read = router.readReportedRtspUrl(DEVICE_SN);
      await vi.advanceTimersByTimeAsync(500);
      s.emit("rtspUrl", { channel: 1, url: "rtsp://u:p@host/live0" });
      await expect(read).resolves.toBe("rtsp://u:p@host/live0");

      await vi.advanceTimersByTimeAsync(60_000); // past the switch's answer window: nothing follows it
      expect(s.sendBytes.mock.calls).toEqual([[buildDirectBinaryBody(1, ACCOUNT_ID, 1), 1, CMD_NAS_SWITCH]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves undefined and leaves no listener when the station refuses the switch", async () => {
    vi.useFakeTimers();
    try {
      const s = connectedSession(false) as FakeSession;
      s.sendBytes = vi.fn((_body: Buffer, channel: number, commandId: number) => {
        queueMicrotask(() => s.emit("commandResult", { code: -1, channel, commandId }));
        return true;
      });
      const router = routerWithSession(s);
      const read = router.readReportedRtspUrl(DEVICE_SN);
      await vi.advanceTimersByTimeAsync(500); // well inside the read deadline

      await expect(read).resolves.toBeUndefined();
      expect(s.listenerCount("rtspUrl")).toBe(0);
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

  it("provokes a device whose member states an empty admin id with that empty id, as the app does", async () => {
    vi.useFakeTimers();
    try {
      const s = session(false);
      const router = routerWithSession(s, { accountId: "" });
      void router.readReportedRtspUrl(DEVICE_SN);
      await vi.advanceTimersByTimeAsync(500);

      expect(s.sendBytes).toHaveBeenCalledWith(buildDirectBinaryBody(1, "", 1), 1, CMD_NAS_SWITCH);
      await vi.advanceTimersByTimeAsync(60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves undefined when the station session cannot be resolved", async () => {
    const s = session(false);
    const router = routerWithSession(s, { register: false }); // nothing registered → no session to open

    await expect(router.readReportedRtspUrl(DEVICE_SN)).resolves.toBeUndefined();
    expect(s.sendBytes).not.toHaveBeenCalled();
  });
});
