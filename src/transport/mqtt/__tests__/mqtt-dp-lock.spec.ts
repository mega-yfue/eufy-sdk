import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MqttCommandRouter } from "../command-router.js";
import { CMD_TRANSFER_PAYLOAD, decryptFf09Frame, walkFf09Tlv } from "../../ff09.js";
import { buildFf09ResponseFrame } from "../../__tests__/ff09-test-fixtures.js";
import type { EufyDevice } from "../../../core/types.js";

/**
 * A settings-bundle `mqtt-dp` write to a security lock goes out as the app's MQTT channel sends it: an `ff09`
 * frame of the bundle's TLV, sealed unless the descriptor says otherwise, in the lock `trans` envelope under
 * `head.cmd = mqttCmdCode`. Synthetic identity.
 */
const SN = "T8531Q0000000000";
const ADMIN = "0000000000000000000000000000000000000000";

function lockRouter(member: { admin_user_id: string } | null = { admin_user_id: ADMIN }, accountId = ADMIN) {
  const dev = {
    sn: SN,
    category: "eufy_security",
    model: "T8531",
    raw: { device_new_pn: "T8531", member: member ?? undefined },
  } as unknown as EufyDevice;
  const acks: Record<string, unknown>[] = [];
  const mqtt = Object.assign(new EventEmitter(), { id: "client-1", publish: vi.fn(async () => {}) });
  const router = new MqttCommandRouter({
    mega: {} as never,
    listDevices: () => [dev],
    ensureDevices: async () => {},
    onCommandAck: (info) => acks.push(info),
    onError: () => {},
    resolveAccountId: () => accountId,
    secureTransport: async () => mqtt as any,
  });
  return { router, mqtt, acks };
}

/** The published envelope's head command, trans and lock frame. */
function published(mqtt: { publish: ReturnType<typeof vi.fn> }) {
  const [topic, body] = mqtt.publish.mock.calls[0] as [string, string];
  const outer = JSON.parse(body);
  const trans = JSON.parse(Buffer.from(JSON.parse(outer.payload).trans, "base64").toString("utf8"));
  return { topic, head: outer.head, trans, frame: Buffer.from(trans.payload.lock_payload, "hex") };
}

describe("a bundle mqtt-dp write to a lock", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const write = {
    kind: "mqtt-dp",
    mqttCmdCode: 9,
    cmdCode: 0x23,
    fields: [{ tag: 0xa3, value: Buffer.from([1]) }],
  } as const;

  it("seals the bundle's TLV in an ff09 frame under head.cmd = mqttCmdCode", async () => {
    const { router, mqtt } = lockRouter();
    const p = router.dispatchCommand(SN, { ...write, subVersion: 3, functionType: 2, encrypt: true });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    const { topic, head, trans, frame } = published(mqtt);
    expect(topic).toBe(`cmd/eufy_security/T8531/${SN}/req`);
    expect(head.cmd).toBe(9);
    expect(trans).toMatchObject({
      cmd: CMD_TRANSFER_PAYLOAD,
      account_id: "",
      payload: { apiCommand: CMD_TRANSFER_PAYLOAD, seq_num: 1 },
    });
    expect(frame.subarray(0, 2)).toEqual(Buffer.from([0xff, 0x09]));
    expect(frame.subarray(4, 9)).toEqual(Buffer.from([0x03, 0x00, 0x02, 0x40, 0x23]));
  });

  it("sends the TLV in the clear where the descriptor needs no seal", async () => {
    const { router, mqtt } = lockRouter();
    const p = router.dispatchCommand(SN, { ...write, subVersion: 4, functionType: 1, encrypt: false });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    const { frame } = published(mqtt);
    expect(frame.subarray(4, 9)).toEqual(Buffer.from([0x04, 0x00, 0x01, 0x00, 0x23]));
    expect(frame.subarray(frame.length - 4, frame.length - 1)).toEqual(Buffer.from([0xa3, 1, 1]));
  });

  it("sends again once while no reply comes, as the app's sendForRawResponse, or as the descriptor's retryCount", async () => {
    const { router, mqtt } = lockRouter();
    const p = router.dispatchCommand(SN, write);
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    expect(mqtt.publish).toHaveBeenCalledTimes(2);
    const q = router.dispatchCommand(SN, { ...write, retryCount: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    await q;
    expect(mqtt.publish).toHaveBeenCalledTimes(3);
  });

  it("refuses a sealed write to a record without a member: the app has no key to seal it with", async () => {
    const { router, mqtt } = lockRouter(null);
    await expect(router.dispatchCommand(SN, { ...write, encrypt: true })).rejects.toThrow(/adminUserId/);
    expect(mqtt.publish).not.toHaveBeenCalled();
  });

  it("sends an unsealed write with an empty A2 where the member states no admin, as the app", async () => {
    const { router, mqtt } = lockRouter({ admin_user_id: "" }, "");
    const p = router.dispatchCommand(SN, { ...write, encrypt: false, retryCount: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;
    const { frame } = published(mqtt);
    expect(frame.subarray(15, 17)).toEqual(Buffer.from([0xa2, 0]));
  });

  it("reports acked only once a reply with head.cmd = mqttCmdCode - 1 comes", async () => {
    const { router, mqtt, acks } = lockRouter();
    const send = async (replyCmd: number) => {
      const p = router.dispatchCommand(SN, { ...write, mqttCmdCode: 11 });
      await vi.advanceTimersByTimeAsync(0);
      mqtt.emit("message", { topic: `cmd/eufy_security/T8531/${SN}/res`, raw: { head: { cmd: replyCmd } } });
      await vi.advanceTimersByTimeAsync(10_000);
      await p;
    };
    await send(8);
    await send(10);
    expect(acks.map((a) => a.acked)).toEqual([false, true]);
  });

  /** The app's raw MQTT response: a reply is a failure on `cmd_status` 4 to 9, a success otherwise. */
  it("answers done on a reply that is not a failure, and not on a failure or a timeout", async () => {
    const { router, mqtt } = lockRouter();
    const send = async (head?: Record<string, number>) => {
      const p = router.dispatchCommand(SN, { ...write, retryCount: 0 });
      await vi.advanceTimersByTimeAsync(0);
      if (head) mqtt.emit("message", { topic: `cmd/eufy_security/T8531/${SN}/res`, raw: { head } });
      await vi.advanceTimersByTimeAsync(10_000);
      return p;
    };
    expect(await send({ cmd: 8, cmd_status: 3 })).toBe(true);
    expect(await send({ cmd: 8, cmd_status: 5 })).toBe(false);
    expect(await send()).toBe(false);
  });
});

/** esiotkit's `doPublish`: the envelope's `account_id` is the record's `member.admin_user_id`, else `""`. */
describe("an MQTT lock write's envelope account id", () => {
  const OWNER = "1111111111111111111111111111111111111111";
  it.each([
    ["the record's admin_user_id", { admin_user_id: OWNER }, OWNER],
    ["empty on a record stating none, the frame keeping the user's id", null, ""],
  ])("is %s", async (_name, member, expected) => {
    const { router, mqtt } = lockRouter(member);
    const dp = { kind: "mqtt-dp", mqttCmdCode: 9, cmdCode: 0x23, fields: [], encrypt: false, retryCount: 0 } as const;
    await router.dispatchCommand(SN, { ...dp, timeoutS: 0 });
    await router.dispatchCommand(SN, { kind: "mqtt-json", mqttCmdCode: 9, cmd: 1235, payload: {}, needAck: false });
    const bodies = mqtt.publish.mock.calls.map((call) => (call as unknown as [string, string])[1]);
    const accounts = bodies.map((body) => JSON.parse(JSON.parse(body).payload).account_id);
    expect(accounts).toEqual([expected, expected]);
    expect(published(mqtt).frame.includes(ADMIN)).toBe(true);
  });
});

/** `sendRequestWithJson`: `{cmd, account_id: "", payload, mValue3: 0, mChannel: 0}` in the security envelope. */
describe("a type json MQTT write", () => {
  it("publishes the descriptor's cmd and JSON payload, cmd_status 2 when no ack is asked", async () => {
    const { router, mqtt } = lockRouter();
    await router.dispatchCommand(SN, {
      kind: "mqtt-json",
      mqttCmdCode: 9,
      cmd: 1235,
      payload: { volume: 1 },
      needAck: false,
    });
    expect(mqtt.publish).toHaveBeenCalledTimes(1);
    const [topic, body] = mqtt.publish.mock.calls[0] as unknown as [string, string];
    const outer = JSON.parse(body);
    const trans = JSON.parse(Buffer.from(JSON.parse(outer.payload).trans, "base64").toString("utf8"));
    expect(topic).toBe(`cmd/eufy_security/T8531/${SN}/req`);
    expect(outer.head).toMatchObject({ cmd: 9, cmd_status: 2 });
    expect(trans).toEqual({ cmd: 1235, account_id: "", payload: { volume: 1 }, mValue3: 0, mChannel: 0 });
  });
});

/** The lock's own MQTT settings service: bare envelope, no ack asked, sent once, its answer pinned to the request. */
describe("a lock service write", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const decode = (body: string) => {
    const outer = JSON.parse(body);
    const payload = JSON.parse(outer.payload);
    return { head: outer.head, payload, trans: JSON.parse(Buffer.from(payload.trans, "base64").toString("utf8")) };
  };
  /** Answers each publish with `{cmd, payload}` from `answer`, unless it returns `undefined`. */
  const answering = (mqtt: EventEmitter & { publish: ReturnType<typeof vi.fn> }, answer: (t: any) => unknown) =>
    mqtt.publish.mockImplementation(async (_topic: string, body: string) => {
      const { trans } = decode(body);
      const payload = answer(trans);
      if (payload === undefined) return;
      const reply = Buffer.from(JSON.stringify({ cmd: trans.cmd, payload })).toString("base64");
      const raw = { head: { cmd: 8 }, payload: JSON.stringify({ trans: reply }) };
      mqtt.emit("message", { topic: `cmd/eufy_security/T8531/${SN}/res`, raw });
    });
  /** The lock: the settings read answered with the do-not-disturb fields, a write with `status`, at `skew` off. */
  const lock =
    (status: number, skew = 0) =>
    (t: any) => {
      const op = parseInt(t.payload.lock_payload.slice(14, 18), 16) & 0x7ff;
      const plain =
        op === 53 ? Buffer.from([0, 0xbd, 1, 1, 0xbe, 2, 0x16, 0, 0xbf, 2, 7, 0x1e]) : Buffer.from([status]);
      const time = t.payload.time + skew;
      return {
        dev_sn: SN,
        lock_payload: buildFf09ResponseFrame(plain, time, ADMIN, SN, 0x30 | (op & 0xf)),
        time: time.toString(16),
      };
    };
  const volume = {
    kind: "mqtt-dp",
    mqttCmdCode: 9,
    cmdCode: 52,
    fields: [
      { tag: 0xa3, value: Buffer.from([4]) },
      { tag: 0xa4, value: Buffer.from([2]) },
    ],
    lockService: true,
    apiCommand: 6015,
    preserve: [0xbd, 0xbe, 0xbf],
    timeoutS: 20,
  } as const;

  it("reads the settings under 6016, re-sends the reported fields under 6015, bare, done on result 0", async () => {
    const { router, mqtt } = lockRouter();
    answering(mqtt as any, lock(0));
    await expect(router.dispatchCommand(SN, volume)).resolves.toBe(true);
    const [read, write] = mqtt.publish.mock.calls.map((c) => decode((c as unknown as [string, string])[1]));
    expect(read!.trans.payload.apiCommand).toBe(6016);
    expect(write!.head.cmd_status).toBe(2);
    expect(Object.keys(write!.payload)).toEqual(["account_id", "device_sn", "trans"]);
    expect(Object.keys(write!.trans)).toEqual(["cmd", "mChannel", "mValue3", "payload"]);
    expect(write!.trans.payload.apiCommand).toBe(6015);
    const p = write!.trans.payload;
    const plain = decryptFf09Frame({ lockPayload: p.lock_payload, keyTime: p.time, adminUserId: ADMIN, deviceSn: SN });
    const tlv = [...walkFf09Tlv(plain, 0, plain.length)].filter(([tag]) => tag > 0xa2);
    expect(tlv.map(([tag, v]) => [tag, v.toString("hex")])).toEqual([
      [0xa3, "04"],
      [0xa4, "02"],
      [0xa5, "01"],
      [0xa6, "1600"],
      [0xa7, "071e"],
    ]);
  });

  it("sends a given value where a re-sent field would go", async () => {
    const { router, mqtt } = lockRouter();
    answering(mqtt as any, lock(0));
    await router.dispatchCommand(SN, { ...volume, preserve: [Buffer.from([9]), 0xbf] });
    const p = decode((mqtt.publish.mock.calls[1] as unknown as [string, string])[1]).trans.payload;
    const plain = decryptFf09Frame({ lockPayload: p.lock_payload, keyTime: p.time, adminUserId: ADMIN, deviceSn: SN });
    const tlv = [...walkFf09Tlv(plain, 0, plain.length)].filter(([tag]) => tag > 0xa4);
    expect(tlv.map(([tag, v]) => [tag, v.toString("hex")])).toEqual([
      [0xa5, "09"],
      [0xa6, "071e"],
    ]);
  });

  it("is not done on a non-zero result, nor on an answer to another request's time, and is not sent again", async () => {
    const { router, mqtt } = lockRouter();
    const write = { ...volume, preserve: undefined };
    answering(mqtt as any, lock(1));
    await expect(router.dispatchCommand(SN, write)).resolves.toBe(false);
    answering(mqtt as any, lock(0, 1));
    const p = router.dispatchCommand(SN, write);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toBe(false);
    expect(mqtt.publish).toHaveBeenCalledTimes(2);
  });

  it("reads auto-lock through the settings service: opcode 53 under apiCommand 6016", async () => {
    const { router, mqtt } = lockRouter();
    answering(mqtt as any, (t: any) => {
      const plain = Buffer.from([0, 0xa1, 1, 1, 0xa2, 2, 0x1e, 0, 0xa3, 1, 0, 0xa4, 2, 0x16, 0, 0xa5, 2, 7, 0x1e]);
      const time = t.payload.time;
      return { dev_sn: SN, lock_payload: buildFf09ResponseFrame(plain, time, ADMIN, SN), time: time.toString(16) };
    });
    await expect(router.getAutoLockState(SN, { adminUserId: ADMIN, deviceSn: SN, lockService: true })).resolves.toEqual(
      {
        enabled: true,
        delaySeconds: 30,
        isSchedule: false,
        scheduleStartTime: [0x16, 0],
        scheduleEndTime: [7, 0x1e],
      },
    );
    const { head, trans } = decode((mqtt.publish.mock.calls[0] as unknown as [string, string])[1]);
    expect([head.cmd_status, trans.payload.apiCommand]).toEqual([2, 6016]);
  });

  it("is done on a JSON write's result 0, bare and once", async () => {
    const { router, mqtt } = lockRouter();
    const json = {
      kind: "mqtt-json",
      mqttCmdCode: 9,
      cmd: 1919,
      payload: { mode: 3 },
      lockService: true,
      timeoutS: 20,
    } as const;
    answering(mqtt as any, () => ({ dev_sn: SN, result: 0 }));
    await expect(router.dispatchCommand(SN, json)).resolves.toBe(true);
    expect(decode((mqtt.publish.mock.calls[0] as unknown as [string, string])[1]).trans).toEqual({
      cmd: 1919,
      mChannel: 0,
      mValue3: 0,
      payload: { mode: 3 },
    });
    answering(mqtt as any, () => undefined);
    const p = router.dispatchCommand(SN, json);
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(p).resolves.toBe(false);
    expect(mqtt.publish).toHaveBeenCalledTimes(2);
  });
});
