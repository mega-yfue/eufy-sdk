import { vi } from "vitest";
import { buildDirectBinaryBody } from "../write-commands.js";
import { connectedSession, routerWithSession, ACCOUNT_ID, STATION_SN } from "./session-fixtures.js";

/**
 * The station-scalar seal: level-2 only by default; with `form` `"auto"` it follows the session, so a
 * keyless one takes the same 132-byte body sealed level-1. Synthetic cmd and value.
 */
describe("p2p-station-scalar seal", () => {
  const withSends = (hasLevel2Key: boolean) =>
    Object.assign(connectedSession(hasLevel2Key), {
      sendRawLevel2Bytes: vi.fn(() => true),
      sendRawLevel1Bytes: vi.fn(() => true),
    });

  it("auto on a keyless session → level-1 on the given channel, replayed", async () => {
    const session = withSends(false);
    await routerWithSession(session).dispatchCommand(STATION_SN, {
      kind: "p2p-station-scalar",
      cmd: 1224,
      value: 63,
      channel: 255,
      form: "auto",
    });
    expect(session.sendRawLevel2Bytes).not.toHaveBeenCalled();
    expect(session.sendRawLevel1Bytes).toHaveBeenCalledWith(buildDirectBinaryBody(63, ACCOUNT_ID), 255, 1224);
    expect(session.sendRawLevel1Bytes.mock.calls.length).toBeGreaterThan(1);
  });

  it("auto on a keyed session → level-2, signCode 8", async () => {
    const session = withSends(true);
    await routerWithSession(session).dispatchCommand(STATION_SN, {
      kind: "p2p-station-scalar",
      cmd: 1224,
      value: 1,
      channel: 255,
      form: "auto",
    });
    expect(session.sendRawLevel1Bytes).not.toHaveBeenCalled();
    expect(session.sendRawLevel2Bytes).toHaveBeenCalledWith(buildDirectBinaryBody(1, ACCOUNT_ID), 255, 1224, 8);
  });

  it("no form on a keyed session → level-2 only", async () => {
    const session = withSends(true);
    await routerWithSession(session).dispatchCommand(STATION_SN, {
      kind: "p2p-station-scalar",
      cmd: 1235,
      value: 2,
      channel: 255,
    });
    expect(session.sendRawLevel1Bytes).not.toHaveBeenCalled();
    expect(session.sendRawLevel2Bytes).toHaveBeenCalledWith(buildDirectBinaryBody(2, ACCOUNT_ID), 255, 1235, 8);
  });
});
