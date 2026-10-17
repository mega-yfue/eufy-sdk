import {
  ARMING,
  ARMING_CMD,
  ARMING_MEMBERS,
  AlarmDelayMode,
  AlarmDelaySeconds,
  ArmingMode,
  type ArmingActions,
} from "../arming.js";
import { buildActions, buildCommand } from "../index.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";
import type { MemberDeps } from "../members.js";
import type { Command } from "../../../core/contracts.js";

const ctx: CommandContext = {
  channel: 0,
  codec: "station",
  // The barrel's `buildCommand` only lets a module answer for a capability the device HAS; this ctx
  // hands evidence directly rather than through detection, so the resolved set is stated.
  capabilities: new Set(["arming"]),
  paramIds: new Set(),
  accountName: "someone+tag",
};

const noIdentityCtx: CommandContext = { channel: 0, codec: "station", paramIds: new Set() };

describe("arming capability module", () => {
  it("declares the capability + schema", () => {
    expect(ARMING.capability).toBe("arming");
    expect(ARMING.properties.map((p) => p.name)).toEqual(["armingMode"]);
  });

  it("proves arming via the guard-mode param 1224", () => {
    expect(ARMING.detection?.evidenceParams).toContain(1224);
  });

  /**
   * away/home/disarmed are byte-exact captures (T8030, 2026-07-23); custom1 is a live confirmation
   * (T8030, 2026-09-12) of the same frame shape with mode_type 3. The frame asserted below is the
   * captured one either way — see ARMING_MODE_WIRE for the evidence split.
   */
  describe("setMode / buildCommand (wire captured live on a T8030, 2026-07-23)", () => {
    it.each([
      [ArmingMode.away, 0],
      [ArmingMode.disarmed, 63],
      [ArmingMode.home, 1],
      [ArmingMode.custom1, 3],
    ])("%s → set-payload cmd 1224, {mode_type:%i, user_name}, explicit mValue3:0", async (mode, modeType) => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      await acts.setMode(mode);
      expect(sent).toEqual([
        {
          kind: "set-payload",
          cmd: 1224,
          payload: { mode_type: modeType, user_name: "someone+tag" },
          channel: 0,
          mValue3: 0,
          form: "auto",
        },
      ]);
    });

    it("buildCommand mirrors the same intent for the low-level setProperty path", () => {
      expect(buildCommand("armingMode", "away", ctx)).toEqual({
        kind: "set-payload",
        cmd: 1224,
        payload: { mode_type: 0, user_name: "someone+tag" },
        channel: 0,
        mValue3: 0,
        form: "auto",
      });
    });

    /**
     * The seal is the SESSION's, not this module's. Pinned level-2, the frame is unsendable on a station
     * that never negotiates a key — an own-session camera such as a T8410, whose session is level-1 — and
     * the send waits out its whole level-2 grace twice before throwing, which a caller experiences as a
     * hang rather than a refusal. A keyed station is unaffected: it still seals this level-2.
     */
    it("leaves the encryption level to the session, so a keyless standalone station can be sent it", () => {
      const cmd = buildCommand("armingMode", "disarmed", ctx) as { form?: string };
      expect(cmd.form).toBe("auto");
    });

    it("buildCommand returns undefined for an unrelated action, and throws for an unknown mode name", () => {
      expect(buildCommand("nope", "home", ctx)).toBeUndefined();
      expect(() => buildCommand("armingMode", "not-a-mode", ctx)).toThrow(
        /mode: "not-a-mode" is not a valid value \(must be one of 0\/1\/2\/3\/4\/5\/6\/47\/63\)/,
      );
    });

    /**
     * The five that spent a release refused. Each was qualified by sending exactly this frame and watching
     * MODE_SWITCH come back (see `ARMING_MODE_WIRE`), so what this asserts is the promotion: the same value
     * the getter answers now goes back out, through both entry points, on the frame that was confirmed.
     *
     * Both are checked because the fluent setter and the intent path share one domain check, and it was
     * them disagreeing that put a guessed `mode_type` on a fire-and-forget wire in the first place.
     */
    it.each([
      ["schedule", 2],
      ["custom2", 4],
      ["custom3", 5],
      ["off", 6],
      ["geo", 47],
    ])("sends %s (mode_type %i) — confirmed live, no longer refused", async (name, wire) => {
      const readCtx: CommandContext = { ...ctx, paramIds: new Set([ARMING_CMD.SET_ARMING]) };
      const { acts, sent } = bind<ArmingActions>("arming", readCtx, {
        read: (p) => (p === "armingMode" ? { value: wire } : undefined),
      });
      expect(acts.mode).toBe(wire);
      await acts.setMode(acts.mode! as never);
      // The frame the three byte-captured modes ride, differing only in `mode_type` — which is what the
      // qualification established, and the reason promoting them needed no new wire.
      expect(sent).toEqual([
        {
          kind: "set-payload",
          cmd: 1224,
          payload: { mode_type: wire, user_name: "someone+tag" },
          channel: 0,
          mValue3: 0,
          form: "auto",
        },
      ]);
      expect(buildCommand("armingMode", name, ctx)).toMatchObject({ payload: { mode_type: wire } });
    });

    it("names every reportable mode, and offers every one of them", () => {
      const mode = ARMING_MEMBERS.mode;
      expect(Object.values(mode.enumValues)).toEqual([
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
      // No `args` entry: the member's two sides agree, so `enumValues` IS the write domain (`writeDomain`
      // falls back to it) and the argument derives from it. Stating it again would be the second
      // declaration that has to be kept equal — `ARMING_MODE_WIRE: Record<ArmingMode, number>` is what
      // holds the table to the union now, at compile time, so there is nothing left for a test to pin.
      expect("args" in mode).toBe(false);
    });

    it("setMode round-trips the wire integer the mode getter answers", async () => {
      const readCtx: CommandContext = { ...ctx, paramIds: new Set([ARMING_CMD.SET_ARMING]) };
      const { acts, sent } = bind<ArmingActions>("arming", readCtx, {
        read: (name) => (name === "armingMode" ? { value: 1 } : undefined),
      });
      expect(acts.mode).toBe(1);
      await acts.setMode(acts.mode!);
      expect(sent).toEqual([
        {
          kind: "set-payload",
          cmd: 1224,
          payload: { mode_type: 1, user_name: "someone+tag" },
          channel: 0,
          mValue3: 0,
          form: "auto",
        },
      ]);
    });

    it("throws a clear error when the context has no account identity", async () => {
      const { acts } = bind<ArmingActions>("arming", noIdentityCtx);
      await expect(acts.setMode(ArmingMode.home)).rejects.toThrow(/missing account identity/);
      expect(() => buildCommand("armingMode", "home", noIdentityCtx)).toThrow(/missing account identity/);
    });
  });

  /**
   * On a T8410C the guard mode is the direct frame the vendor app sends: outer cmd 1224 itself, `mode_type`
   * as the scalar. Home and Away were captured from the app on 2026-10-17, and Away, Home and Disarmed were each
   * confirmed live that day; the fixture identity is synthetic.
   */
  describe("setMode on a T8410C (direct 1224 frame)", () => {
    const t8410c: CommandContext = { ...ctx, model: "T8410C" };

    it.each([
      [ArmingMode.away, 0],
      [ArmingMode.home, 1],
      [ArmingMode.disarmed, 63],
    ])("%s on a T8410C → p2p-station-scalar cmd 1224, value %i, channel 0", async (mode, value) => {
      const { acts, sent } = bind<ArmingActions>("arming", t8410c);
      await acts.setMode(mode);
      expect(sent).toEqual([{ kind: "p2p-station-scalar", cmd: 1224, value, channel: 0 }]);
    });

    it.each([
      ArmingMode.schedule,
      ArmingMode.custom1,
      ArmingMode.custom2,
      ArmingMode.custom3,
      ArmingMode.off,
      ArmingMode.geo,
    ])("%s on a T8410C throws and sends nothing (unconfirmed on the direct frame)", async (mode) => {
      const { acts, sent } = bind<ArmingActions>("arming", t8410c);
      await expect(acts.setMode(mode)).rejects.toThrow(/unconfirmed on the direct 1224 frame/);
      expect(() => buildCommand("armingMode", mode, t8410c)).toThrow(/unconfirmed on the direct 1224 frame/);
      expect(sent).toEqual([]);
    });

    it("buildCommand gives a T8410C the same direct frame", () => {
      expect(buildCommand("armingMode", "away", t8410c)).toEqual({
        kind: "p2p-station-scalar",
        cmd: 1224,
        value: 0,
        channel: 0,
      });
    });
  });

  it("ARMING_CMD names the wire ids (no bare literals)", () => {
    expect(ARMING_CMD.SET_ARMING).toBe(1224);
    expect(ARMING_CMD.SET_ALL_ACTION).toBe(1255);
  });

  it("AlarmDelaySeconds is exactly the app's own picker preset list", () => {
    expect(AlarmDelaySeconds).toEqual({ off: 0, sec15: 15, sec30: 30, sec45: 45, sec60: 60, min3: 180, min5: 300 });
  });

  /**
   * The type pin for the two mode domains. `setMode` accepts `custom1`; this command does not, because
   * the confirmation for mode 3 was gathered on cmd 1224 and cmd 1255 has no capture carrying it and no
   * readback. Nothing else enforces that: the narrowing is type-level, vitest does not typecheck, and
   * `tsc --noEmit` covers this file, so merging the domains back into one union passes every runtime
   * assertion. This line fails that merge with an unused `@ts-expect-error`.
   */
  // @ts-expect-error custom1 is confirmed on cmd 1224 only — the alarm-delay domain excludes it
  void ((): AlarmDelayMode => ArmingMode.custom1)();

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
      await acts.setAlarmDelayConfig(AlarmDelayMode.away, config);
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
      await acts.setAlarmDelayConfig(AlarmDelayMode.home, config);
      const cmd = sent[0] as Extract<Command, { kind: "set-json-raw" }>;
      expect(cmd.data.mode_id).toBe(1);
    });

    it("channel 255 is PINNED — independent of ctx.channel, not just coincidentally matching it", async () => {
      const oddCtx: CommandContext = { ...ctx, channel: 7 };
      const { acts, sent } = bind<ArmingActions>("arming", oddCtx);
      await acts.setAlarmDelayConfig(AlarmDelayMode.away, config);
      const cmd = sent[0] as Extract<Command, { kind: "set-json-raw" }>;
      expect(cmd.channel).toBe(255);
    });

    it("setAlarmDelayConfig rejects a malformed config with a rejected promise, not a sync throw", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", ctx);
      // Deliberately malformed at runtime (a caller ignoring/bypassing types) — missing countDownAlarm,
      // so alarmDelayCommand() throws synchronously reading `.channelList` off `undefined`.
      const malformed = {} as any;
      await expect(acts.setAlarmDelayConfig(AlarmDelayMode.away, malformed)).rejects.toThrow();
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
      expect(acts.deviceNotification!(AlarmDelayMode.home, 0)).toBe(true);
      expect(acts.deviceNotification!(AlarmDelayMode.home, 1)).toBe(false);
      expect(acts.deviceNotification!(AlarmDelayMode.away, 1)).toBe(true);
      expect(acts.deviceNotification!(AlarmDelayMode.home, 33)).toBeUndefined();
      expect(bind<ArmingActions>("arming", t8010).acts.deviceNotification!(AlarmDelayMode.home, 0)).toBeUndefined();
    });

    it("writes the whole table back with only that channel's flag 0x08 changed", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", t8010, { read });
      await acts.setDeviceNotification!(AlarmDelayMode.home, 1, true);
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
      await acts.setDeviceNotification!(AlarmDelayMode.away, 1, false);
      expect(sent[1]).toMatchObject({ data: { mode_id: 0, devices: [{ device_channel: 1, action: 0x00000001 }] } });
    });

    it("rejects, sending nothing, without a table listing the channel", async () => {
      const unlisted = bind<ArmingActions>("arming", t8010, { read });
      await expect(unlisted.acts.setDeviceNotification!(AlarmDelayMode.home, 33, true)).rejects.toThrow();
      const noTable = bind<ArmingActions>("arming", t8010);
      await expect(noTable.acts.setDeviceNotification!(AlarmDelayMode.home, 1, true)).rejects.toThrow();
      expect([...unlisted.sent, ...noTable.sent]).toEqual([]);
    });

    it("is absent on another station model", () => {
      const { acts } = bind<ArmingActions>("arming", { ...ctx, model: "T8030" }, { read });
      expect(acts.deviceNotification).toBeUndefined();
      expect(acts.setDeviceNotification).toBeUndefined();
    });

    it("builds a second write on the first while the reported table lags", async () => {
      const { acts, sent } = bind<ArmingActions>("arming", t8010, { read });
      await acts.setDeviceNotification!(AlarmDelayMode.home, 0, false);
      await acts.setDeviceNotification!(AlarmDelayMode.home, 17, false);
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
        await acts.setDeviceNotification!(AlarmDelayMode.home, 1, true);
        vi.setSystemTime(20_000);
        await acts.setDeviceNotification!(AlarmDelayMode.home, 17, false);
        expect(sent[1]).toMatchObject({ data: { devices: [{}, { action: 0x01000029 }, { action: 0x01000000 }] } });
        vi.setSystemTime(40_000);
        reported = { value: homeTable, ts: 35_000 };
        await acts.setDeviceNotification!(AlarmDelayMode.home, 0, false);
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
      await expect(acts.setDeviceNotification!(AlarmDelayMode.home, 0, false)).rejects.toThrow("p2p timeout");
      await acts.setDeviceNotification!(AlarmDelayMode.home, 17, false);
      expect(sent[1]).toMatchObject({ data: { devices: [{ action: 0x01000009 }, {}, { action: 0x01000000 }] } });
    });
  });
});
