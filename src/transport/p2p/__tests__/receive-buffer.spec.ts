import dgram from "node:dgram";
import { afterEach, describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";

/**
 * A session's socket asks for a receive buffer large enough to queue a keyframe burst, and says so when the OS
 * granted less.
 *
 * The OS caps the request without an error, so the granted size is stubbed here: what the test host's kernel
 * would grant is not what is under test.
 */
const REQUESTED = 4 * 1024 * 1024;

async function connectOnce(granted?: number) {
  if (granted !== undefined) vi.spyOn(dgram.Socket.prototype, "getRecvBufferSize").mockReturnValue(granted);
  const createSocket = vi.spyOn(dgram, "createSocket");
  const warn = vi.fn();
  const session = new P2PSession({
    stationSn: "T8000P0000000000",
    p2pDid: "XXXXXXX-000000-XXXXX",
    noBroadcast: true,
    logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
  });
  session.on("error", () => undefined);
  await session.connect();
  await session.close();
  return { createSocket, warn };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the receive buffer a session's socket asks for", () => {
  it("requests 4 MiB when the socket is created", async () => {
    const { createSocket } = await connectOnce(REQUESTED);
    expect(createSocket).toHaveBeenCalledWith({ type: "udp4", recvBufferSize: REQUESTED });
  });

  it("warns once when the OS granted less, naming the Linux cap to raise", async () => {
    const { warn } = await connectOnce(212992 * 2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("net.core.rmem_max");
  });

  it("stays silent when the OS granted at least the request", async () => {
    const { warn } = await connectOnce(REQUESTED * 2);
    expect(warn).not.toHaveBeenCalled();
  });
});
