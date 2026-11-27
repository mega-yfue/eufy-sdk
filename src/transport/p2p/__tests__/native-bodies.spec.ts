import { vi } from "vitest";
import { buildStringBody } from "../write-commands.js";
import { connectedSession, onFakeTime, routerWithSession, ACCOUNT_ID, STATION_SN } from "./session-fixtures.js";

/** The app's native string body and bare int pair, on the station channel, sealed by the session. Synthetic. */
describe("native bodies", () => {
  const withSends = (hasLevel2Key: boolean) =>
    Object.assign(connectedSession(hasLevel2Key), {
      sendBytes: vi.fn(() => true),
      sendIntStringCommand: vi.fn(),
    });
  const rename = { kind: "p2p-string", cmd: 1217, value: "Garden", channel: 3 } as const;

  it("sends the string body on channel 255", async () => {
    const session = withSends(false);
    await onFakeTime(() =>
      routerWithSession(session)
        .dispatchCommand(STATION_SN, rename)
        .catch(() => undefined),
    );
    expect(session.sendBytes).toHaveBeenCalledWith(buildStringBody(3, "Garden", ACCOUNT_ID), 255, 1217);
  });

  it("sends the bare int pair, [u32 valueSub][u32 value] with no account string", async () => {
    const pair = Buffer.alloc(8);
    pair.writeUInt32LE(2, 0);
    pair.writeUInt32LE(30, 4);
    const command = {
      kind: "p2p-int-string",
      cmd: 1201,
      value: 30,
      valueSub: 2,
      channel: 255,
      form: "int-pair",
    } as const;
    const session = withSends(false);
    await onFakeTime(() =>
      routerWithSession(session)
        .dispatchCommand(STATION_SN, command)
        .catch(() => undefined),
    );
    expect(session.sendBytes).toHaveBeenCalledWith(pair, 255, 1201);
    expect(session.sendIntStringCommand).not.toHaveBeenCalled();
  });
});
