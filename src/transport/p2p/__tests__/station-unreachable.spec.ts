import { describe, expect, it, vi } from "vitest";
import { StationUnreachableError } from "../../../core/contracts.js";
import { P2P_STATION_WAITS } from "../command-router.js";
import { CONNECT_TIMEOUT_MS } from "../p2p-session.js";
import {
  connectedSession,
  disconnectedSession,
  routerWithSession,
  traceCollector,
  DEVICE_SN,
} from "./session-fixtures.js";

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
      const { logger, traces } = traceCollector();
      const router = routerWithSession(session, { deps: { logger } });

      const call = router.mediaProviderFor(DEVICE_SN).live();
      const settled = expect(call).rejects.toBeInstanceOf(StationUnreachableError);

      await vi.advanceTimersByTimeAsync(P2P_STATION_WAITS.connect + 1_000);
      await settled;

      expect(
        traces[0],
        "a station never reached is the case a resolve states, so it is stated before the wait rather than after it",
      ).toMatchObject({ phase: "station-resolved", topology: "attached", source: session.traceId });
      expect(traces[1], "the wait a caller's own deadline expires inside is charged in full").toEqual({
        phase: "session-connect-wait",
        waitMs: P2P_STATION_WAITS.connect,
        source: session.traceId,
      });
      const unreachable = traces.find((trace) => trace.phase === "session-unreachable");
      expect(traces.at(-1), "the outcome is the last word on the wait").toBe(unreachable);
      expect(unreachable?.waitedMs).toBeGreaterThanOrEqual(P2P_STATION_WAITS.connect);
      expect(unreachable?.source).toBe(session.traceId);
      expect(traces.some((trace) => trace.phase === "media-command")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The wait is the session's own connect deadline, not a second number beside it.
   *
   * A session that reaches its deadline closes itself, so a wait longer than it holds a caller on a connection
   * that can no longer answer and charges the difference to every failure — while a wait shorter than it reports
   * unreachable for a station still being asked for.
   */
  it("waits the deadline the session gives a station, and no other", () => {
    expect(P2P_STATION_WAITS.connect).toBe(CONNECT_TIMEOUT_MS);
  });

  /**
   * A session that is already up is the ordinary case and pays nothing for these records: their absence is
   * what states that no wait happened, so a reader is not left telling a fast path from a missing trace.
   */
  it("says nothing where the session was already connected", async () => {
    const { logger, traces } = traceCollector();
    const router = routerWithSession(connectedSession(), { deps: { logger } });

    await router
      .mediaProviderFor(DEVICE_SN)
      .live()
      .catch(() => undefined);

    const phases = traces.map((trace) => trace.phase);
    expect(phases).not.toContain("session-connect-wait");
    expect(phases).not.toContain("session-connected");
    expect(phases).not.toContain("session-unreachable");
  });
});
