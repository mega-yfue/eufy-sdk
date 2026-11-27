import { describe, expect, it, vi } from "vitest";
import { connectedSession, routerWithSession, DEVICE_SN, STATION_SN } from "./session-fixtures.js";

describe("a closed session still registered for its station", () => {
  it("is replaced by a fresh one, not waited on for a connect it never makes", async () => {
    const closed = Object.assign(connectedSession(), { isClosed: true, close: vi.fn(async () => {}) });
    closed.isConnected = false;
    const fresh = Object.assign(connectedSession(), { sendIntStringCommand: vi.fn() });
    const router = routerWithSession(closed);
    const target = router as unknown as {
      manager: { get(key: string): unknown; register(key: string, session: unknown): void };
      openSession(key: string): Promise<unknown>;
    };
    target.openSession = async (key) => {
      if (!target.manager.get(key)) target.manager.register(key, fresh);
      return target.manager.get(key);
    };
    await router.dispatchCommand(DEVICE_SN, {
      kind: "set-param",
      param: 1045,
      value: 1,
      form: "int-string",
      channel: 1,
    });
    expect(target.manager.get(STATION_SN)).toBe(fresh);
    expect(fresh.sendIntStringCommand).toHaveBeenCalled();
  });
});
