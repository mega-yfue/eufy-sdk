import { describe, expect, it, vi } from "vitest";
import { SharedLiveSource } from "../shared-live-source.js";
import { streamFactory } from "./live-source-fixtures.js";

function source(over: Record<string, unknown> = {}) {
  const { makeStream, streams } = streamFactory();
  const onSessionUnreachable = vi.fn(() => true);
  const src = new SharedLiveSource({
    makeStream,
    warmRetryMs: 10_000,
    warmTimeoutMs: 10_000,
    onSessionUnreachable,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  });
  return { src, streams, onSessionUnreachable };
}

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A reused own session can acknowledge every start and serve nothing: measured, a warm-up and eight
 * re-issues each acknowledged within 51 ms, no media datagram for the whole 20 s window, while the next attempt
 * on a fresh session delivered a keyframe 0.4 s after its start. A re-issued start answered by nothing for a whole
 * interval is therefore the session, and the warm-up asks for a fresh one inside its deadline.
 */
describe("re-issued starts the device acknowledges and serves nothing for", () => {
  it("asks for a replacement session after re-issued starts served nothing, and stops re-issuing onto it", async () => {
    const { src, streams, onSessionUnreachable } = source({ warmRetryMs: 20 });
    src.attach().on("error", () => undefined);

    await settle(70);
    const sent = streams[0]!.nudged;
    await settle(60);

    expect(onSessionUnreachable).toHaveBeenCalledTimes(1);
    expect(sent).toBe(2);
    expect(streams[0]!.nudged).toBe(2);
  });

  it("keeps re-issuing starts where the owner cannot replace the session", async () => {
    const cannot = vi.fn(() => false);
    const { src, streams } = source({
      warmRetryMs: 20,
      onSessionUnreachable: cannot,
    });
    src.attach().on("error", () => undefined);

    await settle(130);

    expect(streams).toHaveLength(1);
    expect(streams[0]!.nudged).toBeGreaterThan(3);
    expect(cannot).toHaveBeenCalledTimes(1);
  });

  it("leaves a battery camera's re-issued starts alone, since a cold one is slow rather than deaf", async () => {
    const { src, streams, onSessionUnreachable } = source({ warmRetryMs: 20, powered: "battery" });
    src.attach().on("error", () => undefined);

    await settle(130);

    expect(onSessionUnreachable).not.toHaveBeenCalled();
    expect(streams[0]!.nudged).toBeGreaterThan(3);
  });
});
