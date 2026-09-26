import dgram from "node:dgram";
import { afterEach, describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";

/**
 * A session's socket asks for a receive buffer large enough to queue a keyframe burst, and says so when the OS
 * granted less or refused.
 *
 * What the OS grants is stubbed: the test host's own limits are not what is under test.
 */
const REQUESTED = 4 * 1024 * 1024;

function newSession() {
  const warn = vi.fn();
  const session = new P2PSession({
    stationSn: "T8000P0000000000",
    p2pDid: "XXXXXXX-000000-XXXXX",
    noBroadcast: true,
    logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
  });
  session.on("error", () => undefined);
  return { session, warn };
}

async function connectAndClose(session: P2PSession) {
  await session.connect();
  await session.close();
}

function grant(size: number) {
  vi.spyOn(dgram.Socket.prototype, "setRecvBufferSize").mockImplementation(() => undefined);
  vi.spyOn(dgram.Socket.prototype, "getRecvBufferSize").mockReturnValue(size);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the receive buffer a session's socket asks for", () => {
  it("requests 4 MiB on the bound socket", async () => {
    grant(REQUESTED);
    const { session } = newSession();
    await connectAndClose(session);
    expect(dgram.Socket.prototype.setRecvBufferSize).toHaveBeenCalledWith(REQUESTED);
  });

  it("warns with the granted size when the OS lowered the request", async () => {
    grant(212992 * 2);
    const { session, warn } = newSession();
    await connectAndClose(session);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("granted 425984");
  });

  it("connects and warns instead of throwing when the OS refuses the request", async () => {
    vi.spyOn(dgram.Socket.prototype, "setRecvBufferSize").mockImplementation(() => {
      throw new Error("ENOBUFS");
    });
    const { session, warn } = newSession();
    await expect(connectAndClose(session)).resolves.toBeUndefined();
    expect(warn.mock.calls[0]?.[0]).toContain("request refused");
  });

  it("warns once per session, not again on a reconnect", async () => {
    grant(212992 * 2);
    const { session, warn } = newSession();
    await connectAndClose(session);
    await connectAndClose(session);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
