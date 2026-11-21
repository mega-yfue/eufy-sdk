import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MqttCommandRouter } from "../command-router.js";
import { CMD_TRANSFER_PAYLOAD } from "../../ff09.js";
import type { EufyDevice } from "../../../core/types.js";

/**
 * A settings-bundle `mqtt-dp` write to a security lock goes out as the app's MQTT channel sends it: an `ff09`
 * frame of the bundle's TLV, sealed unless the descriptor says otherwise, in the lock `trans` envelope under
 * `head.cmd = mqttCmdCode`. Synthetic identity.
 */
const SN = "T8531Q0000000000";
const ADMIN = "0000000000000000000000000000000000000000";

function lockRouter() {
  const dev = {
    sn: SN,
    category: "eufy_security",
    model: "T8531",
    raw: { device_new_pn: "T8531" },
  } as unknown as EufyDevice;
  const acks: Record<string, unknown>[] = [];
  const mqtt = Object.assign(new EventEmitter(), { id: "client-1", publish: vi.fn(async () => {}) });
  const router = new MqttCommandRouter({
    mega: {} as never,
    listDevices: () => [dev],
    ensureDevices: async () => {},
    onCommandAck: (info) => acks.push(info),
    onError: () => {},
    resolveAccountId: () => ADMIN,
    securityTransport: async () => mqtt as any,
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
});
