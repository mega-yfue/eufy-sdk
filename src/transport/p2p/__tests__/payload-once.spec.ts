import { describe, expect, it, vi } from "vitest";
import { connectedSession, routerWithSession, DEVICE_SN, ACCOUNT_ID } from "./session-fixtures.js";

function harness() {
  const session = Object.assign(connectedSession(), { sendControlLevel2: vi.fn(() => true) });
  const router = routerWithSession(session);
  return { session, router };
}
const frame = (channel = 1, cmd = 1955, payload: unknown = { code: 0, slState: "4" }) => ({
  commandId: 1351,
  channel,
  json: { cmd, payload },
});
describe("native status query", () => {
  it("matches status by outer command, inner command and channel, never generic success", async () => {
    const { session, router } = harness();
    session.sendControlLevel2.mockImplementation(() => {
      session.emit("commandResult", { code: 0, channel: 1 });
      session.emit("data", frame(2));
      session.emit("data", frame(1, 1940));
      session.emit("data", { ...frame(), commandId: 1350 });
      session.emit("data", frame(1, 1955, []));
      queueMicrotask(() => session.emit("data", frame()));
      return true;
    });
    await expect(router.p2pQuery(DEVICE_SN, 1955, { payload: { timezone: "UTC0" } })).resolves.toEqual({
      code: 0,
      slState: "4",
    });
    expect(session.sendControlLevel2).toHaveBeenCalledExactlyOnceWith(1955, 1, ACCOUNT_ID, { timezone: "UTC0" }, 0);
    expect(session.listenerCount("data")).toBe(0);
    expect(session.listenerCount("close")).toBe(0);
  });
  it("preserves the correctly attributed negative status result", async () => {
    const { session, router } = harness();
    session.sendControlLevel2.mockImplementation(() => {
      queueMicrotask(() => session.emit("data", frame(1, 1955, { code: -106 })));
      return true;
    });
    await expect(router.p2pQuery(DEVICE_SN, 1955, { payload: { timezone: "UTC0" } })).resolves.toEqual({ code: -106 });
    expect(session.listenerCount("data")).toBe(0);
  });
});
