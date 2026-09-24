import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager, type PowerTier } from "../session-manager.js";
import type { P2PSession } from "../p2p-session.js";

/**
 * A minimal fake {@link P2PSession} — the manager only ever calls `close()`. `id` disambiguates
 * instances when a test asserts that a re-open produced a fresh session.
 */
function fakeSession(id = "s"): P2PSession {
  return { id, close: vi.fn().mockResolvedValue(undefined) } as unknown as P2PSession;
}

/** Build a manager whose `poweredFor` returns the given tier for every station. */
function managerFor(tier: PowerTier) {
  return new SessionManager({ poweredFor: () => tier, batteryIdleMs: 1000, commandKeepAliveMs: 100 });
}

describe("SessionManager lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("acquire opens once and coalesces concurrent cold opens", async () => {
    const mgr = managerFor("battery");
    const factory = vi.fn(async () => fakeSession());
    const [a, b] = await Promise.all([mgr.acquire("ST", factory, "ST"), mgr.acquire("ST", factory, "ST")]);
    expect(factory).toHaveBeenCalledOnce();
    expect(a).toBe(b);
    expect(mgr.get("ST")).toBe(a);
  });

  it("a battery station idle-closes after the window once its last user releases", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session, "ST");
    mgr.retain("ST");
    mgr.release("ST");
    expect(session.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.close).toHaveBeenCalledOnce();
    expect(mgr.get("ST") !== undefined).toBe(false);
  });

  it("a wired station never idle-closes (persistent)", async () => {
    const mgr = managerFor("wired");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session, "ST");
    mgr.retain("ST");
    mgr.release("ST");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(session.close).not.toHaveBeenCalled();
    expect(mgr.get("ST") !== undefined).toBe(true);
  });

  it("reconciles an already-idle session when its power claim changes", async () => {
    let tier: PowerTier = "wired";
    const mgr = new SessionManager({ poweredFor: () => tier, batteryIdleMs: 1000 });
    const session = fakeSession();
    await mgr.acquire("ST", async () => session, "ST");
    mgr.retain("ST");
    mgr.release("ST");
    tier = "battery";
    mgr.refreshPower("ST");
    await vi.advanceTimersByTimeAsync(500);
    tier = "wired";
    mgr.refreshPower("ST");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.close).not.toHaveBeenCalled();
    tier = "battery";
    mgr.refreshPower("ST");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("a new user cancels a pending idle-close", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session, "ST");
    mgr.retain("ST");
    mgr.release("ST");
    await vi.advanceTimersByTimeAsync(500);
    mgr.retain("ST");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.close).not.toHaveBeenCalled();
  });

  it("bumpCommand keeps the session warm for the keepalive window then arms idle", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session, "ST");
    mgr.bumpCommand("ST", "ST");
    await vi.advanceTimersByTimeAsync(50);
    mgr.bumpCommand("ST", "ST");
    await vi.advanceTimersByTimeAsync(100);
    expect(session.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("remove drops a station entry and clears its idle timer", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session, "ST");
    mgr.retain("ST");
    mgr.release("ST");
    mgr.remove("ST");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.close).not.toHaveBeenCalled();
    expect(mgr.get("ST") !== undefined).toBe(false);
  });

  it("close immediately detaches a live session, cancels idle, and permits a fresh acquisition", async () => {
    const mgr = managerFor("battery");
    const first = fakeSession("first");
    const second = fakeSession("second");
    await mgr.acquire("ST", async () => first, "ST");
    mgr.retain("ST");
    mgr.release("ST");

    await mgr.close("ST");
    await vi.advanceTimersByTimeAsync(1000);
    const reopened = await mgr.acquire("ST", async () => second, "ST");

    expect(first.close).toHaveBeenCalledOnce();
    expect(reopened).toBe(second);
  });

  it("close supersedes an in-flight acquisition and the next acquisition opens fresh", async () => {
    const mgr = managerFor("battery");
    const stale = fakeSession("stale");
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const opening = mgr.acquire(
      "ST",
      async (register) => {
        await gate;
        register(stale);
        return stale;
      },
      "ST",
    );
    await vi.advanceTimersByTimeAsync(0);

    await mgr.close("ST");
    finish();

    await expect(opening).rejects.toThrow(/superseded/);
    expect(stale.close).toHaveBeenCalledOnce();
    const fresh = fakeSession("fresh");
    await expect(mgr.acquire("ST", async () => fresh, "ST")).resolves.toBe(fresh);
  });

  it("reset ignores command holds but waits for active session consumers", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session, "ST");
    mgr.retain("ST");
    mgr.bumpCommand("ST", "ST");

    const reset = mgr.resetWhenUnused("ST");
    let resetFinished = false;
    void reset.then(() => {
      resetFinished = true;
    });
    expect(session.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(session.close).not.toHaveBeenCalled();
    expect(resetFinished).toBe(false);

    mgr.release("ST");
    await reset;
    expect(session.close).toHaveBeenCalledOnce();
    expect(resetFinished).toBe(true);
  });

  it("hands every caller of a pending reset the same promise, so waiters cannot pile up", async () => {
    const mgr = managerFor("battery");
    mgr.register("ST", fakeSession());
    mgr.retain("ST");

    const first = mgr.resetWhenUnused("ST");
    expect(mgr.resetWhenUnused("ST")).toBe(first);

    mgr.release("ST");
    await first;
  });

  it("reset closes immediately when only command holds remain", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session, "ST");
    mgr.bumpCommand("ST", "ST");

    await mgr.resetWhenUnused("ST");

    expect(session.close).toHaveBeenCalledOnce();
    expect(mgr.get("ST") !== undefined).toBe(false);
  });

  it("closeAll closes every live session and clears timers", async () => {
    const mgr = managerFor("wired");
    const a = fakeSession("a");
    const b = fakeSession("b");
    await mgr.acquire("A", async () => a, "A");
    await mgr.acquire("B", async () => b, "B");
    await mgr.closeAll();
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(mgr.keys().length).toBe(0);
  });

  it("close rejects deferred reset waiters when session teardown fails", async () => {
    const mgr = managerFor("wired");
    const failure = new Error("close failed");
    const session = fakeSession();
    vi.mocked(session.close).mockRejectedValue(failure);
    await mgr.acquire("ST", async () => session, "ST");
    mgr.retain("ST");
    const reset = mgr.resetWhenUnused("ST");

    const resetResult = expect(reset).rejects.toBe(failure);
    await expect(mgr.close("ST")).rejects.toBe(failure);

    await resetResult;
  });

  it("closeAll settles each reset waiter and still reports teardown failure", async () => {
    const mgr = managerFor("wired");
    const failure = new Error("close failed");
    const failed = fakeSession("failed");
    const closed = fakeSession("closed");
    vi.mocked(failed.close).mockRejectedValue(failure);
    await mgr.acquire("A", async () => failed, "A");
    await mgr.acquire("B", async () => closed, "B");
    mgr.retain("A");
    mgr.retain("B");
    const failedReset = mgr.resetWhenUnused("A");
    const closedReset = mgr.resetWhenUnused("B");

    const failedResetResult = expect(failedReset).rejects.toBe(failure);
    const closedResetResult = expect(closedReset).resolves.toBeUndefined();
    await expect(mgr.closeAll()).rejects.toBe(failure);

    await Promise.all([failedResetResult, closedResetResult]);
    expect(failed.close).toHaveBeenCalledOnce();
    expect(closed.close).toHaveBeenCalledOnce();
  });

  it("register makes a session live without arming any idle timer", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    mgr.register("ST", session);
    expect(mgr.get("ST")).toBe(session);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(session.close).not.toHaveBeenCalled();
  });

  it("a hold that expires after its entry was discarded does not release the successor's consumers", async () => {
    const mgr = managerFor("battery");
    mgr.register("ST", fakeSession("first"));

    mgr.bumpCommand("ST", "ST");
    mgr.bumpCommand("ST", "ST");
    await mgr.resetWhenUnused("ST");
    expect(mgr.get("ST") !== undefined).toBe(false);

    const second = fakeSession("second");
    mgr.register("ST", second);
    mgr.retain("ST");
    mgr.retain("ST");

    await vi.advanceTimersByTimeAsync(100 + 1000);
    expect(second.close).not.toHaveBeenCalled();
    expect(mgr.get("ST")).toBe(second);
  });

  it("an extra release on a live station does not restart its idle window", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    mgr.register("ST", session);

    mgr.retain("ST");
    mgr.release("ST");
    await vi.advanceTimersByTimeAsync(600);
    mgr.release("ST");
    await vi.advanceTimersByTimeAsync(400);

    expect(session.close).toHaveBeenCalledOnce();
  });

  it("re-resolves the power tier per idle-arm, so battery evidence arriving late still lets the device sleep", async () => {
    let tier: PowerTier = "wired";
    const mgr = new SessionManager({ poweredFor: () => tier, batteryIdleMs: 1000 });
    const session = fakeSession();
    mgr.register("ST", session);

    mgr.retain("ST");
    mgr.release("ST");
    await vi.advanceTimersByTimeAsync(5000);
    expect(session.close).not.toHaveBeenCalled();

    tier = "battery";
    mgr.retain("ST");
    mgr.release("ST");
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.close).toHaveBeenCalledOnce();
  });

  /**
   * A key is not always a station serial, and the power tier is a property of the hardware. Asked about the
   * key, `poweredFor` would be given a serial that does not exist, answer with its default of `wired`, and
   * leave a battery station's second connection running its 5 s heartbeat forever — the drain this class
   * exists to prevent, invisible until the battery is flat.
   */
  it("asks for the power tier of the STATION, never of the key the session is filed under", async () => {
    const asked: string[] = [];
    const mgr = new SessionManager({
      poweredFor: (sn) => {
        asked.push(sn);
        return "battery";
      },
      batteryIdleMs: 1000,
    });
    const session = fakeSession();
    mgr.register("ST#live:2", session, "ST");

    mgr.retain("ST#live:2");
    mgr.release("ST#live:2");

    expect(asked).toEqual(["ST"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.close).toHaveBeenCalledOnce();
  });

  /** A hold is the one path that CREATES an entry — a pre-warm takes it before the open. */
  it("files a held-open session under its station, so a pre-warm cannot mis-tier it", async () => {
    const asked: string[] = [];
    const mgr = new SessionManager({
      poweredFor: (sn) => {
        asked.push(sn);
        return "battery";
      },
      batteryIdleMs: 1000,
    });

    mgr.hold("ST#live:2", 100, "ST");
    await vi.advanceTimersByTimeAsync(200);

    expect(asked).toEqual(["ST"]);
  });
});
