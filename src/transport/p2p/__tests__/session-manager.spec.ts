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
    const [a, b] = await Promise.all([mgr.acquire("ST", factory), mgr.acquire("ST", factory)]);
    expect(factory).toHaveBeenCalledOnce();
    expect(a).toBe(b);
    expect(mgr.get("ST")).toBe(a);
  });

  it("a battery station idle-closes after the window once its last user releases", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session);
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
    await mgr.acquire("ST", async () => session);
    mgr.retain("ST");
    mgr.release("ST");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(session.close).not.toHaveBeenCalled();
    expect(mgr.get("ST") !== undefined).toBe(true);
  });

  it("a new user cancels a pending idle-close", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session);
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
    await mgr.acquire("ST", async () => session);
    mgr.bumpCommand("ST");
    await vi.advanceTimersByTimeAsync(50);
    mgr.bumpCommand("ST");
    await vi.advanceTimersByTimeAsync(100);
    expect(session.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.close).toHaveBeenCalledOnce();
  });

  it("remove drops a station entry and clears its idle timer", async () => {
    const mgr = managerFor("battery");
    const session = fakeSession();
    await mgr.acquire("ST", async () => session);
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
    await mgr.acquire("ST", async () => first);
    mgr.retain("ST");
    mgr.release("ST");

    await mgr.close("ST");
    await vi.advanceTimersByTimeAsync(1000);
    const reopened = await mgr.acquire("ST", async () => second);

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
    const opening = mgr.acquire("ST", async (register) => {
      await gate;
      register(stale);
      return stale;
    });
    await vi.advanceTimersByTimeAsync(0);

    await mgr.close("ST");
    finish();

    await expect(opening).rejects.toThrow(/superseded/);
    expect(stale.close).toHaveBeenCalledOnce();
    const fresh = fakeSession("fresh");
    await expect(mgr.acquire("ST", async () => fresh)).resolves.toBe(fresh);
  });

  it("closeAll closes every live session and clears timers", async () => {
    const mgr = managerFor("wired");
    const a = fakeSession("a");
    const b = fakeSession("b");
    await mgr.acquire("A", async () => a);
    await mgr.acquire("B", async () => b);
    await mgr.closeAll();
    expect(a.close).toHaveBeenCalledOnce();
    expect(b.close).toHaveBeenCalledOnce();
    expect(mgr.keys().length).toBe(0);
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

    mgr.bumpCommand("ST");
    mgr.bumpCommand("ST");
    await mgr.close("ST");
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
});
