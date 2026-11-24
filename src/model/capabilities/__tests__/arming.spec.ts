import {
  ARMING,
  ARMING_CMD,
  ARMING_MEMBERS,
  armedWithHouse,
  armingModeCommand,
  AlarmDelaySeconds,
  ArmingMode,
  type ArmingActions,
} from "../arming.js";
import { buildActions, buildCommand, decodeState } from "../index.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";
import type { MemberDeps } from "../members.js";
import { commandObservation, commandReflection, type Command } from "../../../core/contracts.js";
import { parseThingsList } from "../thing-description.js";

const ctx: CommandContext = {
  channel: 0,
  codec: "station",
  // The barrel's `buildCommand` only lets a module answer for a capability the device HAS; this ctx
  // hands evidence directly rather than through detection, so the resolved set is stated.
  capabilities: new Set(["arming"]),
  paramIds: new Set(),
  accountName: "someone+tag",
  serial: "T8419P0000000000",
};

const noIdentityCtx: CommandContext = { channel: 0, codec: "station", paramIds: new Set(), serial: "T8419P0000000000" };

describe("arming capability module", () => {
  it("declares the capability + schema", () => {
    expect(ARMING.capability).toBe("arming");
    expect(ARMING.properties.map((p) => p.name)).toEqual(["armingMode"]);
  });

  it("proves arming via the guard-mode param 1224", () => {
    expect(ARMING.detection?.evidenceParams).toContain(1224);
  });

  describe("mode", () => {
    it("reads all nine reported modes and writes none per device", () => {
      expect(Object.values(ARMING_MEMBERS.mode.enumValues)).toEqual([
        "away",
        "home",
        "schedule",
        "custom1",
        "custom2",
        "custom3",
        "off",
        "geo",
        "disarmed",
      ]);
      expect("write" in ARMING_MEMBERS.mode).toBe(false);
    });

    it("leaves the described arming_selected_mode unwritable through the generic thing path", () => {
      const things = parseThingsList({
        things_list: [
          {
            profile: { product_code: "T8030" },
            properties: [{ identifier: "arming_selected_mode", access_mode: "RW", data_type: { type: "int" } }],
          },
        ],
      })["T8030"];
      const described: CommandContext = { ...ctx, model: "T8030", serial: "T8030P0000000000", things };
      expect(buildCommand("arming_selected_mode", "0", described)).toBeUndefined();
    });
  });

  /**
   * The per-station write of a house's mode: the 1350 envelope `{mode_type, user_name}` on a platform-V2
   * device (serial prefix or device type 104/10006), else the direct 1224 frame, on channel 255 for a
   * station serial and on the device's own channel otherwise.
   */
  describe("armingModeCommand", () => {
    it.each([
      [ArmingMode.away, 0],
      [ArmingMode.home, 1],
      [ArmingMode.disarmed, 63],
    ])("%s on a platform-V2 serial → set-payload cmd 1224, {mode_type:%i, user_name}", (mode, modeType) => {
      expect(armingModeCommand(mode, ctx)).toEqual({
        kind: "set-payload",
        cmd: 1224,
        payload: { mode_type: modeType, user_name: "someone+tag" },
        channel: 0,
        mValue3: 0,
        answerMs: 6000,
      });
    });

    it("takes the envelope on a V2 device type whatever its serial", () => {
      const s350: CommandContext = { ...ctx, serial: "T8423P0000000000", deviceType: 104 };
      expect(armingModeCommand(ArmingMode.home, s350)).toMatchObject({ kind: "set-payload", cmd: 1224 });
    });

    it("throws without an account identity on the envelope", () => {
      expect(() => armingModeCommand(ArmingMode.home, noIdentityCtx)).toThrow(/missing account identity/);
    });

    it.each([
      ["T8030P0000000000", 3, 255],
      ["T8410P0000000000", 0, 0],
      ["T8113P0000000000", 2, 2],
    ])("%s on channel %i → p2p-station-scalar cmd 1224 on channel %i, no identity needed", (serial, channel, wire) => {
      const direct: CommandContext = { ...noIdentityCtx, serial, channel };
      for (const [mode, value] of [
        [ArmingMode.away, 0],
        [ArmingMode.home, 1],
        [ArmingMode.disarmed, 63],
      ] as const) {
        expect(armingModeCommand(mode, direct)).toEqual({
          kind: "p2p-station-scalar",
          cmd: 1224,
          value,
          channel: wire,
          answerMs: 6000,
        });
      }
    });

    it("lands the written mode on 1224 and announces armingModeChanged", () => {
      const cmd = armingModeCommand(ArmingMode.disarmed, ctx);
      expect(commandReflection(cmd)).toEqual({ param: 1224, raw: "63" });
      expect(commandObservation(cmd)).toEqual({ event: "armingModeChanged" });
    });
  });

  describe("armedWithHouse", () => {
    const own = { category: "eufy_security", memberType: 2 };
    it.each([
      ["a HomeBase", { ...own, sn: "T8010P0000000000", stationSn: "T8010P0000000000" }, true],
      ["a camera that is its own station", { ...own, sn: "T8113P0000000000", stationSn: "T8113P0000000000" }, true],
      ["the T8531, the lock the app arms", { ...own, sn: "T8531P0000000000", stationSn: "T8531P0000000000" }, true],
      ["a camera on a HomeBase", { ...own, sn: "T8113P0000000000", stationSn: "T8010P0000000000" }, false],
      ["a guest's station", { ...own, memberType: 0, sn: "T8010P0000000000", stationSn: "T8010P0000000000" }, false],
      ["a lock", { ...own, sn: "T8520P0000000000", stationSn: "T8520P0000000000" }, false],
      ["a SmartDrop", { ...own, sn: "T8790P0000000000", stationSn: "T8790P0000000000" }, false],
      ["another line", { ...own, category: "eufy_home", sn: "T8113P0000000000", stationSn: "T8113P0000000000" }, false],
    ])("%s → %s", (_name, device, armed) => {
      expect(armedWithHouse(device)).toBe(armed);
    });
  });

  it("ARMING_CMD names the wire ids (no bare literals)", () => {
    expect(ARMING_CMD.SET_ARMING).toBe(1224);
    expect(ARMING_CMD.SET_ALL_ACTION).toBe(1255);
  });

  it("AlarmDelaySeconds is exactly the app's own picker preset list", () => {
    expect(AlarmDelaySeconds).toEqual({ off: 0, sec15: 15, sec30: 30, sec45: 45, sec60: 60, min3: 180, min5: 300 });
  });

  describe("setAlarmDelayConfig (wire captured live on a T8030, 2026-07-23)", () => {
    const config = {
      countDownAlarm: { channelList: [6], delaySeconds: AlarmDelaySeconds.sec45 },
      countDownArm: { channelList: [], delaySeconds: AlarmDelaySeconds.off },
      devices: [
        { action: 12, deviceChannel: 16 },
        { action: 11, deviceChannel: 6 },
        { action: 9, deviceChannel: 2 },
      ],
      sirenSensorAction: [
        { action: 0, deviceChannel: 16 },
        { action: 0, deviceChannel: 6 },
        { action: 0, deviceChannel: 2 },
      ],
    };

    it("→ set-json-raw cmd 1255, bare plaintext (no 1350/1700 envelope), pinned to station ch 255", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      await acts.setAlarmDelayConfig(ArmingMode.away, config);
      expect(sent).toEqual([
        {
          kind: "set-json-raw",
          cmd: 1255,
          channel: 255,
          data: {
            mode_id: 0,
            count_down_alarm: { channel_list: [6], delay_time: 45 },
            count_down_arm: { channel_list: [], delay_time: 0 },
            devices: [
              { action: 12, device_channel: 16 },
              { action: 11, device_channel: 6 },
              { action: 9, device_channel: 2 },
            ],
            siren_sensor_action: [
              { action: 0, device_channel: 16 },
              { action: 0, device_channel: 6 },
              { action: 0, device_channel: 2 },
            ],
          },
        },
      ]);
    });

    it("maps every ArmingMode name to its captured mode_id", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      await acts.setAlarmDelayConfig(ArmingMode.home, config);
      const cmd = sent[0] as Extract<Command, { kind: "set-json-raw" }>;
      expect(cmd.data.mode_id).toBe(1);
    });

    it("channel 255 is PINNED — independent of ctx.channel, not just coincidentally matching it", async () => {
      const oddCtx: CommandContext = { ...ctx, channel: 7 };
      const { acts, sent } = bind<ArmingActions>("arming", oddCtx);
      await acts.setAlarmDelayConfig(ArmingMode.away, config);
      const cmd = sent[0] as Extract<Command, { kind: "set-json-raw" }>;
      expect(cmd.channel).toBe(255);
    });

    it("setAlarmDelayConfig rejects a malformed config with a rejected promise, not a sync throw", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      // Deliberately malformed at runtime (a caller ignoring/bypassing types) — missing countDownAlarm,
      // so alarmDelayCommand() throws synchronously reading `.channelList` off `undefined`.
      const malformed = {} as any;
      await expect(acts.setAlarmDelayConfig(ArmingMode.away, malformed)).rejects.toThrow();
      expect(sent).toEqual([]);
    });
  });

  /**
   * A standalone T8170's own Device Control entry: read from its own params (1225 Home, 1239 Away, 1148
   * custom1), written to itself on cmd 1255 as a one-entry table with only flag 0x08 changed. Values as
   * captured: Home 9 (notification + recording), Light Alarm 0x20, custom1 on mode_id 3.
   */
  describe("device notification (captured on a standalone T8170)", () => {
    const t8170: CommandContext = { ...ctx, model: "T8170", channel: 0 };
    const params: Record<string, string> = { homeAction: "41", awayAction: "9", custom1Action: "1" };
    const read = (name: string) => (name in params ? { value: params[name] } : undefined);

    it("reads its own flag per mode, and nothing for another channel or an unreported mode", () => {
      const { acts } = bind<ArmingActions>("arming", t8170, { read });
      expect(acts.deviceNotification!("home", 0)).toBe(true);
      expect(acts.deviceNotification!("custom1", 0)).toBe(false);
      expect(acts.deviceNotification!("home", 1), "a standalone camera answers only for itself").toBeUndefined();
      expect(bind<ArmingActions>("arming", t8170).acts.deviceNotification!("away", 0)).toBeUndefined();
    });

    it("writes its one entry with only flag 0x08 changed, keeping the Light Alarm bit", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", t8170, { read });
      await acts.setDeviceNotification!("home", 0, false);
      await acts.setDeviceNotification!("custom1", 0, true);
      expect(sent).toEqual([
        {
          kind: "set-json-raw",
          cmd: 1255,
          channel: 0,
          data: { mode_id: 1, devices: [{ device_channel: 0, action: 0x01000021 }] },
        },
        {
          kind: "set-json-raw",
          cmd: 1255,
          channel: 0,
          data: { mode_id: 3, devices: [{ device_channel: 0, action: 0x03000009 }] },
        },
      ]);
    });

    it("rejects, sending nothing, for another channel or an unreported mode", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", t8170, { read });
      await expect(acts.setDeviceNotification!("home", 1, true)).rejects.toThrow();
      await expect(bind<ArmingActions>("arming", t8170).acts.setDeviceNotification!("away", 0, true)).rejects.toThrow();
      expect(sent).toEqual([]);
    });

    it("is read only on a standalone model whose write is not confirmed", () => {
      const { acts } = bind<ArmingActions>("arming", { ...t8170, model: "T8400" }, { read });
      expect(acts.deviceNotification!("home", 0)).toBe(true);
      expect(acts.setDeviceNotification).toBeUndefined();
      expect(
        bind<ArmingActions>("arming", { ...t8170, model: "T8171" }, { read }).acts.setDeviceNotification,
      ).toBeDefined();
    });
  });

  /**
   * The Device Control Notification checkbox, replayed on a T8010: the reported table written back whole on
   * cmd 1255, channel 0, with only one device's flag 0x08 changed. Synthetic table, captured shape.
   */
  describe("device notification (replayed on a T8010)", () => {
    const homeTable = {
      mode_id: 1,
      account_id: "0".repeat(40),
      devices: [
        { device_channel: 0, action: 0x01000009 },
        { device_channel: 1, action: 0x01000021 },
        { device_channel: 17, action: 0x01000008 },
      ],
      count_down_alarm: { channel_list: [], delay_time: 0 },
      count_down_arm: { channel_list: [], delay_time: 0 },
    };
    const awayTable = { ...homeTable, mode_id: 0, devices: [{ device_channel: 1, action: 0x00000009 }] };
    const t8010: CommandContext = { ...ctx, model: "T8010" };
    const read = (name: string) =>
      name === "homeActionTable" ? { value: homeTable } : name === "awayActionTable" ? { value: awayTable } : undefined;

    it("reads a device's flag per mode and channel, and nothing for an unlisted channel or table", () => {
      const { acts } = bind<ArmingActions>("arming", t8010, { read });
      expect(acts.deviceNotification!(ArmingMode.home, 0)).toBe(true);
      expect(acts.deviceNotification!(ArmingMode.home, 1)).toBe(false);
      expect(acts.deviceNotification!(ArmingMode.away, 1)).toBe(true);
      expect(acts.deviceNotification!(ArmingMode.home, 33)).toBeUndefined();
      expect(bind<ArmingActions>("arming", t8010).acts.deviceNotification!(ArmingMode.home, 0)).toBeUndefined();
    });

    it("writes the whole table back with only that channel's flag 0x08 changed", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", t8010, { read });
      await acts.setDeviceNotification!(ArmingMode.home, 1, true);
      const { account_id: _account, ...expected } = homeTable;
      expect(sent).toEqual([
        {
          kind: "set-json-raw",
          cmd: 1255,
          channel: 0,
          data: {
            ...expected,
            devices: [
              { device_channel: 0, action: 0x01000009 },
              { device_channel: 1, action: 0x01000029 },
              { device_channel: 17, action: 0x01000008 },
            ],
          },
        },
      ]);
      await acts.setDeviceNotification!(ArmingMode.away, 1, false);
      expect(sent[1]).toMatchObject({ data: { mode_id: 0, devices: [{ device_channel: 1, action: 0x00000001 }] } });
    });

    it("rejects, sending nothing, without a table listing the channel", async () => {
      const unlisted = bind<ArmingActions>("arming", t8010, { read });
      await expect(unlisted.acts.setDeviceNotification!(ArmingMode.home, 33, true)).rejects.toThrow();
      const noTable = bind<ArmingActions>("arming", t8010);
      await expect(noTable.acts.setDeviceNotification!(ArmingMode.home, 1, true)).rejects.toThrow();
      expect([...unlisted.sent, ...noTable.sent]).toEqual([]);
    });

    it("is absent on another station model", () => {
      const { acts } = bind<ArmingActions>("arming", { ...ctx, model: "T8030" }, { read });
      expect(acts.deviceNotification).toBeUndefined();
      expect(acts.setDeviceNotification).toBeUndefined();
    });

    it("builds a second write on the first while the reported table lags", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", t8010, { read });
      await acts.setDeviceNotification!(ArmingMode.home, 0, false);
      await acts.setDeviceNotification!(ArmingMode.home, 17, false);
      expect(sent[1]).toMatchObject({
        data: {
          devices: [
            { device_channel: 0, action: 0x01000001 },
            { device_channel: 1, action: 0x01000021 },
            { device_channel: 17, action: 0x01000000 },
          ],
        },
      });
    });

    it("builds on the sent table past the lag until a table observed after it is reported", async () => {
      vi.useFakeTimers({ now: 0 });
      try {
        let reported = { value: homeTable, ts: 0 };
        const { acts, sent } = bind<ArmingActions>("arming", t8010, { read: () => reported });
        await acts.setDeviceNotification!(ArmingMode.home, 1, true);
        vi.setSystemTime(20_000);
        await acts.setDeviceNotification!(ArmingMode.home, 17, false);
        expect(sent[1]).toMatchObject({ data: { devices: [{}, { action: 0x01000029 }, { action: 0x01000000 }] } });
        vi.setSystemTime(40_000);
        reported = { value: homeTable, ts: 35_000 };
        await acts.setDeviceNotification!(ArmingMode.home, 0, false);
        expect(sent[2]).toMatchObject({ data: { devices: [{ action: 0x01000001 }, { action: 0x01000021 }, {}] } });
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not build on a write whose dispatch rejected", async () => {
      const sent: Command[] = [];
      const sink = {
        dispatch: async (c: Command) => {
          sent.push(c);
          if (sent.length === 1) throw new Error("p2p timeout");
        },
      };
      const acts = (
        buildActions(["arming"], { ctx: t8010, sink, read: read as MemberDeps["read"] }) as {
          arming: ArmingActions;
        }
      ).arming;
      await expect(acts.setDeviceNotification!(ArmingMode.home, 0, false)).rejects.toThrow("p2p timeout");
      await acts.setDeviceNotification!(ArmingMode.home, 17, false);
      expect(sent[1]).toMatchObject({ data: { devices: [{ action: 0x01000009 }, {}, { action: 0x01000000 }] } });
    });
  });

  /** The station's guard-mode notify carries two int32; the app lands the first on 1224. */
  it("lands the station's 1151 notify on the guard-mode param", () => {
    const data = Buffer.alloc(8);
    data.writeInt32LE(63, 0);
    data.writeInt32LE(1, 4);
    const signal = { source: "p2p-frame", stationSn: "T8010P0000000000", commandId: 1151, channel: 255, data } as const;
    expect(decodeState(signal, new Set(["arming"]), true)).toEqual([{ params: { 1224: "63" } }]);
  });
});
