import { describe, expect, it, vi } from "vitest";
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

  it("completes the frame when the missing datagram is retransmitted", () => {
    const { feed, received, gapTraces } = harness();
    const payload = Buffer.alloc(48, 7);
    const frame = commandFrame(40, 1300, payload);

    // The middle datagram is overtaken by the one after it, then arrives on the device's repeat.
    feed(dataPacket(40, frame.subarray(0, 24)));
    feed(dataPacket(42, frame.subarray(40)));
    feed(dataPacket(41, frame.subarray(24, 40)));

    expect(received).toHaveLength(1);
    expect(received[0]!.commandId).toBe(1300);
    expect(received[0]!.raw).toEqual(payload);
    expect(gapTraces()).toHaveLength(0);
  });

  it("re-arms the wait when abandoning one hole leaves another hole held", () => {
    vi.useFakeTimers();
    try {
      const { feed, received } = harness();
      feed(dataPacket(40, commandFrame(40, 1300, Buffer.from([1]))));
      feed(dataPacket(42, commandFrame(42, 1300, Buffer.from([2]))));
      feed(dataPacket(43, commandFrame(43, 1300, Buffer.from([3]))));
      feed(dataPacket(45, commandFrame(45, 1300, Buffer.from([5]))));

      vi.advanceTimersToNextTimer();
      expect(received.map((frame) => frame.raw[0])).toEqual([1, 2, 3]);
      vi.advanceTimersToNextTimer();
      expect(received.map((frame) => frame.raw[0])).toEqual([1, 2, 3, 5]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives a later hole a full wait after the earlier hole is filled", () => {
    vi.useFakeTimers();
    try {
      const { feed, received } = harness();
      feed(dataPacket(40, commandFrame(40, 1300, Buffer.from([0]))));
      feed(dataPacket(42, commandFrame(42, 1300, Buffer.from([2]))));
      feed(dataPacket(44, commandFrame(44, 1300, Buffer.from([4]))));

      vi.advanceTimersByTime(240);
      feed(dataPacket(41, commandFrame(41, 1300, Buffer.from([1]))));
      expect(received.map((frame) => frame.raw[0])).toEqual([0, 1, 2]);
      vi.advanceTimersByTime(249);
      expect(received.map((frame) => frame.raw[0])).toEqual([0, 1, 2]);
      vi.advanceTimersToNextTimer();
      expect(received.map((frame) => frame.raw[0])).toEqual([0, 1, 2, 4]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers an overflowing hold in sequence across wraparound without leaving a timer", () => {
    vi.useFakeTimers();
    try {
      const { feed, received } = harness();
      feed(dataPacket(65_530, commandFrame(65_530, 1300, Buffer.from([255]))));
      for (let i = 0; i < 129; i++) {
        const sequence = (65_532 + i) & 0xffff;
        feed(dataPacket(sequence, commandFrame(sequence, 1300, Buffer.from([i]))));
      }

      expect(received.map((frame) => frame.raw[0])).toEqual([255, ...Array.from({ length: 129 }, (_, i) => i)]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an incomplete frame once a forward gap goes unrepaired, and resynchronizes", () => {
    vi.useFakeTimers();
    try {
      const { feed, received, debug } = harness();
      const incomplete = commandFrame(40, 1300, Buffer.alloc(48, 7)).subarray(0, 20);

      feed(dataPacket(40, incomplete));
      feed(dataPacket(42, Buffer.alloc(8)));
      feed(dataPacket(43, commandFrame(43, 1301, Buffer.from([1, 2, 3]))));

      // Held while the missing datagram could still be repeated; nothing is discarded yet.
      expect(received).toHaveLength(0);
      vi.advanceTimersToNextTimer();

      expect(received).toHaveLength(1);
      expect(received[0]!.commandId).toBe(1301);
      expect(debug).toHaveBeenCalledWith(
        LIVE_TRACE_MESSAGE,
        expect.objectContaining({ phase: "datagram-gap", dataType: VIDEO_DATA_TYPE }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("traces a bounded number of datagram gaps however many the channel drops", () => {
    vi.useFakeTimers();
    try {
      const { feed, gapTraces } = harness();

      for (let i = 0; i < 40; i++) {
        feed(dataPacket(100 + i * 3, commandFrame(100 + i * 3, 1300, Buffer.alloc(48, 7)).subarray(0, 20)));
        vi.advanceTimersToNextTimer();
      }

      expect(gapTraces().length).toBeGreaterThan(0);
      expect(gapTraces().length).toBeLessThanOrEqual(8);
    } finally {
      vi.useRealTimers();
    }
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
    vi.useFakeTimers();
    try {
      const { feed, received, close } = harness();
      const payload = Buffer.alloc(48, 7);

      feed(dataPacket(40_000, commandFrame(40_000, 1300, payload)));
      feed(dataPacket(40_002, commandFrame(40_002, 1300, Buffer.from([9]))));
      await close();
      expect(vi.getTimerCount()).toBe(0);
      feed(dataPacket(5, commandFrame(5, 1300, payload)));
      feed(dataPacket(6, commandFrame(6, 1301, Buffer.from([1]))));
      vi.runAllTimers();

      expect(received.map(({ commandId }) => commandId)).toEqual([1300, 1300, 1301]);
      expect(received[1]!.raw).toEqual(payload);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resynchronizes onto numbering the device restarts mid-connection", () => {
    vi.useFakeTimers();
    try {
      const { feed, received, debug } = harness();
      const payload = Buffer.alloc(48, 7);
      const restarted = commandFrame(0, 1300, payload);

      feed(dataPacket(20_000, commandFrame(20_000, 1300, payload).subarray(0, 20)));
      feed(dataPacket(20_002, commandFrame(20_002, 1301, Buffer.from([9]))));
      feed(dataPacket(0, restarted.subarray(0, 24)));
      feed(dataPacket(1, restarted.subarray(24)));
      feed(dataPacket(2, commandFrame(2, 1301, Buffer.from([1, 2, 3]))));
      vi.runAllTimers();

      expect(received.map(({ commandId }) => commandId)).toEqual([1300, 1301]);
      expect(received[0]!.raw).toEqual(payload);
      expect(vi.getTimerCount()).toBe(0);
      expect(debug).toHaveBeenCalledWith(
        LIVE_TRACE_MESSAGE,
        expect.objectContaining({ phase: "sequence-restart", dataType: VIDEO_DATA_TYPE }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([1, 4, 15])(
    "carries a frame header cut %i bytes in by the datagram boundary into the next datagram",
    (cut) => {
      const { feed, received } = harness();
      const first = commandFrame(80, 1300, Buffer.alloc(20, 1));
      const second = commandFrame(80, 1301, Buffer.alloc(30, 2));
      const third = commandFrame(80, 1300, Buffer.alloc(10, 3));
      const stream = Buffer.concat([first, second, third]);

      feed(dataPacket(80, stream.subarray(0, first.length + cut)));
      feed(dataPacket(81, stream.subarray(first.length + cut)));

      expect(received.map(({ commandId }) => commandId)).toEqual([1300, 1301, 1300]);
      expect(received[1]!.raw).toEqual(Buffer.alloc(30, 2));
      expect(received[2]!.raw).toEqual(Buffer.alloc(10, 3));
    },
  );

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
});
