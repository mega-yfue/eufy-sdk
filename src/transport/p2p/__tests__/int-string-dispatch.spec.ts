import { describe, expect, it, vi } from "vitest";
import {
  connectedSession,
  onFakeTime,
  routerWithSession,
  ACCOUNT_ID,
  DEVICE_SN,
  type FakeP2PSession,
} from "./session-fixtures.js";

interface FakeSession extends FakeP2PSession {
  sendIntStringCommand: ReturnType<typeof vi.fn>;
}

function setup(accountId = ACCOUNT_ID, register = true, hasLevel2Key = true) {
  const session = connectedSession(hasLevel2Key) as FakeSession;
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

  it("sends an int-pair set-param as the bare [channel][value] body, with no account id", async () => {
    const session = Object.assign(connectedSession(false), {
      sendIntStringCommand: vi.fn(),
      sendBytes: vi.fn(() => true),
    });
    await onFakeTime(() =>
      routerWithSession(session)
        .dispatchCommand(DEVICE_SN, {
          kind: "set-param",
          param: 1013,
          value: 3,
          form: "int-pair",
          channel: 1,
        })
        .catch(() => undefined),
    );
    const pair = Buffer.alloc(8);
    pair.writeUInt32LE(1, 0);
    pair.writeUInt32LE(3, 4);
    expect(session.sendIntStringCommand).not.toHaveBeenCalled();
    expect(session.sendBytes).toHaveBeenCalledWith(pair, 1, 1013);
  });

  it("sends a member's stated empty admin id as is, as the app does", async () => {
    const { router, session } = setup("");

    await router.dispatchCommand(DEVICE_SN, { kind: "p2p-int-string", cmd: 1202, value: 10, valueSub: 1, channel: 1 });

    expect(session.sendIntStringCommand).toHaveBeenCalledWith(1202, 10, 1, "", 1);
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
