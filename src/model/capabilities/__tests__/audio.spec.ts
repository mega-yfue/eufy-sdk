import { AUDIO, AUDIO_CMD, AUDIO_MEMBERS, type AudioActions } from "../audio.js";
import { propertiesOf } from "../members.js";
import { parseThingsList } from "../thing-description.js";
import { bind } from "./bind.js";
import { DeviceType } from "../../device-types.js";
import { buildCommand, detectCapabilities } from "../index.js";
import type { AvailabilityContext, CommandContext } from "../types.js";
import type { Command } from "../../../core/contracts.js";

/**
 * Audio capability (offline). Asserts the WRITE intents each action emits and the detection signal.
 * The wire (`direct-binary`, signCode 8) and polarity (on ⇒ 1) are CONFIRMED on T8214 (
 * cmd 1240/1241, 136-byte struct; cloud param OFF→0/ON→1). These tests lock that behaviour.
 */
const ctx = (channel = 0, extra: Partial<CommandContext> = {}): CommandContext => ({
  channel,
  codec: "camera",
  // The barrel's `buildCommand` only lets a module answer for a capability the device HAS; these ctxs
  // hand evidence directly rather than through detection, so the resolved set is stated.
  capabilities: new Set(["audio"] as const),
  paramIds: new Set<number>(),
  ...extra,
});
/** A description listing `ids`, as the things service gives one per product. */
const things = (...ids: string[]) =>
  parseThingsList({
    things_list: [{ profile: { product_code: "T0000" }, properties: ids.map((identifier) => ({ identifier })) }],
  }).T0000!;

describe("audio capability module", () => {
  it("declares the mic/speaker/volume schema", () => {
    expect(AUDIO.capability).toBe("audio");
    expect(AUDIO.properties.map((p) => p.name)).toEqual(["microphone", "speaker", "speakerVolume", "audioRecording"]);
  });

  it("detects cameras via mic/speaker params; the HomeBase family, but NOT NVRs", () => {
    expect(detectCapabilities({ params: { 1240: "1", 1241: "1" } }, "camera")).toContain("audio");
    // A camera reporting only volume (1230) but no mic/speaker switch is NOT two-way audio.
    expect(detectCapabilities({ params: { 1230: "26" } }, "camera")).not.toContain("audio");
    // The HomeBase (HB3) has a speaker → audio; keyed on the HOMEBASE deviceType, not the codec.
    expect(detectCapabilities({ deviceType: DeviceType.HB3, params: {} }, "station")).toContain("audio");
    // An NVR (S4 Max / PoE NVR) is `station` codec but has no speaker → must NOT get audio.
    expect(detectCapabilities({ deviceType: DeviceType.NVR_S4_MAX, params: {} }, "station")).not.toContain("audio");
    expect(detectCapabilities({ deviceType: DeviceType.CAMERA_POE_S4, params: {} }, "station")).not.toContain("audio");
  });

  describe("buildCommand — direct-binary intents (wire verified live on T8214)", () => {
    it("microphone → set-param direct-binary on 1240, on ⇒ 1 / off ⇒ 0", () => {
      expect(buildCommand("microphone", true, ctx(2))).toEqual({
        kind: "set-param",
        param: AUDIO_CMD.AUDIO_MICROPHONE,
        value: 1,
        form: "direct-binary",
        channel: 2,
      });
      expect(buildCommand("microphone", false, ctx())).toMatchObject({ value: 0 });
    });

    it("speaker → set-param direct-binary on 1241", () => {
      expect(buildCommand("speaker", true, ctx())).toMatchObject({
        kind: "set-param",
        param: AUDIO_CMD.AUDIO_SPEAKER,
        value: 1,
        form: "direct-binary",
      });
    });

    it("speakerVolume/volume → set-param direct-binary on 1230, rejecting anything outside 0..100", () => {
      expect(buildCommand("speakerVolume", 80, ctx())).toMatchObject({
        param: AUDIO_CMD.SPEAKER_VOLUME,
        value: 80,
        form: "direct-binary",
      });
      expect(() => buildCommand("volume", 250, ctx())).toThrow(
        /volume: 250 is not a valid value \(must be in 0\.\.100\)/,
      );
      expect(() => buildCommand("volume", -5, ctx())).toThrow(
        /volume: -5 is not a valid value \(must be in 0\.\.100\)/,
      );
    });

    it("audioRecording on a HomeBase → 1350 set-payload {channel, record_mute}, INVERTED (on ⇒ mute 0)", () => {
      // Reversed from a live capture on T8425 (ch3): key is `record_mute`, inverted.
      const attached = ctx(3, { homeBaseAttached: true });
      expect(buildCommand("audioRecording", true, attached)).toMatchObject({
        kind: "set-payload",
        cmd: AUDIO_CMD.AUDIO_RECORDING, // 1288
        channel: 3,
        mValue3: 0,
        payload: { channel: 3, record_mute: 0 },
      });
      expect(
        (buildCommand("audioRecording", false, attached) as Extract<Command, { kind: "set-payload" }>).payload,
      ).toEqual({ channel: 3, record_mute: 1 });
    });
    it("audioRecording standalone → 1700/6012 {enable}", () => {
      expect(buildCommand("audioRecording", true, ctx(0, { homeBaseAttached: false }))).toEqual({
        kind: "set-json",
        param: 6012,
        data: { enable: 1 },
        channel: 0,
      });
    });
    it.each([
      ["T8200", false, { paramType: 2042, readAliases: [] }],
      ["T8420", true, { paramType: 1366, invert: true, readAliases: [] }],
      ["T8441", true, { paramType: 1288, invert: false }],
      ["T8452", false, { paramType: 1288, invert: false, readAliases: [] }],
    ])(
      "audioRecording on %s (attached %s) reads its bundle's wire but has no setter until a device confirms it",
      (model, homeBaseAttached, read) => {
        const c = ctx(2, { model, homeBaseAttached, things: things("audio_recording_on_off") });
        expect(bind<AudioActions>("audio", c).acts.setAudioRecording).toBeUndefined();
        expect(() => buildCommand("audioRecording", true, c)).toThrow(/audioRecording write wire unverified/);
        const props = propertiesOf(AUDIO_MEMBERS, { codec: "camera", model, homeBaseAttached } as AvailabilityContext);
        expect(props.find((p) => p.name === "audioRecording")).toMatchObject(read);
      },
    );
    it("audioRecording on a standalone T8441 keeps its 6012 setter", () => {
      const c = ctx(2, { model: "T8441", homeBaseAttached: false, things: things("audio_recording_on_off") });
      expect(buildCommand("audioRecording", true, c)).toMatchObject({ param: 6012, data: { enable: 1 } });
    });
    it("audioRecording is withheld where the bundle sends 1288 inside 1700, or nothing", () => {
      const desc = things("audio_recording_on_off");
      for (const model of ["T81A0", "T84A1", "T8790"])
        expect(bind<AudioActions>("audio", ctx(0, { model, things: desc })).acts.setAudioRecording).toBeUndefined();
    });
    it("audioRecording property is inverted (raw 1288 = record_mute)", () => {
      const p = AUDIO.properties.find((x) => x.name === "audioRecording");
      expect(p?.paramType).toBe(AUDIO_CMD.AUDIO_RECORDING);
      expect(p?.invert).toBe(true);
    });

    it("returns undefined for an unknown action", () => {
      expect(buildCommand("nope", 1, ctx())).toBeUndefined();
    });
  });

  it("actions dispatch the same intents (camera family)", async () => {
    const { acts, sent } = bind<AudioActions>("audio", ctx(3)); // default ctx = camera codec
    await acts.setMicrophone!(false);
    await acts.setSpeaker!(true);
    await acts.setVolume!(40);
    expect(sent).toEqual([
      { kind: "set-param", param: 1240, value: 0, form: "direct-binary", channel: 3 },
      { kind: "set-param", param: 1241, value: 1, form: "direct-binary", channel: 3 },
      { kind: "set-param", param: 1230, value: 40, form: "direct-binary", channel: 3 },
    ]);
  });

  it("offers each camera control only where the product's description lists it", () => {
    const ids = ["microphone_on_off", "speaker_on_off", "speaker_volume", "audio_recording_on_off"];
    const setters = (c: CommandContext) => {
      const a = bind<AudioActions>("audio", c).acts;
      return [a.setMicrophone, a.setSpeaker, a.setVolume, a.setAudioRecording].map((f) => typeof f);
    };
    expect(setters(ctx(0, { things: things() }))).toEqual(Array(4).fill("undefined"));
    expect(setters(ctx(0, { things: things(...ids) }))).toEqual(Array(4).fill("function"));
    expect(setters(ctx(0, { codec: "lock", things: things(...ids) }))).toEqual(Array(4).fill("undefined"));
    expect(setters(ctx())).toEqual(Array(4).fill("function"));
  });

  describe("station (HomeBase) voice-prompt audio", () => {
    const hubCtx = ctx(0, { codec: "station", deviceType: DeviceType.HB3 });

    it("a HomeBase gets prompt volume only; alarm output belongs to siren", () => {
      const { acts } = bind<AudioActions>("audio", hubCtx);
      expect(acts.setPromptVolume).toBeDefined();
      expect(acts.setMicrophone).toBeUndefined();
      expect(acts.setVolume).toBeUndefined();
      expect(acts.setRingtoneVolume).toBeUndefined();
      expect("setAlarmVolume" in acts).toBe(false);
      expect("setAlarmTone" in acts).toBe(false);
    });

    it("an NVR (station codec, no speaker) gets NO audio actions", () => {
      const nvr = ctx(0, { codec: "station", deviceType: DeviceType.NVR_S4_MAX });
      const { acts } = bind<AudioActions>("audio", nvr);
      expect(Object.keys(acts)).toHaveLength(0);
      expect(buildCommand("alarmVolume", 50, nvr)).toBeUndefined();
      expect(buildCommand("promptVolume", 50, nvr)).toBeUndefined();
    });

    it("setPromptVolume → 1350 set-payload wrapper {value} on ch0", async () => {
      const { acts, sent } = bind<AudioActions>("audio", hubCtx);
      await acts.setPromptVolume!(70);
      expect(sent).toEqual([{ kind: "set-payload", cmd: 1292, payload: { value: 70 }, channel: 0 }]);
    });

    it("a camera does NOT get the station actions", () => {
      const { acts } = bind<AudioActions>("audio", ctx(2));
      expect("setAlarmVolume" in acts).toBe(false);
      expect(acts.setPromptVolume).toBeUndefined();
    });
  });

  describe("ringtone volume — doorbell-only, folded into the audio capability", () => {
    const doorbellCtx = ctx(2, { capabilities: new Set(["camera", "audio", "doorbell"]) });
    const cameraCtx = ctx(0, { capabilities: new Set(["camera", "audio"]) });

    it("setRingtoneVolume is present ONLY on a doorbell, and writes 1708 direct-binary", async () => {
      expect(bind<AudioActions>("audio", cameraCtx).acts.setRingtoneVolume).toBeUndefined();

      const { acts, sent } = bind<AudioActions>("audio", doorbellCtx);
      expect(acts.setRingtoneVolume).toBeDefined();
      await acts.setRingtoneVolume!(50);
      expect(sent).toEqual([{ kind: "set-param", param: 1708, value: 50, form: "direct-binary", channel: 2 }]);
    });

    it("buildCommand('ringtoneVolume') is gated on the doorbell capability", () => {
      expect(buildCommand("ringtoneVolume", 90, doorbellCtx)).toMatchObject({
        kind: "set-param",
        param: 1708,
        value: 90,
        form: "direct-binary",
      });
      expect(buildCommand("ringtoneVolume", 90, cameraCtx)).toBeUndefined();
    });
  });
});
