import dgram from "node:dgram";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StationUnreachableError } from "../../../core/contracts.js";
import { P2PSession } from "../p2p-session.js";

/** A socket whose bind fails emits `error` and never invokes its bind callback or closes. */
describe("a P2P session whose socket cannot bind", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects connect, closes the socket and starts no lookup", async () => {
    const held = dgram.createSocket("udp4");
    await new Promise<void>((resolve) => held.bind(0, "127.0.0.1", resolve));
    const { port } = held.address();
    const bind = dgram.Socket.prototype.bind;
    vi.spyOn(dgram.Socket.prototype, "bind").mockImplementationOnce(function (this: dgram.Socket) {
      return bind.call(this, { port, address: "127.0.0.1" });
    });
    const session = new P2PSession({
      stationSn: "T8000P0000000000",
      p2pDid: "XXXXXXX-000000-XXXXX",
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    session.on("error", () => {});
    const closed = vi.fn();
    session.on("close", closed);
    const outcome = await Promise.race([
      session.connect().then(
        () => "resolved",
        (e: unknown) => e,
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 1_000)),
    ]);
    held.close();
    expect(outcome).toBeInstanceOf(StationUnreachableError);
    expect((outcome as Error).cause).toMatchObject({ code: "EADDRINUSE" });
    expect(closed).toHaveBeenCalledOnce();
    const internals = session as unknown as { connecting: boolean; socket?: unknown; lookupTimer?: unknown };
    expect(internals.connecting).toBe(false);
    expect(internals.socket).toBeUndefined();
    expect(internals.lookupTimer).toBeUndefined();
  });
});
