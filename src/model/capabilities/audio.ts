import { isUntriedDoorbell, isHomeBase, HOMEBASE_TYPES } from "../device-family.js";
import { setScalar, setPayload, isCameraCodec, hasCapability } from "./access.js";
import { described } from "./thing-description.js";
import { bundled } from "./bundle.js";
import { propertiesOf, type Members, type Surface } from "./members.js";
import type { AvailabilityContext, CapabilityModule, CommandContext } from "./types.js";
import type { Command } from "../../core/contracts.js";

/**
 * The P2P **feature-command ids** this audio capability drives — the outer-cmd IS the param id on the
 * camera side (direct-binary struct), or the inner cmd of a `1350` SET_PAYLOAD on the station side.
 * Capability-owned wire vocabulary (transport forwards `cmd.param` opaquely; full id→name catalog in
 * the generated `transport/p2p/commands.ts`). Wire shapes are in the module JSDoc below.
 */
export const AUDIO_CMD = {
  /** Microphone on/off (app `AUDIO_MICROPHONE_SWITCH`), 1 = on. */
  AUDIO_MICROPHONE: 1240,
  /** Speaker on/off (app `AUDIO_SPEAKER_SWITCH`), 1 = on. */
  AUDIO_SPEAKER: 1241,
  /** Speaker volume 0..100 (app `DOORBELL_AUDIO_VOLUME`). Same direct-binary wire. */
  SPEAKER_VOLUME: 1230,
  /** Audio recording (app `DOORBELL_AUDIO_RECORDING_SWITCH`), `{channel, record_mute}` in the `1350` envelope. */
  AUDIO_RECORDING: 1288,
  /**
   * Doorbell ringtone/chime volume 0..100 (app `DOORBELL_RINGTONE_VOLUME`): same direct-binary 136-byte struct, signCode 8. Doorbell-only: this capability adds it when
   * the device is a doorbell.
   */
  DOORBELL_RINGTONE_VOLUME: 1708,
  /**
   * HomeBase voice **prompt** volume 0..100 (app `APP_CMD_SET_PROMPT_VOLUME`): the `1350` SET_PAYLOAD wrapper on ch0 with `payload:{value}`. Station-only.
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

/** Camera/doorbell audio write — the direct-binary 136-byte struct (signCode 8). */
function audioCommand(param: number, value: number, ctx: CommandContext): Command {
  return setScalar(param, value, ctx, "direct-binary");
}

/** `microphone_on_off`, `speaker_on_off` and `audio_recording_on_off` as each product's settings bundle sends them. */
const MICROPHONE = bundled(["microphone_on_off"], AUDIO_CMD.AUDIO_MICROPHONE);
const SPEAKER = bundled(["speaker_on_off"], AUDIO_CMD.AUDIO_SPEAKER);
const RECORDING = bundled(["audio_recording_on_off"], AUDIO_CMD.AUDIO_RECORDING);

/**
 * Every general audio feature, declared once and family-gated across cameras, doorbells, and HomeBases.
 *
 * Camera side: the volumes (1230/1708) are a direct-binary `[u32 channel][u32 value][account_id pad→128]`;
 * the switches are written as the product's settings bundle sends them. HomeBase prompt volume `1292`
 * rides the `1350` SET_PAYLOAD wrapper on channel 0 with `payload:{value}` and is not cloud-reflected.
 *
 * Exported but NOT published: each entry states its wire id and its gate,
 * which the reference site does not carry.
 * @internal
 */
export const AUDIO_MEMBERS = {
  /** A switch, not a mute: `true` powers the mic. */
  microphone: {
    type: "bool",
    kind: "boolean",
    ...MICROPHONE,
    description: "Microphone on/off, as the product's settings bundle writes and reads it.",
  },
  /** The device's own speaker switch; distinct from `volume`, which sets how loud it is. */
  speaker: {
    type: "bool",
    kind: "boolean",
    ...SPEAKER,
    description: "Speaker on/off, as the product's settings bundle writes and reads it.",
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
    available: (ctx: AvailabilityContext) => isCameraCodec(ctx) && described("speaker_volume")(ctx),
    min: 0,
    max: 100,
    intentNames: ["volume"],
    description: "Speaker volume 0..100 (1230 DOORBELL_AUDIO_VOLUME).",
    write: (v, ctx) => audioCommand(AUDIO_CMD.SPEAKER_VOLUME, Number(v), ctx),
  },
  /** Record audio with video, written and read with each param's polarity as the product's bundle states it. */
  audioRecording: {
    type: "bool",
    kind: "boolean",
    ...RECORDING,
    description: "Record audio with video, as the product's settings bundle writes and reads it.",
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
    available: (ctx: AvailabilityContext) => hasCapability(ctx, "doorbell") && !isUntriedDoorbell(ctx),
    min: 0,
    max: 100,
    description: "Doorbell ring/chime volume 0..100 (1708 DOORBELL_RINGTONE_VOLUME).",
    write: (v, ctx) => audioCommand(AUDIO_CMD.DOORBELL_RINGTONE_VOLUME, Number(v), ctx),
  },
  /** HomeBase voice-prompt volume uses the 1350 SET_PAYLOAD wrapper on channel 0 and has no cloud readback. */
  promptVolume: {
    param: AUDIO_CMD.HUB_PROMPT_VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    writeOnly: true,
    available: isHomeBase,
    min: 0,
    max: 100,
    description: "HomeBase voice-prompt volume 0..100 (1292 APP_CMD_SET_PROMPT_VOLUME).",
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
