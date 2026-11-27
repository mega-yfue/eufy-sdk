import { describe, expect, it, vi } from "vitest";
import { connectedSession, routerWithSession, ACCOUNT_ID, DEVICE_SN, STATION_SN } from "./session-fixtures.js";

const BODY = Buffer.from("ff00000087030000", "hex");

/** The app's params read: 1103 `[255][903]`, on channel 0 where param 6271 is "1", else on the device's channel. */
describe("P2PCommandRouter.getParams", () => {
  const sendOn = (params?: Record<number, string>) => {
    const session = Object.assign(connectedSession(), { sendBytes: vi.fn(() => true) });
    const router = routerWithSession(session, {
      deps: params
        ? {
            listDevices: () => [{ sn: STATION_SN, stationSn: STATION_SN, model: "T8010", params, raw: {} } as never],
          }
        : {},
    });
    return { router, send: session.sendBytes };
  };

  it("reads a station on its own channel, and on channel 0 where param 6271 is 1", async () => {
    const plain = sendOn({});
    await plain.router.getParams(STATION_SN);
    expect(plain.send).toHaveBeenCalledWith(BODY, 255, 1103);

    const outdoor = sendOn({ 6271: "1" });
    await outdoor.router.getParams(STATION_SN);
    expect(outdoor.send).toHaveBeenCalledWith(BODY, 0, 1103);
  });

  it("reads an attached device on its channel", async () => {
    const { router, send } = sendOn();
    await router.getParams(DEVICE_SN);
    expect(send).toHaveBeenCalledWith(BODY, 1, 1103);
  });
});

/** `P2PRequestCreatorKt.p2pRequest`: a request to a station serial goes on 255, whatever channel its record states. */
describe("a write to a station serial", () => {
  it("goes on channel 255", async () => {
    const session = Object.assign(connectedSession(), {
      sendBytes: vi.fn((_body: Buffer, channel: number, commandId: number) => {
        queueMicrotask(() => session.emit("commandResult", { code: 0, channel, commandId }));
        return true;
      }),
    });
    const router = routerWithSession(session, {
      deps: {
        listDevices: () => [
          {
            sn: STATION_SN,
            stationSn: STATION_SN,
            model: "T8010",
            channel: 0,
            raw: { member: { admin_user_id: ACCOUNT_ID } },
          } as never,
        ],
      },
    });
    await router.dispatchCommand(STATION_SN, { kind: "set-param", param: 1045, value: 1, channel: 0 });
    expect(session.sendBytes.mock.calls[0]![1]).toBe(255);
  });
});
