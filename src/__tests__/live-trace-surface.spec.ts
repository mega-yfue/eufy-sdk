import { describe, expect, it } from "vitest";
import { LIVE_TRACE_MESSAGE, type LiveTrace } from "../index.js";

/**
 * The live-trace vocabulary is reachable from the package entry point.
 *
 * `live-trace.ts` instructs a caller to match on the message plus a phase to tell one startup outcome from
 * another, and both reach the root through `export *` hops rather than being named there — so nothing about
 * the entry point itself shows that they arrive, and a reader looking for them in its declaration file
 * finds four `export *` lines.
 *
 * A caller's own phase allowlist has to be typed against the union to survive it widening: the SDK adds a
 * phase without needing consumer coordination, so a hand-copied list compiles and passes its own tests
 * while discarding the new one. `satisfies Record<LiveTrace["phase"], true>` is the form that fails
 * instead, and this pins that it is available.
 *
 * Imported through `../index.js` deliberately, so removing a hop fails here rather than after release.
 */
describe("live-trace vocabulary at the package entry point", () => {
  it("publishes the message a caller matches traces on", () => {
    expect(LIVE_TRACE_MESSAGE).toBe("[live] start trace");
  });

  /**
   * The `satisfies` is the assertion — `tsc` reads the specs, so a phase added to or removed from the union
   * fails there rather than here. The runtime check only confirms the table was reached.
   */
  it("publishes a phase union a caller can exhaust", () => {
    const handled = {
      "media-command": true,
      "media-command-ack": true,
      "media-command-retry": true,
      "media-command-unacknowledged": true,
      "first-video-command": true,
      "first-video-unit": true,
      "first-keyframe": true,
      "first-foreign-media-command": true,
      "video-decode-empty": true,
      "datagram-gap": true,
      "sequence-restart": true,
      "lookup-channels": true,
      "session-connect-wait": true,
      "session-connected": true,
      "session-unreachable": true,
      "level2-wait": true,
      "level2-ready": true,
      "level2-unavailable": true,
      "level2-negotiating": true,
      "station-resolved": true,
      "cipher-fallback": true,
      warming: true,
      "media-command-unsent": true,
      "path-stale": true,
      "channel-silent": true,
    } satisfies Record<LiveTrace["phase"], true>;
    expect(Object.keys(handled)).toContain("sequence-restart");
  });
});
