import { AUDIO, AUDIO_CMD, type AudioActions } from "../audio.js";
import { parseThingsList } from "../thing-description.js";
import { bind } from "./bind.js";
import { DeviceType } from "../../device-types.js";
import { buildCommand, detectCapabilities } from "../index.js";
import type { CommandContext } from "../types.js";

/** Audio capability (offline). Asserts the WRITE intents each action emits and the detection signal. */
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
const SWITCHES = things("microphone_on_off", "speaker_on_off", "audio_recording_on_off");
/** A described `model`, as each switch's product bundle writes and reads it. */
const at = (channel: number, model: string, extra: Partial<CommandContext> = {}) =>
  ctx(channel, { model, things: SWITCHES, ...extra });

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

  describe("buildCommand", () => {
    it("speakerVolume/volume → set-param direct-binary on 1230, rejecting anything outside 0..100", () => {
      expect(buildCommand("speakerVolume", 80, ctx())).toMatchObject({
        param: AUDIO_CMD.SPEAKER_VOLUME,
        value: 80,
      });
      expect(() => buildCommand("volume", 250, ctx())).toThrow(
        /volume: 250 is not a valid value \(must be in 0\.\.100\)/,
      );
      expect(() => buildCommand("volume", -5, ctx())).toThrow(
        /volume: -5 is not a valid value \(must be in 0\.\.100\)/,
      );
    });

    it("returns undefined for an unknown action", () => {
      expect(buildCommand("nope", 1, ctx())).toBeUndefined();
    });
  });

  it("a setter dispatches the command its intent builds", async () => {
    const described = things("microphone_on_off", "speaker_on_off", "speaker_volume");
    const { acts, sent } = bind<AudioActions>("audio", at(3, "T8214", { things: described }));
    await acts.setMicrophone!(false);
    await acts.setSpeaker!(true);
    await acts.setVolume!(40);
    const c = at(3, "T8214", { things: described });
    expect(sent).toEqual([
      buildCommand("microphone", false, c),
      buildCommand("speaker", true, c),
      { kind: "set-param", stationAccount: true, param: 1230, value: 40, channel: 3 },
    ]);
  });

  it("offers each camera control only where the product's description lists it", () => {
    const ids = ["microphone_on_off", "speaker_on_off", "speaker_volume", "audio_recording_on_off"];
    const setters = (c: CommandContext) => {
      const a = bind<AudioActions>("audio", c).acts;
      return [a.setMicrophone, a.setSpeaker, a.setVolume, a.setAudioRecording].map((f) => typeof f);
    };
    expect(setters(ctx(0, { model: "T8214", things: things() }))).toEqual(Array(4).fill("undefined"));
    expect(setters(ctx(0, { model: "T8214", things: things(...ids) }))).toEqual(Array(4).fill("function"));
    expect(
      setters(ctx(0, { model: "T8214", codec: "lock", things: things(...ids) })),
      "the description decides the bundle-written switches on any codec; the volume stays camera-only",
    ).toEqual(["function", "function", "undefined", "function"]);
    expect(setters(ctx(0, { model: "T8214", codec: "lock", things: things("speaker_on_off") }))).toEqual([
      "undefined",
      "function",
      "undefined",
      "undefined",
    ]);
    expect(setters(ctx()), "no description: the bundle-written switches are not exposed").toEqual([
      "undefined",
      "undefined",
      "function",
      "undefined",
    ]);
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
      expect(sent).toEqual([{ kind: "set-param", stationAccount: true, param: 1708, value: 50, channel: 2 }]);
    });

    it("buildCommand('ringtoneVolume') is gated on the doorbell capability", () => {
      expect(buildCommand("ringtoneVolume", 90, doorbellCtx)).toMatchObject({
        kind: "set-param",
        stationAccount: true,
        param: 1708,
        value: 90,
      });
      expect(buildCommand("ringtoneVolume", 90, cameraCtx)).toBeUndefined();
    });
  });
});
