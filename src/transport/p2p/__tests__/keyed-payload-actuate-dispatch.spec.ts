import { createDecipheriv, createECDH } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eciesUnwrap } from "../codec.js";
import { CommandType } from "../commands.js";
import { KEYED_PAYLOAD_CMD, KEYED_PAYLOAD_SEQ_ERROR, serialIv } from "../keyed-payload.js";
import {
  ACCOUNT_ID,
  DEVICE_SN,
  STATION_SN,
  connectedSession,
  routerWithSession,
  type FakeP2PSession,
} from "./session-fixtures.js";

/**
 * `sendKeyedPayloadActuate` (the `keyed-payload-actuate` intent handler behind `dev.lock()` on the classic
 * Wi-Fi lock): the sealed fields go out as a keyed `sendSetPayload` envelope on the device channel, and the
 * command settles on what the device answers — the `SET_PAYLOAD` echo carrying the int32 result, and the
 * state report it sends once a command changed something. The fake session records every send and answers
 * each one from the test's script, the way the device does: by echo, by report, or by neither.
 */

// Synthetic device key pair: the "device" side of the ECDH, so the spec can open what each envelope seals.
const device = createECDH("prime256v1");
device.setPrivateKey(Buffer.alloc(32, 7));
const devicePublicKeyHex = device.getPublicKey("hex").slice(2);
const devicePrivateKeyHex = Buffer.alloc(32, 7).toString("hex");

/** The device channel the fixture record declares, and so the channel every reply has to arrive on. */
const CHANNEL = 1;
const ECHO_MS = 6000;
const NOTIFY_MS = 5000;
const TWIN_MS = 500;
const CLIMB_MS = 30_000;
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

/** What the fake device sends back for one send: an echo code, a state-report code, both, or neither. */
interface Answer {
  echo?: number;
  report?: number;
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

/** Deliver one answer the way the session surfaces it: the echo as `commandResult`, the report as a frame. */
function reply(session: FakeSession, answer: Answer): void {
  const channel = answer.channel ?? CHANNEL;
  if (answer.echo !== undefined) session.emit("commandResult", { code: answer.echo, channel });
  if (answer.report !== undefined) {
    session.emit("data", {
      commandId: CommandType.CMD_NOTIFY_PAYLOAD,
      channel,
      json: { cmd: KEYED_PAYLOAD_CMD.STATE_REPORT, payload: { code: answer.report, slState: "4" } },
    });
  }
}

/** The device's echo and report for a command it carried out. */
const accepted: Answer[] = [{ echo: 0, report: 0 }];
/** The device's echo and twin report for a command whose sequence was not above its mark. */
const refused: Answer[] = [{ echo: KEYED_PAYLOAD_SEQ_ERROR, report: KEYED_PAYLOAD_SEQ_ERROR }];

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
      for (const answer of answers) reply(session, answer);
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

/** A device that refuses every sequence at or below `mark` and moves the mark to each one it accepts. */
function deviceWithMark(mark: number) {
  return (sent: Sent): Answer[] => {
    if (sent.inner.seq_num <= mark) return refused;
    mark = sent.inner.seq_num;
    return accepted;
  };
}

describe("P2PCommandRouter.sendKeyedPayloadActuate (keyed-payload-actuate command-router branch)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the sealed fields as a keyed SET_PAYLOAD envelope on the device channel, and settles on echo + report", async () => {
    const { sent, actuate, lastSequence } = harness(() => accepted, { nickName: "Front Door Admin" });
    await actuate(true);

    expect(sent).toHaveLength(1);
    const [only] = sent;
    expect(only!.subCmd).toBe(KEYED_PAYLOAD_CMD.ON_OFF_LOCK);
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

  it("settles on the state report alone when the echo was not read", async () => {
    const { sent, actuate } = harness(() => [{ report: 0 }]);
    await expect(actuate(true)).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("settles an echo of 0 with no report as accepted once the report window passes — a command that changed nothing", async () => {
    vi.useFakeTimers();
    const { sent, actuate } = harness(() => [{ echo: 0 }]);
    const done = actuate(true);
    await vi.advanceTimersByTimeAsync(NOTIFY_MS - 1);
    let settled = false;
    void done.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBeUndefined();
    expect(sent).toHaveLength(1);
  });

  it("rejects a command that draws no reply at all once the reply window passes, without resending", async () => {
    vi.useFakeTimers();
    const { sent, actuate, lastSequence } = harness(() => []);
    const done = actuate(true);
    const outcome = expect(done).rejects.toThrow(/keyed-payload command to .* drew no reply/);
    await vi.advanceTimersByTimeAsync(ECHO_MS);
    await outcome;
    expect(sent).toHaveLength(1);
    expect(lastSequence()).toBe(FIRST_SEQ);
  });

  it("rejects with the report's result when the device reports a failure after echoing 0", async () => {
    const { sent, actuate } = harness(() => [{ echo: 0, report: -1 }]);
    await expect(actuate(true)).rejects.toThrow("keyed-payload command rejected by");
    await expect(harness(() => [{ echo: 0, report: -1 }]).actuate(true)).rejects.toThrow("code -1");
    expect(sent).toHaveLength(1);
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

  it("climbs past a refused mark with doubling steps, reaching a mark above 9000, and records where it landed", async () => {
    const { sent, actuate, lastSequence } = harness(deviceWithMark(9500));
    await actuate(true);

    expect(sent.map((s) => s.inner.seq_num)).toEqual([42, 1042, 3042, 7042, 15042]);
    expect(lastSequence()).toBe(15042);
    // The next command starts just above the number the device accepted.
    await actuate(false);
    expect(sent.at(-1)!.inner.seq_num).toBe(15043);
  });

  it("waits for a refusal's twin report before resending, so it is never read as the resend's answer", async () => {
    vi.useFakeTimers();
    const { sent, actuate } = harness((_, index) =>
      index === 0 ? [{ echo: KEYED_PAYLOAD_SEQ_ERROR }] : [{ report: KEYED_PAYLOAD_SEQ_ERROR }, { echo: 0, report: 0 }],
    );
    const done = actuate(true);
    await vi.advanceTimersByTimeAsync(TWIN_MS - 1);
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(done).resolves.toBeUndefined();
    expect(sent.map((s) => s.inner.seq_num)).toEqual([42, 1042]);
  });

  it("gives up at the time bound, still climbing in strides capped at the ceiling, and reports the device's code", async () => {
    vi.useFakeTimers();
    const { sent, actuate } = harness(() => {
      vi.setSystemTime(Date.now() + 1000);
      return refused;
    });
    await expect(actuate(true)).rejects.toThrow(`code ${KEYED_PAYLOAD_SEQ_ERROR}`);
    expect(sent).toHaveLength(CLIMB_MS / 1000);
    const steps = sent.slice(1).map((s, i) => s.inner.seq_num - sent[i]!.inner.seq_num);
    expect(steps.slice(0, 8)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 64000, 64000]);
    expect(new Set(steps.slice(6))).toEqual(new Set([64000]));
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
