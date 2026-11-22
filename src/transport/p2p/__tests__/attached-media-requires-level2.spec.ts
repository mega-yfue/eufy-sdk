import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { LIVE_TRACE_MESSAGE } from "../live-trace.js";
import { parseDataFrameHeader } from "../codec.js";
import { openSentGcm, withGcmKey } from "./session-fixtures.js";

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
    send: (...args: unknown[]) => void;
  };
  internals.connectAddress = { address: "203.0.113.1", port: 32100 };
  if (withKey) withGcmKey(built, Buffer.alloc(32, 7));
  const sent: unknown[][] = [];
  internals.send = (...args: unknown[]) => sent.push(args);
  return {
    session: built,
    sent,
    debug,
    decodedFrame: (index: number) => {
      const data = sent[index]![2] as Buffer;
      const header = parseDataFrameHeader(data.subarray(4));
      const body = data.subarray(20, 20 + header.bytesToRead);
      const plain = openSentGcm(built, body);
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

  it("requests the app's attached live stream type", () => {
    const { session, decodedFrame } = attachedSession(true);
    const accountId = "0".repeat(40);

    session.startLiveMedia(2, accountId, true);
    const start = decodedFrame(0);
    expect(start.header).toMatchObject({ commandId: 1350, channel: 2, signCode: 8 });
    expect(start.value).toMatchObject({ cmd: 1003, payload: { streamtype: 2 } });
  });
});
