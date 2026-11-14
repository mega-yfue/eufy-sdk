import { describe, expect, it, vi } from "vitest";
import { connectedSession, routerWithSession, ACCOUNT_ID, DEVICE_SN, type FakeP2PSession } from "./session-fixtures.js";

interface FakeSession extends FakeP2PSession {
  sendIntStringCommand: ReturnType<typeof vi.fn>;
}

function setup(accountId = ACCOUNT_ID, register = true) {
  const session = connectedSession() as FakeSession;
  session.sendIntStringCommand = vi.fn();
  const router = routerWithSession(session, { accountId, register });
  return { router, session };
}

describe("P2P int-plus-string command dispatch", () => {
  it("injects account identity and preserves the bound camera channel", async () => {
    const { router, session } = setup();

    await router.dispatchCommand(DEVICE_SN, {
      kind: "p2p-int-string",
      cmd: 1202,
      value: 10,
      valueSub: 1,
      channel: 1,
    });

    expect(session.sendIntStringCommand).toHaveBeenCalledWith(1202, 10, 1, ACCOUNT_ID, 1);
  });

  it("sends an int-pair set-param as the bare level-1 [channel][value] body, with no account id", async () => {
    const { router, session } = setup();

    await router.dispatchCommand(DEVICE_SN, { kind: "set-param", param: 1013, value: 3, form: "int-pair", channel: 1 });

    expect(session.sendIntStringCommand).toHaveBeenCalledWith(1013, 3, 1, "", 1);
  });

  it("rejects missing account identity without sending", async () => {
    const { router, session } = setup("");

    await expect(
      router.dispatchCommand(DEVICE_SN, {
        kind: "p2p-int-string",
        cmd: 1202,
        value: 10,
        valueSub: 1,
        channel: 1,
      }),
    ).rejects.toThrow(/requires an account id/);
    expect(session.sendIntStringCommand).not.toHaveBeenCalled();
  });

  it("rejects session resolution failure without sending", async () => {
    const { router, session } = setup(ACCOUNT_ID, false);

    await expect(
      router.dispatchCommand(DEVICE_SN, {
        kind: "p2p-int-string",
        cmd: 1202,
        value: 10,
        valueSub: 1,
        channel: 1,
      }),
    ).rejects.toThrow(/no P2P (?:endpoint|session)/);
    expect(session.sendIntStringCommand).not.toHaveBeenCalled();
  });
});
