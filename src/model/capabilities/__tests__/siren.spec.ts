import { SIREN, SIREN_PARAM, SIREN_CMD, SirenVolume, HubAlarmTone, type SirenActions } from "../siren.js";
import { DeviceType } from "../../device-types.js";
import { bind } from "./bind.js";
import { buildActions, detectCapabilities } from "../index.js";
import type { CommandContext } from "../types.js";
import type { Command } from "../../../core/contracts.js";

/** The bound `dev.siren()` object — every write is a member, derived in the barrel. */
const sirenOf = (c: CommandContext) => bind<SirenActions>("siren", c);

const ctx = (paramIds = [61008, 1825, 61006, 1828], channel = 16): CommandContext =>
  ({
    channel,
    codec: "sensor",
    deviceType: DeviceType.SIREN_SENSOR_E20,
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

  it("volume + duration are now writable, verified", () => {
    for (const name of ["sirenVolume", "alarmDuration"]) {
      const p = SIREN.properties.find((x) => x.name === name);
      expect(p?.writable).toBe(true);
      expect(p?.provenance).toBe("verified");
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

    it("setAlarmDuration emits {value} in seconds", async () => {
      const { acts: a, sent } = sirenOf(ctx());
      await a.setAlarmDuration!(300);
      expect(sent[0]).toMatchObject({ kind: "set-payload", cmd: SIREN_PARAM.ALARM_TIMEOUT, payload: { value: 300 } });
    });

    it("test + stop are momentary triggers gated on volume plus ring-state evidence", async () => {
      const { acts: a, sent } = sirenOf(ctx([1825, 61008]));
      await a.test!();
      await a.stop!();
      expect(sent.map((c) => (c as { cmd: number }).cmd)).toEqual([SIREN_CMD.ALARM_TEST, SIREN_CMD.MANUAL_STOP]);
      expect(sent.every((c) => (c as { kind: string }).kind === "set-payload")).toBe(true);
    });

    it("installs standalone actions from sensor codec and evidence without a siren device type or model", () => {
      const { acts } = sirenOf({
        channel: 16,
        codec: "sensor",
        deviceType: DeviceType.MOTION_SENSOR,
        model: "T8999",
        capabilities: new Set(["siren"]),
        paramIds: new Set([1825, 61006]),
      });

      expect(acts.test).toBeDefined();
      expect(acts.stop).toBeDefined();
    });

    it.each([{ paramIds: [61006] }, { paramIds: [61008] }, { paramIds: [1825] }])(
      "installs no standalone action from partial evidence $paramIds",
      ({ paramIds }) => {
        const actions = sirenOf({
          channel: 16,
          codec: "sensor",
          deviceType: DeviceType.SIREN_SENSOR_E20,
          model: "T90R0",
          capabilities: new Set(["siren"]),
          paramIds: new Set(paramIds),
        }).acts;

        expect(actions.test).toBeUndefined();
        expect(actions.stop).toBeUndefined();
      },
    );

    it("retains configured duration and volume on the volume-plus-timeout evidence path", () => {
      const actions = sirenOf(ctx([1825, 61006])).acts;

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

    it("rejects out-of-range volume and non-preset duration rather than sending", async () => {
      const { acts: a, sent } = sirenOf(ctx());
      await expect(a.setVolume!(4)).rejects.toThrow(/1\/2\/3/);
      await expect(a.setVolume!(0)).rejects.toThrow(/1\/2\/3/);
      await expect(a.setAlarmDuration!(120)).rejects.toThrow(/60\/300\/600\/900/);
      await expect(a.setAlarmDuration!(0)).rejects.toThrow(/60\/300\/600\/900/);
      expect(sent).toEqual([]);
    });
  });

  describe("T8010 HomeBase alarm output", () => {
    it("uses the station device type and reported alarm evidence rather than a model label", () => {
      const { acts } = sirenOf({
        channel: 0,
        codec: "station",
        deviceType: DeviceType.STATION,
        model: "T8999",
        accountName: "tester",
        capabilities: new Set(["siren"]),
        paramIds: new Set([1281]),
      });
      const alarm = acts as unknown as Record<string, unknown>;

      expect(alarm.setAlarmVolume).toBeDefined();
      expect(alarm.setAlarmTone).toBeDefined();
      expect(alarm.trigger).toBeDefined();
      expect(alarm.stop).toBeDefined();
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

    it.each([
      { deviceType: DeviceType.STATION, model: "T8010" },
      { deviceType: DeviceType.HB3, model: "T8030" },
    ])("binds the verified duration trigger and zero-duration stop on the station channel ($model)", async ({ deviceType, model }) => {
      const { acts, sent } = sirenOf({
        channel: 0,
        codec: "station",
        deviceType,
        model,
        accountName: "tester",
        capabilities: new Set(["siren"]),
        paramIds: new Set([1279, 1280, 1281, 1282, 61008, 1825, 61006]),
      });
      const alarm = acts as unknown as {
        trigger?: (seconds: number) => Promise<void>;
        stop?: () => Promise<void>;
      };

      expect(alarm.trigger).toBeDefined();
      expect(alarm.stop).toBeDefined();
      expect((acts as unknown as Record<string, unknown>).active).toBeUndefined();
      expect((acts as unknown as Record<string, unknown>).test).toBeUndefined();
      await alarm.trigger!(10);
      await alarm.stop!();
      expect(sent).toEqual([
        {
          kind: "set-payload",
          cmd: 1201,
          payload: { time_out: 10, user_name: "tester" },
          channel: 255,
          mValue3: 0,
        },
        {
          kind: "set-payload",
          cmd: 1201,
          payload: { time_out: 0, user_name: "tester" },
          channel: 255,
          mValue3: 0,
        },
      ]);
    });

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
      "rejects invalid trigger duration %s without dispatch",
      async (seconds) => {
        const { acts, sent } = sirenOf({
          channel: 0,
          codec: "station",
          deviceType: DeviceType.STATION,
          model: "T8010",
          accountName: "tester",
          capabilities: new Set(["siren"]),
          paramIds: new Set([1281]),
        });
        const trigger = (acts as unknown as { trigger: (value: number) => Promise<void> }).trigger;

        await expect(trigger(seconds)).rejects.toThrow(/positive safe whole-number duration/);
        expect(sent).toEqual([]);
      },
    );

    it("installs no momentary alarm action without reported HomeBase alarm evidence", () => {
      const { acts } = sirenOf({
        channel: 0,
        codec: "station",
        deviceType: DeviceType.STATION,
        model: "T8010",
        accountName: "tester",
        capabilities: new Set(["siren"]),
        paramIds: new Set(),
      });

      expect((acts as unknown as Record<string, unknown>).trigger).toBeUndefined();
      expect((acts as unknown as Record<string, unknown>).stop).toBeUndefined();
      expect((acts as unknown as Record<string, unknown>).active).toBeUndefined();
    });
  });

  describe("HomeBase-attached camera alarm output", () => {
    it("uses attached topology and reported EAS evidence rather than model or device type", () => {
      const { acts } = sirenOf({
        channel: 2,
        codec: "camera",
        deviceType: DeviceType.BATTERY_DOORBELL,
        model: "T8999",
        homeBaseAttached: true,
        capabilities: new Set(["siren"]),
        paramIds: new Set([1015]),
      });
      const alarm = acts as unknown as Record<string, unknown>;

      expect(alarm.trigger).toBeDefined();
      expect(alarm.stop).toBeDefined();
    });

    it.each([
      [0, DeviceType.CAMERA2, "T8114"],
      [1, DeviceType.CAMERA2, "T8114"],
      [2, DeviceType.BATTERY_DOORBELL, "T8210"],
    ])("routes trigger and stop only to the bound camera channel %i", async (channel, deviceType, model) => {
      const { acts, sent } = sirenOf({
        channel,
        codec: "camera",
        deviceType,
        model,
        homeBaseAttached: true,
        capabilities: new Set(["siren"]),
        paramIds: new Set([1015, 61008, 1825, 61006]),
      });
      const alarm = acts as unknown as {
        trigger?: (seconds: number) => Promise<void>;
        stop?: () => Promise<void>;
      };

      await alarm.trigger!(10);
      await alarm.stop!();
      expect(sent).toEqual([
        { kind: "p2p-int-string", cmd: 1202, value: 10, valueSub: channel, channel },
        { kind: "p2p-int-string", cmd: 1202, value: 0, valueSub: channel, channel },
      ]);
      expect((acts as unknown as Record<string, unknown>).setAlarmVolume).toBeUndefined();
      expect((acts as unknown as Record<string, unknown>).setAlarmTone).toBeUndefined();
      expect((acts as unknown as Record<string, unknown>).active).toBeUndefined();
      expect((acts as unknown as Record<string, unknown>).test).toBeUndefined();
    });

    it.each([
      [DeviceType.CAMERA2, "T8114", false, true],
      [DeviceType.INDOOR_PT_CAMERA, "T8410", false, false],
      [DeviceType.INDOOR_PT_CAMERA, "T8410", true, false],
      [DeviceType.BATTERY_DOORBELL, "T8210", true, false],
    ])(
      "installs no alarm action without topology and EAS evidence for %s/%s/%s/%s",
      (deviceType, model, attached, evidenced) => {
        const { acts } = sirenOf({
          channel: 0,
          codec: "camera",
          deviceType,
          model,
          homeBaseAttached: attached,
          capabilities: new Set(["siren"]),
          paramIds: new Set(evidenced ? [1015] : []),
        });
        const alarm = acts as unknown as Record<string, unknown>;

        expect(alarm.trigger).toBeUndefined();
        expect(alarm.stop).toBeUndefined();
        expect(alarm.active).toBeUndefined();
      },
    );

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "10"])(
      "rejects invalid camera trigger duration %s without dispatch",
      async (seconds) => {
        const { acts, sent } = sirenOf({
          channel: 1,
          codec: "camera",
          deviceType: DeviceType.CAMERA2,
          model: "T8114",
          homeBaseAttached: true,
          capabilities: new Set(["siren"]),
          paramIds: new Set([1015]),
        });
        const trigger = (acts as unknown as { trigger: (value: number) => Promise<void> }).trigger;

        await expect(trigger(seconds as unknown as number)).rejects.toThrow(/positive safe whole-number duration/);
        expect(sent).toEqual([]);
      },
    );
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
      deviceType: DeviceType.STATION,
      accountName: "tester",
      capabilities: new Set(["siren"] as const),
      paramIds: new Set([1281]),
    },
    {
      channel: 1,
      codec: "camera" as const,
      deviceType: DeviceType.BATTERY_DOORBELL,
      homeBaseAttached: true,
      capabilities: new Set(["siren"] as const),
      paramIds: new Set([1015]),
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

    await expect(actions.trigger!(10)).rejects.toThrow(/transport failed/);
    await expect(actions.stop!()).rejects.toThrow(/transport failed/);
    expect(attempted).toHaveLength(2);
    expect(actions.active).toBeUndefined();
  });

  describe("detection", () => {
    it("requires both attached topology and reported EAS evidence for a camera", () => {
      expect(
        detectCapabilities(
          {
            deviceType: DeviceType.BATTERY_DOORBELL,
            model: "T8999",
            parentSn: "T8000P0000000000",
            params: { 1015: "0" },
          },
          "camera",
        ),
      ).toContain("siren");
      expect(
        detectCapabilities(
          { deviceType: DeviceType.BATTERY_DOORBELL, model: "T8999", params: { 1015: "0" } },
          "camera",
        ),
      ).not.toContain("siren");
      expect(
        detectCapabilities(
          { deviceType: DeviceType.SENSOR, model: "T8999", parentSn: "T8000P0000000000", params: { 1015: "0" } },
          "sensor",
        ),
      ).not.toContain("siren");
      expect(
        detectCapabilities(
          { deviceType: DeviceType.BATTERY_DOORBELL, model: "T8999", parentSn: "T8000P0000000000", params: {} },
          "camera",
        ),
      ).not.toContain("siren");
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
const _triggerArgs: Exact<Parameters<NonNullable<typeof sn.trigger>>, [seconds: number]> = true;
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
