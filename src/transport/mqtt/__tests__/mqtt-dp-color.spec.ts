import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../../core/contracts.js";
import type { EufyDevice } from "../../../core/types.js";
import { dpColorFields } from "../dp-color.js";
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

  it("publishes one full 0x0206 frame and acknowledges only after publish", async () => {
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
      raw: { device_new_pn: "T8L02" },
    } as EufyDevice;
    let releasePublish!: () => void;
    const published = new Promise<void>((resolve) => (releasePublish = resolve));
    const publishSecure = vi.fn((_dev: EufyDevice, _topic: string, _body: string): Promise<void> => published);
    const acks: Record<string, unknown>[] = [];
    const router = new MqttCommandRouter({
      mega: {} as never,
      listDevices: () => [dev],
      ensureDevices: async () => {},
      resolveAccountId: () => ACCOUNT_ID,
      publishSecure,
      onCommandAck: (info) => acks.push(info),
      onError: () => {},
    });

    const dispatched = router.dispatchCommand(DEVICE_SN, colorCommand());
    await vi.advanceTimersByTimeAsync(0);
    expect(publishSecure).toHaveBeenCalledOnce();
    expect(acks).toHaveLength(0);

    const [, topic, body] = publishSecure.mock.calls[0]!;
    expect(topic).toBe(`cmd/eufy_life/T8L02/${DEVICE_SN}/req`);
    const outer = JSON.parse(body) as { head: { cmd: number }; payload: string };
    const inner = JSON.parse(outer.payload) as { data: string };
    expect(outer.head.cmd).toBe(17);
    expect(Buffer.from(inner.data, "base64").toString("hex")).toBe(
      "ff097d000300020206a10404030201a22830303030303030303030303030303030303030303030303030303030303030303030303030303030" +
        "a302264ea4020000a50105a60601ff00000000a70b0a00010203040506070809a80164a9050000000000aa0100ab020000" +
        "ac04ffffffffad0100ae0100af0100b0010045",
    );

    releasePublish();
    await dispatched;
    expect(acks).toEqual([{ sn: DEVICE_SN, kind: "mqtt-dp-color", cmdCode: 0x0206, acked: true }]);
  });

  it("rejects malformed transport intent without publishing or acknowledging", async () => {
    const dev = { sn: DEVICE_SN, model: "T8L02", category: "eufy_life", raw: { device_new_pn: "T8L02" } } as EufyDevice;
    const publishSecure = vi.fn();
    const onCommandAck = vi.fn();
    const router = new MqttCommandRouter({
      mega: {} as never,
      listDevices: () => [dev],
      ensureDevices: async () => {},
      resolveAccountId: () => ACCOUNT_ID,
      publishSecure,
      onCommandAck,
      onError: () => {},
    });

    await expect(router.dispatchCommand(DEVICE_SN, colorCommand({ segmentCount: 0 }))).rejects.toThrow(
      /segment count/i,
    );
    expect(publishSecure).not.toHaveBeenCalled();
    expect(onCommandAck).not.toHaveBeenCalled();
  });
});
