import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../../core/contracts.js";
import type { EufyDevice } from "../../../core/types.js";
import { dpColorFields } from "../dp-color.js";
import { buildDpFrame } from "../dp-codec.js";
import { MqttCommandRouter } from "../command-router.js";

const ACCOUNT_ID = "0".repeat(40);
const DEVICE_SN = "T8000P0000000000";

const colorCommand = (over: Partial<Extract<Command, { kind: "mqtt-dp-color" }>> = {}) => ({
  kind: "mqtt-dp-color" as const,
  mqttCmdCode: 17,
  cmdCode: 0x0206,
  red: 255,
  green: 0,
  blue: 0,
  segmentCount: 10,
  ...over,
});

describe("0x0206 custom-colour field serialization", () => {
  it("serializes the complete reviewed field sequence with exact widths and sentinels", () => {
    expect(dpColorFields({ red: 255, green: 0, blue: 0, segmentCount: 10 })).toEqual([
      { tag: 0xa3, value: Buffer.from("264e", "hex") },
      { tag: 0xa4, value: Buffer.from("0000", "hex") },
      { tag: 0xa5, value: Buffer.from("05", "hex") },
      { tag: 0xa6, value: Buffer.from("01ff00000000", "hex") },
      { tag: 0xa7, value: Buffer.from("0a00010203040506070809", "hex") },
      { tag: 0xa8, value: Buffer.from("64", "hex") },
      { tag: 0xa9, value: Buffer.from("0000000000", "hex") },
      { tag: 0xaa, value: Buffer.from("00", "hex") },
      { tag: 0xab, value: Buffer.from("0000", "hex") },
      { tag: 0xac, value: Buffer.from("ffffffff", "hex") },
      { tag: 0xad, value: Buffer.from("00", "hex") },
      { tag: 0xae, value: Buffer.from("00", "hex") },
      { tag: 0xaf, value: Buffer.from("00", "hex") },
      { tag: 0xb0, value: Buffer.from("00", "hex") },
    ]);
  });

  it.each([
    [{ red: 0, green: 255, blue: 0 }, [0, 255, 0, 0, 0]],
    [{ red: 0, green: 0, blue: 255 }, [0, 0, 255, 0, 0]],
    [{ red: 0, green: 0, blue: 0 }, [0, 0, 0, 0, 0]],
    [{ red: 255, green: 255, blue: 255 }, [7, 77, 183, 148, 171]],
    [{ red: 171, green: 205, blue: 239 }, [3, 80, 183, 0, 158]],
  ] as const)("converts RGB $0 through the shared RGBCW mapping", (color, expected) => {
    const foreground = dpColorFields({ ...color, segmentCount: 1 }).find((field) => field.tag === 0xa6)!.value;
    expect([...foreground]).toEqual([1, ...expected]);
  });

  it.each([
    { red: -1, green: 0, blue: 0, segmentCount: 1 },
    { red: 256, green: 0, blue: 0, segmentCount: 1 },
    { red: 1.5, green: 0, blue: 0, segmentCount: 1 },
    { red: 0, green: 0, blue: 0, segmentCount: 0 },
    { red: 0, green: 0, blue: 0, segmentCount: 255 },
  ])("rejects malformed intent before producing fields", (input) => {
    expect(() => dpColorFields(input)).toThrow(/RGB|segment count/i);
  });
});

describe("MqttCommandRouter custom-colour dispatch", () => {
  afterEach(() => vi.useRealTimers());

  it("sends one full 0x0206 frame under the own user id and is done on the light's answer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0x01020304 * 1000));
    const dev = {
      sn: DEVICE_SN,
      // The topic names the product number (`device_new_pn`), not the model the record reports.
      model: "T8L02X",
      category: "eufy_life",
      deviceClass: "light",
      api: "mega",
      realtime: "smqtt",
      raw: { device_new_pn: "T8L02", member: { admin_user_id: "2".repeat(40) } },
    } as EufyDevice;
    const mqtt = Object.assign(new EventEmitter(), { id: "client-1", publish: vi.fn(async () => {}) });
    const acks: Record<string, unknown>[] = [];
    const router = new MqttCommandRouter({
      mega: { auth: { userId: ACCOUNT_ID } } as never,
      listDevices: () => [dev],
      ensureDevices: async () => {},
      secureTransport: async () => mqtt as never,
      onCommandAck: (info) => acks.push(info),
      onError: () => {},
    });

    const dispatched = router.dispatchCommand(DEVICE_SN, colorCommand());
    await vi.advanceTimersByTimeAsync(0);
    expect(mqtt.publish).toHaveBeenCalledOnce();

    const [topic, body] = mqtt.publish.mock.calls[0] as unknown as [string, string];
    expect(topic).toBe(`cmd/eufy_life/T8L02/${DEVICE_SN}/req`);
    const outer = JSON.parse(body) as { head: { cmd: number; cmd_status: number }; payload: string };
    const inner = JSON.parse(outer.payload) as { data: string };
    expect(outer.head).toMatchObject({ cmd: 17, cmd_status: 1 });
    expect(Buffer.from(inner.data, "base64").toString("hex")).toBe(
      "ff097d000300020206a10404030201a22830303030303030303030303030303030303030303030303030303030303030303030303030303030" +
        "a302264ea4020000a50105a60601ff00000000a70b0a00010203040506070809a80164a9050000000000aa0100ab020000" +
        "ac04ffffffffad0100ae0100af0100b0010045",
    );

    const answer = (cmd: number) => ({
      topic: `cmd/eufy_life/T8L02/${DEVICE_SN}/app/res`,
      raw: {
        head: { cmd: 16 },
        payload: JSON.stringify({
          data: Buffer.from(JSON.stringify({ data: buildDpFrame(cmd, "", []).toString("hex") })).toString("base64"),
        }),
      },
    });
    mqtt.emit("message", answer(0x0204));
    await vi.advanceTimersByTimeAsync(0);
    expect(acks).toHaveLength(0);
    mqtt.emit("message", answer(0x0a06));
    await expect(dispatched).resolves.toBe(true);
    expect(acks).toEqual([{ sn: DEVICE_SN, kind: "mqtt-dp-color", cmdCode: 0x0206, acked: true }]);
  });

  /** A router over one T8L02 and a fake light stack. */
  const lightRouter = () => {
    const dev = { sn: DEVICE_SN, model: "T8L02", category: "eufy_life", raw: { device_new_pn: "T8L02" } } as EufyDevice;
    const mqtt = Object.assign(new EventEmitter(), { id: "client-1", publish: vi.fn(async () => {}) });
    const router = new MqttCommandRouter({
      mega: { auth: { userId: ACCOUNT_ID } } as never,
      listDevices: () => [dev],
      ensureDevices: async () => {},
      secureTransport: async () => mqtt as never,
      onCommandAck: () => {},
      onError: () => {},
    });
    return { router, mqtt };
  };

  it("is not done when the light does not answer within 15 s, and is not sent again", async () => {
    vi.useFakeTimers();
    const { router, mqtt } = lightRouter();
    const dispatched = router.dispatchCommand(DEVICE_SN, colorCommand());
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(dispatched).resolves.toBe(false);
    expect(mqtt.publish).toHaveBeenCalledOnce();
  });

  it("is done on the last package of a split answer, not the first", async () => {
    vi.useFakeTimers();
    const { router, mqtt } = lightRouter();
    const part = (index: number) => {
      const body = Buffer.from([0xff, 0x09, 0, 0, 0x03, 0x00, 0x02, 0x8a, 0x06, index, 0x00]);
      body.writeUInt16LE(body.length + 1, 2);
      const frame = Buffer.concat([body, Buffer.from([body.reduce((x, y) => x ^ y, 0)])]);
      return {
        topic: `cmd/eufy_life/T8L02/${DEVICE_SN}/app/res`,
        raw: {
          head: { cmd: 16 },
          payload: JSON.stringify({
            data: Buffer.from(JSON.stringify({ data: frame.toString("hex") })).toString("base64"),
          }),
        },
      };
    };
    let done: boolean | undefined;
    void router.dispatchCommand(DEVICE_SN, colorCommand()).then((r) => (done = r));
    await vi.advanceTimersByTimeAsync(0);
    mqtt.emit("message", part(0x12));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBeUndefined();
    mqtt.emit("message", part(0x22));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it("rejects malformed transport intent without publishing or acknowledging", async () => {
    const dev = { sn: DEVICE_SN, model: "T8L02", category: "eufy_life", raw: { device_new_pn: "T8L02" } } as EufyDevice;
    const secureTransport = vi.fn();
    const onCommandAck = vi.fn();
    const router = new MqttCommandRouter({
      mega: {} as never,
      listDevices: () => [dev],
      ensureDevices: async () => {},
      secureTransport,
      onCommandAck,
      onError: () => {},
    });

    await expect(router.dispatchCommand(DEVICE_SN, colorCommand({ segmentCount: 0 }))).rejects.toThrow(
      /segment count/i,
    );
    expect(secureTransport).not.toHaveBeenCalled();
    expect(onCommandAck).not.toHaveBeenCalled();
  });
});
