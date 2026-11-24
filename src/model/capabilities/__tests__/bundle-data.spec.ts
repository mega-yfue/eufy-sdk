import { frameCommand, thingRead, thingWrite, type BundleFrame } from "../bundle.js";
import { byteCodec } from "./proto-bytes.js";
import type { ThingDescription, ThingProperty } from "../thing-description.js";
import type { CommandContext } from "../types.js";
import type { Command } from "../../../core/contracts.js";
import DATA from "../bundle-wires.generated.json" with { type: "json" };

/** The identifiers a member writes from the shipped data, `bool` where the member is a switch. */
const IDENTIFIERS: Record<string, "bool" | "enum"> = {
  camera_on_off: "bool",
  led_on_off: "bool",
  anti_theft_detection_switch: "bool",
  microphone_on_off: "bool",
  speaker_on_off: "bool",
  audio_recording_on_off: "bool",
  motion_track_status: "bool",
  notification_type: "enum",
  nightvision_type_new: "enum",
  nightvision_type: "enum",
  live_streaming_resolution: "enum",
  record_resolution: "enum",
  watermark_set: "enum",
};
const STATIONS = { standalone: undefined, hb2: "T8010P0000000000", hb3: "T8030P0000000000" } as const;

type Grouped<T> = Record<string, T>;
const data = DATA as unknown as {
  frames?: BundleFrame[];
  wires: Grouped<
    Grouped<{
      write?: Grouped<Grouped<BundleFrame | number>>;
      read?: Grouped<{ map?: Grouped<Grouped<string>>; exact?: { record: [number, string][]; ui: string }[] }>;
    }>
  >;
};
const frameOf = (f: BundleFrame | number) => (typeof f === "number" ? data.frames![f]! : f);

/** A description listing `identifier` (resolved to `variant`) with the given type. */
const described = (identifier: string, variant: string, type: string): ThingDescription =>
  ({
    properties: { [identifier]: { identifier: identifier + variant, type, members: [] } as unknown as ThingProperty },
  }) as unknown as ThingDescription;

/** Every write row of the shipped data for the member identifiers: product, variant, topology, value, frame. */
const rows = Object.entries(IDENTIFIERS).flatMap(([identifier, type]) =>
  Object.entries(data.wires[identifier] ?? {}).flatMap(([products, entry]) =>
    products.split(" ").flatMap((product) => {
      const [model, variant = ""] = product.split(/(?=__v\d+$)/);
      return Object.entries(entry.write ?? {}).flatMap(([topologies, values]) =>
        topologies.split(" ").flatMap((topology) =>
          Object.entries(values).flatMap(([keys, f]) =>
            keys
              .split(" ")
              .filter((v) => v !== "*")
              .map((value) => ({ identifier, type, model: model!, variant, topology, value, frame: frameOf(f) })),
          ),
        ),
      );
    }),
  ),
);

const NOW = 1_700_000_000_000;
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
afterEach(() => vi.restoreAllMocks());

/** The context of a row: a described `model` on channel 2, attached to the topology's station. */
const contextOf = (r: { identifier: string; type: string; model: string; variant: string; topology: string }) => {
  const station = STATIONS[r.topology as keyof typeof STATIONS];
  return {
    channel: 2,
    codec: "camera",
    model: r.model,
    serial: `${r.model}P0000000000`.slice(0, 16),
    paramIds: new Set<number>(),
    things: described(r.identifier, r.variant, r.type),
    ...(station && { stationSerial: station, homeBaseAttached: true }),
  } as CommandContext;
};

/**
 * `x` with the bundle's tokens as the app fills them on this device for `value`, no param reported (a
 * `$param:` token's `??` fallback); an `account_id: "$userId"` key left out.
 */
const filled = (x: unknown, value: unknown, ctx: CommandContext): unknown => {
  const tokens: Record<string, unknown> = {
    $value: value,
    $channel: ctx.channel,
    $now: String(NOW),
    $nowS: NOW / 1000,
    $sn: ctx.serial,
    $station: ctx.stationSerial ?? ctx.serial,
  };
  if (typeof x === "string" && x in tokens) return tokens[x];
  if (typeof x === "string" && x.startsWith("$param:")) return JSON.parse(x.split("??")[1]!);
  if (Array.isArray(x)) return x.map((v) => filled(v, value, ctx));
  if (x && typeof x === "object")
    return Object.fromEntries(
      Object.entries(x).flatMap(([k, v]) =>
        v === "$userId" && k === "account_id" ? [] : [[k, filled(v, value, ctx)]],
      ),
    );
  return x;
};

/** The app's `toIntSafety` / `toBooleanSafety` of a scalar body's value. */
const scalar = (v: unknown, coerce?: string) =>
  coerce === "bool1" ? ([true, 1, "1", "true", "TRUE"].includes(v as never) ? 1 : 0) : Math.trunc(Number(v));

/** The command the app sends for a P2P frame of the data: its outer cmd, sub-command, body and header channel. */
function expected(f: BundleFrame, value: unknown, ctx: CommandContext): object {
  const payload = filled(f.payload, value, ctx);
  const channel = filled(f.channel, value, ctx);
  const head =
    f.body === "json1350"
      ? {
          kind: "set-payload",
          cmd: f.subCmd,
          payload,
          channel,
          mValue3: f.mValue3,
        }
      : f.body === "json1700"
        ? { kind: "set-json", param: f.subCmd, data: payload, channel }
        : {
            kind: "set-param",
            param: f.cmd,
            value: scalar((payload as Record<string, unknown>)[f.valueKey!], f.coerce),
            ...(f.body === "pair" && { form: "int-pair" }),
            channel,
          };
  return f.next?.length ? { ...head, next: expected({ ...f.next[0]!, next: f.next.slice(1) }, value, ctx) } : head;
}

describe("every write of the shipped data, as the member identifiers send it", () => {
  // `type: "json"` MQTT frames have their own command shape (`mqtt-json`, bundle.spec.ts).
  const sent = rows.filter((r) => !(r.frame.transport === "mqtt" && r.frame.type === "json"));
  // The T8531 / T85V0 night vision goes as their own settings screens send it (below).
  const bundled = sent.filter((r) => !(/^T85(31|V0)$/.test(r.model) && r.identifier.startsWith("nightvision_type")));

  it("covers the data", () => {
    expect(sent.length).toBeGreaterThan(5000);
    expect(rows.length - sent.length).toBe(6);
    expect(sent.length - bundled.length).toBe(18);
  });
  it.each(bundled.map((r) => [`${r.model}${r.variant} ${r.identifier} ${r.topology} ${r.value}`, r] as const))(
    "%s",
    (_, r) => {
      const ctx = contextOf(r);
      const value = r.type === "bool" ? r.value === "1" : /^-?\d+$/.test(r.value) ? Number(r.value) : r.value;
      // A cached field without a fallback, its param unreported: the app's frame needs the device record.
      const unfilled = /"\$param:[^"?]*"/.test(JSON.stringify(r.frame));
      expect(thingWrite(r.identifier, r.value, ctx)).toEqual(unfilled ? undefined : expected(r.frame, value, ctx));
    },
  );
});

/** Every mapped read of the shipped data: product, variant, topology, param, raw and the value it maps to. */
const reads = Object.entries(IDENTIFIERS).flatMap(([identifier, type]) =>
  Object.entries(data.wires[identifier] ?? {}).flatMap(([products, entry]) =>
    products.split(" ").flatMap((product) => {
      const [model, variant = ""] = product.split(/(?=__v\d+$)/);
      return Object.entries(entry.read ?? {}).flatMap(([topologies, read]) =>
        topologies.split(" ").flatMap((topology) =>
          Object.entries(read.map ?? {}).flatMap(([param, map]) =>
            Object.entries(map).map(([raw, ui]) => {
              const exact = read.exact?.find(
                (e) => e.record.length === 1 && e.record[0]![0] === Number(param) && e.record[0]![1] === raw,
              );
              const value = exact?.ui ?? ui;
              return {
                identifier,
                type,
                model: model!,
                variant,
                topology,
                param: Number(param),
                raw,
                ui: value === "true" ? "1" : value === "false" ? "0" : value,
              };
            }),
          ),
        ),
      );
    }),
  ),
);

describe("every mapped read of the shipped data", () => {
  it.each(reads.map((r) => [`${r.model}${r.variant} ${r.identifier} ${r.topology} ${r.param}=${r.raw}`, r] as const))(
    "%s",
    (_, r) => {
      expect(thingRead(r.identifier, contextOf(r), (p) => (p === r.param ? r.raw : undefined))).toBe(r.ui);
    },
  );
});

describe("the shipped data", () => {
  it("has no null field outside a $param token: a field the bundle reads off the cache names its param", () => {
    const nulls = (x: unknown): boolean =>
      x === null || (typeof x === "object" && Object.values(x as object).some(nulls));
    expect(nulls(data)).toBe(false);
  });
});

/** `SecurityOutdoorModeAction` writes outdoor mode: the bundle's parser reads an object payload the bool cannot carry. */
describe("device_set_outdoor_mode", () => {
  it("is written by the app's Java action, so the data sends nothing for it", () => {
    expect(data.wires.device_set_outdoor_mode).toEqual({ T814X: { override: "java" } });
  });
});

/** A lock setting over its station (`lock-over-station.md` §3): the `ble` TLV as the fields the transport frames. */
describe("smart_lock_rain_mode_switch on a T8531 behind a HomeBase", () => {
  it("is a 1350/1940 whose params the transport builds from the v2 ble descriptor", () => {
    const ctx = contextOf({
      identifier: "smart_lock_rain_mode_switch",
      type: "bool",
      model: "T8531",
      variant: "",
      topology: "hb2",
    });
    const command = thingWrite("smart_lock_rain_mode_switch", "1", ctx) as { kind: string; cmd: number; lock?: any };
    expect([command.kind, command.cmd]).toEqual(["set-payload", 1940]);
    expect(command.lock).toMatchObject({
      cmdCode: 52,
      apiCommand: 6015,
      subVersion: 3,
      functionType: 2,
      encrypt: true,
    });
    expect(command.lock.fields.map((f: { tag: number; value: Buffer }) => [f.tag, f.value.toString("hex")])).toEqual([
      [0xa3, "07"],
      [0xa4, "01"],
    ]);
  });
});

/** A lock that is its own station, as its own settings screen sends there: over secure MQTT, its result awaited. */
describe("a standalone T8531 / T85V0 lock setting", () => {
  const standalone = (identifier: string, model: string, type: string) =>
    contextOf({ identifier, type, model, variant: "", topology: "standalone" });
  const tlv = (c: Command | undefined) =>
    (c as Extract<Command, { kind: "mqtt-dp" }>).fields.map((f) => [f.tag, f.value.toString("hex")]);
  const sent = { kind: "mqtt-dp", mqttCmdCode: 9, cmdCode: 52, apiCommand: 6015, lockService: true };

  it("is the settings TLV in the lock's ff09 frame, a volume re-sending the do-not-disturb fields", () => {
    const rain = thingWrite(
      "smart_lock_rain_mode_switch",
      "1",
      standalone("smart_lock_rain_mode_switch", "T8531", "bool"),
    );
    expect(rain).toMatchObject({ ...sent, subVersion: 3, functionType: 2, encrypt: true, timeoutS: 20 });
    expect(tlv(rain)).toEqual([
      [0xa3, "07"],
      [0xa4, "01"],
    ]);
    const volume = thingWrite(
      "smart_lock_lock_sound_volume",
      "3",
      standalone("smart_lock_lock_sound_volume", "T8531", "string"),
    );
    expect(volume).toMatchObject({ ...sent, preserve: [0xbd, 0xbe, 0xbf] });
    expect(tlv(volume)).toEqual([
      [0xa3, "04"],
      [0xa4, "03"],
    ]);
    const off = thingWrite(
      "smart_lock_lock_sound_switch",
      "false",
      standalone("smart_lock_lock_sound_switch", "T85V0", "string"),
    );
    expect(tlv(off)).toEqual([
      [0xa3, "04"],
      [0xa4, "00"],
    ]);
    const params = standalone("smart_lock_set_setting_params", "T85V0", "text");
    const write = (paramType: number, param = {}) =>
      thingWrite("smart_lock_set_setting_params", JSON.stringify({ paramType, param }), params);
    expect(tlv(write(8, { isPassageMode: 1, passageModeStartTime: "19:00", passageModeEndTime: "07:30" }))).toEqual([
      [0xa3, "08"],
      [0xa4, "01"],
      [0xa5, "1300"],
      [0xa6, "071e"],
    ]);
    expect(tlv(write(6, { isEnableLog: 1 }))).toEqual([]);
    expect(write(13, { faceEnabled: 1, faceWakeType: 0, fingerprintEnabled: 1 })).toBeUndefined();
  });

  it("is a station JSON body as its cmd and payload", () => {
    const ctx = standalone("device_rain_mode", "T85V0", "bool");
    expect(thingWrite("device_rain_mode", "1", ctx)).toEqual({
      kind: "mqtt-json",
      mqttCmdCode: 9,
      cmd: 2732,
      payload: { pvm_rainny_switch: 1 },
      needAck: false,
      lockService: true,
      timeoutS: 20,
    });
  });

  it("awaits the lock's result for a notification switch, as its own settings screen", () => {
    const ctx = standalone("smart_lock_notification_locked_switch", "T85V0", "bool");
    expect(thingWrite("smart_lock_notification_locked_switch", "1", ctx)).toMatchObject({
      kind: "mqtt-json",
      cmd: 1919,
      lockService: true,
      timeoutS: 20,
    });
  });
});

/** What the T8531 / T85V0 settings screens send through the app's legacy sender, and the items they do not show. */
describe("a T8531 / T85V0 lock's own settings screens", () => {
  const on = (identifier: string, model: string, type: string, topology: string) =>
    contextOf({ identifier, type, model, variant: "", topology });

  it("send night vision as a 1350 body without transaction, under the station's member account", () => {
    const legacy = { kind: "set-payload", channel: 2, mValue3: 0, stationAccount: true };
    const write = (identifier: string, value: string, model = "T8531", topology = "hb2", type = "bool") =>
      thingWrite(identifier, value, on(identifier, model, type, topology));
    expect(write("smart_lock_night_vision_optimization", "1")).toEqual({
      ...legacy,
      cmd: 6244,
      payload: { nightVisionEnhance: 1 },
    });
    expect(write("smart_lock_night_vision_open_direction", "2", "T8531", "standalone", "int")).toEqual({
      ...legacy,
      cmd: 6245,
      payload: { lockOpenDirection: 2 },
    });
    expect(write("nightvision_type", "1", "T8531", "standalone")).toEqual({
      ...legacy,
      cmd: 1277,
      payload: { night_sion: 1, channel: 2 },
    });
    expect(write("nightvision_type_new", "102", "T85V0", "hb3", "enum")).toEqual({
      ...legacy,
      cmd: 1277,
      payload: { night_sion: 1, channel: 2 },
    });
  });

  it("send the loitering groups through the lock's settings service on its own, else through the legacy sender", () => {
    const groups = {
      num: 1,
      setting: [
        {
          active: 1,
          auto_voice_id: 0,
          auto_voice_name: "",
          auto_voice_resp: 1,
          end_hour: "23",
          end_min: "59",
          familiar_id: 0,
          homebase_alert: 1,
          push_notify: 1,
          start_hour: "00",
          start_min: "00",
        },
      ],
    };
    const write = (topology: string) =>
      thingWrite(
        "device_loitering_detection_response",
        JSON.stringify(groups),
        on("device_loitering_detection_response", "T85V0", "text", topology),
      );
    expect(write("standalone")).toEqual({
      kind: "mqtt-json",
      mqttCmdCode: 9,
      cmd: 2715,
      payload: groups,
      needAck: false,
      lockService: true,
      timeoutS: 20,
    });
    expect(write("hb2")).toEqual({
      kind: "set-payload",
      cmd: 2715,
      payload: groups,
      channel: 2,
      mValue3: 0,
      stationAccount: true,
    });
  });

  it("send a T8530's loitering groups as the T85V0's: settings service on its own, else the legacy sender", () => {
    const write = (topology: string) =>
      thingWrite(
        "device_loitering_detection_response",
        JSON.stringify({ num: 0, setting: [] }),
        on("device_loitering_detection_response", "T8530", "text", topology),
      );
    expect(write("standalone")).toMatchObject({ kind: "mqtt-json", cmd: 2715, lockService: true });
    expect(write("hb3")).toEqual({
      kind: "set-payload",
      cmd: 2715,
      payload: { num: 0, setting: [] },
      channel: 2,
      mValue3: 0,
      stationAccount: true,
    });
  });

  it("send the T85V0 rear screen settings through the legacy sender on every topology", () => {
    const ctx = on("device_live_view_switch", "T85V0", "bool", "standalone");
    expect(thingWrite("device_live_view_switch", "1", ctx)).toEqual({
      kind: "set-payload",
      cmd: 6491,
      payload: { auto_up: 1 },
      channel: 2,
      mValue3: 0,
      stationAccount: true,
    });
  });

  it("carry the radar rain notification bit in the notification bitmask as the app does", () => {
    const mode = (rain: boolean, cached?: string) => {
      const ctx = on("smart_lock_notification_locked_switch", "T85V0", "bool", "standalone");
      const things = { properties: { ...ctx.things!.properties, ...(rain && { device_rain_mode: {} }) } };
      const c = { ...ctx, things, paramValue: (p: number) => (p === 1919 ? cached : undefined) } as CommandContext;
      return (thingWrite("smart_lock_notification_locked_switch", "1", c) as { payload: { mode: number } }).payload
        .mode;
    };
    expect(mode(true, "3")).toBe(7);
    expect(mode(true, "19")).toBe(23);
    expect(mode(false, "3")).toBe(23);
    expect(mode(true)).toBe(17);
  });

  it("send loitering detection as the dialog's 1-based index, read back as the UI value", () => {
    const ctx = (identifier: string, model: string, topology: string) => on(identifier, model, "int", topology);
    const range = "detection_loitering_detection_range";
    expect(thingWrite(range, "8", ctx(range, "T85V0", "standalone"))).toEqual({
      kind: "mqtt-json",
      mqttCmdCode: 9,
      cmd: 2707,
      payload: { radar_wd_distance: 4 },
      needAck: false,
      lockService: true,
      timeoutS: 20,
    });
    const time = "detection_loitering_detection_length";
    expect(thingWrite(time, "45", ctx(time, "T8530", "hb3"))).toEqual({
      kind: "set-payload",
      cmd: 2708,
      payload: { radar_wd_time: 5 },
      channel: 2,
      mValue3: 0,
      stationAccount: true,
    });
    expect(thingWrite(time, "35", ctx(time, "T8530", "hb3"))).toBeUndefined();
    const raw = Buffer.from(JSON.stringify({ radar_wd_time: 6 })).toString("base64");
    expect(thingRead(time, ctx(time, "T85V0", "hb2"), (p) => (p === 2708 ? raw : undefined))).toBe("60");
  });

  it("send a T8530 setting over its last read, under the station's member account", () => {
    const value = JSON.stringify({ paramType: 6505, param: { lockVolume: 2 } });
    const command = thingWrite(
      "smart_lock_set_setting_params",
      value,
      on("smart_lock_set_setting_params", "T8530", "text", "hb3"),
    ) as Extract<Command, { kind: "set-payload" }>;
    expect(command).toMatchObject({
      kind: "set-payload",
      cmd: 1958,
      payload: { lockVolume: 2, paramType: 6505 },
      channel: 2,
      stationAccount: true,
      base: { query: 1959 },
    });
    expect(Object.keys(command.base!.fields)).toHaveLength(33);
  });

  it("offer rain mode on the T8531 only, never on a lock whose settings are its bundle's", () => {
    const rain = (model: string, topology: string) =>
      thingWrite("smart_lock_rain_mode_switch", "1", on("smart_lock_rain_mode_switch", model, "bool", topology));
    expect(rain("T8531", "standalone")).toBeDefined();
    expect(rain("T8531", "hb2")).toBeDefined();
    expect(rain("T85V0", "standalone")).toBeUndefined();
    expect(rain("T85M0", "standalone")).toBeUndefined();
    const params = (topology: string) =>
      thingWrite(
        "smart_lock_set_setting_params",
        JSON.stringify({ paramType: 7, param: { isRainMode: 1 } }),
        on("smart_lock_set_setting_params", "T85V0", "text", topology),
      );
    expect(params("standalone")).toBeUndefined();
    expect(params("hb2")).toBeUndefined();
  });
});

/** `smart_lock_set_setting_params` (`{paramType, param}`): the paramType's TLV, each field the parser writes in place. */
describe("smart_lock_set_setting_params on a T8502 behind a HomeBase", () => {
  it("writes paramType 0 (auto-lock and schedule) from the param fields", () => {
    const ctx = contextOf({
      identifier: "smart_lock_set_setting_params",
      type: "text",
      model: "T8502",
      variant: "",
      topology: "hb2",
    });
    const value = JSON.stringify({
      paramType: 0,
      param: {
        isAutoLock: 1,
        autoLockTime: 30,
        isSchedule: 0,
        scheduleStartTime: "22:00",
        scheduleEndTime: "06:30",
        lockLogic: 1,
      },
    });
    const command = thingWrite("smart_lock_set_setting_params", value, ctx) as { cmd: number; lock?: any };
    expect(command.cmd).toBe(1940);
    expect(command.lock.fields.map((f: { tag: number; value: Buffer }) => [f.tag, f.value.toString("hex")])).toEqual([
      [0xa3, "00"],
      [0xa4, "01"],
      [0xa5, "1e00"],
      [0xa6, "00"],
      [0xa7, "1600"],
      [0xa8, "061e"],
      [0xa9, "01"],
    ]);
  });

  it("refuses a field it cannot encode rather than send a short frame", () => {
    const ctx = contextOf({
      identifier: "smart_lock_set_setting_params",
      type: "text",
      model: "T8502",
      variant: "",
      topology: "hb2",
    });
    const value = JSON.stringify({ paramType: 4, param: { lockVolume: 300 } });
    expect(thingWrite("smart_lock_set_setting_params", value, ctx)).toBeUndefined();
  });
});

/** The v4 settings parser (`setLockParamsBleV1PayloadData`, paramType 6500..): its TLV, sealed by the transport. */
describe("smart_lock_set_setting_params on a T8500", () => {
  it("writes paramType 6500 (auto-lock) as a v4 lock body under bleCommand 0x22", () => {
    const ctx = contextOf({
      identifier: "smart_lock_set_setting_params",
      type: "text",
      model: "T8500",
      variant: "",
      topology: "hb2",
    });
    const value = JSON.stringify({ paramType: 6500, param: { isAutoLock: 1, autoLockTime: 30 } });
    const command = thingWrite("smart_lock_set_setting_params", value, ctx) as { lock?: any };
    expect(command.lock).toMatchObject({ version: 4, bleCommand: 0x22 });
    expect(command.lock.payload.toString("hex")).toBe("a1021964a20101a3021e00a404" + "00f15365");
  });
});

/** Rows the generator frames once a bool goes as a number and a json MQTT payload as its object (`$value` inside). */
describe("writes framed from their real payload shape", () => {
  it("sends T8028's arming mode as a type json MQTT write carrying the value", () => {
    const ctx = contextOf({
      identifier: "arming_selected_mode",
      type: "enum",
      model: "T8028",
      variant: "",
      topology: "standalone",
    });
    expect(thingWrite("arming_selected_mode", "2", ctx)).toMatchObject({ kind: "mqtt-json", cmd: 1350, payload: 2 });
  });
  it("sends T8200's HDR switch as a 1700 with the status as a number", () => {
    const ctx = contextOf({
      identifier: "video_quality_hdr_switch",
      type: "bool",
      model: "T8200",
      variant: "",
      topology: "standalone",
    });
    expect(thingWrite("video_quality_hdr_switch", "1", ctx)).toMatchObject({
      kind: "set-json",
      param: 1019,
      data: { status: 1 },
    });
  });
});

/** A frame whose parser passes the host's object through (`"$input": "..."`) sends that object, spread in. */
describe("a config write the parser passes through", () => {
  it("spreads the host's object into T8010's arming schedule", () => {
    const ctx = contextOf({
      identifier: "arming_schedule_config",
      type: "text",
      model: "T8010",
      variant: "",
      topology: "standalone",
    });
    const value = JSON.stringify({ schedule: [{ start: "08:00", end: "18:00" }], mode: 1 });
    const command = thingWrite("arming_schedule_config", value, ctx) as { data?: Record<string, unknown> };
    expect(command.data).toMatchObject({ schedule: [{ start: "08:00", end: "18:00" }], mode: 1 });
    expect(command.data).not.toHaveProperty("$input");
  });
  it("sends T8028's DND config whole, in base64 inside a type json MQTT write", () => {
    const ctx = contextOf({
      identifier: "device_not_disturb_config",
      type: "text",
      model: "T8028",
      variant: "",
      topology: "standalone",
    });
    const config = {
      version: 2,
      enable: 1,
      schedules: [{ id: "1-a", enable: 1, start_h: 22, start_m: 0, end_h: 6, end_m: 0, weeks: [0, 6] }],
    };
    const data = Buffer.from(JSON.stringify({ cmd: 6521, payload: config })).toString("base64");
    expect(thingWrite("device_not_disturb_config", JSON.stringify(config), ctx)).toEqual({
      kind: "mqtt-json",
      mqttCmdCode: 9,
      cmd: 1350,
      payload: { data },
      needAck: false,
      timeoutS: 15,
    });
  });
});

describe("auto_cruise_schedule_list on a T8171", () => {
  it("sends the host's schedules with each week as [{day}], as AutoCruiseScheduleListParser does", () => {
    const ctx = contextOf({
      identifier: "auto_cruise_schedule_list",
      type: "text",
      model: "T8171",
      variant: "",
      topology: "standalone",
    });
    const value = JSON.stringify({ loop: [{ start_time: "08:00", end_time: "09:00", week: [1, 3] }] });
    const command = thingWrite("auto_cruise_schedule_list", value, ctx) as { data?: { schedules?: unknown } };
    expect(command.data?.schedules).toEqual({
      loop: [{ start_time: "08:00", end_time: "09:00", week: [{ day: 1 }, { day: 3 }] }],
    });
  });
});

/** A field the bundle's parser transforms before it sends it (`$input.<key>|<name>`) goes out transformed. */
describe("named transforms, as the parsers apply them", () => {
  const write = (identifier: string, model: string, value: unknown) =>
    thingWrite(
      identifier,
      JSON.stringify(value),
      contextOf({ identifier, type: "text", model, variant: "", topology: "standalone" }),
    ) as { cmd?: number; payload?: Record<string, unknown> } | undefined;

  it("T8425 ambient light: week as a bitmask, each loop's enable 0 while sunset2rise is on", () => {
    const loop = [{ start_h: 8, week: [1, 3], enable: 1 }];
    expect(
      write("light_ambient_lighting_setting", "T8425", { enable: true, sunset2rise: true, loop })?.payload,
    ).toMatchObject({
      enable: 1,
      sunset2rise: 1,
      schedule: [{ start_h: 8, week: 10, enable: 0 }],
    });
    expect(write("light_ambient_lighting_setting", "T8425", { sunset2rise: false, loop })?.payload).toMatchObject({
      schedule: [{ week: 10, enable: 1 }],
    });
  });

  it("T8213 chimes: each normalised, encrypt_key left to the transport", () => {
    const chimes = [{ chime_sn: "SN", chime_mac: "MAC", enable: true, volume: "7", is_play: 0 }];
    expect(write("device_chime_minibase_chime_setting", "T8213", { chimes })).toMatchObject({
      cmd: 6239,
      payload: {
        chimes: [
          {
            chime_sn: "SN",
            chime_mac: "MAC",
            enable: 1,
            volume: 7,
            voice_type: Number.NaN,
            is_play: 0,
            trigger_type: 1,
          },
        ],
        encrypt_key: "$userId",
      },
    });
  });

  it("T8172 motion detection: detection types summed on their bits; image effect on the device's scale", () => {
    expect(
      write("device_motion_detection", "T8172", { ai_detect_type: "1,2", ai_notification: "", ai_switch: true })
        ?.payload,
    ).toMatchObject({ ai_detect_type: 7, ai_notification: 0, push_detect_type: 0 });
    expect(
      write("video_setting_image_effect_set", "T8172", { brightness: 50, contrast: 100, saturation: 0, chrome: 75 })
        ?.payload,
    ).toEqual(expect.objectContaining({ brightness: 256, contrast: 1000, saturation: 1024, chrome: 5120 }));
    expect(
      write("video_setting_image_effect_set", "T8172", { brightness: 101, contrast: 1, saturation: 1, chrome: 1 }),
    ).toBeUndefined();
  });
});

describe("a templated protobuf data point", () => {
  const PROTO = ["hex", "hex-len", "base64"];
  const protos = data.frames!.filter((f) => PROTO.includes(f.encoding!) && f.template);
  /** The standalone frame of `identifier` on the product group listing `product`. */
  const robot = (identifier: string, product: string) =>
    frameOf(
      Object.entries(data.wires[identifier]!).find(([k]) => k.split(" ").includes(product))![1].write!.standalone![
        "*"
      ]!,
    );
  /** The varint or text at `path` (`n:i` the i-th repeat of `n`) of the frame's message. */
  const leaf = (f: BundleFrame, path: string) => {
    const v = f.value as string;
    let fields =
      f.encoding === "hex"
        ? byteCodec.nested(Buffer.from(v, "hex"))
        : byteCodec.decode(f.encoding === "base64" ? v : Buffer.from(v, "hex").toString("base64"));
    let hit;
    for (const key of path.split(".")) {
      const [n, i = 0] = key.split(":").map(Number);
      hit = fields?.filter((x) => x.field === n)[i!];
      fields = hit?.kind === "bytes" ? byteCodec.nested(hit.value) : undefined;
    }
    return hit?.kind === "int" ? Number(hit.value) : hit?.value.toString("utf8");
  };
  const ctx = { channel: 0, paramIds: new Set<number>() } as unknown as CommandContext;

  it("re-encodes every one of the data byte for byte, its fields set to what they hold", () => {
    // A transformed field (`|<name>`) is set from the host's value, not read back: its own cases below.
    const plain = protos.filter((f) => !JSON.stringify(f.template).includes("|"));
    expect(plain.length).toBe(262);
    for (const f of plain) {
      // A table's key (`values`) is the one its own value is listed under.
      const table = f.values && Object.entries(f.values.map).find(([, v]) => v === f.value)?.[0];
      const input: Record<string, unknown> = table === undefined ? {} : { [f.values!.key]: Number(table) };
      for (const [path, token] of Object.entries(f.template as Record<string, string>)) {
        const v = leaf(f, path);
        if (token === "$seq") vi.spyOn(Math, "random").mockReturnValue(((v as number) - 1000) / 9000);
        else input[token.slice("$input.".length)] = v;
      }
      const value = f.encoding === "base64" ? f.value : Buffer.from(f.value as string, "hex").toString("base64");
      expect(frameCommand(f, JSON.stringify(input), ctx), JSON.stringify(f)).toEqual({
        kind: "aiot-dp",
        dp: f.dp,
        value,
      });
    }
  });
  it("sets a T2801 bool in its wrapper as the bundle does, false an empty message", () => {
    const f = frameOf(data.wires.ecl_mow_defogger_control!["T2801 T280B T2880 T2880B"]!.write!.standalone!["*"]!);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const sent = (on: boolean) => frameCommand(f, JSON.stringify({ force_heating: on }), ctx);
    expect(sent(true)).toEqual({
      kind: "aiot-dp",
      dp: 143,
      value: Buffer.from("08fc2a10032a020801", "hex").toString("base64"),
    });
    expect(sent(false)).toEqual({
      kind: "aiot-dp",
      dp: 143,
      value: Buffer.from("08fc2a10032a00", "hex").toString("base64"),
    });
  });
  it("sends a room list as the bundles' repeated {id, order}, from 1 or (T2080A cleaning) from 0", () => {
    // The bundles' `controlDevice` answers for these inputs.
    const room = '{"roomIds":[2,5,9],"cleanTimes":2,"mapId":3,"seq":7}';
    expect(frameCommand(robot("ecl_start_room_clean", "T2070"), room, ctx)).toEqual({
      kind: "aiot-dp",
      dp: 152,
      value: "HAgBEAciFgoECAIQAQoECAUQAgoECAkQAxACGAM=",
    });
    expect(frameCommand(robot("ecl_start_room_clean", "T2080A"), room, ctx)).toEqual({
      kind: "aiot-dp",
      dp: 152,
      value: Buffer.from("1a0801100722140a0208020a04080510010a040809100210021803", "hex").toString("base64"),
    });
    const order = robot("ecl_custom_order", "T2070");
    expect(frameCommand(order, '{"selectRooms":[4,1],"mapId":3,"isEnable":true,"seq":7}', ctx)).toEqual({
      kind: "aiot-dp",
      dp: 170,
      value: "GggFEAcYA1ISCgIIARIMCgQIBBABCgQIARAC",
    });
    expect(frameCommand(order, '{"selectRooms":[],"mapId":3,"isEnable":false,"seq":7}', ctx)).toEqual({
      kind: "aiot-dp",
      dp: 170,
      value: "DAgFEAcYA1IECgASAA==",
    });
    const json = frameCommand(robot("ecl_custom_order", "T2261A"), '{"selectRooms":[4,1],"mapId":3}', ctx) as {
      value: string;
    };
    expect(JSON.parse(Buffer.from(json.value, "base64").toString("utf8"))).toEqual({
      method: "globalRooms",
      data: {
        mapId: 3,
        property: [
          { roomId: 4, cleanOrder: 1 },
          { roomId: 1, cleanOrder: 2 },
        ],
      },
      timestamp: NOW,
    });
  });
  it("sends do-not-disturb as the bundles' ASCII hex, or T2210's JSON times", () => {
    // The bundles' `controlDevice` answers for these inputs.
    const dnd = '{"isOn":true,"startHour":22,"startMin":5,"endHour":7,"endMin":30}';
    const hex = (h: string) => Buffer.from(h, "hex").toString("base64");
    const t2261a = robot("ecl_toggle_do_not_disturb", "T2261A");
    expect(frameCommand(t2261a, dnd, ctx)).toEqual({ kind: "aiot-dp", dp: 139, value: hex("313232303530373330") });
    expect(frameCommand(t2261a, '{"isOn":false,"startHour":"9","startMin":0,"endHour":10,"endMin":0}', ctx)).toEqual({
      kind: "aiot-dp",
      dp: 139,
      value: hex("303039303031303030"),
    });
    expect(frameCommand(robot("ecl_toggle_do_not_disturb", "T2210"), dnd, ctx)).toEqual({
      kind: "aiot-dp",
      dp: 107,
      value: '{"en":true,"start_t":"2205","end_t":"0730"}',
    });
  });
  it("sends a value through the bundle's own table, a list of one by its element", () => {
    // The bundles' `controlDevice` answers for these inputs; a longer list is not in the table, so not sent.
    const hex = (h: string) => Buffer.from(h, "hex").toString("base64");
    const reset = robot("ecl_reset_accessory", "T2261A");
    expect(frameCommand(reset, '{"consumables":[6]}', ctx)).toEqual({
      kind: "aiot-dp",
      dp: 116,
      value: hex("7b22636f6e73756d61626c65223a7b227265736574223a5b224442225d7d7d"),
    });
    expect(frameCommand(reset, '{"consumables":[0,1]}', ctx)).toBeUndefined();
    expect(frameCommand(robot("ecl_reset_accessory", "T2210"), '{"consumables":[2]}', ctx)).toEqual({
      kind: "aiot-dp",
      dp: 150,
      value: '{"dust_filter":0}',
    });
    expect(frameCommand(robot("ecl_update_suction", "T2261A"), '{"speed":2}', ctx)).toEqual({
      kind: "aiot-dp",
      dp: 102,
      value: "Turbo",
    });
  });
  it("sets T2070's custom fan and water as its bundle builds it, a false leaving its message empty", () => {
    const f = frameOf(data.wires.ecl_custom_fan_water!["T2070 T2071 T2081 T2280 T2351"]!.write!.standalone!["*"]!);
    // The bundle's `controlDevice` answers for {seq, mapId, isCleaningScheduledTask, isEnable: 1, smartMode: 1}.
    expect(frameCommand(f, '{"seq":7,"mapId":3,"isCleaningScheduledTask":false,"smartMode":1}', ctx)).toEqual({
      kind: "aiot-dp",
      dp: 170,
      value: "DAgFEAcYA1IEIgIIAQ==",
    });
    expect(frameCommand(f, '{"seq":300,"mapId":2,"isCleaningScheduledTask":true,"smartMode":1}', ctx)).toEqual({
      kind: "aiot-dp",
      dp: 170,
      value: "DwgFEKwCGAJSBiICCAEoAQ==",
    });
  });
});
