import { P2PDataType, type P2PDataFrameHeader } from "../codec.js";
import { CommandType } from "../commands.js";
import { P2PSession } from "../p2p-session.js";

const receive = (commandId: number, dataType: number, payload: Buffer) => {
  const session = new P2PSession({ stationSn: "T8420P0000000000", p2pDid: "XXXXXXX-000000-XXXXX" });
  const receiver = session as unknown as {
    handleFrame(header: P2PDataFrameHeader, body: Buffer, dataType: number): void;
    sendCommand(command: number, channel: number): void;
  };
  const reply = vi.spyOn(receiver, "sendCommand").mockImplementation(() => {});
  const received = vi.fn();
  session.on("data", received);
  receiver.handleFrame(
    { commandId, channel: 3, signCode: 0, bytesToRead: payload.length } as P2PDataFrameHeader,
    payload,
    dataType,
  );
  return { reply, received };
};

describe("P2P device ping", () => {
  it("answers on the incoming channel and still delivers the frame", () => {
    const { reply, received } = receive(CommandType.CMD_GET_DEVICE_PING, P2PDataType.CONTROL, Buffer.alloc(8));
    expect(reply).toHaveBeenCalledExactlyOnceWith(CommandType.CMD_GET_DEVICE_PING, 3);
    expect(received).toHaveBeenCalledTimes(1);
  });

  it.each([
    [CommandType.CMD_GET_DEVICE_PING, P2PDataType.DATA, Buffer.alloc(8)],
    [CommandType.CMD_GET_DEVICE_PING, P2PDataType.CONTROL, Buffer.alloc(0)],
    [CommandType.CMD_GET_DEVICE_PING, P2PDataType.CONTROL, Buffer.alloc(8, 1)],
    [CommandType.CMD_CAMERA_INFO, P2PDataType.CONTROL, Buffer.alloc(8)],
  ])("does not answer a non-matching frame (%s, %s, %j)", (commandId, dataType, payload) => {
    expect(receive(commandId, dataType, payload).reply).not.toHaveBeenCalled();
  });
});
