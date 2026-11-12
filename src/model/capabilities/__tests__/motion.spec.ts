import {
  MOTION,
  MOTION_CMD,
  AiDetectType,
  encodeAiDetectType,
  decodeAiDetectType,
  decodeRadarWdSwitch,
} from "../motion.js";
import type { MotionActions } from "../motion.js";

import type { CommandContext } from "../types.js";
import type { Command } from "../../../core/contracts.js";
import { buildActions, buildCommand } from "../index.js";
import { Device } from "../../device.js";

/**
 * Bind the way a device does: a member's setter is derived in the barrel, not returned by `actions()`.
 * `sent` collects what reached the wire.
 */
const bindMotion = (c: CommandContext, sent: Command[] = []): MotionActions =>
  buildActions(["motion"], {
    ctx: c,
    sink: { dispatch: async (cmd) => void sent.push(cmd) },
    read: () => undefined,
  }).motion as unknown as MotionActions;

/** Resolve an intent the way a device does, pinned to this capability. */
const intent = (action: string, value: boolean | number | string, c: CommandContext): Command | undefined =>
  buildCommand(action, value, { ...c, capabilities: new Set(["motion"]) });

const ctx = (paramIds: number[], channel = 3): CommandContext => ({
  channel,
  codec: "camera",
  paramIds: new Set(paramIds),
});

describe("motion capability module", () => {
  it("declares the capability + schema", () => {
    expect(MOTION.capability).toBe("motion");
    expect(MOTION.properties.map((p) => p.name)).toEqual([
      "motionDetection",
      "motionSensitivity",
      "aiDetectType",
      "soloSensitivity",
      "indoorSensitivity",
      "pirSensitivityRaw",
      "sensorPirSensitivity",
      "testMode",
      "snoozeTime",
      "humanOnlyAtNight",
      "loiteringDetection",
    ]);
  });

  describe("detection sub-switches (1719 / 2706)", () => {
    // 1350 SET_PAYLOAD, mChannel = device channel (setPayload's 4-arg form), mValue3 0. The writes are
    // evidence-gated on the device reporting the param, so ctx must include the id.
    const H = (ch: number) => ctx([MOTION_CMD.HUMAN_ONLY_AT_NIGHT], ch);
    const L = (ch: number) => ctx([MOTION_CMD.LOITERING_DETECTION], ch);

    it("humanOnlyAtNight emits 1350 {only_ai} on the DEVICE channel with mValue3 0", () => {
      expect(intent("humanOnlyAtNight", true, H(3))).toEqual({
        kind: "set-payload",
        cmd: MOTION_CMD.HUMAN_ONLY_AT_NIGHT, // 1719
        payload: { only_ai: 1 },
        channel: 3,
        mValue3: 0,
        form: "auto",
      });
      expect(intent("humanOnlyAtNight", false, H(3))).toMatchObject({ payload: { only_ai: 0 } });
    });

    it("loiteringDetection emits 1350 {radar_wd_switch} on the DEVICE channel with mValue3 0", () => {
      expect(intent("loiteringDetection", true, L(2))).toEqual({
        kind: "set-payload",
        cmd: MOTION_CMD.LOITERING_DETECTION, // 2706
        payload: { radar_wd_switch: 1 },
        channel: 2,
        mValue3: 0,
        form: "auto",
      });
      expect(intent("loiteringDetection", false, L(2))).toMatchObject({
        payload: { radar_wd_switch: 0 },
      });
    });

    it("both writes are gated: no frame on a device that doesn't report the param", () => {
      expect(intent("humanOnlyAtNight", true, ctx([], 3))).toBeUndefined();
      expect(intent("loiteringDetection", true, ctx([], 3))).toBeUndefined();
    });

    it("the fluent setters dispatch the identical frames, so the two paths cannot drift", async () => {
      const sent: any[] = [];
      const acts = bindMotion(H(3), sent);
      await acts.setHumanOnlyAtNight!(true);
      const acts2 = bindMotion(L(3), sent);
      await acts2.setLoiteringDetection!(false);
      expect(sent).toEqual([intent("humanOnlyAtNight", true, H(3)), intent("loiteringDetection", false, L(3))]);
    });

    it("the fluent setters are ABSENT when the device lacks the param — not a method that always fails", () => {
      const acts = bindMotion(ctx([], 3));
      expect(acts.setHumanOnlyAtNight).toBeUndefined();
      expect(acts.setLoiteringDetection).toBeUndefined();
      expect(bindMotion(H(3)).setHumanOnlyAtNight).toBeTypeOf("function");
      expect(bindMotion(L(3)).setLoiteringDetection).toBeTypeOf("function");
    });

    it("loitering READ decodes the object form, not just a scalar (decodeRadarWdSwitch)", () => {
      expect(decodeRadarWdSwitch("1")).toBe(true);
      expect(decodeRadarWdSwitch("0")).toBe(false);
      // The app stores it as {radar_wd_switch,…} on some devices; a plain bool coercion of that string
      // would be truthy-nonempty and wrong. The decode reads the field.
      expect(decodeRadarWdSwitch('{"radar_wd_switch":1,"other":9}')).toBe(true);
      expect(decodeRadarWdSwitch('{"radar_wd_switch":0}')).toBe(false);
    });
  });

  describe("motionDetection buildCommand", () => {
    it("emits the direct-binary 1011 scalar (on=1/off=0) — the capture-verified watermark-class wire", () => {
      expect(intent("motionDetection", true, ctx([], 3))).toEqual({
        kind: "set-param",
        param: MOTION_CMD.CAMERA_PIR, // 1011
        value: 1,
        form: "direct-binary",
        channel: 3,
      });
      expect(intent("motionDetection", false, ctx([], 3))).toMatchObject({
        form: "direct-binary",
        value: 0,
      });
    });
    it("actions.setDetection dispatches the same direct-binary 1011 scalar", async () => {
      const sent: any[] = [];
      const acts = bindMotion(ctx([], 3), sent);
      await acts.setDetection(true);
      expect(sent[0]).toMatchObject({
        kind: "set-param",
        param: MOTION_CMD.CAMERA_PIR,
        form: "direct-binary",
        value: 1,
      });
    });
  });

  describe("motionDetection on a T8410 (6040)", () => {
    const t8410 = (extra: Partial<CommandContext> = {}): CommandContext => ({
      ...ctx([MOTION_CMD.INDOOR_MOTION_ENABLE], 0),
      model: "T8410",
      ...extra,
    });

    it("reads 6040 into motionDetection and follows it both ways", () => {
      const dev = Device.fromRecord("T8410P0000000000", { model: "T8410", params: { 6040: "0" } });
      expect(dev.properties.find((p) => p.name === "motionDetection")).toMatchObject({
        paramType: MOTION_CMD.INDOOR_MOTION_ENABLE,
        writable: true,
      });
      expect(dev.getProperty("motionDetection")?.value).toBe(false);
      dev.applyParams({ 6040: "1" });
      expect(dev.getProperty("motionDetection")?.value).toBe(true);
    });

    it("writes the 1700 control payload on 6040, on and off", () => {
      expect(intent("motionDetection", true, t8410())).toEqual({
        kind: "set-json",
        param: MOTION_CMD.INDOOR_MOTION_ENABLE,
        data: { enable: 0, quality: 0, status: 1, value: 0 },
        channel: 0,
      });
      expect(intent("motionDetection", false, t8410())).toMatchObject({ data: { status: 0 } });
    });

    it("actions.setDetection dispatches the same 6040 payload", async () => {
      const sent: Command[] = [];
      await bindMotion(t8410(), sent).setDetection(true);
      expect(sent).toEqual([
        {
          kind: "set-json",
          param: MOTION_CMD.INDOOR_MOTION_ENABLE,
          data: { enable: 0, quality: 0, status: 1, value: 0 },
          channel: 0,
        },
      ]);
    });

    it("reads 6040 on a HomeBase-attached T8410 that also reports 1011", () => {
      const dev = Device.fromRecord("T8410P0000000000", {
        model: "T8410",
        parentSn: "T8030P0000000000",
        params: { 1011: "1", 6040: "0" },
      });
      expect(dev.properties.find((p) => p.name === "motionDetection")?.paramType).toBe(MOTION_CMD.INDOOR_MOTION_ENABLE);
      expect(dev.getProperty("motionDetection")?.value).toBe(false);
    });

    it("refuses the write on a HomeBase-attached T8410, where no wire is confirmed", () => {
      const attached = t8410({ homeBaseAttached: true, paramIds: new Set([1011, MOTION_CMD.INDOOR_MOTION_ENABLE]) });
      expect(() => intent("motionDetection", true, attached)).toThrow(/unverified on a HomeBase-attached T8410/);
    });

    it("every other camera keeps the 1011 direct-binary switch", () => {
      expect(intent("motionDetection", true, { ...ctx([1011, 6040], 3), model: "T8425" })).toMatchObject({
        kind: "set-param",
        param: MOTION_CMD.CAMERA_PIR,
        form: "direct-binary",
      });
    });
  });

  describe("aiDetectType buildCommand", () => {
    it("emits the 1350 SET_PAYLOAD envelope on cmd 1298 (mChannel 0, mValue3 0, channel in payload)", () => {
      // Live-observed: 1298 is the detailed bitmask; the value passes through raw (here 0x3000f).
      const cmd = intent("aiDetectType", 0x3000f, ctx([], 3));
      expect(cmd).toMatchObject({
        kind: "set-payload",
        cmd: MOTION_CMD.AI_DETECT_TYPE, // 1298 — mirrors the night-vision envelope
        payload: { ai_detect_type: 0x3000f, channel: 3 },
        channel: 0,
        mValue3: 0,
        form: "auto",
      });
    });

    it("throws on a non-integer / negative value (no bogus bitmask on the wire)", () => {
      expect(() => intent("aiDetectType", -1, ctx([]))).toThrow(/aiDetectType: -1 is not a valid value/);
      expect(() => intent("aiDetectType", "x", ctx([]))).toThrow(/aiDetectType: "x" is not a valid value/);
    });
  });

  describe("aiDetectType encode/decode (bits confirmed live vs the app)", () => {
    it("encodes named types → the live-observed fleet values (always incl. the enabled base)", () => {
      // T8170: all four on = 0x3000f.
      expect(encodeAiDetectType({ humanRecognition: true, humanDetection: true, vehicle: true, pet: true })).toBe(
        0x3000f,
      );
      // T8124: vehicle off = 0x3000b.
      expect(encodeAiDetectType({ humanRecognition: true, humanDetection: true, vehicle: false, pet: true })).toBe(
        0x3000b,
      );
      // Base only (no types) still carries the enabled flag.
      expect(encodeAiDetectType({})).toBe(AiDetectType.enabledBase);
    });

    it("decode is the inverse (ignores the base + any unmodelled high bits like one hub's 0x180)", () => {
      expect(decodeAiDetectType(0x3000f)).toEqual({
        humanRecognition: true,
        humanDetection: true,
        vehicle: true,
        pet: true,
      });
      expect(decodeAiDetectType(0x3000b)).toEqual({
        humanRecognition: true,
        humanDetection: true,
        vehicle: false,
        pet: true,
      });
      // A hub reporting 0x3018f: the extra 0x180 bits aren't in our model → still decodes the 4 known types.
      expect(decodeAiDetectType(0x3018f)).toMatchObject({ vehicle: true, pet: true });
    });

    it("round-trips: encode(decode(v)) preserves the four known bits", () => {
      const flags = decodeAiDetectType(0x3000b);
      expect(encodeAiDetectType(flags)).toBe(0x3000b);
    });
  });

  describe("snoozeTime buildCommand (wire captured live on T8170 T8170, 2026-07-23)", () => {
    it("a positive duration → set-json-raw cmd 1271, bare plaintext (no 1350/1700 envelope)", () => {
      const cmd = intent("snoozeTime", 3600, ctx([], 2)) as Extract<
        ReturnType<NonNullable<typeof MOTION.buildCommand>>,
        { kind: "set-json-raw" }
      >;
      expect(cmd).toMatchObject({
        kind: "set-json-raw",
        cmd: MOTION_CMD.SNOOZE_TIME, // 1271
        channel: 2,
        data: { snooze_time: 3600, chime_onoff: 0, homebase_onoff: 0, motion_notify_onoff: 1 },
      });
      // startTime is "now" (the app sends the current time, not a fixed capture timestamp).
      expect(cmd!.data.startTime).toBeCloseTo(Math.floor(Date.now() / 1000), -1);
    });

    it("0 (or omitted) → the bare captured clear/cancel shape, no extra fields", () => {
      expect(intent("snoozeTime", 0, ctx([], 2))).toEqual({
        kind: "set-json-raw",
        cmd: MOTION_CMD.SNOOZE_TIME,
        channel: 2,
        data: { snooze_time: 0 },
      });
    });

    it("throws on a negative / non-finite value", () => {
      expect(() => intent("snoozeTime", -1, ctx([]))).toThrow(/snoozeTime: -1 is not a valid value \(must be >= 0\)/);
      expect(() => intent("snoozeTime", NaN, ctx([]))).toThrow(/snoozeTime: .* is not a valid value \(must be >= 0\)/);
    });

    it("actions.setSnoozeTime dispatches the same intent", async () => {
      const sent: any[] = [];
      const acts = bindMotion(ctx([], 2), sent);
      await acts.setSnoozeTime(0);
      expect(sent).toEqual([{ kind: "set-json-raw", cmd: 1271, channel: 2, data: { snooze_time: 0 } }]);
    });

    it(
      "actions.setSnoozeTime rejects a negative/non-finite value with a descriptive error — same " +
        "guard as buildCommand, not a silent 'clear' or a null on the wire",
      async () => {
        const sent: any[] = [];
        const acts = bindMotion(ctx([], 2), sent);
        await expect(acts.setSnoozeTime(-1)).rejects.toThrow(/snoozeTime.*must be >= 0/);
        await expect(acts.setSnoozeTime(NaN)).rejects.toThrow(/snoozeTime.*must be >= 0/);
        expect(sent).toEqual([]);
      },
    );
  });

  describe("detection", () => {
    it("proves motion via the PIR switch param 1011", () => {
      expect(MOTION.detection?.evidenceParams).toContain(1011);
    });
    it("the glass-break model hint matches glass but not an unrelated string", () => {
      const re = MOTION.detection!.modelHints![0];
      expect(re.test("Glass Break Sensor")).toBe(true);
      expect(re.test("Wired Doorbell")).toBe(false);
    });
  });
});

/**
 * A standalone motion sensor is the capability by device type, but shares only ONE verified wire with
 * a camera's motion controls — and even that one under a different id.
 */

describe("motion — sensor test mode", () => {
  const ctx = (codec: string) =>
    ({ channel: 33, codec, paramIds: new Set<number>(), accountId: "0".repeat(40) }) as never;
  const bind = (codec: string) => {
    const sent: Command[] = [];
    return { actions: bindMotion(ctx(codec), sent), sent };
  };

  it("enters with the channel inside the payload, which is what the device requires", async () => {
    const { actions, sent } = bind("sensor");
    await actions.setTestMode(true);
    expect(sent[0]).toMatchObject({
      kind: "set-payload",
      cmd: MOTION_CMD.SENSOR_ENTER_TEST_MODE,
      payload: { channel: 33 },
    });
  });

  it("leaves through the direct-binary shape, not the payload one", async () => {
    const { actions, sent } = bind("sensor");
    await actions.setTestMode(false);
    expect(sent[0]).toMatchObject({
      kind: "set-param",
      param: MOTION_CMD.SENSOR_EXIT_TEST_MODE,
      form: "direct-binary",
    });
  });

  /**
   * A REJECTION, not a synchronous throw: `requireFamily` throws while building the command, and
   * `bindMembers` converts that so every derived setter keeps one Promise contract — a caller chaining
   * `.catch()` would miss a sync throw entirely.
   */
  it("refuses both on a camera — the pair exists only on sensors", async () => {
    const { actions } = bind("camera");
    await expect(actions.setTestMode(true)).rejects.toThrow(/verified only on a sensor/);
    await expect(actions.setTestMode(false)).rejects.toThrow(/verified only on a sensor/);
  });
});

describe("motion — the sensor's work-mode report", () => {
  const frame = (json: unknown) =>
    ({ source: "p2p-frame" as const, stationSn: "T8000P0000000000", commandId: 1351, channel: 33, json }) as never;

  it("lands the reported mode under the id the property reads", () => {
    expect(MOTION.decodeState?.(frame({ cmd: MOTION_CMD.SENSOR_WORK_MODE, payload: { workmode: 1 } }))).toEqual({
      params: { [MOTION_CMD.SENSOR_WORK_MODE]: "1" },
    });
  });

  it("lands the off report too, rather than treating 0 as nothing said", () => {
    expect(MOTION.decodeState?.(frame({ cmd: MOTION_CMD.SENSOR_WORK_MODE, payload: { workmode: 0 } }))?.params).toEqual(
      { [MOTION_CMD.SENSOR_WORK_MODE]: "0" },
    );
  });

  it("ignores a frame carrying no mode, and any other command", () => {
    expect(MOTION.decodeState?.(frame({ cmd: MOTION_CMD.SENSOR_WORK_MODE, payload: {} }))).toBeNull();
    expect(MOTION.decodeState?.(frame({ cmd: 1829, payload: { params: [] } }))).toBeNull();
  });

  it("ignores a poll signal — this value only exists on the frame path", () => {
    const poll = { source: "poll" as const, deviceSn: "T8000P0000000000", paramType: 1612, to: "1", params: {} };
    expect(MOTION.decodeState?.(poll as never)).toBeNull();
  });
});

/**
 * The sensor's detection level. The wire counts DOWN as the sensor gets more sensitive, so the level
 * is named — a caller passing a number would reasonably pick the wrong end.
 */

/**
 * Detection sensitivity is a STEP, never a device value: five families use four command ids, three
 * frame shapes and two opposite numeric directions, so the same number means the opposite thing
 * depending on what it reaches. Step 1 is always the least sensitive.
 */

/**
 * Sensitivity is resolved from what a device REPORTS, never from its model — an SDK that needed a new
 * table row per device would be a catalogue. These drive the resolution with reported params and
 * values only; no test names a model.
 */
describe("motion — sensitivity scales resolved from reported state", () => {
  const bind = (params: number[], values: Record<string, string> = {}, codec = "camera") => {
    const sent: Record<string, unknown>[] = [];
    const a = MOTION.actions?.({
      ctx: { channel: 2, codec, paramIds: new Set(params), accountId: "0".repeat(40) } as never,
      sink: { dispatch: (c: unknown) => (sent.push(c as never), Promise.resolve()) } as never,
      read: ((n: string) => (values[n] === undefined ? undefined : { value: values[n] })) as never,
    });
    return { actions: a as never as MotionActions, sent };
  };

  it("recognises an inverted five-step scale by a value only it can hold", () => {
    const d = bind([1609], { sensorPirSensitivity: "37" }, "sensor");
    expect(d.actions.sensitivitySteps()).toBe(5);
    expect(d.actions.sensitivityStep()).toBe(3);
  });

  it("recognises an inverted seven-step scale the same way", () => {
    const d = bind([1210, 1276, 6041], { pirSensitivityRaw: "46" });
    expect(d.actions.sensitivitySteps()).toBe(7);
    expect(d.actions.sensitivityStep()).toBe(4);
  });

  it("does not mistake a device that merely mirrors that id for the scale that owns it (same three ids, value on no distinctive ladder)", () => {
    const d = bind([1210, 1276, 6041], { pirSensitivityRaw: "112", motionSensitivity: "3" });
    expect(d.actions.sensitivitySteps()).toBe(5);
    expect(d.actions.sensitivityStep()).toBe(3);
  });

  it("falls back to which id is present when no ladder is a fingerprint", () => {
    expect(bind([6070], { soloSensitivity: "7" }).actions.sensitivitySteps()).toBe(7);
    expect(bind([6041], { indoorSensitivity: "2" }).actions.sensitivityStep()).toBe(2);
  });

  it("drives a device it has never been told about, on the strength of what it reports", async () => {
    const unknown = bind([6041], { indoorSensitivity: "1" });
    expect(unknown.actions.sensitivitySteps()).toBe(5);
    await unknown.actions.setSensitivityStep(5);
    expect(unknown.sent[0]).toMatchObject({ kind: "set-json", param: 6041, data: { index: 5 } });
  });

  it("sends each scale its own id and shape, counting down where the ladder does", async () => {
    const sensor = bind([1609], { sensorPirSensitivity: "37" }, "sensor");
    await sensor.actions.setSensitivityStep(1);
    await sensor.actions.setSensitivityStep(5);
    expect(sensor.sent.map((c) => c.value)).toEqual([80, 8]);

    const solo = bind([6070], { soloSensitivity: "7" });
    await solo.actions.setSensitivityStep(7);
    expect(solo.sent[0]).toMatchObject({ kind: "set-payload", cmd: 1276, payload: { sensitivity: 7 } });
  });

  it("reports nothing, and refuses to write, for a device on no known scale", async () => {
    const d = bind([9999], { motionSensitivity: "1" });
    expect(d.actions.sensitivitySteps()).toBeUndefined();
    await expect(d.actions.setSensitivityStep(1)).rejects.toThrow(/no .*scale/i);
    expect(d.sent).toEqual([]);
  });

  it("rejects a step past the resolved scale's own range", async () => {
    const d = bind([1276], { motionSensitivity: "3" });
    await expect(d.actions.setSensitivityStep(6)).rejects.toThrow(/1\.\.5/);
    expect(d.sent).toEqual([]);
  });
});

/**
 * 6041 arrives as a scalar on some devices and as a base64 JSON per-sensor list on others. The list is
 * stored as reported and is not a misdeclared number. The payload below is synthetic.
 */
describe("motion — indoor sensitivity reported as a per-sensor list", () => {
  const spec = MOTION.properties.find((p) => p.name === "indoorSensitivity")!;
  const device = () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const dev = new Device(
      "T8000P0000000000",
      { codec: "camera", capabilities: ["motion"], properties: [spec], name: "cam", source: "model" },
      logger,
    );
    return { dev, warn };
  };

  it("stores the list verbatim without warning", () => {
    const { dev, warn } = device();
    const list = Buffer.from(JSON.stringify({ list: [{ sensor_id: 0, sensitivity: 3 }] })).toString("base64");

    dev.applyParams({ 6041: list });

    expect(dev.getProperty("indoorSensitivity")?.value).toBe(list);
    expect(warn).not.toHaveBeenCalled();
  });

  it("still stores the scalar form as a number", () => {
    const { dev } = device();

    dev.applyParams({ 6041: "2" });

    expect(dev.getProperty("indoorSensitivity")?.value).toBe(2);
  });
});
