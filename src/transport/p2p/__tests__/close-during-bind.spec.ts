import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";

/** A real UDP socket closed before its bind completes never invokes the bind callback. */
describe("a P2P session closed while its socket binds", () => {
  it("settles connect without starting the lookup", async () => {
    const session = new P2PSession({
      stationSn: "T8000P0000000000",
      p2pDid: "XXXXXXX-000000-XXXXX",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const connecting = session.connect();
    await session.close();
    const outcome = await Promise.race([
      connecting.then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 1_000)),
    ]);
    expect(outcome).toBe("settled");
    expect((session as unknown as { lookupTimer?: unknown }).lookupTimer).toBeUndefined();
  });
});
