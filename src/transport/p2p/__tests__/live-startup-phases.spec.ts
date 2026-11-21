import { describe, expect, it, vi } from "vitest";
import { LIVE_TRACE_MESSAGE } from "../live-trace.js";
import { SharedLiveSource } from "../shared-live-source.js";
import { streamFactory } from "./live-source-fixtures.js";

/**
 * The wait before any media command is sent, as structured phases.
 *
 * These facts were only ever free text, and a consumer's diagnostics cannot keep free text: a station identity
 * inside it survives every pattern a redactor recognises. So the numbers a slow start is diagnosed from — how
 * long a start may wait for the level-2 key, what the key negotiation answered, the interval a warm-up
 * re-issues on and the deadline it fails at — were unreachable to a host, which left it reading keyword
 * buckets and concluding wrongly.
 *
 * Each field is a bounded integer, which is what makes the phase safe to retain rather than merely useful.
 */
const phases = (calls: [string, ...unknown[]][]) =>
  calls.filter(([message]) => message === LIVE_TRACE_MESSAGE).map(([, trace]) => trace);

describe("warm-up phase", () => {
  it("states the deadline it will fail at", () => {
    const debug = vi.fn();
    const { makeStream } = streamFactory();
    const source = new SharedLiveSource({
      makeStream,
      warmTimeoutMs: 20000,
      logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const consumer = source.attach();

    expect(phases(debug.mock.calls as never)).toContainEqual(
      expect.objectContaining({ phase: "warming", deadlineMs: 20000 }),
    );
    consumer.detach();
  });

  it("states the values a caller configured, not the defaults", () => {
    const debug = vi.fn();
    const { makeStream } = streamFactory();
    const source = new SharedLiveSource({
      makeStream,
      warmTimeoutMs: 9000,
      logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const consumer = source.attach();

    expect(phases(debug.mock.calls as never)).toContainEqual(
      expect.objectContaining({ phase: "warming", deadlineMs: 9000 }),
    );
    consumer.detach();
  });

  /**
   * A rebuilt stream warms again, so the phase marks each attempt rather than only the first.
   *
   * The linger teardown is a timer even at zero, so re-attaching in the same turn reuses the source it was
   * about to drop — which is the reuse the linger exists for, and why this waits for it to fire.
   */
  it("marks every warm, so a rebuilt stream is not silent", async () => {
    const debug = vi.fn();
    const { makeStream } = streamFactory();
    const source = new SharedLiveSource({
      makeStream,
      lingerMs: 0,
      logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    source.attach().detach();
    await new Promise((resolve) => setTimeout(resolve, 5));
    source.attach().detach();

    expect(phases(debug.mock.calls as never).filter((t) => (t as { phase: string }).phase === "warming")).toHaveLength(
      2,
    );
  });

  it("carries no identity, which is what makes it retainable", () => {
    const debug = vi.fn();
    const { makeStream } = streamFactory();
    const source = new SharedLiveSource({
      makeStream,
      label: "T8000P0000000000:2",
      logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    const consumer = source.attach();

    const traced = phases(debug.mock.calls as never) as { source?: string }[];
    expect(JSON.stringify(traced)).not.toContain("T8000P0000000000");
    // The handle that groups a run's records is opaque by construction, and asserted to be so: it is what a
    // reader uses instead of the label, which is a serial.
    expect(traced[0]?.source).toMatch(/^pull-\d+$/);
    consumer.detach();
  });
});
