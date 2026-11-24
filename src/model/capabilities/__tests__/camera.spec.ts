import { CAMERA, CAMERA_CMD, CAMERA_MEMBERS, SoundDetectionType } from "../camera.js";
import { buildCommand } from "../index.js";
import { actionSpecOf } from "../access.js";
import { propertiesOf } from "../members.js";
import { bind } from "./bind.js";
import type { CameraActions } from "../camera.js";
import { DeviceType } from "../../device-types.js";
import { Device } from "../../device.js";
import type { CommandContext } from "../types.js";
import { parseThingsList, resolveThing, type ThingDescription } from "../thing-description.js";
import { CameraDisabledError, type MediaProvider } from "../../../core/contracts.js";

/**
 * Pinned to the `camera` capability so intent resolution is this module's alone — the barrel walks every
 * module a device HAS, and the spec is about what camera answers, not about resolution order.
 */
const ctx = (channel = 0, extra: Partial<CommandContext> = {}): CommandContext => ({
  channel,
  codec: "camera",
  paramIds: new Set<number>(),
  capabilities: new Set(["camera"]),
  ...extra,
});

/**
 * A product's thing description as `get_things_list` returns it, each property's `eunmList` given by its
 * members' wire values (or `"wire=label"`), or `"bool"` for a boolean property. Parsed by the real parser.
 */
const things = (props: Record<string, readonly string[] | "bool">): ThingDescription =>
  parseThingsList({
    things_list: [
      {
        profile: { product_code: "T0000" },
        properties: Object.entries(props).map(([identifier, members]) => ({
          identifier,
          data_type:
            members === "bool"
              ? { type: "bool", specs: { defaultValue: "true" } }
              : {
                  type: "enum",
                  specs: {
                    eunmList: members.map((m) => ({
                      value: m.split("=")[0],
                      associatedValue: m.split("=")[0],
                      desc: m.split("=")[1],
                    })),
                  },
                },
        })),
      },
    ],
  }).T0000!;
const AUTO_NIGHT_VISION = things({ nightvision_type: "bool" });
/** A description listing every identifier a camera member is written and read by from its product's bundle. */
const NIGHT_VISION_UI = {
  100: "Off",
  101: "Infrared On",
  102: "Infrared",
  103: "Color",
  104: "Standard",
  105: "Daylike",
};
const DESCRIBED = things({
  camera_on_off: "bool",
  led_on_off: "bool",
  notification_type: ["0=Most Efficient", "1=Full Effect", "2=Include Thumbnail"],
  nightvision_type_new: Object.entries(NIGHT_VISION_UI).map(([v, label]) => `${v}=${label}`),
  watermark_set: ["0=Off", "1=Timestamp", "2=Timestamp and logo"],
  live_streaming_resolution: ["0=Auto", "1=Max", "2=Full HD", "6=HD", "8=Low", "9=Middle", "10=High"],
  record_resolution: ["2=Full HD", "5=2K HD"],
  anti_theft_detection_switch: "bool",
});
/** A described `model` on channel 2, standalone unless `extra` attaches it. */
const at = (model: string, extra: Partial<CommandContext> = {}) => ctx(2, { model, things: DESCRIBED, ...extra });
const ATTACHED = { homeBaseAttached: true, stationSerial: "T8010P0000000000" };

/** The bound `dev.camera()` object — the members derive their setters in the barrel, not in `actions()`. */
const camera = (c: CommandContext, media?: MediaProvider) => bind<CameraActions>("camera", c, { media });

describe("camera capability module", () => {
  it("declares the capability + schema", () => {
    expect(CAMERA.capability).toBe("camera");
    expect(CAMERA.properties.map((p) => p.name)).toEqual([
      "wifiRssi",
      "enabled",
      "imageFlipped",
      "watermark",
      "soundDetection",
      "soundDetectionSensitivity",
      "soundDetectionType",
      "notificationStyle",
      "nightVision",
      "streamingQuality",
      "recordingQuality",
      "antiTheftDetection",
      "statusLed",
    ]);
  });

  describe("wifiRssi", () => {
    it.each([
      { deviceType: 47, model: "T8425", homeBaseAttached: true },
      { deviceType: 31, model: "T8410", homeBaseAttached: false },
    ])("reads reported signal on $model and follows cache updates", (identity) => {
      const dev = Device.fromRecord("SN", { ...identity, params: { 1142: "-62" } });
      dev.bindActions(ctx(0, { ...identity, paramIds: new Set([1142]) }), { dispatch: async () => undefined });
      const acts = dev.camera!()!;
      expect(acts.wifiRssi).toBe(-62);
      expect("setWifiRssi" in acts).toBe(false);
      dev.applyParams({ 1142: "0" });
      expect(acts.wifiRssi).toBe(0);
      dev.applyParams({ 1142: "not-a-number" });
      expect(acts.wifiRssi).toBeUndefined();
    });
  });

  // Every wire here was captured from the app on an indoor pan-tilt (standalone, mains) and read back
  // on the cloud param. Each command names its payload field differently — status / index / type —
  // which is the reason there is no shared setter for the three.
  describe("sound detection (6043 / 6044 / 6046)", () => {
    it("soundDetection writes {status}, both directions", () => {
      expect(buildCommand("soundDetection", true, ctx(0))).toEqual({
        kind: "set-json",
        param: CAMERA_CMD.SOUND_DETECTION, // 6043
        data: { status: 1 },
        channel: 0,
      });
      expect(buildCommand("soundDetection", false, ctx(0))).toMatchObject({ data: { status: 0 } });
    });

    it.each([
      [1, "lowest"],
      [3, "mid"],
      [5, "highest"],
    ])("soundDetectionSensitivity writes %i (%s) as {index}", (n) => {
      expect(buildCommand("soundDetectionSensitivity", n, ctx(2))).toEqual({
        kind: "set-json",
        param: CAMERA_CMD.SOUND_DETECTION_SENSITIVITY, // 6044
        data: { index: n },
        channel: 2,
      });
    });

    // The setter answers undefined; the intent path turns that into a throw rather than reporting the
    // device as lacking the feature — a clamped value would arm a setting nobody asked for.
    it.each([0, 6, -1, 2.5])("soundDetectionSensitivity refuses %s rather than clamping", (bad) => {
      expect(CAMERA_MEMBERS.soundDetectionSensitivity.write!(bad, ctx(0))).toBeUndefined();
      expect(() => buildCommand("soundDetectionSensitivity", bad, ctx(0))).toThrow(/not a valid value/);
    });

    it("soundDetectionSensitivity refuses a non-number instead of coercing it to 0", () => {
      // Number(null) and Number("") are both 0, which would look like a real setting.
      expect(CAMERA_MEMBERS.soundDetectionSensitivity.write!(null as never, ctx(0))).toBeUndefined();
      expect(CAMERA_MEMBERS.soundDetectionSensitivity.write!("" as never, ctx(0))).toBeUndefined();
    });

    it("soundDetectionType writes {type}, and refuses a value outside the enum", () => {
      expect(SoundDetectionType).toEqual({ Crying: 1, AllSound: 2 });
      expect(buildCommand("soundDetectionType", SoundDetectionType.AllSound, ctx(0))).toEqual({
        kind: "set-json",
        param: CAMERA_CMD.SOUND_DETECTION_TYPE, // 6046
        data: { type: 2 },
        channel: 0,
      });
      expect(buildCommand("soundDetectionType", SoundDetectionType.Crying, ctx(0))).toMatchObject({
        data: { type: 1 },
      });
      // 3 is not a type: coercing it would arm the wrong trigger and report success.
      expect(CAMERA_MEMBERS.soundDetectionType.write!(3, ctx(0))).toBeUndefined();
      expect(() => buildCommand("soundDetectionType", 3, ctx(0))).toThrow(/must be one of 1\/2/);
    });

    it("the sensitivity and the type do not compose against the switch — each writes alone", () => {
      // A setter that folded the switch's state into its payload would revert it on the second write.
      const sens = buildCommand("soundDetectionSensitivity", 5, ctx(0)) as { data: Record<string, unknown> };
      const type = buildCommand("soundDetectionType", 1, ctx(0)) as { data: Record<string, unknown> };
      expect(Object.keys(sens.data)).toEqual(["index"]);
      expect(Object.keys(type.data)).toEqual(["type"]);
    });
  });

  describe("night vision, as the app's own values", () => {
    it("is absent without a description, whatever the device reports", () => {
      const dev = Device.fromRecord("TEST-SN", { model: "T8400", params: { 2002: "1" } });
      expect(dev.properties.find((p) => p.name === "nightVision")).toBeUndefined();
    });

    it("offers the modes the description names, nightvision_type_new first, and writes those with a frame", () => {
      const spec = (model: string, description?: ThingDescription) =>
        Device.fromRecord("TEST-SN", { model, params: { 1277: "1" }, things: description }).properties.find(
          (p) => p.name === "nightVision",
        );
      expect(spec("T8170", DESCRIBED)?.enumValues).toEqual(NIGHT_VISION_UI);
      expect(
        spec("T8162", things({ nightvision_type: ["7=Spotlights", "8=Daylike", "10=Infrared", "11=Standard"] })),
      ).toMatchObject({ enumValues: { 7: "Spotlights", 8: "Daylike", 10: "Infrared", 11: "Standard" } });
      expect(spec("T8442", AUTO_NIGHT_VISION)?.enumValues, "a bool names no values: the hand labels").toEqual({
        0: "Off",
        1: "On",
      });
      expect(spec("T8170"), "no description").toBeUndefined();
      expect(() => buildCommand("nightVision", 104, at("T8170"))).toThrow(
        /nightVision: 104 is not a valid value \(must be one of 100\/102\/103\)/,
      );
    });
  });

  describe("options from the thing description", () => {
    const options = (name: string, params: Record<number, string>, description?: ThingDescription) =>
      Device.fromRecord("TEST-SN", { model: "T8170", params, things: description }).properties.find(
        (p) => p.name === name,
      )?.enumValues;

    it("offers the notification styles notification_type names", () => {
      const style = (description?: ThingDescription) => options("notificationStyle", { 6020: "1" }, description);
      expect(style(DESCRIBED)).toEqual({ 0: "Most Efficient", 1: "Full Effect", 2: "Include Thumbnail" });
      expect(style(), "no description").toBeUndefined();
      expect(() => buildCommand("notificationStyle", 2, at("T8217"))).toThrow(
        /notificationStyle: 2 is not a valid value \(must be one of 0\/1\)/,
      );
    });

    it("offers the live-view qualities live_streaming_resolution names", () => {
      expect(options("streamingQuality", { 2730: "MA==" }, DESCRIBED)).toEqual({
        0: "Auto",
        1: "Max",
        2: "Full HD",
        6: "HD",
        8: "Low",
        9: "Middle",
        10: "High",
      });
      expect(options("streamingQuality", { 2730: "MA==" }), "no description").toBeUndefined();
    });
  });

  describe("an enum read outside the product's map or the member's options", () => {
    it("reads a raw the product's map does not list as no value", () => {
      const dev = Device.fromRecord("TEST-SN", { model: "T8425", params: { 1277: "5" }, things: DESCRIBED });
      expect(dev.getProperty("nightVision")?.value).toBeUndefined();
      const reported = ctx(3, { model: "T8425", paramIds: new Set([1277]), things: DESCRIBED });
      expect(bind<CameraActions>("camera", reported, { read: () => ({ value: 5 }) }).acts.nightVision).toBeUndefined();
    });

    it("checks a number member published as an enum against its options too", () => {
      const reported = ctx(0, { model: "T8150", things: DESCRIBED, paramIds: new Set([1205]) });
      const read = (value: number) => bind<CameraActions>("camera", reported, { read: () => ({ value }) }).acts;
      expect(read(5).streamingQuality).toBeUndefined();
      expect(read(10).streamingQuality).toBe(10);
    });
  });

  describe("antiTheftDetection (1015)", () => {
    const t8114 = (ch: number) => ctx(ch, { model: "T8114", things: DESCRIBED });

    it("is absent where the bundle writes none, or without a description, reported or not", () => {
      expect(
        buildCommand("antiTheftDetection", true, ctx(3, { paramIds: new Set([CAMERA_CMD.EAS_SWITCH]) })),
      ).toBeUndefined();
      expect(buildCommand("antiTheftDetection", true, at("T8171"))).toBeUndefined();
    });

    it("the derived setter dispatches the identical frame the intent path builds", async () => {
      const { acts, sent } = camera(t8114(3));
      await acts.setAntiTheftDetection!(true);
      expect(sent).toEqual([buildCommand("antiTheftDetection", true, t8114(3))]);
    });

    it("the setter is absent — not a rejecting stub — where the bundle writes none", () => {
      expect(camera(ctx(3)).acts.setAntiTheftDetection).toBeUndefined();
    });
  });

  it("is a camera-codec baseline", () => {
    expect(CAMERA.detection?.codecs).toEqual(["camera"]);
  });

  it("offers a camera-codec setting only where the product's description lists it", () => {
    const acts = (description?: ThingDescription) => camera(ctx(0, { model: "T8171", things: description })).acts;
    const described = acts(things({ camera_on_off: "bool", watermark_set: ["0", "1"] }));
    expect(described.setImageFlipped, "rotate_image_180_on_off unlisted").toBeUndefined();
    expect(described.setSoundDetection, "sound_detection_status unlisted").toBeUndefined();
    expect(described.setRecordingQuality, "record_resolution unlisted").toBeUndefined();
    expect(described.setWatermark).toBeTypeOf("function");
    expect(described.on).toBeTypeOf("function");
    const unlisted = acts(things({ watermark_set: ["0", "1"] }));
    expect([unlisted.on, unlisted.setEnabled, unlisted.setPrivacy], "camera_on_off unlisted").toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(acts().setImageFlipped, "no description").toBeTypeOf("function");
    expect(acts().on, "no description: the bundle-written power is not exposed").toBeUndefined();
  });

  /**
   * Each member is written on the frame the product's settings bundle sends, picked by the resolved
   * identifier variant, the topology the bundle branches on, and the product code.
   */
  describe("members the product's bundle writes: variants, the app's values, the decoded reads", () => {
    it("recordingQuality: 1023 standalone, 1286 on its variant and attached, 2731 attached", () => {
      const variant = resolveThing(
        parseThingsList({
          things_list: [
            {
              profile: { product_code: "T0000" },
              properties: [
                { identifier: "record_resolution" },
                {
                  identifier: "record_resolution__v1",
                  read_conditions: {
                    condition_list: [{ conditions: [{ type: "device_version", qualifier: ">=", value: "1.0" }] }],
                  },
                },
              ],
            },
          ],
        }).T0000!,
        { firmwareVersion: "2.0" },
      );
      expect(buildCommand("recordingQuality", 2, at("T8123"))).toMatchObject({
        param: CAMERA_CMD.VIDEO_RECORD_QUALITY,
      });
      expect(buildCommand("recordingQuality", 2, at("T8123", { things: variant }))).toMatchObject({
        cmd: CAMERA_CMD.SET_RECORD_QUALITY,
        payload: { record_quality: 2 },
      });
      expect(buildCommand("recordingQuality", 2, at("T8140", ATTACHED))).toMatchObject({
        cmd: CAMERA_CMD.SET_RECORD_QUALITY,
      });
      expect(buildCommand("recordingQuality", 2, at("T8410", ATTACHED))).toMatchObject({
        cmd: CAMERA_CMD.RECORDING_QUALITY_SET,
        payload: { quality: 2 },
      });
    });

    it("recordingQuality: the app's values, named by the description, a raw tier refused", () => {
      const c = at("T8410", { ...ATTACHED, paramIds: new Set([CAMERA_CMD.RECORDING_QUALITY_SET]) });
      expect(buildCommand("recordingQuality", 5, c)).toMatchObject({ payload: { quality: 3 } });
      expect(() => buildCommand("recordingQuality", 1, c)).toThrow(/must be one of 2\/5/);
      expect(actionSpecOf(camera(c).acts.setRecordingQuality)!.args?.[0]).toMatchObject({ values: [2, 5] });
      const property = propertiesOf(CAMERA_MEMBERS, c).find((p) => p.name === "recordingQuality");
      expect(property?.enumValues).toEqual({ 2: "Full HD", 5: "2K HD" });
    });

    it("recordingQuality and streamingQuality read the config a device reports as the app's value", () => {
      const b64 = (cfg: unknown) => Buffer.from(JSON.stringify(cfg)).toString("base64");
      const params = {
        2730: b64({ cur_mode: 0, mode_0: { quality: 3 }, mode_1: { quality: 1 } }),
        2731: b64({ cur_mode: 0, mode_0: { quality: 3 }, mode_1: { quality: 2 } }),
      };
      const dev = Device.fromRecord("T8410P000000000", {
        model: "T8410",
        params,
        parentSn: "T8010P0000000000",
        things: DESCRIBED,
      });
      dev.bindActions(at("T8410", { ...ATTACHED, paramIds: new Set([2730, 2731]) }), {
        dispatch: async () => undefined,
      });
      expect(dev.camera!()!.recordingQuality, "tier 3 is 5").toBe(5);
      expect(dev.camera!()!.streamingQuality, "tier 3 is 10").toBe(10);
      dev.applyParams({ 2731: b64({ cur_mode: 0, mode_0: { quality: 1 } }) });
      expect(dev.getProperty("recordingQuality")?.value, "an unlisted tier is the default").toBe(2);
    });

    it("reads past its own param where the bundle does: 6243 picks the quality mode as the data maps it, an exact record wins", () => {
      const b64 = (cfg: unknown) => Buffer.from(JSON.stringify(cfg)).toString("base64");
      const config = b64({ cur_mode: 0, mode_0: { quality: 2 }, mode_1: { quality: 3 } });
      const dev = (model: string, params: Record<number, string>, extra: Partial<CommandContext> = {}) => {
        const parentSn = extra.homeBaseAttached ? "T8010P0000000000" : undefined;
        const d = Device.fromRecord(`${model}P000000000`, { model, params, parentSn, things: DESCRIBED });
        d.bindActions(at(model, { paramIds: new Set(Object.keys(params).map(Number)), ...extra }), {
          dispatch: async () => undefined,
        });
        return d;
      };
      const t8223 = dev("T8223", { 2731: config, 6243: "12" });
      expect(t8223.getProperty("recordingQuality")?.value, "6243 = 12 is mode_1, tier 3").toBe(5);
      t8223.applyParams({ 2731: config, 6243: "0" });
      expect(t8223.getProperty("recordingQuality")?.value, "else mode_0, tier 2").toBe(2);
      const t8400 = dev("T8400", { 2730: config, 6243: "0" }, ATTACHED);
      expect(t8400.getProperty("streamingQuality")?.value, "6243 = 0 is mode_0, tier 2").toBe(9);
      t8400.applyParams({ 2730: config, 6243: "1" });
      expect(t8400.getProperty("streamingQuality")?.value, "any other is mode_1, tier 3").toBe(10);
      expect(dev("T8214", { 1277: "1" }).getProperty("nightVision")?.value, "1277 alone").toBe(101);
      expect(dev("T8214", { 1277: "1", 6252: b64({ value: 1 }) }).getProperty("nightVision")?.value).toBe(102);
    });

    it("reads a config's value by cur_mode and a JSON report's field, as the data states them", () => {
      const b64 = (cfg: unknown) => Buffer.from(JSON.stringify(cfg)).toString("base64");
      const dev = (model: string, params: Record<number, string>) => {
        const d = Device.fromRecord(`${model}P000000000`, { model, params, things: DESCRIBED });
        d.bindActions(at(model, { paramIds: new Set(Object.keys(params).map(Number)) }), {
          dispatch: async () => undefined,
        });
        return d;
      };
      const config = (cur_mode: number) => b64({ cur_mode, mode_0: { quality: 2 }, mode_1: { quality: 3 } });
      const t8170 = dev("T8170", { 2730: config(0) });
      expect(t8170.getProperty("streamingQuality")?.value, "cur_mode 0 is the value 0").toBe(0);
      t8170.applyParams({ 2730: config(2) });
      expect(t8170.getProperty("streamingQuality")?.value, "else mode_1's tier 3").toBe(1);
      const style = JSON.stringify({ notification_motion_onoff: 1, notification_ring_onoff: 1, notification_style: 3 });
      expect(dev("T8210", { 1710: style }).getProperty("notificationStyle")?.value).toBe(1);
    });
  });

  describe("buildCommand", () => {
    it("returns undefined for an unknown action", () => {
      expect(buildCommand("nope", 1, ctx())).toBeUndefined();
    });

    it("'enabled' (the canonical writable property name) reaches a set-param intent", () => {
      expect(buildCommand("enabled", true, at("T8114"))).toMatchObject({
        kind: "set-param",
        param: CAMERA_CMD.CAMERA_ENABLE,
        value: 0,
      });
      expect(buildCommand("enabled", false, at("T8114"))).toMatchObject({ value: 1 });
    });

    it("coerces string/number truthiness consistently (asBool) for the property path", () => {
      expect(buildCommand("enabled", "1", at("T8114"))).toMatchObject({ value: 0 });
      expect(buildCommand("enabled", "false", at("T8114"))).toMatchObject({ value: 1 });
    });

    it("imageFlipped → an 'auto' scalar for ROTATE_IMAGE (1207), 1=flipped/0=normal", () => {
      expect(buildCommand("imageFlipped", true, ctx(2))).toEqual({
        kind: "set-param",
        stationAccount: true,
        param: CAMERA_CMD.ROTATE_IMAGE,
        value: 1,
        channel: 2,
      });
      expect(buildCommand("imageFlipped", false, ctx())).toMatchObject({ value: 0 });
    });

    it("notificationStyle rejects a value outside the enum — every neighbour is a real style", () => {
      for (const bad of [3, 4, -1, "x"]) {
        expect(() => buildCommand("notificationStyle", bad as number, at("T8171"))).toThrow(
          /notificationStyle: .+ is not a valid value \(must be one of 0\/1\/2\)/,
        );
      }
    });

    it("watermark / nightVision throw on a value outside the enum (no bogus level on the wire)", () => {
      for (const bad of [5, -1, 99, "x"]) {
        expect(() => buildCommand("watermark", bad as number, at("T8425"))).toThrow(
          /watermark: .+ is not a valid value \(must be one of 0\/1\/2\)/,
        );
        expect(() => buildCommand("nightVision", bad as number, at("T8170"))).toThrow(
          /nightVision: .+ is not a valid value \(must be one of 100\/102\/103\)/,
        );
      }
      expect(buildCommand("watermark", 1, at("T8425"))).toMatchObject({ value: 1 });
      expect(buildCommand("nightVision", 102, at("T8170"))).toMatchObject({ payload: { night_sion: 1 } });
    });

    it("recordingQuality throws on a value the product does not write", () => {
      const c = ctx(3, { model: "T8414", things: DESCRIBED, ...ATTACHED });
      for (const bad of [0, 1, 3, -1, 99, "0", "4K HD"]) {
        expect(() => buildCommand("recordingQuality", bad, c)).toThrow(
          /recordingQuality: .+ is not a valid value \(must be one of 2\/5\)/,
        );
      }
      expect(buildCommand("recordingQuality", 2, c)).toMatchObject({ payload: { quality: 2 } });
    });

    it("recordingQuality's described argument carries the values it writes", () => {
      const { acts } = camera(
        ctx(3, {
          model: "T8414",
          things: DESCRIBED,
          ...ATTACHED,
          paramIds: new Set([CAMERA_CMD.RECORDING_QUALITY_SET]),
        }),
      );
      expect(actionSpecOf(acts.setRecordingQuality)!.args?.[0]).toMatchObject({ kind: "scalar", values: [2, 5] });
    });
  });

  describe("power off is privacy on", () => {
    const on = (model: string, extra: Partial<CommandContext> = {}) => buildCommand("on", true, at(model, extra));
    const off = (model: string, extra: Partial<CommandContext> = {}) => buildCommand("off", false, at(model, extra));

    it("sends privacy on for off and privacy off for on, where the bundle powers through privacy mode", () => {
      vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
      const s350 = { deviceType: DeviceType.INDOOR_PT_CAMERA_S350, ...ATTACHED };
      expect(off("T8416", s350)).toEqual(buildCommand("privacy", true, at("T8416", s350)));
      expect(on("T8416", s350)).toEqual(buildCommand("privacy", false, at("T8416", s350)));
    });
  });

  /**
   * `camera_on_off` read where the product's bundle reads it: the T8162 bundle's parser reads only 6250, a
   * v5 bundle 2001 standalone. A listed identifier installs the getter on the description's default.
   */
  describe("enabled — the description's read param and default", () => {
    const ON_OFF = parseThingsList({
      things_list: [
        {
          profile: { product_code: "T0000" },
          properties: [{ identifier: "camera_on_off", data_type: { type: "bool", specs: { defaultValue: "1" } } }],
        },
      ],
    }).T0000!;
    const enabledOf = (model: string, attached: boolean, params: Record<number, string>, things?: ThingDescription) => {
      const identity = { deviceType: 9, model, category: "eufy_security" };
      const parentSn = attached ? "T8010P0000000000" : undefined;
      const dev = Device.fromRecord("T8000P0000000000", { ...identity, parentSn, params, things });
      const paramIds = new Set(Object.keys(params).map(Number));
      dev.bindActions(ctx(1, { ...identity, homeBaseAttached: attached, paramIds, things }), {
        dispatch: async () => undefined,
      });
      const acts = dev.camera!()!;
      return "enabled" in acts ? acts.enabled : "absent";
    };

    it("is present on a described product that reported no power param, reading the default", () => {
      expect(enabledOf("T8162", true, {}, ON_OFF)).toBe(true);
    });
    it("reads 99904 in the bundle's order over 1035", () => {
      expect(enabledOf("T8210", false, { 99904: "1", 1035: "0" }, ON_OFF)).toBe(false);
      expect(enabledOf("T8210", true, { 99904: "1", 1035: "0" }, ON_OFF)).toBe(true);
      expect(enabledOf("T8210", true, { 99904: "1" }, ON_OFF)).toBe(false);
      expect(enabledOf("T8213", false, { 99904: "1", 1035: "0" }, ON_OFF)).toBe(true);
      expect(enabledOf("T8200", false, { 2001: "true", 99904: "1" }, ON_OFF)).toBe(true);
      expect(enabledOf("T8420", true, { 99904: "1", 1035: "0" }, ON_OFF), "its bundle reads nothing").toBe(true);
    });
    it("without a description is absent", () => {
      expect(enabledOf("T8162", true, {})).toBe("absent");
      expect(enabledOf("T8162", true, { 6250: "1" })).toBe("absent");
      expect(enabledOf("T8162", true, { 1035: "1" })).toBe("absent");
    });
  });

  describe("statusLed — installed once the device reported a param its bundle reads", () => {
    it.each([
      [CAMERA_CMD.DEV_LED_SWITCH, "T8114", new Set(["camera"] as const)],
      [CAMERA_CMD.DOORBELL_LED, "T8214", new Set(["camera", "doorbell"] as const)],
    ])("installs statusLed and setStatusLed when the device reports %i", (param, model, capabilities) => {
      const { acts } = camera(at(model, { paramIds: new Set([param]), capabilities }));
      expect("statusLed" in acts).toBe(true);
      expect(acts.statusLed).toBeUndefined();
      expect(acts.setStatusLed).toBeTypeOf("function");
    });

    it("omits both members without a reported status LED parameter", () => {
      const { acts } = camera(at("T8114"));
      expect("statusLed" in acts).toBe(false);
      expect(acts.setStatusLed).toBeUndefined();
    });
  });

  describe("actions", () => {
    it("on/off dispatch inverted power; no privacy setter where power rides 1035", async () => {
      const { acts, sent } = camera(ctx(0, { model: "T8114", things: DESCRIBED }));
      await acts.on();
      await acts.off();
      expect(sent[0]).toMatchObject({ kind: "set-param", value: 0 }); // ON = 0 (default family)
      expect(sent[1]).toMatchObject({ kind: "set-param", value: 1 }); // OFF = 1
      expect(acts.setPrivacy).toBeUndefined();
    });

    it("a derived setter dispatches its member's command; a value the member rejects never reaches the wire", async () => {
      const { acts, sent } = camera(ctx(3, { model: "T8414", things: DESCRIBED, ...ATTACHED }));
      await acts.setWatermark!(2);
      await acts.setRecordingQuality!(5);
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatchObject({ param: CAMERA_CMD.SET_DEVS_OSD });
      expect(sent[1]).toMatchObject({ cmd: CAMERA_CMD.RECORDING_QUALITY_SET, payload: { quality: 3 } });
      await expect(acts.setWatermark!(5)).rejects.toThrow("watermark: 5 is not a valid value (must be one of 0/1/2)");
      await expect(acts.setRecordingQuality!(1)).rejects.toThrow(
        "recordingQuality: 1 is not a valid value (must be one of 2/5)",
      );
      expect(sent).toHaveLength(2);
    });

    it("media actions appear only with a provider, and delegate to it", async () => {
      expect(camera(ctx()).acts.snapshotStored).toBeUndefined();

      const calls: string[] = [];
      const media: MediaProvider = {
        snapshotStored: async () => (calls.push("snapshotStored"), Buffer.from("jpeg")),
        snapshotLive: async () => (calls.push("snapshotLive"), { jpeg: Buffer.alloc(0), width: 1, height: 1 }),
        // The test only checks it's callable; a live stream instance isn't needed here.
        live: async () => (calls.push("live"), {} as never),
        record: async (s: number) => (calls.push(`record:${s}`), Buffer.alloc(0)),
      };
      const { acts } = camera(ctx(0, { capabilities: new Set(["camera", "snapshot"]) }), media);
      const snap = await acts.snapshotStored!();
      await acts.record!(5);
      expect(snap).toEqual(Buffer.from("jpeg"));
      expect(calls).toEqual(["snapshotStored", "record:5"]);
    });

    it("withholds stored snapshots without snapshot capability evidence", () => {
      const media: MediaProvider = {
        snapshotStored: async () => Buffer.alloc(0),
        snapshotLive: async () => ({ jpeg: Buffer.alloc(0), width: 1, height: 1 }),
        live: async () => ({}) as never,
        record: async () => Buffer.alloc(0),
      };
      expect(camera(ctx(), media).acts.snapshotStored).toBeUndefined();
    });

    it("an optional media method the provider does not implement is absent, not a key holding undefined", () => {
      const media: MediaProvider = {
        snapshotLive: async () => ({ jpeg: Buffer.alloc(0), width: 1, height: 1 }),
        live: async () => ({}) as never,
        record: async () => Buffer.alloc(0),
      };
      expect("openReadable" in camera(ctx(), media).acts).toBe(false);
      expect("downloadRecording" in camera(ctx(), media).acts).toBe(false);
    });

    it("a lock-codec device other than the T8530 is offered live view alone; the T8530 adds openReadable", () => {
      const media: MediaProvider = {
        snapshotStored: async () => Buffer.alloc(0),
        snapshotLive: async () => ({ jpeg: Buffer.alloc(0), width: 1, height: 1 }),
        live: async () => ({}) as never,
        record: async () => Buffer.alloc(0),
        openReadable: async () => ({}) as never,
        recordFragments: () => ({}) as never,
        downloadRecording: async () => ({}) as never,
        talkback: async () => ({}) as never,
      };
      const evidence = {
        paramIds: new Set<number>([...Object.values(CAMERA_CMD), 1241, 2001]),
        capabilities: new Set(["lock", "camera", "snapshot"] as const),
      };
      const lock = camera(ctx(0, { codec: "lock", ...evidence }), media).acts as Record<string, unknown>;
      const offered = Object.keys(lock).filter((k) => typeof lock[k] === "function");
      expect(offered).toEqual(["live"]);
      expect(
        camera(ctx(0, { codec: "camera", model: "T8171", things: DESCRIBED, ...evidence }), media).acts.setWatermark,
      ).toBeTypeOf("function");
      const videoLock = camera(ctx(0, { codec: "lock", deviceType: DeviceType.LOCK_8530, ...evidence }), media)
        .acts as Record<string, unknown>;
      const videoLockOffered = Object.keys(videoLock).filter((k) => typeof videoLock[k] === "function");
      expect(videoLockOffered.sort()).toEqual(["live", "openReadable"]);
    });

    it("the T8530 is offered a recording download behind a HomeBase 3 alone", () => {
      const media: MediaProvider = {
        snapshotLive: async () => ({ jpeg: Buffer.alloc(0), width: 1, height: 1 }),
        live: async () => ({}) as never,
        record: async () => Buffer.alloc(0),
        downloadRecording: async () => ({}) as never,
      };
      const videoLock = (stationSerial?: string) =>
        camera(ctx(4, { codec: "lock", deviceType: DeviceType.LOCK_8530, stationSerial }), media).acts;
      expect(videoLock("T8030P0000000000").downloadRecording).toBeTypeOf("function");
      expect("downloadRecording" in videoLock("T8010P0000000000")).toBe(false);
      expect("downloadRecording" in videoLock()).toBe(false);
      const otherLock = camera(ctx(4, { codec: "lock", stationSerial: "T8030P0000000000" }), media).acts;
      expect("downloadRecording" in otherLock).toBe(false);
    });

    it("a stored-recording download passes the pushed recording name and cipher id through unchanged", async () => {
      const seen: unknown[] = [];
      const recording = { video: Buffer.from([1]), frames: 1, missingFrames: 0, durationMs: 0, fps: 0 };
      const media: MediaProvider = {
        snapshotLive: async () => ({ jpeg: Buffer.alloc(0), width: 1, height: 1 }),
        live: async () => ({}) as never,
        record: async () => Buffer.alloc(0),
        downloadRecording: async (opts) => (seen.push(opts), recording),
      };
      const { acts } = camera(ctx(), media);

      await expect(acts.downloadRecording!({ recording: "20260101120000", cipherId: 1 })).resolves.toBe(recording);
      expect(seen).toEqual([{ recording: "20260101120000", cipherId: 1 }]);
    });
  });

  /**
   * Talkback is a speaker feature, so it is gated on the SPEAKER param being reported — not on the
   * `audio` capability, which resolves on a microphone alone. A mic-only camera advertising talkback is
   * exactly the phantom sub-feature evidence-gating exists to prevent.
   */
  describe("talkback gating", () => {
    const AUDIO_MICROPHONE = 1240;
    const AUDIO_SPEAKER = 1241;

    const mediaWithTalkback = (calls: string[] = []): MediaProvider => ({
      snapshotLive: async () => ({ jpeg: Buffer.alloc(0), width: 1, height: 1 }),
      live: async () => ({}) as never,
      record: async () => Buffer.alloc(0),
      talkback: async (opts) => (calls.push(`talkback:${opts?.powered}`), {}) as never,
    });

    it("is offered when the device reported a speaker", () => {
      const { acts } = camera(ctx(0, { paramIds: new Set([AUDIO_SPEAKER]) }), mediaWithTalkback());
      expect(acts.talkback).toBeTypeOf("function");
    });

    it("is withheld from a camera that reported only a microphone", () => {
      const { acts } = camera(ctx(0, { paramIds: new Set([AUDIO_MICROPHONE]) }), mediaWithTalkback());
      expect(acts.talkback).toBeUndefined();
    });

    it("is withheld when the device reported neither", () => {
      expect(camera(ctx(), mediaWithTalkback()).acts.talkback).toBeUndefined();
    });

    it("carries the power hint, so a battery camera talked to is still bounded", async () => {
      const calls: string[] = [];
      const { acts } = camera(
        ctx(0, { paramIds: new Set([AUDIO_SPEAKER]), capabilities: new Set(["camera", "battery"]) }),
        mediaWithTalkback(calls),
      );
      await acts.talkback!();
      expect(calls).toEqual(["talkback:battery"]);
    });

    it("keeps the passive snapshot separate from the powered live path", async () => {
      const seen: string[] = [];
      const media: MediaProvider = {
        snapshotStored: async () => (seen.push("snapshotStored"), Buffer.alloc(0)),
        snapshotLive: async (o) => (
          seen.push(`snapshotLive:${o?.powered}`),
          { jpeg: Buffer.alloc(0), width: 1, height: 1 }
        ),
        live: async () => ({}) as never,
        record: async () => Buffer.alloc(0),
      };
      const { acts } = camera(ctx(0, { capabilities: new Set(["camera", "snapshot", "battery"]) }), media);
      await acts.snapshotStored!();
      await acts.snapshotLive!();
      expect(seen).toEqual(["snapshotStored", "snapshotLive:battery"]);
    });

    it("passes recording prebuffer options and the power hint to the recording handle", () => {
      const seen: unknown[] = [];
      const recording = {
        on: () => recording,
        stop: () => undefined,
        async *[Symbol.asyncIterator]() {},
      };
      const media: MediaProvider = {
        snapshotLive: async () => ({ jpeg: Buffer.alloc(0), width: 1, height: 1 }),
        live: async () => ({}) as never,
        record: async () => Buffer.alloc(0),
        recordFragments: (opts) => (seen.push(opts), recording),
      };
      const { acts } = camera(ctx(0, { capabilities: new Set(["camera", "battery"]) }), media);
      expect(acts.recordFragments!({ preBufferSeconds: 8 })).toBe(recording);
      expect(seen).toEqual([{ powered: "battery", preBufferSeconds: 8 }]);
    });
  });
});

/**
 * The derived surface, pinned at COMPILE time — these assertions have no runtime half, which is the
 * point: what a developer sees in the editor is the same table the runtime installs from, and the two
 * cannot drift. Checked by `npm run typecheck`; a widened type fails the build here.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
declare const cam: CameraActions;

// A getter is optional (evidence-gated) and narrowed to what the member declares it is stored as.
const _enabled: Exact<typeof cam.enabled, boolean | undefined> = true;
const _watermark: Exact<typeof cam.watermark, number | undefined> = true;

// Write-only: a setter and no getter, because the device never reports privacy state back.
const _noPrivacyGetter: Exact<"privacy" extends keyof CameraActions ? true : false, false> = true;
const _setPrivacy: Exact<Parameters<NonNullable<typeof cam.setPrivacy>>[0], boolean> = true;
const _statusLed: Exact<typeof cam.statusLed, boolean | undefined> = true;
const _setStatusLedOptional: Exact<undefined extends typeof cam.setStatusLed ? true : false, true> = true;

// The app's own value, read and written alike.
const _recordingQualityRead: Exact<typeof cam.recordingQuality, number | undefined> = true;
const _recordingQualityWrite: Exact<Parameters<NonNullable<typeof cam.setRecordingQuality>>[0], number> = true;

// A gated write is OPTIONAL, so a caller is made to check: by reported evidence, or by codec.
const _antiTheftOptional: Exact<undefined extends typeof cam.setAntiTheftDetection ? true : false, true> = true;
const _watermarkOptional: Exact<undefined extends typeof cam.setWatermark ? true : false, true> = true;

const _snapshotOptional: Exact<undefined extends typeof cam.snapshotStored ? true : false, true> = true;
const _snapshotReturns: Exact<
  ReturnType<NonNullable<typeof cam.snapshotStored>>,
  ReturnType<NonNullable<MediaProvider["snapshotStored"]>>
> = true;
const _recordArg: Exact<Parameters<NonNullable<typeof cam.record>>[0], number> = true;
// …and a builder's falsy "declined" answer never reaches the caller — past the guard it is the function.
const _talkbackNotFalse: Exact<false extends typeof cam.talkback ? true : false, false> = true;

export const _surfaceAssertions = [
  _enabled,
  _watermark,
  _noPrivacyGetter,
  _setPrivacy,
  _statusLed,
  _setStatusLedOptional,
  _recordingQualityRead,
  _recordingQualityWrite,
  _antiTheftOptional,
  _watermarkOptional,
  _snapshotOptional,
  _snapshotReturns,
  _recordArg,
  _talkbackNotFalse,
];

/**
 * Confirming an enablement write through bounded readback, on the first param the product's bundle reads
 * that the device reported, expecting the raw value the bundle maps to the written state.
 */
describe("camera enablement — observed write", () => {
  const observationFor = (model: string, reported: number[], value: boolean, homeBaseAttached?: boolean) =>
    CAMERA_MEMBERS.enabled.observation.reflects(value, {
      channel: 0,
      codec: "camera",
      model,
      homeBaseAttached,
      things: DESCRIBED,
      paramIds: new Set(reported),
    } as never);

  const CAMERA_ENABLE = CAMERA_CMD.CAMERA_ENABLE;
  const OPEN_DEVICE = 2001;

  it("observes the param the device actually reports, not the one that was written", () => {
    expect(observationFor("T8410", [OPEN_DEVICE], true)).toEqual({
      param: OPEN_DEVICE,
      expected: "true",
    });
    expect(observationFor("T8410", [OPEN_DEVICE], false)).toEqual({
      param: OPEN_DEVICE,
      expected: "false",
    });
  });

  it("states the raw disable bit", () => {
    expect(observationFor("T8114", [CAMERA_ENABLE], true)).toEqual({
      param: CAMERA_ENABLE,
      expected: "0",
    });
    expect(observationFor("T8114", [CAMERA_ENABLE], false)).toEqual({
      param: CAMERA_ENABLE,
      expected: "1",
    });
  });

  it("observes 6250 where the product's bundle reads the param it writes", () => {
    expect(observationFor("T8400", [OPEN_DEVICE, CAMERA_CMD.PRIVACY_MODE], true, true)).toEqual({
      param: CAMERA_CMD.PRIVACY_MODE,
      expected: "0",
    });
  });

  it("declines to observe a device that reports no enablement param", () => {
    expect(observationFor("T8410", [], true)).toBeUndefined();
  });

  it("observes an attached S350 on the 6250 its bundle reads, and not on a reported 1035", () => {
    expect(observationFor("T8416", [CAMERA_ENABLE], true, true)).toBeUndefined();
    expect(observationFor("T8416", [CAMERA_CMD.PRIVACY_MODE], true, true)).toMatchObject({
      param: CAMERA_CMD.PRIVACY_MODE,
    });
  });

  it("refuses media from a camera whose enabled reading is false", async () => {
    const media: MediaProvider = {
      snapshotLive: async () => ({ jpeg: Buffer.from("jpeg"), width: 1, height: 1 }),
      live: async () => ({}) as never,
      record: async () => Buffer.alloc(0),
    };
    const s350 = (value: boolean) =>
      bind<CameraActions>("camera", at("T8416", ATTACHED), { media, read: () => ({ value }) }).acts;
    expect((await s350(true).snapshotLive!()).jpeg).toEqual(Buffer.from("jpeg"));
    await expect(s350(false).snapshotLive!()).rejects.toBeInstanceOf(CameraDisabledError);
  });

  it("observes a standalone S350 on the param it reports", () => {
    expect(observationFor("T8416", [CAMERA_ENABLE], true, false)).toEqual({
      param: CAMERA_ENABLE,
      expected: "0",
    });
  });
});
