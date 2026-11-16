import { asBool } from "../../core/util.js";
import { isUntriedDoorbell, isHomeBase, HOMEBASE_TYPES } from "../device-family.js";
import { setScalar, setJson, setPayload, isCameraCodec, hasCapability } from "./access.js";
import { described } from "./thing-description.js";
import { propertiesOf, type Members, type Surface } from "./members.js";
import type { AvailabilityContext, CapabilityModule, CommandContext } from "./types.js";
import type { Command } from "../../core/contracts.js";

/**
 * The P2P **feature-command ids** this audio capability drives — the outer-cmd IS the param id on the
 * camera side (direct-binary struct), or the inner cmd of a `1350` SET_PAYLOAD on the station side.
 * Capability-owned wire vocabulary (transport forwards `cmd.param` opaquely; full id→name catalog in
 * the generated `transport/p2p/commands.ts`). All ✅ wire-verified live — see the module JSDoc below.
 */
export const AUDIO_CMD = {
  /**
   * Microphone on/off (app `AUDIO_MICROPHONE_SWITCH`). ✅ Wire verified live on T8214: direct-binary
   * 136-byte struct, signCode 8, 1=on/0=off (a switch, not a mute).
   */
  AUDIO_MICROPHONE: 1240,
  /** Speaker on/off (app `AUDIO_SPEAKER_SWITCH`). ✅ Wire verified live on T8214 — direct-binary, 1=on/0=off. */
  AUDIO_SPEAKER: 1241,
  /** Speaker volume 0..100 (app `DOORBELL_AUDIO_VOLUME`). ✅ Same direct-binary wire; write verified live on T8214 (set 60 → param 60). */
  SPEAKER_VOLUME: 1230,
  /**
   * Audio recording on/off (app `DOORBELL_AUDIO_RECORDING_SWITCH`) — whether the camera records audio
   * with video. Reported by every camera. ✅ Wire reversed from a live outbound capture + L2 decrypt on
   * T8425 (ch3): `1350` SET_PAYLOAD on the device channel (mChannel = device ch, mValue3 0), payload
   * `{channel:<deviceCh>, record_mute:0|1}`. The key is `record_mute` and it is **INVERTED** —
   * `record_mute:1` = muted (recording OFF), `record_mute:0` = recording ON.
   */
  AUDIO_RECORDING: 1288,
  /** Audio recording on a standalone camera (app `AUDIO_RECORDING_SWITCH`): `1700` with `{enable:0|1}`, 1 = on. */
  AUDIO_RECORDING_STANDALONE: 6012,
  /** Audio recording on the T8420 (app `FLC_AUDIO_RECORDING_SWITCH`): `1350` with `{storage_audio_switch}`, inverted. */
  AUDIO_RECORDING_FLC: 1366,
  /**
   * Doorbell ringtone/chime volume 0..100 (app `DOORBELL_RINGTONE_VOLUME`). ✅ Wire verified live on
   * T8214 — same direct-binary 136-byte struct, signCode 8. Doorbell-only: this capability adds it when
   * the device is a doorbell.
   */
  DOORBELL_RINGTONE_VOLUME: 1708,
  /**
   * HomeBase voice **prompt** volume 0..100 (app `APP_CMD_SET_PROMPT_VOLUME`). ✅ Wire verified live on
   * T8030 (audible): the `1350` SET_PAYLOAD wrapper on ch0 with `payload:{value}`. Station-only.
   */
  HUB_PROMPT_VOLUME: 1292,
} as const;

/**
 * Bound audio controls — the object returned by `dev.audio()`.
 *
 * Everything is DERIVED from `AUDIO_MEMBERS`. Which methods a device has depends on its FAMILY, so
 * every write is optional and a caller checks: a **camera/doorbell** gets `setMicrophone`/`setSpeaker`/
 * `setVolume`/`setAudioRecording` (+ `setRingtoneVolume` on a doorbell); a **HomeBase/station** gets
 * `setPromptVolume`. Alarm-output configuration belongs to the `siren` capability.
 */
export type AudioActions = Surface<typeof AUDIO_MEMBERS>;

/** Camera/doorbell audio write — the direct-binary 136-byte struct (signCode 8), wire-verified on T8214. */
function audioCommand(param: number, value: number, ctx: CommandContext): Command {
  return setScalar(param, value, ctx, "direct-binary");
}

/**
 * Where a product's bundle departs from `AudioRecordingOnOffParser` v1. `status`: T8200/T8201 send `1700`/1029
 * `{status}`, 1 = on, and read it on 2042. `flc`: the T8420's `AudioRecordingOnOffParser1366`. `plain`: T8441/T8442
 * keep 6012 standalone but send `record_mute` NOT inverted on a HomeBase. `plainEnable`: T8452/T8453 send
 * `{record_mute, channel, enable}`, not inverted, on every topology. `null` withholds the setter: T81A0/T84A1 send
 * 1288 inside `1700` `param_data`, which no SDK shape carries, and the T8790 bundle builds no command.
 */
const AUDIO_RECORDING_BUNDLE: Readonly<Record<string, "status" | "flc" | "plain" | "plainEnable" | null>> = {
  T8200: "status",
  T8201: "status",
  T8420: "flc",
  T8441: "plain",
  T8442: "plain",
  T8452: "plainEnable",
  T8453: "plainEnable",
  T81A0: null,
  T84A1: null,
  T8790: null,
};
const audioRecordingBundle = (ctx: AvailabilityContext) => AUDIO_RECORDING_BUNDLE[ctx.model ?? ""];
/** v1's connect-type split, which `plain` keeps: a standalone camera sends and reads 6012 `{enable}`. */
const sendsEnable = (ctx: AvailabilityContext) => {
  const bundle = audioRecordingBundle(ctx);
  return !ctx.homeBaseAttached && (bundle === undefined || bundle === "plain");
};

/**
 * Audio recording as `AudioRecordingOnOffParser` v1 sends it, its connect type deciding: `1700`/6012 `{enable}`
 * when the camera stands alone, 1288 `{channel, record_mute}` inverted when it hangs off a HomeBase. The other
 * {@link AUDIO_RECORDING_BUNDLE} wires are bundle-only, so the member is `unverifiedFor` them.
 */
function audioRecordingCommand(on: boolean, ctx: CommandContext): Command {
  if (sendsEnable(ctx)) return setJson(AUDIO_CMD.AUDIO_RECORDING_STANDALONE, { enable: on ? 1 : 0 }, ctx);
  return setPayload(
    AUDIO_CMD.AUDIO_RECORDING,
    { channel: ctx.channel, record_mute: on ? 0 : 1 },
    ctx,
    0,
    undefined,
    "auto",
  );
}

/**
 * Every general audio feature, declared once and family-gated across cameras, doorbells, and HomeBases.
 *
 * Camera side (Doorbell T8214): outer-cmd = the param id
 * (1240/1241/1230/1708), signCode 8, device channel, 168B→136B direct-binary struct
 * `[u32 channel][u32 value][account_id pad→128]`; polarity is 1=on. HomeBase prompt volume `1292`
 * rides the `1350` SET_PAYLOAD wrapper on channel 0 with `payload:{value}` and is not cloud-reflected.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const AUDIO_MEMBERS = {
  /**
   * A SWITCH, not a mute: `true` powers the mic, so the polarity reads the same way round on the wire
   * (1 = on) with no `invert`. Camera-family only — a HomeBase has no microphone, so the getter and
   * setter are both absent there and a caller must check.
   */
  microphone: {
    param: AUDIO_CMD.AUDIO_MICROPHONE,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    available: (ctx: AvailabilityContext) => isCameraCodec(ctx) && described("microphone_on_off")(ctx),
    description: "Microphone on/off (1240 AUDIO_MICROPHONE_SWITCH; 1=on/0=off). Wire verified live on T8214.",
    write: (v, ctx) => audioCommand(AUDIO_CMD.AUDIO_MICROPHONE, asBool(v) ? 1 : 0, ctx),
  },
  /**
   * The camera's own speaker switch — what talkback and the doorbell's responses play out of. Distinct
   * from `volume`, which sets how loud it is: turning this off silences the camera whatever the level
   * says. Camera-family only, like `microphone` above; HomeBase voice prompts use `promptVolume`.
   */
  speaker: {
    param: AUDIO_CMD.AUDIO_SPEAKER,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    available: (ctx: AvailabilityContext) => isCameraCodec(ctx) && described("speaker_on_off")(ctx),
    description: "Speaker on/off (1241 AUDIO_SPEAKER_SWITCH; 1=on/0=off). Wire verified live on T8214.",
    write: (v, ctx) => audioCommand(AUDIO_CMD.AUDIO_SPEAKER, asBool(v) ? 1 : 0, ctx),
  },
  /**
   * `volume` is the accessor a caller sees; the flat property has to be `speakerVolume` because three
   * capabilities claim `volume`. Both names reach the same write through the intent path.
   */
  volume: {
    param: AUDIO_CMD.SPEAKER_VOLUME,
    property: "speakerVolume",
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "verified",
    available: (ctx: AvailabilityContext) => isCameraCodec(ctx) && described("speaker_volume")(ctx),
    min: 0,
    max: 100,
    intentNames: ["volume"],
    description:
      "Speaker volume 0..100 (1230 DOORBELL_AUDIO_VOLUME). Write verified live on T8214 (set 60 → param 60).",
    write: (v, ctx) => audioCommand(AUDIO_CMD.SPEAKER_VOLUME, Number(v), ctx),
  },
  /** Raw 1288 is `record_mute` (1 = recording OFF), so audioRecording = NOT record_mute; 6012 and 1366 per the write. */
  audioRecording: {
    param: AUDIO_CMD.AUDIO_RECORDING,
    type: "bool",
    kind: "boolean",
    invert: true,
    invertFor: (ctx) => (audioRecordingBundle(ctx)?.startsWith("plain") ? false : undefined),
    readAvailable: (ctx) => !["status", "flc"].includes(audioRecordingBundle(ctx) ?? ""),
    readAliases: [
      { paramType: 2042, invert: false, available: (ctx) => audioRecordingBundle(ctx) === "status" },
      { paramType: AUDIO_CMD.AUDIO_RECORDING_STANDALONE, available: sendsEnable },
      {
        paramType: AUDIO_CMD.AUDIO_RECORDING_FLC,
        invert: true,
        available: (ctx) => audioRecordingBundle(ctx) === "flc",
      },
    ],
    provenance: "apk",
    unverifiedFor: (ctx) => audioRecordingBundle(ctx) != null && !sendsEnable(ctx),
    available: (ctx: AvailabilityContext) =>
      isCameraCodec(ctx) && described("audio_recording_on_off")(ctx) && audioRecordingBundle(ctx) !== null,
    description:
      "Record audio with video. HomeBase-attached: 1350/1288 `{channel, record_mute}` (inverted). " +
      "Standalone: 1700/6012 `{enable}`. The other AUDIO_RECORDING_BUNDLE wires are read, not written.",
    write: (v, ctx) => audioRecordingCommand(asBool(v), ctx),
  },
  /**
   * Doorbell ring/chime loudness — WRITE-ONLY here on purpose. The READ property `ringtoneVolume` (1708)
   * lives on the `doorbell` capability: 1708 leaks onto non-doorbell cameras, so it cannot be an `audio`
   * property (which spans all cameras) without over-surfacing junk. Audio owns the write.
   */
  ringtoneVolume: {
    param: AUDIO_CMD.DOORBELL_RINGTONE_VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    writeOnly: true,
    provenance: "verified",
    available: (ctx: AvailabilityContext) => hasCapability(ctx, "doorbell") && !isUntriedDoorbell(ctx),
    min: 0,
    max: 100,
    description: "Doorbell ring/chime volume 0..100 (1708 DOORBELL_RINGTONE_VOLUME). Wire verified live on T8214.",
    write: (v, ctx) => audioCommand(AUDIO_CMD.DOORBELL_RINGTONE_VOLUME, Number(v), ctx),
  },
  /** HomeBase voice-prompt volume uses the 1350 SET_PAYLOAD wrapper on channel 0 and has no cloud readback. */
  promptVolume: {
    param: AUDIO_CMD.HUB_PROMPT_VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    writeOnly: true,
    provenance: "verified",
    available: isHomeBase,
    min: 0,
    max: 100,
    description: "HomeBase voice-prompt volume 0..100 (1292 APP_CMD_SET_PROMPT_VOLUME). Verified audible on a T8030.",
    write: (v, ctx) => setPayload(AUDIO_CMD.HUB_PROMPT_VOLUME, { value: Number(v) }, ctx),
  },
} as const satisfies Members;

export const AUDIO: CapabilityModule = {
  capability: "audio",
  description:
    "Audio/volume controls, family-gated: camera/doorbell mic (1240) / speaker (1241) / volume (1230) " +
    "+ doorbell ringtone volume (1708); HomeBase voice-prompt volume (1292).",
  members: AUDIO_MEMBERS,
  properties: propertiesOf(AUDIO_MEMBERS),
  // Cameras/doorbells: proven by the mic/speaker switch params (NOT 1230 alone — the hub reports 1230
  // too). The HomeBase family gets `audio` too (it has a speaker: alarm + voice prompts) — but gated on
  // the HOMEBASE deviceTypes, NOT the whole `station` codec: NVRs (S4 Max / PoE NVR) are also `station`
  // yet have no speaker, so codec-detection would wrongly expose setAlarmVolume/setPromptVolume on them.
  detection: {
    evidenceParams: [AUDIO_CMD.AUDIO_MICROPHONE, AUDIO_CMD.AUDIO_SPEAKER],
    deviceTypes: [...HOMEBASE_TYPES],
  },
};
