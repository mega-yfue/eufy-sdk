import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAckPayload,
  decryptP2PData,
  frameMessage,
  parseDataFrameHeader,
  p2pCommandEncryptionKey,
  P2PDataTypeHeader,
  ResponseMessageType,
} from "../codec.js";
import { LIVE_TRACE_MESSAGE } from "../live-trace.js";
import { P2PSession } from "../p2p-session.js";

const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const ADMIN_ACCOUNT_ID = "0000000000000000000000000000000000000000";
const ADDRESS = { host: "127.0.0.1", port: 1 };
/** The frame header sits 4 bytes in, and its encrypted body 16 bytes after that. */
const FRAME_BODY_OFFSET = 20;

/**
 * A connected own-session camera whose socket send is captured: the start frame and its retransmission are
 * what the device would receive, so the assertions read the exact bytes handed to the socket.
 */
function harness() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID, logger });
  const send = vi.fn();
  const target = session as unknown as {
    connectAddress: typeof ADDRESS;
    send: typeof send;
    onAck: (message: Buffer) => void;
  };
  target.connectAddress = ADDRESS;
  target.send = send;
  return {
    session,
    send,
    debug: logger.debug,
    sentFrame: (index: number) => send.mock.calls[index]![2] as Buffer,
    decodedFrame: (index: number) => {
      const data = send.mock.calls[index]![2] as Buffer;
      const header = parseDataFrameHeader(data.subarray(4));
      const encrypted = data.subarray(FRAME_BODY_OFFSET, FRAME_BODY_OFFSET + header.bytesToRead);
      return JSON.parse(
        decryptP2PData(encrypted, Buffer.from(p2pCommandEncryptionKey(STATION_SN, P2P_DID)))
          .toString("utf8")
          .replace(/\0+$/, ""),
      );
    },
    acknowledge: (sequence: number) =>
      target.onAck(frameMessage(ResponseMessageType.ACK, buildAckPayload(P2PDataTypeHeader.DATA, sequence))),
  };
}

describe("live start acknowledgement diagnostics", () => {
  afterEach(() => vi.useRealTimers());

  it("reports when the camera acknowledges an own-session live start", () => {
    vi.useFakeTimers();
    const { session, send, debug, acknowledge } = harness();

    session.startLiveMedia();
    acknowledge(0);

    expect(debug).toHaveBeenCalledWith(
      LIVE_TRACE_MESSAGE,
      expect.objectContaining({ phase: "media-command-ack", action: "start" }),
    );
    vi.advanceTimersByTime(1000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("uses the current app's own-session START_LIVE fields", () => {
    const { session, decodedFrame } = harness();

    session.startLiveMedia(0, ADMIN_ACCOUNT_ID);
    const value = decodedFrame(0);

    expect(value).toMatchObject({ commandType: 1000 });
    expect(value.data).toMatchObject({ cmd: 1000, msg_id: 1, extValue: 1000, streamtype: 2, video_type: 12 });
  });

  it("rejects the unverified own-session stream type without sending a start", () => {
    const { session, send } = harness();

    expect(() => session.startLiveMedia(0, ADMIN_ACCOUNT_ID, false, { streamType: 1 })).toThrow(RangeError);
    expect(send).not.toHaveBeenCalled();
  });

  it("repeats an unacknowledged live start byte-identically", () => {
    vi.useFakeTimers();
    const { session, send, sentFrame } = harness();

    session.startLiveMedia();
    const first = sentFrame(0);
    vi.advanceTimersByTime(1000);

    expect(send.mock.calls.length).toBeGreaterThan(2);
    for (const [, , frame] of send.mock.calls) expect(frame).toEqual(first);
  });

  it("gives up on a start the camera never acknowledges, and says so", () => {
    vi.useFakeTimers();
    const { session, send, debug } = harness();

    session.startLiveMedia();
    vi.advanceTimersByTime(3000);
    const sent = send.mock.calls.length;
    vi.advanceTimersByTime(10_000);

    expect(debug).toHaveBeenCalledWith(
      LIVE_TRACE_MESSAGE,
      expect.objectContaining({ phase: "media-command-unacknowledged", action: "start" }),
    );
    expect(send).toHaveBeenCalledTimes(sent);
  });

  it("issues a fresh start after abandoning one, rather than nudging a stream that never began", () => {
    vi.useFakeTimers();
    const { session, send, debug, sentFrame } = harness();

    session.startLiveMedia();
    const first = sentFrame(0);
    vi.advanceTimersByTime(3000);
    const abandoned = send.mock.calls.length;
    session.startLiveMedia();

    expect(send).toHaveBeenCalledTimes(abandoned + 1);
    const reissued = sentFrame(abandoned);
    expect(reissued).not.toEqual(first);
    expect(reissued.subarray(4).length).toBe(first.subarray(4).length);
    expect(debug).toHaveBeenCalledWith(
      LIVE_TRACE_MESSAGE,
      expect.objectContaining({ phase: "media-command", action: "start" }),
    );
  });

  it("stops retransmitting once the acknowledgement lands", () => {
    vi.useFakeTimers();
    const { session, send, debug, acknowledge } = harness();

    session.startLiveMedia();
    vi.advanceTimersByTime(150);
    acknowledge(0);
    const sent = send.mock.calls.length;
    vi.advanceTimersByTime(5000);

    expect(send).toHaveBeenCalledTimes(sent);
    expect(debug).not.toHaveBeenCalledWith(
      LIVE_TRACE_MESSAGE,
      expect.objectContaining({ phase: "media-command-unacknowledged" }),
    );
  });
});
