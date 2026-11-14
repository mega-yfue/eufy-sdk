import { CONTACT, CONTACT_CMD, type ContactActions } from "../contact.js";
import { parseThingsList, resolveThing } from "../thing-description.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";

const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString("base64");
const ctx = (paramIds: number[] = [1550, 1507, 1508], over: Partial<CommandContext> = {}): CommandContext =>
  ({ channel: 27, codec: "sensor", serial: "T90E00000000000", paramIds: new Set(paramIds), ...over }) as CommandContext;
/** A resolved description listing `ids`, as the things service gives one per product. */
const things = (...ids: string[]) =>
  resolveThing(
    parseThingsList({
      things_list: [
        {
          profile: { product_code: "T0000" },
          properties: ids.map((identifier) => ({ identifier, data_type: { type: "int" } })),
        },
      ],
    }).T0000!,
    {},
  );

describe("contact capability module", () => {
  it("declares the capability + schema", () => {
    expect(CONTACT.capability).toBe("contact");
    expect(CONTACT.properties.map((p) => p.name)).toEqual([
      "contact",
      "tampered",
      "bypassed",
      "openAlertConfig",
      "dailyCheckConfig",
      "alarmSoundType",
      "alarmVolume",
    ]);
  });

  it("proves contact via the entry-sensor contact param 1550", () => {
    expect(CONTACT.detection?.evidenceParams).toContain(1550);
  });

  describe("left-open alert and daily state check (1290 / 1291)", () => {
    const state = {
      openAlertConfig: b64({ door_time_point: 5, door_enable: 1 }),
      dailyCheckConfig: b64({ door_time_interval: [763, 1200], door_enable: 0 }),
    };
    const read = (name: string) => (name in state ? { value: state[name as keyof typeof state] } : undefined);
    const bound = () => bind<ContactActions>("contact", ctx([1550, 1290, 1291]), { read }).acts;

    it("reads each field out of the base64 JSON config the sensor stores", () => {
      const a = bound();
      expect([a.openAlert, a.openAlertMinutes]).toEqual([true, 5]);
      expect([a.dailyCheck, a.dailyCheckTimes]).toEqual([false, "12:43,20:00"]);
    });

    it("sets both fields of each in the settings bundle's frame", async () => {
      const { acts: a, sent } = bind<ContactActions>("contact", ctx([1550, 1290, 1291]));
      await a.setOpenAlert(true, 10);
      await a.setDailyCheck(true, ["12:43", "07:05"]);
      expect(sent).toEqual([
        { kind: "set-payload", cmd: 1290, payload: { door_enable: 1, door_time_point: 10 }, channel: 27, mValue3: 0 },
        {
          kind: "set-payload",
          cmd: 1291,
          payload: { door_enable: 1, door_time_interval: [763, 425] },
          channel: 27,
          mValue3: 0,
        },
      ]);
    });

    it("refuses a delay or a time the app does not offer", async () => {
      const { acts: a, sent } = bind<ContactActions>("contact", ctx([1550]));
      await expect(a.setOpenAlert(true, 20 as 10)).rejects.toThrow(/5, 10, 15, 30, 60/);
      await expect(a.setDailyCheck(true, ["25:00"])).rejects.toThrow(/HH:MM/);
      expect(sent).toEqual([]);
    });
  });

  describe("alarm (writes verified live on a T90E0)", () => {
    it("setAlarmSoundType emits a direct-binary scalar on the device channel", async () => {
      const { acts: a, sent } = bind<ContactActions>("contact", ctx());
      await a.setAlarmSoundType!(4);
      expect(sent).toEqual([
        { kind: "set-param", param: CONTACT_CMD.ALARM_SOUND_TYPE, value: 4, form: "auto", channel: 27 },
      ]);
    });

    it("setAlarmVolume emits the 1350 SET_PAYLOAD the app sends (channel+volume+transaction, mValue3 0)", async () => {
      const { acts: a, sent } = bind<ContactActions>("contact", ctx());
      await a.setAlarmVolume!(20);
      expect(sent[0]).toMatchObject({
        kind: "set-payload",
        cmd: CONTACT_CMD.ALARM_VOLUME,
        channel: 27,
        mValue3: 0,
        payload: { channel: 27, volume: 20 },
      });
      expect(typeof (sent[0] as unknown as { payload: { transaction: unknown } }).payload.transaction).toBe("string");
    });

    it("rejects out-of-range values rather than sending them", async () => {
      const { acts: a, sent } = bind<ContactActions>("contact", ctx());
      await expect(a.setAlarmSoundType!(5)).rejects.toThrow(/one of 0\/1\/2\/3\/4/);
      await expect(a.setAlarmVolume!(0)).rejects.toThrow(/in 1\.\.26/);
      expect(sent).toEqual([]);
    });

    it("is offered only where the product's description lists it, though the sensor reports the params", () => {
      const without = bind<ContactActions>("contact", ctx(undefined, { things: things("sensor_door_status") }))
        .acts as Record<string, unknown>;
      expect([without.setAlarmSoundType, without.setAlarmVolume]).toEqual([undefined, undefined]);
      const listed = bind<ContactActions>(
        "contact",
        ctx(undefined, { things: things("device_alarm_sound_type", "alarm_volume_value") }),
      ).acts as Record<string, unknown>;
      expect(typeof listed.setAlarmSoundType).toBe("function");
      expect(typeof listed.setAlarmVolume).toBe("function");
    });
  });
});

/**
 * The station's sensor-status notify (inner cmd 1829) — the local path, which beats the FCM push by
 * ~2 s. Frames are shaped after live traffic but carry synthetic values only.
 */
describe("contact — station sensor-status notify", () => {
  const notify = (params: unknown) => ({
    source: "p2p-frame" as const,
    stationSn: "T8000P0000000000",
    commandId: 1351,
    channel: 16,
    json: { cmd: 1829, payload: { params } },
  });
  const param = (param_type: number, param_value: string) => ({ dev_type: 16, param_type, param_value });

  it("emits contactState open from the contact param", () => {
    expect(CONTACT.decodeEvent?.(notify([param(1550, "1")]))).toEqual({
      event: "contactState",
      payload: { open: true },
    });
  });

  it("emits contactState closed for any non-1 value, matching the app's polarity", () => {
    expect(CONTACT.decodeEvent?.(notify([param(1550, "0")]))?.payload).toEqual({ open: false });
  });

  it("finds the contact param wherever it sits in the array", () => {
    const frame = notify([param(1101, "30"), param(1141, "-63"), param(1550, "1")]);
    expect(CONTACT.decodeEvent?.(frame)?.payload).toEqual({ open: true });
  });

  it("stays silent on a status notify that carries no contact param", () => {
    expect(CONTACT.decodeEvent?.(notify([param(1101, "30"), param(1141, "-63")]))).toBeNull();
  });

  it("ignores a notify whose inner cmd is not the sensor-status one", () => {
    const frame = { ...notify([param(1550, "1")]), json: { cmd: 6246, payload: { num: 0 } } };
    expect(CONTACT.decodeEvent?.(frame)).toBeNull();
  });

  it("ignores a frame with no JSON at all (binary / undecrypted)", () => {
    expect(
      CONTACT.decodeEvent?.({
        source: "p2p-frame",
        stationSn: "T8000P0000000000",
        commandId: 1351,
        channel: 16,
        data: Buffer.from("00", "hex"),
      }),
    ).toBeNull();
  });

  it("does not claim a push or poll signal — those stay on the declarative table", () => {
    expect(
      CONTACT.decodeEvent?.({ source: "poll", deviceSn: "T8000P0000000000", paramType: 1550, to: "1", params: {} }),
    ).toBeNull();
  });
});
