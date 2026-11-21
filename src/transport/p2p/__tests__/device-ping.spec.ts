import { describe, expect, it, vi } from "vitest";
import { P2PDataType, RequestMessageType, type P2PDataFrameHeader } from "../codec.js";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { CommandType } from "../commands.js";
import type { P2PSession } from "../p2p-session.js";

const ACCOUNT_ID = "0".repeat(40);
const STATION = "T8000P0000000000";
const ADDRESS = { host: "127.0.0.1", port: 1 };

/**
 * `P2PReceiver` answers every 1152 notify with `ZmediaUtil.sendDevicePing`: msgType 4, channel 0, `mValue` and
 * `mValueSub` 0, so the group-A body `[u32 0][u32 0][128 zero bytes]`, through the app's sender (1.45 s at sign
 * mode 0, then in the clear).
 */
describe("P2P connection device ping", () => {
  it("answers before live media", () => {
    vi.useFakeTimers();
    const onFrame = vi.fn();
    const router = new P2PCommandRouter({
      mega: { auth: { userId: "1".repeat(40) } },
      listDevices: () => [],
      ensureDevices: async () => {},
      onConnect: vi.fn(),
      onClose: vi.fn(),
      onError: vi.fn(),
      onLevel2Ready: vi.fn(),
      onFrame,
    } as unknown as P2PRouterDeps);
    const factory = router as unknown as {
      makeSession(...args: unknown[]): P2PSession;
    };
    const session = factory.makeSession(
      STATION,
      "XXXXXXX-000000-XXXXX",
      { member: { admin_user_id: ACCOUNT_ID } },
      undefined,
      undefined,
    );
    const receiver = session as unknown as {
      handleFrame(header: P2PDataFrameHeader, body: Buffer, dataType: number): void;
      connectAddress: typeof ADDRESS;
      level1Key: Buffer;
      send(address: typeof ADDRESS, type: Buffer, payload: Buffer): void;
    };
    receiver.connectAddress = ADDRESS;
    receiver.level1Key = Buffer.alloc(16, 0x11);
    const reply = vi.spyOn(receiver, "send").mockImplementation(() => {});
    session.emit("connect");
    expect(reply).not.toHaveBeenCalled();
    const received = vi.fn();
    session.on("data", received);
    receiver.handleFrame(
      {
        commandId: CommandType.CMD_GET_DEVICE_PING,
        channel: 0,
        signCode: 0,
        bytesToRead: 8,
      } as P2PDataFrameHeader,
      Buffer.alloc(8),
      P2PDataType.CONTROL,
    );
    expect(reply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_450);
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      ADDRESS,
      RequestMessageType.DATA,
      Buffer.concat([Buffer.from("d1000000585a5948800488000000010000000000", "hex"), Buffer.alloc(136)]),
    );
    expect(received).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledTimes(1);

    reply.mockClear();
    received.mockClear();
    onFrame.mockClear();
    receiver.handleFrame(
      {
        commandId: CommandType.CMD_GET_DEVICE_PING,
        channel: 3,
        signCode: 0,
        bytesToRead: 4,
      } as P2PDataFrameHeader,
      Buffer.alloc(4, 7),
      P2PDataType.CONTROL,
    );
    vi.advanceTimersByTime(1_450);
    // Any 1152 notify, whatever its channel or body, is answered the same way.
    expect(reply).toHaveBeenCalledTimes(1);
    expect((reply.mock.calls[0]![2] as Buffer).subarray(20)).toEqual(Buffer.alloc(136));
    expect(received).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
