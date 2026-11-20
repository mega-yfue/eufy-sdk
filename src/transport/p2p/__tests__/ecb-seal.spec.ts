import { vi } from "vitest";
import { connectedSession, onFakeTime, routerWithSession, ACCOUNT_ID, STATION_SN } from "./session-fixtures.js";

/**
 * The frames the app seals level-1 (ECB) whatever the session holds — 1060, and 1350 with sub-command 1001 —
 * go out level-1 even on a keyed session; the 1350 send settles on the device's answer, absent here. Synthetic payloads.
 */
describe("a level-1 pinned frame on a keyed session", () => {
  const keyed = () =>
    Object.assign(connectedSession(true), {
      sendSetPayload: vi.fn(),
      sendAcknowledged: vi.fn((send: () => boolean) => send()),
      sendControlLevel2: vi.fn(() => true),
      sendStringPayloadCommand: vi.fn(),
      sendRawLevel2: vi.fn(() => true),
    });

  it("sends a 1350 envelope level-1", async () => {
    const session = keyed();
    await onFakeTime(() =>
      routerWithSession(session)
        .dispatchCommand(STATION_SN, {
          kind: "set-payload",
          cmd: 1001,
          payload: { a: 1 },
          channel: 2,
          mValue3: 0,
          form: "int-string",
        })
        .catch(() => undefined),
    );
    expect(session.sendControlLevel2).not.toHaveBeenCalled();
    expect(session.sendSetPayload).toHaveBeenCalledWith(
      1001,
      { a: 1 },
      expect.objectContaining({ accountId: ACCOUNT_ID, channel: 2 }),
    );
  });

  it("sends a bare JSON body level-1", async () => {
    const session = keyed();
    await onFakeTime(() =>
      routerWithSession(session).dispatchCommand(STATION_SN, {
        kind: "set-json-raw",
        cmd: 1060,
        data: { a: 1 },
        channel: 255,
        form: "int-string",
      }),
    );
    expect(session.sendRawLevel2).not.toHaveBeenCalled();
    expect(session.sendStringPayloadCommand).toHaveBeenCalledWith(
      1060,
      JSON.stringify({ account_id: ACCOUNT_ID, a: 1 }),
      255,
    );
  });
});

describe("a 1350 envelope on a keyed session", () => {
  it("sends mValue3 0 when the intent gives none, as the app's envelope", async () => {
    const session = Object.assign(connectedSession(true), {
      sendAcknowledged: vi.fn((send: () => boolean) => send()),
      sendControlLevel2: vi.fn(() => true),
    });
    await onFakeTime(() =>
      routerWithSession(session)
        .dispatchCommand(STATION_SN, { kind: "set-payload", cmd: 1717, payload: { v: 1 }, channel: 2 })
        .catch(() => undefined),
    );
    expect(session.sendControlLevel2).toHaveBeenCalledWith(
      1717,
      2,
      ACCOUNT_ID,
      { v: 1 },
      0,
      expect.anything(),
      expect.anything(),
      undefined,
    );
  });
});
