import { vi } from "vitest";
import { buildStringBody } from "../write-commands.js";
import { connectedSession, onFakeTime, routerWithSession, ACCOUNT_ID, STATION_SN } from "./session-fixtures.js";

/** The app's native string body and bare int pair, on the station channel, sealed by the session. Synthetic. */
describe("native bodies", () => {
  const withSends = (hasLevel2Key: boolean) =>
    Object.assign(connectedSession(hasLevel2Key), {
      sendRawLevel2Bytes: vi.fn(() => true),
      sendRawLevel1Bytes: vi.fn(() => true),
      sendIntStringCommand: vi.fn(),
    });
  const rename = { kind: "p2p-string", cmd: 1217, value: "Garden", channel: 3 } as const;

  it("sends the string body level-2 on a keyed session, level-1 on a keyless one, on channel 255", async () => {
    const keyed = withSends(true);
    await onFakeTime(() => routerWithSession(keyed).dispatchCommand(STATION_SN, rename));
    expect(keyed.sendRawLevel2Bytes).toHaveBeenCalledWith(buildStringBody(3, "Garden", ACCOUNT_ID), 255, 1217, 8);
    const keyless = withSends(false);
    await onFakeTime(() => routerWithSession(keyless).dispatchCommand(STATION_SN, rename));
    expect(keyless.sendRawLevel1Bytes).toHaveBeenCalledWith(buildStringBody(3, "Garden", ACCOUNT_ID), 255, 1217);
    expect(keyless.sendRawLevel2Bytes).not.toHaveBeenCalled();
  });

  it("seals the bare int pair at the session's level, [u32 valueSub][u32 value] with no account string", async () => {
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
    const keyed = withSends(true);
    await onFakeTime(() => routerWithSession(keyed).dispatchCommand(STATION_SN, command));
    expect(keyed.sendRawLevel2Bytes).toHaveBeenCalledWith(pair, 255, 1201, 8);
    expect(keyed.sendIntStringCommand).not.toHaveBeenCalled();
    const keyless = withSends(false);
    await onFakeTime(() => routerWithSession(keyless).dispatchCommand(STATION_SN, command));
    expect(keyless.sendRawLevel1Bytes).toHaveBeenCalledWith(pair, 255, 1201);
  });
});
