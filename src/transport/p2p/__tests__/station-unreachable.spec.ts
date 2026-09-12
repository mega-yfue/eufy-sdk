import { describe, expect, it, vi } from "vitest";
import { StationUnreachableError } from "../../../core/contracts.js";
import { P2P_STATION_WAITS } from "../command-router.js";
import { disconnectedSession, routerWithSession, DEVICE_SN } from "./session-fixtures.js";

/**
 * A station that cannot be reached says so, and says it as itself.
 *
 * Nothing can be addressed to a station before its session is up, so every call holds for that first. Two
 * outcomes were previously indistinguishable to whoever read the result: a station that never connected, and a
 * station that connected and then refused or delivered nothing usable. They call for opposite next steps —
 * one is a station or network to look at, the other is a camera or a stream — so the wait is traced under the
 * session's own handle and its expiry is raised as its own type.
 *
 * The wait matters to a caller that bounds these calls itself: a bound below it reports the caller's own
 * expiry in place of this reason, which is why the wait is published rather than left to be copied.
 */
describe("a station whose session does not connect", () => {
  it("traces the wait it is holding for, then names the station unreachable", async () => {
    vi.useFakeTimers();
    try {
      const session = disconnectedSession();
      const router = routerWithSession(session);

      const call = router.mediaProviderFor(DEVICE_SN).live();
      const settled = expect(call).rejects.toBeInstanceOf(StationUnreachableError);

      await vi.advanceTimersByTimeAsync(P2P_STATION_WAITS.connect + 1_000);
      await settled;

      const phases = session.trace.mock.calls.map(([trace]) => trace);
      expect(phases[0], "a caller whose own deadline expires inside the wait has this record and no other").toEqual({
        phase: "session-connect-wait",
        waitMs: P2P_STATION_WAITS.connect,
      });
      expect(phases.at(-1)).toMatchObject({ phase: "session-unreachable" });
      expect(phases.at(-1)!.waitedMs).toBeGreaterThanOrEqual(P2P_STATION_WAITS.connect);
      expect(phases.some((trace) => trace.phase === "media-command")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * A session that is already up is the ordinary case and pays nothing for these records: their absence is
   * what states that no wait happened, so a reader is not left telling a fast path from a missing trace.
   */
  it("says nothing where the session was already connected", async () => {
    const session = disconnectedSession();
    session.isConnected = true;
    const router = routerWithSession(session);

    await router
      .mediaProviderFor(DEVICE_SN)
      .live()
      .catch(() => undefined);

    const phases = session.trace.mock.calls.map(([trace]) => trace.phase);
    expect(phases).not.toContain("session-connect-wait");
    expect(phases).not.toContain("session-connected");
    expect(phases).not.toContain("session-unreachable");
  });
});
