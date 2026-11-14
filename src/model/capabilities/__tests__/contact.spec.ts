import { CONTACT, CONTACT_CMD, EntryAlarmTone, type ContactActions } from "../contact.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";

const ctx = (paramIds: number[] = [1550, 1507, 1508], channel = 27): CommandContext =>
  ({ channel, codec: "sensor", serial: "T90E00000000000", paramIds: new Set(paramIds) }) as CommandContext;

describe("contact capability module", () => {
  it("declares the capability + schema", () => {
    expect(CONTACT.capability).toBe("contact");
    expect(CONTACT.properties.map((p) => p.name)).toEqual(["contact", "alarmSoundType", "alarmVolume"]);
  });

  it("proves contact via the entry-sensor contact param 1550", () => {
    expect(CONTACT.detection?.evidenceParams).toContain(1550);
  });

  describe("alarm writes (verified live on a T90E0)", () => {
    it("the tone enum matches the captured wire values", () => {
      expect(EntryAlarmTone).toEqual({ None: 0, Water: 1, Classic: 2, Light: 3, Ding: 4 });
    });

    it("setAlarmSoundType emits a direct-binary scalar on the device channel", async () => {
      const { acts: a, sent } = bind<ContactActions>("contact", ctx());
      await a.setAlarmSoundType!(EntryAlarmTone.Ding);
      expect(sent).toEqual([
        { kind: "set-param", param: CONTACT_CMD.ALARM_SOUND_TYPE, value: 4, form: "auto", channel: 27 },
      ]);
    });

    it("setAlarmVolume emits the 1350 SET_PAYLOAD the app sends (channel+volume+transaction, mValue3 0)", async () => {
      const { acts: a, sent } = bind<ContactActions>("contact", ctx());
      await a.setAlarmVolume!(20);
      expect(sent).toHaveLength(1);
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
      await expect(a.setAlarmVolume!(27)).rejects.toThrow(/in 1\.\.26/);
      expect(sent).toEqual([]);
    });

    it("installs each setter only when the sensor reports the param", () => {
      const a = bind<ContactActions>("contact", ctx([1550])).acts as Record<string, unknown>;
      expect(a.setAlarmSoundType).toBeUndefined();
      expect(a.setAlarmVolume).toBeUndefined();
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
