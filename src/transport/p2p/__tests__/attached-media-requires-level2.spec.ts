import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { LIVE_TRACE_MESSAGE } from "../live-trace.js";
import {
  buildAckPayload,
  frameMessage,
  parseDataFrameHeader,
  P2PDataTypeHeader,
  ResponseMessageType,
} from "../codec.js";
import { P2PCommandRouter } from "../command-router.js";
import { LiveStream } from "../live-stream.js";
import { p2pVideoFrame } from "./live-source-fixtures.js";

/**
 * A HomeBase-attached camera's media start has no level-1 wire.
 *
 * `sendMediaPayloadLevel2` returns without sending when there is no level-2 key, so on a connection whose
 * negotiation settled without one, every attached start is a no-op: nothing reaches the station, nothing
 * reports it, and the warm-up re-issues on a two-second interval until it times out. Observed on a real
 * account as 48 attached starts, all with no key, one keyframe between them and a `source-error` at the end —
 * where the retry that followed rebuilt the session, negotiated a key at once, and streamed in 0.69 s.
 *
 * An own-session camera is unaffected: `sendStartLiveOwnSession` carries both levels and picks by the key it
 * holds, which is why the hardening is on the attached path alone.
 *
 * The silence is the second half of the defect. A command that was never put on the wire has to say so, or
 * it is indistinguishable from one the station ignored — which is what made 48 of them invisible.
 */
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

function attachedSession(withKey: boolean) {
  const debug = vi.fn();
  const built = new P2PSession({
    stationSn: STATION_SN,
    p2pDid: P2P_DID,
    logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const internals = built as unknown as {
    connectAddress?: { address: string; port: number };
    level2Key?: Buffer;
    send: (...args: unknown[]) => void;
    decryptLevel2: (payload: Buffer, signCode: number) => Buffer | undefined;
    onAck: (message: Buffer) => void;
  };
  internals.connectAddress = { address: "203.0.113.1", port: 32100 };
  if (withKey) internals.level2Key = Buffer.alloc(32, 7);
  const sent: unknown[][] = [];
  internals.send = (...args: unknown[]) => sent.push(args);
  return {
    session: built,
    sent,
    debug,
    acknowledge: (sequence: number) =>
      internals.onAck(frameMessage(ResponseMessageType.ACK, buildAckPayload(P2PDataTypeHeader.DATA, sequence))),
    decodedFrame: (index: number) => {
      const data = sent[index]![2] as Buffer;
      const header = parseDataFrameHeader(data.subarray(4));
      const body = data.subarray(20, 20 + header.bytesToRead);
      const plain = internals.decryptLevel2(body, header.signCode);
      if (!plain) throw new Error("captured media command did not decrypt");
      return { header, value: JSON.parse(plain.toString("utf8")) };
    },
  };
}

const traces = (debug: ReturnType<typeof vi.fn>) =>
  debug.mock.calls.filter(([message]) => message === LIVE_TRACE_MESSAGE).map(([, trace]) => trace);

describe("an attached media start with no level-2 key", () => {
  it("puts nothing on the wire, because that wire does not exist without the key", () => {
    const { session, sent } = attachedSession(false);

    session.startLiveMedia(2, "account", true);

    expect(sent).toEqual([]);
  });

  it("says it was not sent, rather than leaving it indistinguishable from one the station ignored", () => {
    const { session, debug } = attachedSession(false);

    session.startLiveMedia(2, "account", true);

    expect(traces(debug)).toContainEqual(
      expect.objectContaining({ phase: "media-command-unsent", reason: "level2-key" }),
    );
  });

  it("puts it on the wire once the key is held, and says nothing about being unsent", () => {
    const { session, sent, debug } = attachedSession(true);

    session.startLiveMedia(2, "account", true);

    expect(sent).toHaveLength(1);
    expect(traces(debug).map((t) => (t as { phase: string }).phase)).not.toContain("media-command-unsent");
  });

  it("preserves the attached default and selects a stream type", () => {
    const { session, decodedFrame } = attachedSession(true);
    const accountId = "0".repeat(40);

    session.startLiveMedia(2, accountId, true);
    expect(decodedFrame(0).value).toMatchObject({ cmd: 1003, payload: { streamtype: 1 } });

    session.startLiveMedia(2, accountId, true, { streamType: 2 });
    const start = decodedFrame(1);
    expect(start.header).toMatchObject({ commandId: 1350, channel: 2, signCode: 8 });
    expect(start.value).toMatchObject({ cmd: 1003, payload: { streamtype: 2 } });
  });
});

describe("the managed live stream type", () => {
  it.each([
    [true, 2],
    [false, 2],
  ] as const)(
    "keeps the public first opener's selection through retries (attached=%s, type=%s)",
    async (attached, streamType) => {
      vi.useFakeTimers();
      const { session, sent, decodedFrame, acknowledge } = attachedSession(true);
      const start = vi.spyOn(session, "startLiveMedia");
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const router = new P2PCommandRouter({
        mega: {} as never,
        logger,
        listDevices: () => [],
        ensureDevices: async () => {},
        onConnect: () => {},
        onClose: () => {},
        onError: () => {},
        onLevel2Ready: () => {},
        onFrame: () => {},
      });
      (router as unknown as { resolveSession: unknown }).resolveSession = async () => ({
        session,
        parentSn: STATION_SN,
        channel: 2,
        accountId: "0".repeat(40),
        homeBaseAttached: attached,
      });
      try {
        const media = router.mediaProviderFor(STATION_SN);
        const first = await media.live({ streamType, lingerMs: 0 });
        const joined = await media.live({ streamType: attached ? (streamType === 2 ? 1 : 2) : 2 });
        if (!attached) acknowledge(0);
        vi.advanceTimersByTime(6000);

        expect(start).toHaveBeenCalledWith(2, "0".repeat(40), attached, { force: true, streamType });
        const starts = sent
          .map((args, index) => ({ header: parseDataFrameHeader((args[2] as Buffer).subarray(4)), index }))
          .filter(({ header }) => header.commandId === 1350 || header.commandId === 1700)
          .map(({ index }) => decodedFrame(index).value)
          .filter((value) => value.cmd === 1003 || value.commandType === 1000);
        expect(starts.length).toBeGreaterThan(1);
        for (const value of starts) expect((value.payload ?? value.data).streamtype).toBe(streamType);
        if (attached) expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("streamType"));

        joined.stop();
        first.stop();
        vi.advanceTimersByTime(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("rejects an unverified own-session selection before opening a source", async () => {
    const { session, sent } = attachedSession(true);
    const router = new P2PCommandRouter({
      mega: {} as never,
      listDevices: () => [],
      ensureDevices: async () => {},
      onConnect: () => {},
      onClose: () => {},
      onError: () => {},
      onLevel2Ready: () => {},
      onFrame: () => {},
    });
    (router as unknown as { resolveSession: unknown }).resolveSession = async () => ({
      session,
      parentSn: STATION_SN,
      channel: 2,
      accountId: "0".repeat(40),
      homeBaseAttached: false,
    });

    await expect(router.mediaProviderFor(STATION_SN).live({ streamType: 1 })).rejects.toThrow(RangeError);
    expect(sent).toHaveLength(0);
  });

  it("retains the selected type when an attached stream reasserts after silence", () => {
    vi.useFakeTimers();
    const { session, sent, decodedFrame } = attachedSession(true);
    const stream = new LiveStream(session, {
      channel: 2,
      homeBaseAttached: true,
      streamType: 2,
      keepAliveMs: 20,
      stallMs: 50,
    });
    try {
      stream.start();
      session.emit("data", p2pVideoFrame({ nal: Buffer.from([0x65, 0x11]), keyframe: true, channel: 2 }));
      vi.advanceTimersByTime(49);
      expect(sent).toHaveLength(1);
      vi.advanceTimersByTime(22);
      expect(sent.length).toBeGreaterThan(1);
      for (let index = 0; index < sent.length; index++) {
        expect(decodedFrame(index).value).toMatchObject({ cmd: 1003, payload: { streamtype: 2 } });
      }
    } finally {
      stream.stop();
      vi.useRealTimers();
    }
  });
});
