import { frameCommand, qualityOf, thingWrite, type BundleFrame } from "../bundle.js";
import { parseThingsList, type ThingDescription } from "../thing-description.js";
import { power } from "./bundle-fixture.js";
import type { CommandContext } from "../types.js";

const NOW = 1_700_000_000_000;
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
afterEach(() => vi.restoreAllMocks());

/** A description listing each identifier `RW`, a `bool` or an enum of the given UI values. */
const things = (props: Record<string, "bool" | readonly string[]>): ThingDescription =>
  parseThingsList({
    things_list: [
      {
        profile: { product_code: "T0000" },
        properties: Object.entries(props).map(([identifier, values]) => ({
          identifier,
          access_mode: "RW",
          data_type:
            values === "bool"
              ? { type: "bool", specs: { defaultValue: "1" } }
              : { type: "enum", specs: { defaultValue: values[0], eunmList: values.map((value) => ({ value })) } },
        })),
      },
    ],
  }).T0000!;

const ctx = (model: string, extra: Partial<CommandContext> = {}): CommandContext => ({
  channel: 3,
  codec: "camera",
  model,
  serial: `${model}P0000000000`,
  paramIds: new Set<number>(),
  capabilities: new Set(["camera"]),
  ...extra,
});
const attached = { homeBaseAttached: true, stationSerial: "T8030P0000000000" };

describe("frameCommand", () => {
  it("T8217 device_motion_detection: each selection's bits over its cached param's others, nothing without ai_notification", () => {
    const sent = (value: object) =>
      thingWrite(
        "device_motion_detection",
        JSON.stringify(value),
        ctx("T8217", { paramValue: (p) => (p === 1298 ? "7" : undefined) }),
      ) as { cmd?: number; payload?: object } | undefined;
    expect(sent({ ai_detect_type: "5,4", ai_notification: "5" })).toMatchObject({
      cmd: 1298,
      payload: { ai_detect_type: 32775, push_detect_type: 3, ai_notification: 3 },
    });
    expect(sent({ ai_detect_type: "5,4" })).toBeUndefined();
  });
  it("fills $param tokens from the device's cached params: a JSON field, bits, the fallback, else refuses", () => {
    const frame: BundleFrame = {
      cmd: 1350,
      body: "json1350",
      channel: "$channel",
      subCmd: 1710,
      mValue3: 0,
      payload: {
        notification_motion_onoff: "$param:1710.notification_motion_onoff??0",
        notification_ring_onoff: "$param:1710.notification_ring_onoff??0",
        notification_style: 2,
      },
    };
    const cached = JSON.stringify({ notification_motion_onoff: 1, notification_ring_onoff: 1, notification_style: 3 });
    const sent = (f: BundleFrame, params: Record<number, string>) =>
      (frameCommand(f, 2, ctx("T8425", { paramValue: (p) => params[p] })) as { payload?: object } | undefined)?.payload;
    expect(sent(frame, { 1710: cached })).toEqual({
      notification_motion_onoff: 1,
      notification_ring_onoff: 1,
      notification_style: 2,
    });
    expect(sent(frame, { 1710: Buffer.from(cached).toString("base64") })).toMatchObject({ notification_ring_onoff: 1 });
    expect(sent(frame, {})).toMatchObject({ notification_motion_onoff: 0, notification_ring_onoff: 0 });
    const lock: BundleFrame = { ...frame, subCmd: 1919, payload: { mode: "$param:1919|4" } };
    expect(sent(lock, { 1919: "3" })).toEqual({ mode: 7 });
    expect(sent({ ...lock, payload: { mode: "$param:1919&~2" } }, { 1919: "3" })).toEqual({ mode: 1 });
    expect(sent(lock, {})).toBeUndefined();
  });
  it("sends a json1350 frame in the 1350 envelope, mValue3 and the channel from the frame, the tokens filled", () => {
    const frame: BundleFrame = {
      cmd: 1350,
      body: "json1350",
      channel: "$channel",
      payload: { night_sion: 2, channel: "$channel", transaction: "$now" },
      subCmd: 1277,
      mValue3: 0,
    };
    expect(frameCommand(frame, "103", ctx("T8162"))).toEqual({
      kind: "set-payload",
      cmd: 1277,
      payload: { night_sion: 2, channel: 3, transaction: String(NOW) },
      channel: 3,
      mValue3: 0,
    });
  });
  it("sends a json1700 frame in the 1700 wrapper, and the frame after it as next", () => {
    const frame: BundleFrame = {
      cmd: 1700,
      body: "json1700",
      channel: "$channel",
      payload: { value: 1, transaction: "$now" },
      subCmd: 6014,
      next: [
        {
          cmd: 1045,
          body: "groupA",
          channel: "$channel",
          payload: { ledStatus: 1 },
          valueKey: "ledStatus",
          coerce: "int",
        },
      ],
    };
    expect(frameCommand(frame, true, ctx("T8124"))).toEqual({
      kind: "set-json",
      param: 6014,
      data: { value: 1, transaction: String(NOW) },
      channel: 3,
      next: { kind: "set-param", param: 1045, value: 1, channel: 3 },
    });
  });
  it("sends group A as an auto scalar, coercing a boolean switch as the app does", () => {
    const frame: BundleFrame = {
      cmd: 1035,
      body: "groupA",
      channel: "$channel",
      payload: { switch: "$value" },
      valueKey: "switch",
      coerce: "bool1",
    };
    expect(frameCommand(frame, true, ctx("T8410"))).toEqual({
      kind: "set-param",
      param: 1035,
      value: 1,
      channel: 3,
    });
    expect(frameCommand({ ...frame, payload: { switch: 2 } }, 2, ctx("T8410"))).toMatchObject({ value: 0 });
  });
  it("sends a pair as the level-1 int pair and group B as a station scalar on channel 255", () => {
    const pair: BundleFrame = {
      cmd: 1013,
      body: "pair",
      channel: "$channel",
      payload: { value: 1, channel: "$channel" },
      valueKey: "value",
      coerce: "int",
    };
    expect(frameCommand(pair, "102", ctx("T8111"))).toEqual({
      kind: "set-param",
      param: 1013,
      value: 1,
      form: "int-pair",
      channel: 3,
    });
    const b: BundleFrame = {
      cmd: 1235,
      body: "groupB",
      channel: 255,
      payload: { volume: "$value" },
      valueKey: "volume",
      coerce: "int",
    };
    expect(frameCommand(b, 7, ctx("T8010", { codec: "station" }))).toEqual({
      kind: "p2p-station-scalar",
      cmd: 1235,
      value: 7,
      channel: 255,
    });
  });
  it("fills $now as epoch milliseconds and $nowS as epoch seconds", () => {
    const frame: BundleFrame = {
      cmd: 1700,
      subCmd: 6014,
      body: "json1700",
      channel: "$channel",
      payload: { ms: "$now", s: "$nowS" },
    };
    expect(frameCommand(frame, 1, ctx("T8124"))).toMatchObject({ data: { ms: String(NOW), s: NOW / 1000 } });
  });
  it("sends a bare JSON body with the value as its object, the serial and a station's 255 channel filled", () => {
    const raw: BundleFrame = { cmd: 1254, body: "json", channel: 255, payload: "$value" };
    expect(frameCommand(raw, { schedules: [] }, ctx("T8010"))).toEqual({
      kind: "set-json-raw",
      cmd: 1254,
      data: { schedules: [] },
      channel: 255,
    });
    const sn: BundleFrame = {
      cmd: 1350,
      body: "json1350",
      channel: "$channel",
      payload: { deviceSn: "$sn", enable: 1, transaction: "$now" },
      subCmd: 6450,
      mValue3: 0,
    };
    expect(frameCommand(sn, true, ctx("T8030", { codec: "station" }))).toMatchObject({
      channel: 255,
      payload: { deviceSn: "T8030P0000000000" },
    });
  });
  it("pins an ecb-sealed JSON frame to level 1, as the app seals 1060 and 1350/1001", () => {
    const envelope: BundleFrame = {
      cmd: 1350,
      subCmd: 1001,
      mValue3: 0,
      body: "json1350",
      channel: "$channel",
      payload: {},
      seal: "ecb",
    };
    expect(frameCommand(envelope, 1, ctx("T8114"))).toMatchObject({
      kind: "set-payload",
      cmd: 1001,
    });
    const raw: BundleFrame = { cmd: 1060, body: "json", channel: 255, payload: { a: 1 }, seal: "ecb" };
    expect(frameCommand(raw, 1, ctx("T8114"))).toMatchObject({ kind: "set-json-raw", cmd: 1060 });
  });
  it("carries a 1350 frame's list payload, unzipped keys and header counter, and a 1700 frame's param_data", () => {
    const envelope: BundleFrame = { cmd: 1350, subCmd: 1961, mValue3: 0, body: "json1350", channel: "$channel" };
    expect(frameCommand({ ...envelope, payload: { version: "3" }, unzipParams: true }, 1, ctx("T8114"))).toMatchObject({
      cmd: 1961,
      payload: { version: "3" },
      unzip: true,
    });
    expect(frameCommand({ ...envelope, subCmd: 1308, payload: [{ a: "$value" }] }, 7, ctx("T8114"))).toMatchObject({
      cmd: 1308,
      payload: [{ a: 7 }],
    });
    expect(
      frameCommand({ ...envelope, subCmd: 1025, mValue3: 1025, payload: {}, counter: "bump" }, 1, ctx("T8114")),
    ).toMatchObject({ cmd: 1025, mValue3: 1025, counter: "bump" });
    const control: BundleFrame = { cmd: 1700, subCmd: 6001, body: "json1700", channel: "$channel", payload: 3 };
    expect(frameCommand(control, 1, ctx("T8114"))).toMatchObject({ kind: "set-json", param: 6001, data: 3 });
  });
  it("refuses another session than the device's own, a 1003 raw-params frame and a 1700 live start", () => {
    const envelope: BundleFrame = {
      cmd: 1350,
      subCmd: 6250,
      mValue3: 0,
      body: "json1350",
      channel: "$channel",
      payload: {},
    };
    expect(frameCommand({ ...envelope, session: { targetSn: "$sn" } }, 1, ctx("T8114")), "own").toBeDefined();
    expect(frameCommand({ ...envelope, session: { targetSn: "$sn" } }, 1, ctx("T8114", attached))).toBeUndefined();
    expect(frameCommand({ ...envelope, session: { p2pDid: "x" } }, 1, ctx("T8114"))).toBeUndefined();
    expect(frameCommand({ ...envelope, payload: { cmd: 1003 } }, 1, ctx("T8114"))).toBeUndefined();
    const live: BundleFrame = {
      cmd: 1700,
      subCmd: 1000,
      body: "json1700",
      channel: "$channel",
      payload: { extValue: 1 },
    };
    expect(frameCommand(live, 1, ctx("T8114"))).toBeUndefined();
    expect(frameCommand({ ...envelope, counter: "other" }, 1, ctx("T8114"))).toBeUndefined();
  });
  it("sends a native body: the string layout as p2p-string, the int-pair layout as a bare p2p-int-string", () => {
    const name: BundleFrame = {
      cmd: 1217,
      body: "native",
      layout: 0x2d9cb4,
      channel: 255,
      payload: { deviceName: "$value" },
      valueKey: "deviceName",
      coerce: "string",
    };
    expect(frameCommand(name, "Garden", ctx("T8114"))).toEqual({
      kind: "p2p-string",
      cmd: 1217,
      value: "Garden",
      channel: 3,
    });
    expect(frameCommand(name, "Garden", ctx("T8010", { codec: "station" }))).toMatchObject({ channel: 255 });
    expect(frameCommand(name, "x".repeat(128), ctx("T8114")), "longer than the app sends").toBeUndefined();
    const alarm: BundleFrame = {
      cmd: 1201,
      body: "native",
      layout: "0x2da458",
      channel: 255,
      payload: { type: 2, time_out: 30, channel: "$channel" },
      valueKey: "type",
      subKey: "time_out",
      coerce: "int",
    };
    expect(frameCommand(alarm, 1, ctx("T8010"))).toEqual({
      kind: "p2p-int-string",
      cmd: 1201,
      value: 30,
      valueSub: 2,
      channel: 255,
      form: "int-pair",
    });
    expect(frameCommand({ ...alarm, layout: 0x2d9999 }, 1, ctx("T8010")), "another layout").toBeUndefined();
  });
  it("refuses a frame no builder carries: another transport, a pinned seal, an unknown body, a scalar with no integer, a bad next", () => {
    const a: BundleFrame = {
      cmd: 1035,
      body: "groupA",
      channel: "$channel",
      payload: { switch: 1 },
      valueKey: "switch",
    };
    expect(frameCommand({ ...a, seal: "ecb" }, 1, ctx("T8114")), "an ecb scalar").toBeUndefined();
    expect(frameCommand({ ...a, seal: "gcm" }, 1, ctx("T8114"))).toBeUndefined();
    expect(frameCommand({ ...a, transport: "dp" }, 1, ctx("T8114"))).toBeUndefined();
    expect(frameCommand({ ...a, transport: "p2p" }, 1, ctx("T8114"))).toMatchObject({ param: 1035 });
    expect(frameCommand({ ...a, body: "other" }, 1, ctx("T8114"))).toBeUndefined();
    expect(frameCommand({ ...a, payload: { switch: "x" } }, 1, ctx("T8114"))).toBeUndefined();
    expect(frameCommand({ ...a, next: [{ ...a, seal: "ecb" }] }, 1, ctx("T8114"))).toBeUndefined();
  });
});

describe("frameCommand on the other transports", () => {
  it("sends a dp frame as a data-point write, a hex value as base64", () => {
    expect(frameCommand({ transport: "dp", dp: 152, value: "$value" }, true, ctx("T2351"))).toEqual({
      kind: "aiot-dp",
      dp: 152,
      value: true,
    });
    expect(frameCommand({ transport: "dp", dp: 154, value: "0a02", encoding: "hex" }, 1, ctx("T2351"))).toEqual({
      kind: "aiot-dp",
      dp: 154,
      value: "CgI=",
    });
  });
  it("sets a templated data point's fields per write: the clock, and a key of the written value", () => {
    const json = { mode: 1, timestamp: 0 };
    const hex = Buffer.from(JSON.stringify(json)).toString("hex");
    expect(
      frameCommand(
        { transport: "dp", dp: 124, value: hex, encoding: "hex-json", template: { timestamp: "$now", id: "$sn" } },
        1,
        ctx("T2261A"),
      ),
    ).toEqual({
      kind: "aiot-dp",
      dp: 124,
      value: Buffer.from(JSON.stringify({ mode: 1, timestamp: NOW, id: "T2261AP0000000000" })).toString("base64"),
    });
    expect(
      frameCommand(
        { transport: "dp", dp: 152, value: { seq: 0, t: 0 }, template: { seq: "$input.seq", t: "$nowS" } },
        '{"seq":7}',
        ctx("T2351"),
      ),
    ).toEqual({ kind: "aiot-dp", dp: 152, value: JSON.stringify({ seq: 7, t: NOW / 1000 }) });
    expect(
      frameCommand(
        { transport: "dp", dp: 103, value: 1, template: { "": "$input.ifFindMe" } },
        '{"ifFindMe":0}',
        ctx("T2261A"),
      ),
      "the whole value",
    ).toEqual({ kind: "aiot-dp", dp: 103, value: 0 });
  });
  it("sends an http frame as a cloud call, after the session frame where it follows one", () => {
    const rename = { transport: "http", method: "POST", path: "/v1/app/device/rename", body: { device_sn: "$sn" } };
    const frame: BundleFrame = {
      cmd: 1217,
      body: "groupB",
      channel: 255,
      payload: { value: 0 },
      valueKey: "value",
      after: rename,
    };
    expect(frameCommand(frame, "x", ctx("T8114"))).toEqual({
      kind: "p2p-station-scalar",
      cmd: 1217,
      value: 0,
      channel: 255,
      next: {
        kind: "cloud-request",
        method: "POST",
        domain: "eufy_security",
        path: "/v1/app/device/rename",
        body: { device_sn: "T8114P0000000000" },
      },
    });
  });
  it("sends an mqtt ble frame as the bundle's TLV fields after A1 and A2, with its ff09 header", () => {
    const frame: BundleFrame = {
      transport: "mqtt",
      type: "ble",
      mqttCmdCode: 9,
      cmdCode: 0x23,
      subVersion: 3,
      functionType: 2,
      needEncrypt: true,
      payload: "A104{nowS:u32le}A228{userId}A301{value:u8}A4022c01",
    };
    expect(frameCommand(frame, 1, ctx("T8531"))).toEqual({
      kind: "mqtt-dp",
      mqttCmdCode: 9,
      cmdCode: 0x23,
      fields: [
        { tag: 0xa3, value: Buffer.from([1]) },
        { tag: 0xa4, value: Buffer.from([0x2c, 0x01]) },
      ],
      subVersion: 3,
      functionType: 2,
      encrypt: true,
    });
    expect(
      frameCommand({ ...frame, payload: "A502{shortUserId}" }, 1, ctx("T8531")),
      "a user id past A2",
    ).toBeUndefined();
    expect(frameCommand({ ...frame, payload: "A30201" }, 1, ctx("T8531")), "short of its length").toBeUndefined();
    expect(frameCommand({ ...frame, type: "json" }, 1, ctx("T8531")), "json").toBeUndefined();
  });
  it("follows a P2P rename with the app's own update_device_info call", () => {
    const name: BundleFrame = {
      cmd: 1217,
      body: "native",
      layout: 0x2d9cb4,
      channel: 255,
      payload: { deviceName: "$value" },
      valueKey: "deviceName",
      after: { transport: "http", path: "app/devicemanage/update_device_info" },
    };
    expect(frameCommand(name, "Garden", ctx("T8114", { stationSerial: "T8010P0000000000" }))).toMatchObject({
      kind: "p2p-string",
      next: {
        kind: "cloud-request",
        method: "POST",
        domain: "DeviceManage",
        path: "/app/devicemanage/update_device_info",
        headers: { "app-tab": "eufy_security" },
        body: {
          device_sn: "T8114P0000000000",
          parent_sn: "T8010P0000000000",
          station_sn: "T8010P0000000000",
          device_name: "Garden",
          category: "eufy_security",
          is_integrated: false,
        },
      },
    });
    expect(frameCommand(name, "Hub", ctx("T8114"))).toMatchObject({ next: { body: { is_integrated: true } } });
  });
  it("carries a cloud call's method, domain, query and headers", () => {
    const frame: BundleFrame = {
      transport: "http",
      method: "get",
      domain: "DeviceManage",
      path: "/v1/x",
      query: { sn: "$sn" },
      headers: { a: "b" },
    };
    expect(frameCommand(frame, 1, ctx("T8114"))).toEqual({
      kind: "cloud-request",
      method: "GET",
      domain: "DeviceManage",
      path: "/v1/x",
      query: { sn: "T8114P0000000000" },
      headers: { a: "b" },
    });
  });
  it("refuses an mqtt, ble or unknown transport, a templated data point and a cloud write it cannot sign", () => {
    for (const transport of ["mqtt", "ble", "other"])
      expect(frameCommand({ transport, cmd: 1, payload: {} }, 1, ctx("T8114")), transport).toBeUndefined();
    expect(
      frameCommand(
        { transport: "dp", dp: 1, value: "0a02", encoding: "hex", template: { seq: "$now" } },
        1,
        ctx("T2351"),
      ),
      "a protobuf",
    ).toBeUndefined();
    expect(
      frameCommand({ transport: "dp", dp: 1, value: {}, template: { seq: "$input.seq" } }, "{}", ctx("T2351")),
      "no seq given",
    ).toBeUndefined();
    expect(
      frameCommand({ transport: "http", path: "/v1/x", method: "patch" }, 1, ctx("T8114")),
      "patch",
    ).toBeUndefined();
    expect(
      frameCommand({ transport: "http", path: "/v1/x", body: "x" }, 1, ctx("T8114")),
      "a body not JSON",
    ).toBeUndefined();
  });
});

/** The bundle module (and the barrel, the device) over a synthetic `wires` table instead of the shipped data. */
async function over(wires: object) {
  vi.resetModules();
  vi.doMock("../bundle-wires.generated.json", () => ({ default: { wires } }));
  const modules = {
    bundle: await import("../bundle.js"),
    index: await import("../index.js"),
    device: await import("../../device.js"),
  };
  vi.doUnmock("../bundle-wires.generated.json");
  return modules;
}

/** Power as `bundle-fixture` writes it on T0001, 2001 read after 1035; T0002 reads it but writes nothing. */
const POWER = { camera_on_off: { T0001: power("1035>2001"), T0002: { read: { standalone: { order: "1035" } } } } };

describe("bundled", () => {
  const described = things({ camera_on_off: "bool" });

  it("reads each param with the polarity its map gives it, on the topology that reads it", async () => {
    const { bundle } = await over(POWER);
    const onOff = bundle.bundled(["camera_on_off"], 1035);
    const standalone = ctx("T0001", { things: described, paramIds: new Set([2001]) });
    expect(onOff.invertFor(standalone), "1035 maps 0 to on").toBe(true);
    const alias = onOff.readAliases.find((a) => a.paramType === 2001)!;
    expect([alias.invert, alias.available(standalone)]).toEqual([false, true]);
    expect(alias.available(ctx("T0001", { things: described, ...attached })), "not read on a HomeBase").toBe(false);
    expect(
      onOff.readAliases.find((a) => a.paramType === 6250)!.available(ctx("T0001", { things: described, ...attached })),
    ).toBe(true);
  });
  it("writes the frame of the topology the device is on", async () => {
    const { bundle } = await over(POWER);
    const onOff = bundle.bundled(["camera_on_off"], 1035);
    expect(onOff.write(true, ctx("T0001", { things: described }))).toMatchObject({ param: 1035, value: 0 });
    expect(onOff.write(true, ctx("T0001", { things: described, ...attached }))).toMatchObject({
      cmd: 6250,
      payload: { switch: 0 },
    });
  });
  it("is absent without a description, and where the bundle writes nothing", async () => {
    const { bundle } = await over(POWER);
    const onOff = bundle.bundled(["camera_on_off"], 1035);
    expect(onOff.available(ctx("T0001"))).toBe(false);
    expect(onOff.available(ctx("T0002", { things: described }))).toBe(false);
    expect(onOff.available(ctx("T0001", { things: described }))).toBe(true);
  });
  it("is absent where every frame the bundle sends is one the SDK cannot send", async () => {
    const ble = { transport: "ble" };
    const { bundle } = await over({ led_on_off: { T0001: { write: { standalone: { "0": ble, "1": ble } } } } });
    expect(
      bundle.bundled(["led_on_off"], 1045).available(ctx("T0001", { things: things({ led_on_off: "bool" }) })),
    ).toBe(false);
  });
  it("sends a type json MQTT frame as the app's sendRequestWithJson: its cmd and the JSON its payload holds", async () => {
    const json = (on: number) => ({
      transport: "mqtt",
      type: "json",
      mqttCmdCode: 9,
      cmd: 1235,
      payload: `{"on":${on}}`,
      needAck: false,
    });
    const { bundle } = await over({ led_on_off: { T0001: { write: { standalone: { "0": json(0), "1": json(1) } } } } });
    const c = ctx("T0001", { things: things({ led_on_off: "bool" }) });
    expect(bundle.bundled(["led_on_off"], 1045).available(c)).toBe(true);
    expect(bundle.thingWrite("led_on_off", "1", c)).toMatchObject({
      kind: "mqtt-json",
      mqttCmdCode: 9,
      cmd: 1235,
      payload: { on: 1 },
      needAck: false,
    });
  });
  it("offers the app's values and writes only those with a frame; a raw reads as the app's value", async () => {
    const frame = (night_sion: number) => ({
      cmd: 1350,
      subCmd: 1277,
      mValue3: 0,
      body: "json1350",
      channel: "$channel",
      payload: { night_sion },
    });
    const { bundle } = await over({
      nightvision_type_new: {
        T0001: {
          write: { standalone: { "100": frame(0), "102": frame(1), "103": frame(2) } },
          read: { standalone: { order: "1277", map: { 1277: { "0": "100", "1": "102", "2": "103" } } } },
        },
      },
    });
    const nv = bundle.bundled(["nightvision_type_new"], 1277, true);
    const c = ctx("T0001", { things: things({ nightvision_type_new: ["100", "101", "102", "103"] }) });
    expect(nv.enumValuesFor(c), "values the description leaves unnamed are not offered").toBeUndefined();
    expect(nv.writeDomainFor(c)).toEqual([100, 102, 103]);
    expect(nv.write(101, c), "listed, no frame").toBeUndefined();
    expect(nv.write(103, c)).toMatchObject({ cmd: 1277, payload: { night_sion: 2 } });
    expect(nv.coerceFor(c)!("2", 1277)).toBe(103);
  });
  it("offers a bool property's 0/1 as Off/On", async () => {
    const frame = (osd: number) => ({
      cmd: 1214,
      body: "groupA",
      channel: "$channel",
      payload: { value: osd },
      valueKey: "value",
      coerce: "int",
    });
    const { bundle } = await over({
      watermark_set: {
        T0001: {
          write: { standalone: { "0": frame(0), "1": frame(2) } },
          read: { standalone: { order: "1214", map: { 1214: { "0": "0", "2": "1" } } } },
        },
      },
    });
    const wm = bundle.bundled(["watermark_set"], 1214, true);
    const c = ctx("T0001", { things: things({ watermark_set: "bool" }) });
    expect(wm.enumValuesFor(c)).toEqual({ 0: "Off", 1: "On" });
    expect(wm.writeDomainFor(c)).toEqual([0, 1]);
    expect(wm.coerceFor(c)!("2", 1214)).toBe(1);
  });
});

describe("an identifier no member claims", () => {
  const WIRES = {
    voice_expulsion_switch: {
      T0001: {
        write: {
          standalone: {
            "*": {
              cmd: 1350,
              subCmd: 6450,
              mValue3: 0,
              body: "json1350",
              channel: "$channel",
              payload: { deviceSn: "$sn", enable: "$value", transaction: "$now" },
            },
          },
        },
        read: { standalone: { order: "6450" } },
      },
    },
  };
  const td = things({ voice_expulsion_switch: "bool", led_on_off: "bool" });

  it("is written by its identifier as the product's bundle sends it", async () => {
    const { index } = await over(WIRES);
    expect(index.buildCommand("voice_expulsion_switch", true, ctx("T0001", { things: td }))).toEqual({
      kind: "set-payload",
      cmd: 6450,
      payload: { deviceSn: "T0001P0000000000", enable: true, transaction: String(NOW) },
      channel: 3,
      mValue3: 0,
    });
  });
  it("is refused when a member claims it, or the description does not list it", async () => {
    const { index } = await over(WIRES);
    expect(index.buildCommand("led_on_off", true, ctx("T0001", { things: td }))).toBeUndefined();
    expect(index.buildCommand("voice_expulsion_switch", true, ctx("T0001"))).toBeUndefined();
  });
  it("is read as the bundle reads it, the description's default until reported", async () => {
    const { device } = await over(WIRES);
    const dev = device.Device.fromRecord("T0001P0000000000", { model: "T0001", category: "eufy_security", params: {} });
    dev.bindActions(ctx("T0001", { things: td }), { dispatch: async () => undefined });
    expect(dev.thingValue("voice_expulsion_switch")).toBe("1");
    dev.applyParams({ 6450: "0" });
    expect(dev.thingValue("voice_expulsion_switch")).toBe("0");
    expect(dev.thingValue("not_listed")).toBeUndefined();
  });
});

test("reads a hex-encoded data point by the base64 the SDK holds it in", async () => {
  vi.resetModules();
  vi.doMock("../bundle-wires.generated.json", () => ({
    default: {
      wires: {
        clean_mode: {
          T0001: {
            write: { standalone: { "1": { transport: "dp", dp: 154, value: "0a02", encoding: "hex" } } },
            read: { standalone: { order: "154", map: { 154: { "0a02": "1", "0a00": "0" } } } },
          },
        },
      },
    },
  }));
  const bundle = await import("../bundle.js");
  const c = ctx("T0001", { codec: undefined, things: things({ clean_mode: ["0", "1"] }) });
  expect(bundle.thingRead("clean_mode", c, (p) => (p === 154 ? "CgI=" : undefined))).toBe("1");
  expect(bundle.thingReadback("clean_mode", "1", c)).toEqual({ param: 154, raw: "CgI=" });
  vi.doUnmock("../bundle-wires.generated.json");
});

describe("the regenerated data's forms", () => {
  it("picks a quality config's tier as the app does: base64 JSON by cur_mode or mode_0, a bare int as is", () => {
    const b64 = (cfg: unknown) => Buffer.from(JSON.stringify(cfg)).toString("base64");
    const cfg = { cur_mode: 2, mode_0: { quality: 2 }, mode_1: { quality: 3 } };
    expect(qualityOf(b64(cfg), "cur_mode")).toBe(3);
    expect(qualityOf(b64({ ...cfg, cur_mode: 1 }), "cur_mode")).toBe(2);
    expect(qualityOf(b64(cfg), "mode_0")).toBe(2);
    expect(qualityOf("3", "cur_mode")).toBe(3);
    expect(qualityOf(b64({ mode_0: { quality: 2 } }), "cur_mode"), "no cur_mode").toBeUndefined();
  });

  it("leaves a $userId key to the transport", () => {
    const frame: BundleFrame = {
      cmd: 1271,
      body: "json",
      channel: 255,
      payload: { account_id: "$userId", snooze_time: 900 },
    };
    expect(frameCommand(frame, 1, ctx("T8214"))).toMatchObject({ kind: "set-json-raw", data: { snooze_time: 900 } });
    expect((frameCommand(frame, 1, ctx("T8214")) as { data: object }).data).not.toHaveProperty("account_id");
  });
});

test("names a shared frame by its index, and reads a quality config through its decoder", async () => {
  vi.resetModules();
  vi.doMock("../bundle-wires.generated.json", () => ({
    default: {
      frames: [{ cmd: 1350, subCmd: 2731, mValue3: 0, body: "json1350", channel: "$channel", payload: { quality: 3 } }],
      wires: {
        record_resolution: {
          T0001: {
            write: { standalone: { "5": 0 } },
            read: {
              standalone: {
                order: "2731",
                quality: { param: 2731, select: "cur_mode", map: { "3": "5", default: "2" } },
              },
            },
          },
        },
      },
    },
  }));
  const bundle = await import("../bundle.js");
  const c = ctx("T0001", { things: things({ record_resolution: ["2", "5"] }) });
  expect(bundle.thingWrite("record_resolution", "5", c)).toMatchObject({ cmd: 2731, payload: { quality: 3 } });
  const config = Buffer.from(JSON.stringify({ cur_mode: 0, mode_0: { quality: 3 } })).toString("base64");
  expect(bundle.thingRead("record_resolution", c, () => config)).toBe("5");
  expect(
    bundle.thingRead("record_resolution", c, () => "1"),
    "another tier",
  ).toBe("2");
  vi.doUnmock("../bundle-wires.generated.json");
});

test("refuses an identifier the app handles in its own Java, write and read alike", async () => {
  vi.resetModules();
  vi.doMock("../bundle-wires.generated.json", () => ({
    default: {
      wires: {
        timezone_set: {
          T0001: {
            override: "java",
            write: {
              standalone: {
                "*": {
                  cmd: 1215,
                  body: "groupA",
                  channel: "$channel",
                  payload: { value: "$value" },
                  valueKey: "value",
                },
              },
            },
            read: { standalone: { order: "1215" } },
          },
        },
      },
    },
  }));
  const bundle = await import("../bundle.js");
  const index = await import("../index.js");
  const c = ctx("T0001", { things: things({ timezone_set: ["Europe/Berlin"] }) });
  expect(bundle.thingWrite("timezone_set", "1", c)).toBeUndefined();
  expect(index.buildCommand("timezone_set", "1", c)).toBeUndefined();
  expect(index.thingValue("timezone_set", c, () => "x")).toBeUndefined();
  vi.doUnmock("../bundle-wires.generated.json");
});
