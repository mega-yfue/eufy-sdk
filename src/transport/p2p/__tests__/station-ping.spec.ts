import { afterEach, describe, expect, it, vi } from "vitest";
import { connectedSession, routerWithSession, STATION_SN, type FakeP2PSession } from "./session-fixtures.js";

/**
 * The app's esiotkit pinger: a 1139 every 3 s to a parent serial that is not a station, for 300 s after a request and
 * without end during live view. The fixtures' station is a T8010, which is never pinged, so these use a standalone one.
 */
const SOLO_SN = "T8410P0000000000";

function solo(sn = SOLO_SN) {
  const session = Object.assign(connectedSession(), {
    sendPing: vi.fn(),
    sendBytes: vi.fn(() => true),
    close: vi.fn(async () => {}),
  }) as FakeP2PSession & { sendPing: ReturnType<typeof vi.fn> };
  const router = routerWithSession(session, {
    register: false,
    deps: { listDevices: () => [{ sn, stationSn: sn, model: sn.slice(0, 5), p2pDid: "", raw: {} } as never] },
  });
  (router as unknown as { manager: { register(sn: string, s: unknown): void } }).manager.register(sn, session);
  return { router, session };
}

describe("the app's station ping", () => {
  afterEach(() => vi.useRealTimers());

  it("pings a standalone device every 3 s for 300 s after a request, then stops", async () => {
    vi.useFakeTimers();
    const { router, session } = solo();
    await router.getParams(SOLO_SN);
    vi.advanceTimersByTime(3_000);
    expect(session.sendPing).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(297_000);
    expect(session.sendPing).toHaveBeenCalledTimes(100);
    vi.advanceTimersByTime(30_000);
    expect(session.sendPing).toHaveBeenCalledTimes(100);
    await router.closeAll();
  });

  /** `PingTimeUtil` beside it on an O4 hub whose strategy needs a ping: 240 s after the last command. */
  it("adds the legacy ping on a T8170 for 240 s after a request", async () => {
    vi.useFakeTimers();
    const { router, session } = solo("T8170P0000000000");
    await router.getParams("T8170P0000000000");
    vi.advanceTimersByTime(240_000);
    expect(session.sendPing).toHaveBeenCalledTimes(160);
    vi.advanceTimersByTime(60_000);
    expect(session.sendPing).toHaveBeenCalledTimes(180);
    await router.closeAll();
  });

  it("never pings a station", async () => {
    vi.useFakeTimers();
    const session = Object.assign(connectedSession(), {
      sendPing: vi.fn(),
      sendBytes: vi.fn(() => true),
      close: vi.fn(async () => {}),
    });
    const router = routerWithSession(session);
    await router.getParams(STATION_SN);
    vi.advanceTimersByTime(30_000);
    expect(session.sendPing).not.toHaveBeenCalled();
    await router.closeAll();
  });
});
