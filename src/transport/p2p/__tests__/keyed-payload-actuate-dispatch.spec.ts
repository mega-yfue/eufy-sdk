import { createDecipheriv, createECDH } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eciesUnwrap } from "../codec.js";
import { CommandType } from "../commands.js";
import { KEYED_PAYLOAD_SEQ_ERROR, serialIv } from "../keyed-payload.js";
import {
  ACCOUNT_ID,
  DEVICE_SN,
  STATION_SN,
  connectedSession,
  onFakeTime,
  routerWithSession,
  type FakeP2PSession,
} from "./session-fixtures.js";

/**
 * `sendKeyedPayloadActuate` (the `keyed-payload-actuate` intent handler behind `dev.lock()` on the classic
 * Wi-Fi lock): the sealed fields go out as a keyed `sendSetPayload` envelope on the device channel, and the
 * command settles on the first of the device's replies — the `SET_PAYLOAD` echo carrying the int32 result, or
 * the state report it sends once a command changed something. The fake session records every send and answers
 * each one from the test's script, the way the device does: by echo, by report, or by neither.
 */

// Synthetic device key pair: the "device" side of the ECDH, so the spec can open what each envelope seals.
const device = createECDH("prime256v1");
device.setPrivateKey(Buffer.alloc(32, 7));
const devicePublicKeyHex = device.getPublicKey("hex").slice(2);
const devicePrivateKeyHex = Buffer.alloc(32, 7).toString("hex");

/** The device channel the fixture record declares, and so the channel every reply has to arrive on. */
const CHANNEL = 1;
const REPLY_MS = 6000;
const TWIN_MS = 500;
const FIRST_SEQ = 42;

interface Inner {
  shortUserId: string;
  slOperation: number;
  userId: string;
  userName: string;
  seq_num: number;
}

interface Sent {
  subCmd: number;
  payload: string;
  opts: { accountId?: string; channel?: number; key?: string };
  inner: Inner;
}

/** What the fake device sends back for one send: an echo code, a state-report code, a published mark, or none. */
interface Answer {
  echo?: number;
  report?: number;
  /** The `slState` the report states — by default the state the command drove to. */
  slState?: string;
  /** A sequence refusal's mark twin — a `CMD_DOORLOCK_P2P_SEQ` (1916) carrying `seq_num`. */
  mark?: number;
  channel?: number;
}

interface FakeSession extends FakeP2PSession {
  sendSetPayload: ReturnType<typeof vi.fn>;
}

/** Open an envelope the way the device does: unseal the per-command key with the device key, then the JSON. */
function open(keyHex: string, payloadB64: string): Inner {
  const aesKeyHex = eciesUnwrap(Buffer.from(keyHex, "hex"), devicePrivateKeyHex, {
    verifyHmac: true,
    pkcs7: true,
  })!.toString("utf8");
  const opener = createDecipheriv("aes-128-cbc", Buffer.from(aesKeyHex, "hex"), serialIv(DEVICE_SN));
  return JSON.parse(
    Buffer.concat([opener.update(Buffer.from(payloadB64, "base64")), opener.final()]).toString("utf8"),
  ) as Inner;
}

/**
 * Deliver one answer the way the session surfaces it: the echo as `commandResult`, the report as a frame
 * stating `slState` — the state the answered command drove to, unless the answer names another.
 */
function reply(session: FakeSession, answer: Answer, slState = "4"): void {
  const channel = answer.channel ?? CHANNEL;
  if (answer.echo !== undefined) session.emit("commandResult", { code: answer.echo, channel });
  if (answer.report !== undefined) {
    session.emit("data", {
      commandId: CommandType.CMD_NOTIFY_PAYLOAD,
      channel,
      json: {
        cmd: CommandType.P2P_QUERY_STATUS_IN_LOCK,
        payload: { code: answer.report, slBattery: "48", slState: answer.slState ?? slState, trigger: 2 },
      },
    });
  }
  if (answer.mark !== undefined) {
    session.emit("data", {
      commandId: CommandType.CMD_NOTIFY_PAYLOAD,
      channel,
      json: {
        cmd: CommandType.CMD_DOORLOCK_P2P_SEQ,
        payload: { lock_cmd: CommandType.P2P_ON_OFF_LOCK, seq_num: answer.mark },
      },
    });
  }
}

/** The device's echo and report for a command it carried out. */
const accepted: Answer[] = [{ echo: 0, report: 0 }];
/** The device's echo and mark twin for a command whose sequence was not above the mark it holds. */
const refusedAt = (mark: number): Answer[] => [{ echo: KEYED_PAYLOAD_SEQ_ERROR, mark }];

/**
 * A router on a fake session whose device answers each send from `script` — a function of the send and its
 * index, so a device can keep a sequence mark. The sequence starts at a known number so every `seq_num` is
 * predictable. `nickName` puts a display name on the device record's member.
 */
function harness(script: (sent: Sent, index: number) => Answer[], opts: { nickName?: string } = {}) {
  const session = connectedSession(false) as FakeSession;
  const sent: Sent[] = [];
  session.sendSetPayload = vi.fn((subCmd: number, payload: string, o: Sent["opts"]) => {
    const record: Sent = { subCmd, payload, opts: o, inner: open(o.key!, payload) };
    sent.push(record);
    const answers = script(record, sent.length - 1);
    queueMicrotask(() => {
      for (const answer of answers) reply(session, answer, record.inner.slOperation ? "4" : "3");
    });
  });
  const member = { admin_user_id: ACCOUNT_ID, ...(opts.nickName ? { nick_name: opts.nickName } : {}) };
  const router = routerWithSession(session, {
    deps: {
      mega: { getDevicePublicKey: vi.fn(async () => devicePublicKeyHex) } as never,
      listDevices: () =>
        [
          {
            sn: DEVICE_SN,
            stationSn: STATION_SN,
            model: "T8520",
            channel: CHANNEL,
            raw: { parent_sn: STATION_SN, device_channel: CHANNEL, member },
          },
          { sn: STATION_SN, stationSn: STATION_SN, p2pDid: "", model: "T8520", raw: { member } },
        ] as never,
    },
  });
  const sequences = (router as unknown as { keyedSequences: Map<string, number> }).keyedSequences;
  sequences.set(DEVICE_SN, FIRST_SEQ - 1);
  const actuate = (engage = true) =>
    router.dispatchCommand(DEVICE_SN, {
      kind: "keyed-payload-actuate",
      engage,
      adminUserId: ACCOUNT_ID,
      username: "account-name",
      shortUserId: "0003",
      deviceSn: DEVICE_SN,
    });
  return { session, sent, sequences, actuate, lastSequence: () => sequences.get(DEVICE_SN) };
}

/**
 * A device that refuses every sequence at or below `mark`, publishing `mark` in the refusal's twin, and
 * moves the mark to each number it accepts.
 */
function deviceWithMark(mark: number) {
  return (sent: Sent): Answer[] => {
    if (sent.inner.seq_num <= mark) return refusedAt(mark);
    mark = sent.inner.seq_num;
    return accepted;
  };
}

describe("P2PCommandRouter.sendKeyedPayloadActuate (keyed-payload-actuate command-router branch)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the sealed fields as a keyed SET_PAYLOAD envelope on the device channel, and settles on the echo", async () => {
    const { sent, actuate, lastSequence } = harness(() => accepted, { nickName: "Front Door Admin" });
    await actuate(true);

    expect(sent).toHaveLength(1);
    const [only] = sent;
    expect(only!.subCmd).toBe(CommandType.P2P_ON_OFF_LOCK);
    expect(only!.opts).toEqual({ accountId: ACCOUNT_ID, channel: CHANNEL, key: expect.any(String) });
    expect(only!.inner).toEqual({
      shortUserId: "0003",
      slOperation: 1,
      userId: ACCOUNT_ID,
      userName: "Front Door Admin",
      seq_num: FIRST_SEQ,
    });
    expect(lastSequence()).toBe(FIRST_SEQ);
  });

  it("releases with slOperation 0, and names the acting member by the account name when the record has no nick_name", async () => {
    const { sent, actuate } = harness(() => accepted);
    await actuate(false);
    expect(sent[0]!.inner).toMatchObject({ slOperation: 0, userName: "account-name" });
  });

  it("settles on the state report alone when the echo was not read — the report of the state it drove to", async () => {
    const { sent, actuate } = harness(() => [{ report: 0 }]);
    await expect(actuate(true)).resolves.toBe(true);
    await expect(actuate(false)).resolves.toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("reads only a report of the state it drives to: the other state's report is a previous command's, not this one's", async () => {
    // lock() settled on its echo; its report lands about two seconds later, while unlock() is in flight
    // with its own echo unread. That report states locked, so it is not the unlock's answer — the unlock
    // waits for its own, here an echo that rejects it.
    const { sent, actuate } = harness(() => [{ report: 0, slState: "4" }, { echo: -110 }]);
    await expect(actuate(false)).rejects.toThrow("code -110");
    expect(sent).toHaveLength(1);
  });

  it("settles on the echo alone, at once — a command the device was already in the state of draws no report", async () => {
    const { sent, actuate } = harness(() => [{ echo: 0 }]);
    await expect(actuate(true)).resolves.toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("rejects a command that draws no reply at all once the reply window passes, without resending", async () => {
    vi.useFakeTimers();
    const { sent, actuate, lastSequence } = harness(() => []);
    const done = actuate(true);
    const outcome = expect(done).rejects.toThrow(/keyed-payload command to .* drew no reply/);
    await vi.advanceTimersByTimeAsync(REPLY_MS);
    await outcome;
    expect(sent).toHaveLength(1);
    expect(lastSequence()).toBe(FIRST_SEQ);
  });

  it("rejects at once on any echo but 0 or a sequence refusal, without resending", async () => {
    const { sent, actuate, lastSequence } = harness(() => [{ echo: -110 }]);
    await expect(actuate(true)).rejects.toThrow("code -110");
    expect(sent).toHaveLength(1);
    expect(lastSequence()).toBe(FIRST_SEQ);
  });

  it("reads only replies on the device channel: a stray result on another channel is not this command's answer", async () => {
    // A station volunteers frames on the broadcast channel around a connect; one that reads as a result
    // there must not settle a command sent on the device channel.
    const { sent, actuate } = harness(() => [{ echo: 0, channel: 255 }, { echo: -110 }]);
    await expect(actuate(true)).rejects.toThrow("code -110");
    expect(sent).toHaveLength(1);
  });

  it("resends once at the published mark + 1 after a refusal, and records where it landed", async () => {
    // The first send is below the device's mark and is refused; the refusal publishes the mark, so the
    // resend goes straight to mark + 1 — two round trips whatever the distance, no climb.
    const { sent, actuate, lastSequence } = harness(deviceWithMark(9500));
    await actuate(true);

    expect(sent.map((s) => s.inner.seq_num)).toEqual([42, 9501]);
    expect(lastSequence()).toBe(9501);
    // The next command starts just above the number the device accepted.
    await actuate(false);
    expect(sent.at(-1)!.inner.seq_num).toBe(9502);
  });

  it("rejects when the resend at mark + 1 is refused too", async () => {
    // Two refusals and the command gives up with the device's code — it does not keep resending.
    const { sent, actuate } = harness((sent) => refusedAt(sent.inner.seq_num + 100));
    await expect(onFakeTime(() => actuate(true))).rejects.toThrow(`code ${KEYED_PAYLOAD_SEQ_ERROR}`);
    expect(sent).toHaveLength(2);
  });

  it("rejects a refusal that publishes no mark, without resending", async () => {
    // A -151 with no `CMD_DOORLOCK_P2P_SEQ` twin leaves nothing to resend above, so the command rejects on it.
    const { sent, actuate } = harness(() => [{ echo: KEYED_PAYLOAD_SEQ_ERROR }]);
    await expect(actuate(true)).rejects.toThrow(`code ${KEYED_PAYLOAD_SEQ_ERROR}`);
    expect(sent).toHaveLength(1);
  });

  it("holds the resend until the refusal's twin window passes, so a trailing statement is never read as the resend's answer", async () => {
    vi.useFakeTimers();
    const { sent, actuate } = harness((_, index) => (index === 0 ? refusedAt(1000) : accepted));
    const done = actuate(true);
    await vi.advanceTimersByTimeAsync(TWIN_MS - 1);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBe(true);
    expect(sent.map((s) => s.inner.seq_num)).toEqual([FIRST_SEQ, 1001]);
  });

  it("resolves a refusal on its echo alone when no mark twin arrives, after the twin window", async () => {
    vi.useFakeTimers();
    const { sent, actuate } = harness(() => [{ echo: KEYED_PAYLOAD_SEQ_ERROR }]);
    const done = actuate(true);
    const outcome = expect(done).rejects.toThrow(`code ${KEYED_PAYLOAD_SEQ_ERROR}`);
    await vi.advanceTimersByTimeAsync(TWIN_MS);
    await outcome;
    expect(sent).toHaveLength(1);
  });

  it("runs commands for one device one at a time, so a second waits for the first to settle", async () => {
    const { session, sent, actuate } = harness(() => []);
    const first = actuate(true);
    const second = actuate(false);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    reply(session, { echo: 0, report: 0 });
    await first;
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]!.inner).toMatchObject({ slOperation: 0, seq_num: FIRST_SEQ + 1 });
    reply(session, { echo: 0, report: 0 });
    await second;
  });
});
