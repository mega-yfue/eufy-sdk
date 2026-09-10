import {
  CAMERA,
  CAMERA_CMD,
  CAMERA_MEMBERS,
  Watermark,
  NotificationStyle,
  SoundDetectionType,
  NightVision,
  VideoQuality,
  resolveVideoQuality,
} from "../camera.js";
import type { VideoQualityName } from "../camera.js";
import { buildCommand } from "../index.js";
import { actionSpecOf } from "../access.js";
import { bind } from "./bind.js";
import type { CameraActions } from "../camera.js";
import { DeviceType } from "../../device-types.js";
import { Device } from "../../device.js";
import type { CommandContext } from "../types.js";
import type { MediaProvider } from "../../../core/contracts.js";

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

/** The bound `dev.camera()` object — the members derive their setters in the barrel, not in `actions()`. */
const camera = (c: CommandContext, media?: MediaProvider) => bind<CameraActions>("camera", c, { media });

describe("camera capability module", () => {
  it("declares the capability + schema", () => {
    expect(CAMERA.capability).toBe("camera");
    expect(CAMERA.properties.map((p) => p.name)).toEqual([
      "enabled",
      "imageFlipped",
      "watermark",
      "soundDetection",
      "soundDetectionSensitivity",
      "soundDetectionType",
      "notificationStyle",
      "nightVision",
      "videoQuality",
      "antiTheftDetection",
      "statusLed",
    ]);
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

  describe("antiTheftDetection (1015)", () => {
    // The app parses EAS_SWITCH as anti_theft_detection_switch, so the property is named for that.
    // Adaptive scalar form (topology picks the level), and the write is evidence-gated on 1015.
    const withParam = (ch: number) => ctx(ch, { paramIds: new Set([CAMERA_CMD.EAS_SWITCH]) });

    it("emits an adaptive scalar when the device reports 1015", () => {
      expect(buildCommand("antiTheftDetection", true, withParam(3))).toEqual({
        kind: "set-param",
        param: CAMERA_CMD.EAS_SWITCH, // 1015
        value: 1,
        form: "auto",
        channel: 3,
      });
      expect(buildCommand("antiTheftDetection", false, withParam(3))).toMatchObject({ value: 0 });
    });

    it("is gated: no command on a device that doesn't report 1015 (→ not-supported, not a silent no-op)", () => {
      expect(buildCommand("antiTheftDetection", true, ctx(3))).toBeUndefined();
    });

    it("the derived setter dispatches the identical frame the intent path builds", async () => {
      const { acts, sent } = camera(withParam(3));
      await acts.setAntiTheftDetection!(true);
      expect(sent).toEqual([buildCommand("antiTheftDetection", true, withParam(3))]);
    });

    it("the setter is absent — not a rejecting stub — on a device that never reported 1015", () => {
      expect(camera(ctx(3)).acts.setAntiTheftDetection).toBeUndefined();
    });
  });

  it("is a camera-codec baseline", () => {
    expect(CAMERA.detection?.codecs).toEqual(["camera"]);
  });

  describe("buildCommand — emits transport-neutral intents (wire chosen by the resolver)", () => {
    it("on/off → a set-param 'auto' scalar for CAMERA_ENABLE (wire decided downstream)", () => {
      expect(buildCommand("on", true, ctx(1))).toEqual({
        kind: "set-param",
        param: CAMERA_CMD.CAMERA_ENABLE,
        value: 0, // default family (no deviceType) = disable bit → ON ⇒ 0
        form: "auto",
        channel: 1,
      });
      expect(buildCommand("off", false, ctx())).toMatchObject({ kind: "set-param", value: 1 });
    });

    it("privacy → the multi-frame burst command", () => {
      expect(buildCommand("privacy", true, ctx(2))).toEqual({
        kind: "p2p-privacy-burst",
        enabled: true,
        channel: 2,
      });
    });

    it("returns undefined for an unknown action", () => {
      expect(buildCommand("nope", 1, ctx())).toBeUndefined();
    });

    it("'enabled' (the canonical writable property name) reaches a set-param intent", () => {
      // Regression: the sole writable PropertySpec is named "enabled"; setProperty(sn,"enabled",…)
      // must reach a command, not fall through to CapabilityNotSupportedError.
      expect(buildCommand("enabled", true, ctx())).toMatchObject({
        kind: "set-param",
        param: CAMERA_CMD.CAMERA_ENABLE,
        value: 0,
      });
      expect(buildCommand("enabled", false, ctx())).toMatchObject({ value: 1 });
    });

    it("coerces string/number truthiness consistently (asBool) for the property path", () => {
      expect(buildCommand("enabled", "1", ctx())).toMatchObject({ value: 0 }); // ON
      expect(buildCommand("enabled", "false", ctx())).toMatchObject({ value: 1 }); // OFF
    });

    it("statusLed → a set-param pinned to int-string (DEV_LED_SWITCH 1045, always level-1)", () => {
      const statusLedCtx = ctx(1, { paramIds: new Set([CAMERA_CMD.DEV_LED_SWITCH]) });
      expect(buildCommand("statusLed", true, statusLedCtx)).toEqual({
        kind: "set-param",
        param: CAMERA_CMD.DEV_LED_SWITCH,
        value: 1,
        form: "int-string",
        channel: 1,
      });
      expect(buildCommand("statusLed", false, statusLedCtx)).toMatchObject({ form: "int-string", value: 0 });
    });

    it("imageFlipped → an 'auto' scalar for ROTATE_IMAGE (1207), 1=flipped/0=normal", () => {
      expect(buildCommand("imageFlipped", true, ctx(2))).toEqual({
        kind: "set-param",
        param: CAMERA_CMD.ROTATE_IMAGE,
        value: 1,
        form: "auto",
        channel: 2,
      });
      expect(buildCommand("imageFlipped", false, ctx())).toMatchObject({ value: 0 });
    });

    it("watermark → an 'auto' direct scalar for CMD_SET_DEVS_OSD (1214), Watermark enum (verified)", () => {
      // Watermark = { Off:0, Timestamp:1, TimestampAndLogo:2 } — verified live on T8425.
      expect(Watermark).toEqual({ Off: 0, Timestamp: 1, TimestampAndLogo: 2 });
      expect(buildCommand("watermark", Watermark.TimestampAndLogo, ctx(3))).toEqual({
        kind: "set-param",
        param: CAMERA_CMD.SET_DEVS_OSD,
        value: 2,
        form: "auto",
        channel: 3,
      });
      expect(buildCommand("watermark", Watermark.Off, ctx())).toMatchObject({ value: 0 });
    });

    it("notificationStyle → the 1700 control payload for 6020, on the device channel (verified)", () => {
      // All three values captured byte-exact from the app on a standalone T8171, each read back on
      // the cloud param.
      expect(NotificationStyle).toEqual({ TextOnly: 1, IncludedThumbnail: 2, TextFirstThenThumbnail: 3 });
      const cmd = buildCommand("notificationStyle", NotificationStyle.IncludedThumbnail, ctx(0));
      expect(cmd).toMatchObject({
        kind: "set-json",
        param: CAMERA_CMD.PUSH_NOTIFY_TYPE, // 6020
        channel: 0,
      });
      // `transaction` is a decimal epoch-in-milliseconds string, so only its shape is fixed.
      const data = (cmd as { data: Record<string, unknown> }).data;
      expect(data.value).toBe(2);
      expect(data.transaction).toMatch(/^\d{13}$/);
      expect(buildCommand("notificationStyle", NotificationStyle.TextOnly, ctx(2))).toMatchObject({
        channel: 2,
        data: { value: 1 },
      });
    });

    it("notificationStyle rejects a value outside the enum — every neighbour is a real style", () => {
      for (const bad of [0, 4, -1, "x"]) {
        expect(() => buildCommand("notificationStyle", bad as number, ctx())).toThrow(
          /notificationStyle: .+ is not a valid value \(must be one of 1\/2\/3\)/,
        );
      }
    });

    it("watermark / nightVision throw on a value outside the enum (no bogus level on the wire)", () => {
      for (const bad of [5, -1, 99, "x"]) {
        expect(() => buildCommand("watermark", bad as number, ctx())).toThrow(
          /watermark: .+ is not a valid value \(must be one of 0\/1\/2\)/,
        );
        expect(() => buildCommand("nightVision", bad as number, ctx())).toThrow(
          /nightVision: .+ is not a valid value \(must be one of 0\/1\/2\)/,
        );
      }
      // Valid enum values still pass.
      expect(buildCommand("watermark", 1, ctx())).toMatchObject({ value: 1 });
      expect(buildCommand("nightVision", 1, ctx())).toMatchObject({ payload: { night_sion: 1 } });
    });

    it("nightVision → 1350 set-payload, mChannel 0, {channel,night_sion} (verified)", () => {
      // Verified live: device channel goes INSIDE the payload; the envelope's mChannel is 0.
      expect(NightVision).toEqual({ Off: 0, Infrared: 1, FullColor: 2 });
      expect(buildCommand("nightVision", NightVision.FullColor, ctx(3))).toMatchObject({
        kind: "set-payload",
        cmd: CAMERA_CMD.NIGHT_VISION_TYPE,
        payload: { channel: 3, night_sion: 2 },
        channel: 0,
        mValue3: 0,
      });
    });

    it("videoQuality → 1350 set-payload (2731), raw tier or resolution NAME (verified T8425)", () => {
      // Raw tier value.
      expect(buildCommand("videoQuality", 3, ctx(3))).toMatchObject({
        kind: "set-payload",
        cmd: CAMERA_CMD.VIDEO_QUALITY_SET,
        payload: { channel: 0, mode: 0, primary_view: 0, quality: 3 },
        channel: 3,
        mValue3: 0,
      });
      // Resolution NAME → tier (verified live on T8425): 1=720P, 2=1080P, 3=3K HD.
      expect(resolveVideoQuality(1)).toBe("HD (720P)");
      expect(resolveVideoQuality(3)).toBe("3K HD");
      const byName = buildCommand("videoQuality", VideoQuality.HD720, ctx(3));
      expect(byName).toMatchObject({ cmd: CAMERA_CMD.VIDEO_QUALITY_SET, payload: { quality: 1 } });
    });

    it("videoQuality throws on a value that isn't a real tier (no bogus value on the fire-and-forget wire)", () => {
      const c = ctx(3); // verified tiers = 1/2/3
      // Out-of-range raw values must NOT produce a command (0 / negative / above top tier / non-tier name).
      for (const bad of [0, -1, 99, "0", "4K HD"]) {
        expect(() => buildCommand("videoQuality", bad, c)).toThrow(
          /videoQuality: .+ is not a valid value \(must be one of 1\/2\/3\)/,
        );
      }
      // Valid tiers still pass.
      expect(buildCommand("videoQuality", 2, c)).toMatchObject({ payload: { quality: 2 } });
    });

    /**
     * The member renames its argument (`quality`, not `videoQuality`) and explains what it takes, while
     * the tier set is DERIVED from `decodedValues`. A member's own arg used to REPLACE the derived one, so
     * the rename silently dropped the tiers and left a caller rendering a picker with nothing to pick.
     */
    it("videoQuality's described argument keeps the derived tier set under its own name", () => {
      const { acts } = camera(ctx(3, { paramIds: new Set([CAMERA_CMD.VIDEO_QUALITY_SET]) }));
      const spec = actionSpecOf(acts.setVideoQuality)!;
      expect(spec.args).toEqual([
        {
          name: "quality",
          kind: "enum",
          values: [1, 2, 3],
          description: "A tier; the resolution name it maps to is accepted too.",
        },
      ]);
    });

    it("statusLed on a DOORBELL swaps to the 1716 set-payload wire (family-aware, verified T8214)", () => {
      const doorbellCtx = ctx(3, {
        deviceType: 94,
        model: "T8214",
        capabilities: new Set(["camera", "doorbell"]),
        paramIds: new Set([CAMERA_CMD.DOORBELL_LED]),
      });
      expect(buildCommand("statusLed", true, doorbellCtx)).toEqual({
        kind: "set-payload",
        cmd: CAMERA_CMD.DOORBELL_LED,
        payload: { light_enable: 1 },
        channel: 3,
      });
      expect(buildCommand("statusLed", false, doorbellCtx)).toMatchObject({
        kind: "set-payload",
        payload: { light_enable: 0 },
      });
    });
  });

  describe("power — polarity is the capability's concern (family-dependent value)", () => {
    // The capability owns POLARITY (the value); the WIRE (int-string vs direct-binary) is the
    // resolver's job — see resolver.spec / index. So here we assert value + form only.
    it("default / battery family (T8114, type 9): disable bit → ON ⇒ 0, form auto", () => {
      expect(buildCommand("on", true, ctx(0, { deviceType: 9, model: "T8114" }))).toMatchObject({
        kind: "set-param",
        form: "auto",
        value: 0,
      });
      expect(buildCommand("off", false, ctx(0, { deviceType: 9, model: "T8114" }))).toMatchObject({ value: 1 });
    });

    it("indoor-PT T8410 (type 31): enable bit → ON ⇒ 1, OFF ⇒ 0", () => {
      expect(buildCommand("on", true, ctx(0, { deviceType: 31, model: "T8410" }))).toMatchObject({ value: 1 });
      expect(buildCommand("off", false, ctx(0, { deviceType: 31, model: "T8410" }))).toMatchObject({
        value: 0,
      });
    });

    it("floodlight cams 8422/8424 flip to enable bit → ON ⇒ 1", () => {
      expect(buildCommand("on", true, ctx(0, { deviceType: 37, model: "T8422" }))).toMatchObject({ value: 1 });
      expect(buildCommand("on", true, ctx(0, { deviceType: 39, model: "T8424" }))).toMatchObject({ value: 1 });
    });

    it("battery/solo family (default) stays disable bit → ON ⇒ 0", () => {
      expect(buildCommand("on", true, ctx(0, { deviceType: 9, model: "T8114" }))).toMatchObject({ value: 0 });
    });

    /**
     * Every family writes the on/off param, the privacy envelope (6250) none of them.
     *
     * Confirmed against the current app's own frames: across six cameras of four device types and both
     * topologies every on/off it sent was `1035`, and the capture carries no `6250` frame. The envelope also
     * has no level-1 form, so it is unsendable on a session that never negotiates a key.
     */
    it("every family writes the on/off param, none the privacy envelope", () => {
      for (const deviceType of [
        DeviceType.INDOOR_COST_DOWN_CAMERA,
        DeviceType.INDOOR_PT_CAMERA_S350,
        DeviceType.OUTDOOR_PT_CAMERA,
      ]) {
        expect(buildCommand("on", true, ctx(2, { deviceType }))).toMatchObject({
          kind: "set-param",
          param: CAMERA_CMD.CAMERA_ENABLE,
          form: "auto",
          channel: 2,
        });
      }
    });
  });

  describe("enabled — family-aware read (param + polarity)", () => {
    // Battery/solo cam reports on/off under 1035 (disable bit → "0" ⇒ ON). Verified live: T8114.
    it('1035="0" reads enabled=true (inverted disable bit)', () => {
      const dev = Device.fromRecord("SN", {
        deviceType: 9,
        model: "T8114",
        category: "eufy_security",
        params: { 1035: "0" },
      });
      expect(dev.getProperty("enabled")?.value).toBe(true);
    });
    it('1035="1" reads enabled=false', () => {
      const dev = Device.fromRecord("SN", {
        deviceType: 9,
        model: "T8114",
        category: "eufy_security",
        params: { 1035: "1" },
      });
      expect(dev.getProperty("enabled")?.value).toBe(false);
    });
    // Standalone indoor cam reports on/off under 2001 OPEN_DEVICE (direct polarity). Verified live: T8410.
    it('2001="false" reads enabled=false (OPEN_DEVICE alias, direct polarity)', () => {
      const dev = Device.fromRecord("SN", {
        deviceType: 31,
        model: "T8410",
        category: "eufy_security",
        params: { 2001: "false" },
      });
      expect(dev.getProperty("enabled")?.value).toBe(false);
    });
    it('2001="true" reads enabled=true', () => {
      const dev = Device.fromRecord("SN", {
        deviceType: 31,
        model: "T8410",
        category: "eufy_security",
        params: { 2001: "true" },
      });
      expect(dev.getProperty("enabled")?.value).toBe(true);
    });
  });

  describe("statusLed — family-aware read alias and evidence-gated write", () => {
    it.each([
      [CAMERA_CMD.DEV_LED_SWITCH, "1", true, { deviceType: 9, model: "T8114" }],
      [CAMERA_CMD.DEV_LED_SWITCH, "0", false, { deviceType: 9, model: "T8114" }],
      [CAMERA_CMD.DOORBELL_LED, "true", true, { deviceType: 94, model: "T8214" }],
      [CAMERA_CMD.DOORBELL_LED, "false", false, { deviceType: 94, model: "T8214" }],
    ])("reads reported param %i value %s as %s", (param, value, expected, identity) => {
      const dev = Device.fromRecord("SN", {
        ...identity,
        category: "eufy_security",
        params: { [param]: value },
      });
      expect(dev.getProperty("statusLed")?.value).toBe(expected);
    });

    it("does not let a non-doorbell's unrelated 1716 value overwrite status LED 1045", () => {
      const dev = Device.fromRecord("SN", {
        deviceType: 9,
        model: "T8114",
        category: "eufy_security",
        params: { 1045: "0", 1716: "1" },
      });
      expect(dev.getProperty("statusLed")?.value).toBe(false);
    });

    it("uses 1716, not 1045, when a doorbell reports both parameters", () => {
      const dev = Device.fromRecord("SN", {
        deviceType: 94,
        model: "T8214",
        category: "eufy_security",
        params: { 1045: "0", 1716: "1" },
      });
      expect(dev.getProperty("statusLed")).toMatchObject({ paramType: 1716, value: true });
    });

    it("does not treat 1045 alone as status LED evidence on a doorbell", () => {
      const dev = Device.fromRecord("SN", {
        deviceType: 94,
        model: "T8214",
        category: "eufy_security",
        params: { 1045: "1" },
      });
      expect(dev.getProperty("statusLed")).toBeUndefined();
      const { acts } = camera(
        ctx(0, { paramIds: new Set([CAMERA_CMD.DEV_LED_SWITCH]), capabilities: new Set(["camera", "doorbell"]) }),
      );
      expect("statusLed" in acts).toBe(false);
      expect(acts.setStatusLed).toBeUndefined();
    });

    it("does not treat 1716 alone as status LED evidence on a non-doorbell", () => {
      const dev = Device.fromRecord("SN", {
        deviceType: 9,
        model: "T8114",
        category: "eufy_security",
        params: { 1716: "1" },
      });
      expect(dev.getProperty("statusLed")).toBeUndefined();
      const { acts } = camera(ctx(0, { paramIds: new Set([CAMERA_CMD.DOORBELL_LED]) }));
      expect("statusLed" in acts).toBe(false);
      expect(acts.setStatusLed).toBeUndefined();
    });

    it.each([
      [CAMERA_CMD.DEV_LED_SWITCH, new Set(["camera"] as const)],
      [CAMERA_CMD.DOORBELL_LED, new Set(["camera", "doorbell"] as const)],
    ])("installs statusLed and setStatusLed when the device reports %i", (param, capabilities) => {
      const { acts } = camera(ctx(0, { paramIds: new Set([param]), capabilities }));
      expect("statusLed" in acts).toBe(true);
      expect(acts.statusLed).toBeUndefined();
      expect(acts.setStatusLed).toBeTypeOf("function");
    });

    it("omits both members without a reported status LED parameter", () => {
      const { acts } = camera(ctx());
      expect("statusLed" in acts).toBe(false);
      expect(acts.setStatusLed).toBeUndefined();
    });
  });

  describe("actions", () => {
    it("on/off dispatch inverted power; setPrivacy dispatches the burst", async () => {
      const { acts, sent } = camera(ctx(0));
      await acts.on();
      await acts.off();
      await acts.setPrivacy(true);
      expect(sent[0]).toMatchObject({ kind: "set-param", form: "auto", value: 0 }); // ON = 0 (default family)
      expect(sent[1]).toMatchObject({ kind: "set-param", form: "auto", value: 1 }); // OFF = 1
      expect(sent[2]).toMatchObject({ kind: "p2p-privacy-burst", enabled: true });
    });

    it("a derived setter dispatches its member's command; a value the member rejects never reaches the wire", async () => {
      const { acts, sent } = camera(ctx(3));
      await acts.setWatermark(2);
      await acts.setVideoQuality(3);
      expect(sent).toHaveLength(2);
      expect(sent[0]).toMatchObject({ param: CAMERA_CMD.SET_DEVS_OSD, value: 2 });
      expect(sent[1]).toMatchObject({ cmd: CAMERA_CMD.VIDEO_QUALITY_SET, payload: { quality: 3 } });
      await expect(acts.setWatermark(5)).rejects.toThrow("watermark: 5 is not a valid value (must be one of 0/1/2)");
      await expect(acts.setNightVision(9)).rejects.toThrow(
        "nightVision: 9 is not a valid value (must be one of 0/1/2)",
      );
      await expect(acts.setVideoQuality(0)).rejects.toThrow(
        "videoQuality: 0 is not a valid value (must be one of 1/2/3)",
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
const _setPrivacy: Exact<Parameters<typeof cam.setPrivacy>[0], boolean> = true;
const _statusLed: Exact<typeof cam.statusLed, boolean | undefined> = true;
const _setStatusLedOptional: Exact<undefined extends typeof cam.setStatusLed ? true : false, true> = true;

// `accepts` widens the SETTER past the getter: a resolution name as well as the tier that is stored.
const _videoQualityRead: Exact<typeof cam.videoQuality, number | undefined> = true;
const _videoQualityWrite: Exact<Parameters<NonNullable<typeof cam.setVideoQuality>>[0], VideoQualityName | number> =
  true;

// An evidence-gated write is OPTIONAL, so a caller is made to check; an ungated one is not.
const _antiTheftOptional: Exact<undefined extends typeof cam.setAntiTheftDetection ? true : false, true> = true;
const _watermarkRequired: Exact<undefined extends typeof cam.setWatermark ? true : false, false> = true;

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
  _videoQualityRead,
  _videoQualityWrite,
  _antiTheftOptional,
  _watermarkRequired,
  _snapshotOptional,
  _snapshotReturns,
  _recordArg,
  _talkbackNotFalse,
];

/**
 * Confirming an enablement write through bounded readback.
 *
 * Enablement is the one camera value a caller has to be able to trust and cannot poll for itself: it arrives
 * only by cloud param and no id pushes it, so before this the reported value simply froze — measured on a
 * bound object, `setEnabled(true)` succeeded, the camera streamed, and the reading stayed false at 0s, 2s, 7s
 * and 22s. A caller that publishes "this camera is off" was publishing a value that could never come back.
 *
 * The write and the read are on DIFFERENT wires here, which is what the observation has to resolve: every
 * family is written on the enablement param, while the standalone indoor/outdoor cameras report their state
 * under the `2001` alias and never the param that was written. Polling the written param there would never
 * converge. Measured on one account: 5 cameras report `1035` and never `2001`, 3 report `2001` and never
 * `1035`, and none reported both.
 */
describe("camera enablement — observed write", () => {
  const observationFor = (deviceType: number, reported: number[], value: boolean) => {
    const member = CAMERA_MEMBERS.enabled;
    const ctx = { channel: 0, codec: "camera" as const, deviceType, paramIds: new Set(reported) };
    return member.observation.reflects(value, ctx as never);
  };

  const CAMERA_ENABLE = CAMERA_CMD.CAMERA_ENABLE;
  const OPEN_DEVICE = 2001;

  it("observes the param the device actually reports, not the one that was written", () => {
    // Standalone indoor/outdoor: written on the enablement param, reported under the 2001 alias.
    expect(observationFor(DeviceType.INDOOR_PT_CAMERA, [OPEN_DEVICE], true)).toEqual({
      param: OPEN_DEVICE,
      expected: true,
      observed: true,
    });
    expect(observationFor(DeviceType.INDOOR_PT_CAMERA, [OPEN_DEVICE], false)).toEqual({
      param: OPEN_DEVICE,
      expected: false,
      observed: false,
    });
  });

  /**
   * The raw wire value and the decoded property value diverge here, and BOTH are stated: the param reports the
   * disable bit while the property reads enablement, so a readback checked only against the raw expectation
   * converges the value and never fires the transition event — measured, the 2001 family emitted its event and
   * this one did not.
   */
  it("states the raw disable bit AND the decoded value it means", () => {
    // Battery/solo (disable bit): ON ⇒ 0. Live: a T8114 reports 1035="0" while enabled.
    expect(observationFor(9, [CAMERA_ENABLE], true)).toEqual({ param: CAMERA_ENABLE, expected: 0, observed: true });
    expect(observationFor(9, [CAMERA_ENABLE], false)).toEqual({ param: CAMERA_ENABLE, expected: 1, observed: false });
  });

  /** A device reporting neither has nothing to read back, so the write is dispatched unobserved. */
  it("declines to observe a device that reports no enablement param", () => {
    expect(observationFor(DeviceType.INDOOR_PT_CAMERA, [], true)).toBeUndefined();
  });

  /**
   * Every family observes the param it reports. The app was captured writing `1035` to cameras of each, so
   * the wire written and the wire read agree everywhere and a readback can confirm any of them.
   */
  it("observes every family, including the outdoor-PT and S350 ones", () => {
    expect(observationFor(DeviceType.INDOOR_PT_CAMERA_S350, [CAMERA_ENABLE], true)).toEqual({
      param: CAMERA_ENABLE,
      expected: 0,
      observed: true,
    });
    expect(observationFor(DeviceType.OUTDOOR_PT_CAMERA, [CAMERA_ENABLE], true)).toEqual({
      param: CAMERA_ENABLE,
      expected: 0,
      observed: true,
    });
  });
});
