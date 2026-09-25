import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCommandHeader,
  buildRawCommandPayload,
  frameMessage,
  P2PDataTypeHeader,
  RequestMessageType,
} from "../codec.js";
import { LIVE_TRACE_MESSAGE } from "../live-trace.js";
import { P2PSession, type P2PFrame } from "../p2p-session.js";

const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const ADDRESS = { host: "127.0.0.1", port: 1 };
const VIDEO_DATA_TYPE = 1;

/** One inbound DATA datagram: the 4-byte data-type + sequence header the device prefixes, then the body. */
function dataPacket(sequence: number, body: Buffer, dataTypeHeader = P2PDataTypeHeader.VIDEO): Buffer {
  const header = Buffer.alloc(4);
  dataTypeHeader.copy(header);
  header.writeUInt16BE(sequence, 2);
  return frameMessage(RequestMessageType.DATA, Buffer.concat([header, body]));
}

/** A framed command whose payload the device splits across datagrams. */
function commandFrame(sequence: number, commandId: number, payload: Buffer): Buffer {
  const dataTypeHeader = commandId === 1351 ? P2PDataTypeHeader.CONTROL : P2PDataTypeHeader.VIDEO;
  return Buffer.concat([
    buildCommandHeader(sequence, commandId, dataTypeHeader).subarray(4),
    buildRawCommandPayload(payload),
  ]);
}

/**
 * A session fed datagrams directly, with its socket send stubbed: reassembly is reached through `onData`
 * because that is the seam the device's datagrams arrive on, and every case here is about what reassembly
 * does with a sequence number.
 */
function harness() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const session = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID, logger });
  const target = session as unknown as {
    onData: (message: Buffer, address: typeof ADDRESS) => void;
    send: () => void;
  };
  target.send = vi.fn();
  const received: P2PFrame[] = [];
  session.on("data", (frame) => received.push(frame));
  return {
    received,
    debug: logger.debug,
    feed: (packet: Buffer) => target.onData(packet, ADDRESS),
    close: () => session.close(),
    gapTraces: () =>
      logger.debug.mock.calls.filter(
        ([message, trace]) => message === LIVE_TRACE_MESSAGE && (trace as { phase?: string })?.phase === "datagram-gap",
      ),
  };
}

describe("P2P data reassembly", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores a retransmitted continuation without discarding the frame being assembled", () => {
    const { feed, received, gapTraces } = harness();
    const payload = Buffer.alloc(48, 7);
    const frame = commandFrame(40, 1300, payload);
    const middle = dataPacket(41, frame.subarray(24, 40));

    feed(dataPacket(40, frame.subarray(0, 24)));
    feed(middle);
    feed(dataPacket(40, frame.subarray(0, 24)));
    feed(middle);
    feed(dataPacket(42, frame.subarray(40)));

    expect(received).toHaveLength(1);
    expect(received[0]!.commandId).toBe(1300);
    expect(received[0]!.raw).toEqual(payload);
    expect(gapTraces()).toHaveLength(0);
  });

  it("drops an incomplete frame on a forward sequence gap that is never filled, and resynchronizes", () => {
    vi.useFakeTimers();
    const { feed, received, debug } = harness();
    const incomplete = commandFrame(40, 1300, Buffer.alloc(48, 7)).subarray(0, 20);

    feed(dataPacket(40, incomplete));
    feed(dataPacket(42, Buffer.alloc(8)));
    feed(dataPacket(43, commandFrame(43, 1301, Buffer.from([1, 2, 3]))));

    expect(received).toHaveLength(0);
    vi.advanceTimersByTime(400);
    expect(received).toHaveLength(1);
    expect(received[0]!.commandId).toBe(1301);
    expect(debug).toHaveBeenCalledWith(
      LIVE_TRACE_MESSAGE,
      expect.objectContaining({ phase: "datagram-gap", dataType: VIDEO_DATA_TYPE }),
    );
  });

  it("traces a bounded number of datagram gaps however many the channel drops", () => {
    vi.useFakeTimers();
    const { feed, gapTraces } = harness();

    for (let i = 0; i < 40; i++) {
      feed(dataPacket(100 + i * 3, commandFrame(100 + i * 3, 1300, Buffer.alloc(48, 7)).subarray(0, 20)));
    }
    vi.advanceTimersByTime(40 * 400);

    expect(gapTraces().length).toBeGreaterThan(0);
    expect(gapTraces().length).toBeLessThanOrEqual(8);
  });

  it("reassembles video independently of an interleaved control frame", () => {
    const { feed, received } = harness();
    const videoPayload = Buffer.alloc(48, 7);
    const video = commandFrame(50, 1300, videoPayload);

    feed(dataPacket(50, video.subarray(0, 24)));
    feed(dataPacket(7, commandFrame(7, 1351, Buffer.from([1, 2, 3])), P2PDataTypeHeader.CONTROL));
    feed(dataPacket(51, video.subarray(24)));

    expect(received.map(({ commandId }) => commandId)).toEqual([1351, 1300]);
    expect(received[1]!.raw).toEqual(videoPayload);
  });

  it("accepts an in-order continuation across sequence wraparound", () => {
    const { feed, received } = harness();
    const payload = Buffer.alloc(48, 7);
    const frame = commandFrame(65_535, 1300, payload);

    feed(dataPacket(65_535, frame.subarray(0, 24)));
    feed(dataPacket(0, frame.subarray(24)));

    expect(received).toHaveLength(1);
    expect(received[0]!.raw).toEqual(payload);
  });

  it("takes a new connection's low sequence numbers instead of reading them as retransmissions", async () => {
    const { feed, received, close } = harness();
    const payload = Buffer.alloc(48, 7);

    feed(dataPacket(40_000, commandFrame(40_000, 1300, payload)));
    await close();
    feed(dataPacket(5, commandFrame(5, 1300, payload)));

    expect(received).toHaveLength(2);
    expect(received[1]!.raw).toEqual(payload);
  });

  it("resynchronizes onto numbering the device restarts mid-connection", () => {
    const { feed, received, debug } = harness();
    const payload = Buffer.alloc(48, 7);
    const restarted = commandFrame(0, 1300, payload);

    feed(dataPacket(20_000, commandFrame(20_000, 1300, payload).subarray(0, 20)));
    feed(dataPacket(0, restarted.subarray(0, 24)));
    feed(dataPacket(1, restarted.subarray(24)));
    feed(dataPacket(2, commandFrame(2, 1301, Buffer.from([1, 2, 3]))));

    expect(received.map(({ commandId }) => commandId)).toEqual([1300, 1301]);
    expect(received[0]!.raw).toEqual(payload);
    expect(debug).toHaveBeenCalledWith(
      LIVE_TRACE_MESSAGE,
      expect.objectContaining({ phase: "sequence-restart", dataType: VIDEO_DATA_TYPE }),
    );
  });

  it("ignores a repeat from as far back as the device has been seen to repeat", () => {
    const { feed, received } = harness();
    const payload = Buffer.alloc(48, 7);
    const frame = commandFrame(1_000, 1300, payload);

    feed(dataPacket(1_000, frame.subarray(0, 24)));
    feed(dataPacket(880, Buffer.alloc(16, 9))); // 120 behind: the deepest repeat the captures show
    feed(dataPacket(1_001, frame.subarray(24)));

    expect(received).toHaveLength(1);
    expect(received[0]!.raw).toEqual(payload);
  });

  it("holds datagrams that overtook a missing one and completes the frame when it is retransmitted", () => {
    const { feed, received, gapTraces } = harness();
    const payload = Buffer.alloc(64, 7);
    const frame = commandFrame(60, 1300, payload);

    feed(dataPacket(60, frame.subarray(0, 24)));
    feed(dataPacket(62, frame.subarray(40, 56)));
    feed(dataPacket(63, frame.subarray(56)));
    expect(received).toHaveLength(0);
    feed(dataPacket(61, frame.subarray(24, 40)));

    expect(received).toHaveLength(1);
    expect(received[0]!.raw).toEqual(payload);
    expect(gapTraces()).toHaveLength(0);
  });

  it("keeps later frames when the hole is finally given up", () => {
    vi.useFakeTimers();
    const { feed, received } = harness();
    const lost = commandFrame(70, 1300, Buffer.alloc(64, 7));
    const next = Buffer.from([4, 5, 6]);

    feed(dataPacket(70, lost.subarray(0, 24)));
    feed(dataPacket(72, lost.subarray(40)));
    feed(dataPacket(73, commandFrame(73, 1301, next)));
    vi.advanceTimersByTime(400);

    expect(received.map(({ commandId }) => commandId)).toEqual([1301]);
    expect(received[0]!.raw).toEqual(next);
  });

  it("gives the hole up at once when too many datagrams are held behind it", () => {
    const { feed, received } = harness();
    const frames = Array.from({ length: 513 }, (_, i) => commandFrame(i, 1301, Buffer.from([i & 0xff])));

    feed(dataPacket(0, frames[0]!));
    for (let i = 2; i <= 514; i++) feed(dataPacket(i, frames[i - 2]!));

    expect(received).toHaveLength(514);
  });

  it("carries a frame header cut by the datagram boundary into the next datagram", () => {
    const { feed, received } = harness();
    const first = commandFrame(80, 1300, Buffer.alloc(20, 1));
    const second = commandFrame(80, 1301, Buffer.alloc(30, 2));
    const third = commandFrame(80, 1300, Buffer.alloc(10, 3));
    const stream = Buffer.concat([first, second, third]);
    const cut = first.length + 6;

    feed(dataPacket(80, stream.subarray(0, cut)));
    feed(dataPacket(81, stream.subarray(cut)));

    expect(received.map(({ commandId }) => commandId)).toEqual([1300, 1301, 1300]);
    expect(received[1]!.raw).toEqual(Buffer.alloc(30, 2));
    expect(received[2]!.raw).toEqual(Buffer.alloc(10, 3));
  });

  it("drops held datagrams when the device restarts its numbering", () => {
    vi.useFakeTimers();
    const { feed, received } = harness();
    const payload = Buffer.from([7, 8, 9]);

    feed(dataPacket(30_000, commandFrame(30_000, 1300, Buffer.alloc(48, 7)).subarray(0, 20)));
    feed(dataPacket(30_002, Buffer.alloc(8)));
    feed(dataPacket(0, commandFrame(0, 1301, payload)));
    vi.advanceTimersByTime(400);

    expect(received.map(({ commandId }) => commandId)).toEqual([1301]);
    expect(received[0]!.raw).toEqual(payload);
  });
});
