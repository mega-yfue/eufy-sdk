import { SIREN, SIREN_PARAM, SirenVolume, HubAlarmTone, type SirenActions } from "../siren.js";
import { DeviceType } from "../../device-types.js";
import { bind } from "./bind.js";
import { parseThingsList } from "../thing-description.js";
import { buildActions, detectCapabilities } from "../index.js";
import type { CommandContext } from "../types.js";
import type { Command } from "../../../core/contracts.js";

/** The bound `dev.siren()` object — every write is a member, derived in the barrel. */
const sirenOf = (c: CommandContext) => bind<SirenActions>("siren", c);

/** `sensor_alarm_timeout` as T90R0's description lists it, and as T90G0's (an int with no members). */
const timeout = (data_type: object) =>
  parseThingsList({
    things_list: [
      { profile: { product_code: "T0000" }, properties: [{ identifier: "sensor_alarm_timeout", data_type }] },
    ],
  }).T0000!;
const T90R0_TIMEOUT = timeout({
  type: "ienum",
  specs: {
    eunmList: ["1min", "5min", "10min", "15min"].map((desc, i) => ({ value: String(i), desc, associatedValue: "" })),
  },
});
const T90G0_TIMEOUT = timeout({ type: "int", specs: {} });

const ctx = (paramIds = [61008, 1825, 61006, 1828], channel = 16): CommandContext =>
  ({
    channel,
    codec: "sensor",
    deviceType: DeviceType.SIREN_SENSOR_E20,
    model: "T90R0",
    serial: "T90R00000000000",
    paramIds: new Set(paramIds),
  }) as CommandContext;

describe("siren capability module", () => {
  it("declares the capability + schema", () => {
    expect(SIREN.capability).toBe("siren");
    expect(SIREN.properties.map((p) => p.name)).toEqual([
      "siren",
      "sirenVolume",
      "alarmDuration",
      "doNotDisturb",
      "hubAlarmTone",
    ]);
  });

  it("pins the exact ids a real siren reports — a fabricated id must fail here", () => {
    const ids = SIREN.properties.map((p) => p.paramType);
    expect(ids).toEqual([61008, 1825, 61006, 1828, 1281]);
    expect(ids).not.toContain(1300); // old guessed switch
    expect(ids).not.toContain(1230); // old guessed volume
    expect([
      SIREN_PARAM.RING_STATUS,
      SIREN_PARAM.ALARM_VOLUME,
      SIREN_PARAM.ALARM_TIMEOUT,
      SIREN_PARAM.NOT_DISTURB,
    ]).toEqual([61008, 1825, 61006, 1828]);
  });

  it("the sounding read is a confirmed boolean (a live test observed 1 then 0)", () => {
    const ring = SIREN.properties.find((p) => p.paramType === SIREN_PARAM.RING_STATUS);
    expect(ring?.type).toBe("bool");
    expect(ring?.writable).toBe(false);
  });

  it("volume + duration are writable", () => {
    for (const name of ["sirenVolume", "alarmDuration"]) {
      const p = SIREN.properties.find((x) => x.name === name);
      expect(p?.writable).toBe(true);
    }
  });

  describe("writes (captured live on a T90R0)", () => {
    it("setVolume emits the 1350 SET_PAYLOAD the app sends ({volume}, mValue3 0, device channel)", async () => {
      const { acts: a, sent } = sirenOf(ctx());
      await a.setVolume!(SirenVolume.High);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        kind: "set-payload",
        cmd: SIREN_PARAM.ALARM_VOLUME,
        channel: 16,
        mValue3: 0,
        payload: { volume: 3 },
      });
    });

    it("setAlarmDuration sends the app's UI value as its bundle's seconds", async () => {
      const { acts: a, sent } = sirenOf({ ...ctx(), things: T90R0_TIMEOUT });
      await a.setAlarmDuration!(1);
      expect(sent[0]).toMatchObject({ kind: "set-payload", cmd: SIREN_PARAM.ALARM_TIMEOUT, payload: { value: 300 } });
    });

    it("offers no alarm duration where the description lists none, as the app offers none (T90G0)", () => {
      const a = sirenOf({ ...ctx(), model: "T90G0", serial: "T90G00000000000", things: T90G0_TIMEOUT }).acts;
      expect(a.setAlarmDuration).toBeUndefined();
    });

    it.each([
      // `SetAlarmTypeParser` (forTest): the test on 1826, the ringing stop on 61017 APP_CMD_DEV_SIREN_STOP_ALARM.
      ["T90R0", 61017],
      // The open-only parser: the test on 1826, any stop on 1871.
      ["T8920", 1871],
    ])("sends a %s the settings' test and ringing stop as its bundle frames them", async (model, stop) => {
      const { acts, sent } = sirenOf({
        ...ctx(),
        model,
        serial: `${model}0000000000`,
        things: alarmThings(model, ["0"]),
      });
      await acts.test!();
      await acts.stop!();
      expect(sent).toEqual(
        [1826, stop].map((cmd) => ({
          kind: "set-payload",
          cmd,
          payload: { transaction: expect.any(String) },
          channel: 16,
          mValue3: 0,
        })),
      );
    });

    it("installs no test or stop on a sensor siren whose description lists no set_alarm_type", () => {
      const { acts } = sirenOf(ctx());
      expect(acts.test).toBeUndefined();
      expect(acts.stop).toBeUndefined();
    });

    it("retains configured duration and volume on the volume-plus-timeout evidence path", () => {
      const actions = sirenOf({ ...ctx([1825, 61006]), things: T90R0_TIMEOUT }).acts;

      expect("volume" in actions).toBe(true);
      expect(actions.setVolume).toBeDefined();
      expect("alarmDuration" in actions).toBe(true);
      expect(actions.setAlarmDuration).toBeDefined();
      expect("active" in actions).toBe(false);
      expect("doNotDisturb" in actions).toBe(false);
    });

    it("retains reported active and do-not-disturb reads on the volume-plus-ring evidence path", () => {
      const actions = sirenOf(ctx([1825, 61008, 1828])).acts;

      expect("volume" in actions).toBe(true);
      expect(actions.setVolume).toBeDefined();
      expect("active" in actions).toBe(true);
      expect("doNotDisturb" in actions).toBe(true);
      expect("alarmDuration" in actions).toBe(false);
    });

    it("installs nothing on a sensor with no standalone siren evidence", () => {
      const a = sirenOf(ctx([])).acts as Record<string, unknown>;
      expect(a.setVolume).toBeUndefined();
      expect(a.setAlarmDuration).toBeUndefined();
      expect(a.test).toBeUndefined();
      expect(a.stop).toBeUndefined();
    });

    it("rejects out-of-range volume rather than sending", async () => {
      const { acts: a, sent } = sirenOf(ctx());
      await expect(a.setVolume!(4)).rejects.toThrow(/1\/2\/3/);
      await expect(a.setVolume!(0)).rejects.toThrow(/1\/2\/3/);
      expect(sent).toEqual([]);
    });

    it("keeps its own value sets for volume, duration and tone, whatever the description lists", async () => {
      const listing = parseThingsList({
        things_list: [
          {
            profile: { product_code: "T0000" },
            properties: [
              { identifier: "audio_alert_volume", data_type: { type: "ienum", specs: { eunmList: [{ value: "1" }] } } },
            ],
          },
        ],
      }).T0000!;
      const { acts: a, sent } = sirenOf({ ...ctx(), model: "T90R0", things: listing });
      await a.setVolume!(2);
      await expect(a.setVolume!(4)).rejects.toThrow(/must be one of 1\/2\/3\)/);
      expect(sent).toHaveLength(1);
    });
  });

  /** A description listing `set_alarm_type` with `values`, as each product's does. */
  const alarmThings = (model: string, values: string[]) =>
    parseThingsList({
      things_list: [
        {
          profile: { product_code: model },
          properties: [
            {
              identifier: "set_alarm_type",
              access_mode: "RW",
              data_type: { type: "ienum", specs: { eunmList: values.map((value) => ({ value, desc: "" })) } },
            },
          ],
        },
      ],
    })[model]!;

  describe("HomeBase alarm output", () => {
    it("keeps alarm volume and tone on reported evidence, the trigger on the description", () => {
      const hub = {
        channel: 0,
        codec: "station" as const,
        deviceType: DeviceType.STATION,
        model: "T8010",
        serial: "T8010P0000000001",
        capabilities: new Set(["siren"] as const),
        paramIds: new Set([1281]),
      };
      const bare = sirenOf(hub).acts;
      expect(bare.setAlarmVolume).toBeDefined();
      expect(bare.setAlarmTone).toBeDefined();
      expect(bare.trigger).toBeUndefined();
      expect(bare.stop).toBeUndefined();
      const described = sirenOf({ ...hub, things: alarmThings("T8010", ["0", "3"]) }).acts;
      expect(described.trigger).toBeDefined();
      expect(described.stop).toBeDefined();
    });

    it("owns HomeBase alarm volume and tone while audio retains only prompt volume", async () => {
      const hub = {
        channel: 0,
        codec: "station" as const,
        deviceType: DeviceType.HB3,
        model: "T8030",
        capabilities: new Set(["audio", "siren"] as const),
        paramIds: new Set([1281]),
      };
      const siren = bind<Record<string, ((value: number) => Promise<void>) | undefined>>("siren", hub);
      const audio = bind<Record<string, unknown>>("audio", hub).acts;

      expect(siren.acts.setAlarmVolume).toBeDefined();
      expect(siren.acts.setAlarmTone).toBeDefined();
      expect(audio.setAlarmVolume).toBeUndefined();
      expect(audio.setAlarmTone).toBeUndefined();
      expect(audio.setPromptVolume).toBeDefined();

      await siren.acts.setAlarmVolume!(44);
      await siren.acts.setAlarmTone!(2);
      expect(siren.sent).toEqual([
        { kind: "p2p-station-scalar", cmd: 1235, value: 44, channel: 255 },
        { kind: "set-payload", cmd: 1281, payload: { type: 2 }, channel: 0, mValue3: 0 },
      ]);
      expect(HubAlarmTone).toEqual({ Tone1: 1, Tone2: 2 });
      await expect(siren.acts.setAlarmTone!(3)).rejects.toThrow(/alarmTone: 3 is not a valid value/);
    });

    it("previews a hub's alarm as the app's volume setting does, 2 s under the raw nick_name; none on a HomeBase 3", async () => {
      const hub = (model: string, nick: { nickName?: string } = { nickName: "someone" }): CommandContext => ({
        channel: 0,
        codec: "station",
        model,
        serial: `${model}P0000000001`,
        accountName: "local-part",
        ...nick,
        capabilities: new Set(["siren"]),
        paramIds: new Set(),
        things: alarmThings(model, ["0", "3"]),
      });
      const { acts, sent } = sirenOf(hub("T8010"));
      await acts.test!();
      expect(sent).toEqual([
        {
          kind: "set-payload",
          cmd: 1201,
          payload: { time_out: 2, user_name: "someone", transaction: expect.any(String) },
          channel: 255,
          mValue3: 0,
        },
      ]);
      expect(sirenOf(hub("T8030")).acts.test).toBeUndefined();
      // No local-part fallback: an empty nick_name goes as is, and none drops the key, as the RN screen's JSON does.
      for (const [nick, named] of [
        [{ nickName: "" }, { user_name: "" }],
        [{}, {}],
      ] as const) {
        const empty = sirenOf(hub("T8010", nick));
        await empty.acts.test!();
        const { transaction: _, ...payload } = JSON.parse(
          JSON.stringify((empty.sent[0] as { payload: object }).payload),
        );
        expect(payload).toEqual({ time_out: 2, ...named });
      }
    });

    it.each([
      ["T8010", { time_out: 30 }, { time_out: 0 }],
      ["T9000", { time_out: 30, user_name: "" }, { time_out: 0, user_name: "", open: false }],
    ])("sounds and stops a %s as the live view's HomeBase sound, on the station channel", async (model, on, off) => {
      const { acts, sent } = sirenOf({
        channel: 0,
        codec: "station",
        model,
        serial: `${model}P0000000001`,
        capabilities: new Set(["siren"]),
        paramIds: new Set(),
        things: alarmThings(model, ["0", "3"]),
      });
      await acts.trigger!();
      await acts.stop!();
      expect(sent).toEqual(
        [on, off].map((payload) => ({
          kind: "set-payload",
          cmd: 1201,
          payload: { ...payload, transaction: expect.any(String) },
          channel: 255,
          mValue3: 0,
        })),
      );
    });
  });

  describe("camera alarm output", () => {
    const camera = (model: string, attached: boolean, channel = 2): CommandContext => ({
      channel,
      codec: "camera",
      model,
      serial: `${model}P0000000001`,
      homeBaseAttached: attached,
      ...(attached && { stationSerial: "T8010P0000000009" }),
      capabilities: new Set(["siren"]),
      paramIds: new Set(),
      things: alarmThings(model, ["0"]),
    });

    it.each([
      // `SetAlarmTypeParser` v3: SINGLE level 2 on 1201, the HomeBase default level 2 on 1202.
      ["T8134", false, 1201],
      ["T8134", true, 1202],
    ])("sends a %s (attached %s) the bundle's 30 s sound-only alarm, then its stop", async (model, attached, cmd) => {
      const { acts, sent } = sirenOf(camera(model, attached));
      await acts.trigger!();
      await acts.stop!();
      expect(sent).toEqual(
        [30, 0].map((time_out) => ({
          kind: "set-payload",
          cmd,
          payload: { channel: 2, type: 10, time_out, user_name: "", transaction: expect.any(String) },
          channel: 2,
          mValue3: 0,
        })),
      );
    });

    it("sends a standalone T8410 the bundle's level-1 1201 on the station channel", async () => {
      const { acts, sent } = sirenOf(camera("T8410", false));
      await acts.trigger!();
      await acts.stop!();
      expect(sent).toEqual(
        [30, 0].map((value) => ({
          kind: "p2p-int-string",
          cmd: 1201,
          value,
          valueSub: 10,
          channel: 255,
          form: "int-pair",
        })),
      );
    });

    it("sends a T8114 behind a HomeBase the bundle's 1202 pair", async () => {
      const { acts, sent } = sirenOf(camera("T8114", true, 3));
      await acts.trigger!();
      await acts.stop!();
      expect(sent).toEqual(
        [30, 0].map((value) => ({ kind: "set-param", param: 1202, value, channel: 3, form: "int-pair" })),
      );
    });

    it("installs no alarm action where the description lists no set_alarm_type", () => {
      const { acts } = sirenOf({ ...camera("T8134", true), things: undefined, paramIds: new Set([1015]) });
      expect(acts.trigger).toBeUndefined();
      expect(acts.stop).toBeUndefined();
      expect(acts.active).toBeUndefined();
    });
  });

  it("does not install standalone members from colliding params on another device family", () => {
    const contexts: CommandContext[] = [
      {
        channel: 0,
        codec: "station",
        deviceType: DeviceType.HB3,
        model: "T8030",
        capabilities: new Set(["siren"]),
        paramIds: new Set([61008, 1825, 61006]),
      },
      {
        channel: 0,
        codec: "station",
        deviceType: DeviceType.NVR_S4_MAX,
        capabilities: new Set(["siren"]),
        paramIds: new Set([61008, 1825, 61006]),
      },
      {
        channel: 0,
        codec: "camera",
        deviceType: DeviceType.INDOOR_CAMERA,
        homeBaseAttached: true,
        capabilities: new Set(["siren"]),
        paramIds: new Set([61008, 1825, 61006]),
      },
      {
        channel: 17,
        codec: "sensor",
        deviceType: DeviceType.SENSOR,
        homeBaseAttached: true,
        capabilities: new Set(["siren"]),
        paramIds: new Set([1015]),
      },
    ];

    for (const context of contexts) {
      const alarm = sirenOf(context).acts as unknown as Record<string, unknown>;
      expect(alarm.active).toBeUndefined();
      expect(alarm.volume).toBeUndefined();
      expect(alarm.test).toBeUndefined();
      expect(alarm.trigger).toBeUndefined();
      expect(alarm.stop).toBeUndefined();
    }
  });

  it.each([
    {
      channel: 0,
      codec: "station" as const,
      model: "T8010",
      serial: "T8010P0000000001",
      capabilities: new Set(["siren"] as const),
      paramIds: new Set<number>(),
      things: alarmThings("T8010", ["0", "3"]),
    },
    {
      channel: 1,
      codec: "camera" as const,
      model: "T8134",
      serial: "T8134P0000000001",
      homeBaseAttached: true,
      stationSerial: "T8010P0000000009",
      capabilities: new Set(["siren"] as const),
      paramIds: new Set<number>(),
      things: alarmThings("T8134", ["0"]),
    },
  ])("propagates transport rejection without fabricating active state", async (context) => {
    const attempted: Command[] = [];
    const actions = buildActions(["siren"], {
      ctx: context,
      sink: {
        dispatch: async (command) => {
          attempted.push(command);
          throw new Error("transport failed");
        },
      },
      read: () => undefined,
    }).siren as SirenActions;

    await expect(actions.trigger!()).rejects.toThrow(/transport failed/);
    await expect(actions.stop!()).rejects.toThrow(/transport failed/);
    expect(attempted).toHaveLength(2);
    expect(actions.active).toBeUndefined();
  });

  describe("detection", () => {
    it("detects a camera from its description's set_alarm_type, not from the EAS switch", () => {
      const record = { deviceType: DeviceType.BATTERY_DOORBELL, model: "T8134", params: { 1015: "0" } };
      expect(detectCapabilities({ ...record, things: alarmThings("T8134", ["0"]) }, "camera")).toContain("siren");
      expect(detectCapabilities({ ...record, parentSn: "T8010P0000000000" }, "camera")).not.toContain("siren");
      expect(detectCapabilities({ ...record, things: alarmThings("T8134", ["0"]) }, "sensor")).not.toContain("siren");
    });
    it("does not detect a motion sensor from generic timeout alone", () => {
      expect(
        detectCapabilities({ deviceType: DeviceType.MOTION_SENSOR, model: "T8910", params: { 61006: "0" } }, "sensor"),
      ).not.toContain("siren");
    });
    it("does not detect standalone siren evidence under a non-sensor codec", () => {
      expect(
        detectCapabilities({ deviceType: DeviceType.INDOOR_CAMERA, params: { 1825: "3", 61008: "0" } }, "camera"),
      ).not.toContain("siren");
      expect(
        detectCapabilities({ deviceType: DeviceType.HB3, params: { 1825: "3", 61006: "900" } }, "station"),
      ).not.toContain("siren");
    });
    it("detects standalone sirens from sensor codec plus combined evidence without static family hints", () => {
      expect(
        detectCapabilities(
          { deviceType: DeviceType.MOTION_SENSOR, model: "T8999", params: { 1825: "3", 61008: "0" } },
          "sensor",
        ),
      ).toContain("siren");
      expect(
        detectCapabilities(
          { deviceType: DeviceType.MOTION_SENSOR, model: "T8999", params: { 1825: "3", 61006: "900" } },
          "sensor",
        ),
      ).toContain("siren");
      expect(SIREN.detection?.deviceTypes ?? []).not.toContain(DeviceType.SIREN_SENSOR);
      expect(SIREN.detection?.deviceTypes ?? []).not.toContain(DeviceType.SIREN_SENSOR_E20);
      expect(SIREN.detection?.modelHints ?? []).toEqual([]);
    });
    it.each([{ 61006: "0" }, { 61008: "0" }, { 1825: "3" }])(
      "does not detect a standalone siren from partial evidence %j",
      (params) => {
        expect(
          detectCapabilities(
            {
              deviceType: DeviceType.SIREN_SENSOR_E20,
              model: "T90R0",
              params: params as unknown as Record<number, string>,
            },
            "sensor",
          ),
        ).not.toContain("siren");
      },
    );
    it("detects a HomeBase device type only when it reports alarm evidence", () => {
      expect(
        detectCapabilities({ deviceType: DeviceType.STATION, model: "T8999", params: { 1281: "1" } }, "station"),
      ).toContain("siren");
      expect(
        detectCapabilities({ deviceType: DeviceType.STATION, model: "T8999", params: {} }, "station"),
      ).not.toContain("siren");
    });
  });
});

/**
 * The derived surface, pinned at compile time. Family-specific evidence makes every write optional, so
 * callers must check presence before invoking a verified wire.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
declare const sn: SirenActions;

const _active: Exact<typeof sn.active, boolean | undefined> = true;
const _volume: Exact<typeof sn.volume, number | undefined> = true;
const _dnd: Exact<typeof sn.doNotDisturb, boolean | undefined> = true;

const _setVolumeOptional: Exact<undefined extends typeof sn.setVolume ? true : false, true> = true;
const _testOptional: Exact<undefined extends typeof sn.test ? true : false, true> = true;
const _testArgs: Exact<Parameters<NonNullable<typeof sn.test>>, []> = true;
const _triggerOptional: Exact<undefined extends typeof sn.trigger ? true : false, true> = true;
const _triggerArgs: Exact<Parameters<NonNullable<typeof sn.trigger>>, []> = true;
const _stopOptional: Exact<undefined extends typeof sn.stop ? true : false, true> = true;
const _stopArgs: Exact<Parameters<NonNullable<typeof sn.stop>>, []> = true;

/** Read-only members expose no setter for sounding state or do-not-disturb. */
const _noSetActive: Exact<"setActive" extends keyof SirenActions ? true : false, false> = true;
const _noSetDnd: Exact<"setDoNotDisturb" extends keyof SirenActions ? true : false, false> = true;

export const _surfaceAssertions = [
  _active,
  _volume,
  _dnd,
  _setVolumeOptional,
  _testOptional,
  _testArgs,
  _triggerOptional,
  _triggerArgs,
  _stopOptional,
  _stopArgs,
  _noSetActive,
  _noSetDnd,
];
