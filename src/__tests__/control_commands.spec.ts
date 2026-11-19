import { CAMERA_CMD } from "../model/capabilities/camera.js";
import { LIGHT_CMD } from "../model/capabilities/light.js";
import { AUDIO_CMD } from "../model/capabilities/audio.js";
import { SIREN_CMD } from "../model/capabilities/siren.js";
import { DOORBELL_CMD } from "../model/capabilities/doorbell.js";
import { PTZ_CMD } from "../model/capabilities/ptz.js";
import { P2P_ENVELOPE } from "../transport/p2p/envelope.js";
import { CommandType } from "../transport/p2p/commands.js";

/**
 * Guard the curated per-capability feature-command ids (`CAMERA_CMD`, `LIGHT_CMD`, `AUDIO_CMD`, …)
 * against the generated command catalog so a typo/mismatch can't slip in.
 */
describe("capability feature-command ids", () => {
  it("match the generated CommandType catalog", () => {
    expect(CAMERA_CMD.CAMERA_ENABLE).toBe(CommandType.CMD_DEVS_SWITCH);
    expect(LIGHT_CMD.SPOTLIGHT_BRIGHTNESS).toBe(CommandType.CMD_SET_FLOODLIGHT_BRIGHT_VALUE);
    expect(LIGHT_CMD.SPOTLIGHT_ENABLE).toBe(CommandType.CMD_SET_FLOODLIGHT_TOTAL_SWITCH);
    expect(LIGHT_CMD.SPOTLIGHT_COLOR_TEMP).toBe(CommandType.CMD_SET_LIGHT_CTRL_LAMP_VALUE);
    expect(LIGHT_CMD.FLOODLIGHT_SWITCH).toBe(CommandType.CMD_SET_FLOODLIGHT_MANUAL_SWITCH);
    expect(PTZ_CMD.PTZ_ROTATE).toBe(CommandType.CMD_INDOOR_ROTATE);
    expect(CAMERA_CMD.PRIVACY_MODE).toBe(CommandType.CMD_INDOOR_ENABLE_PRIVACY_MODE_S350);
    expect(DOORBELL_CMD.QUICK_RESPONSE).toBe(CommandType.CMD_BAT_DOORBELL_QUICK_RESPONSE);
    expect(CAMERA_CMD.DOORBELL_LED).toBe(CommandType.CMD_BAT_DOORBELL_SET_LED_ENABLE);
    expect(AUDIO_CMD.AUDIO_MICROPHONE).toBe(CommandType.CMD_SET_DEV_MIC_MUTE);
    expect(AUDIO_CMD.AUDIO_SPEAKER).toBe(CommandType.CMD_SET_DEV_SPEAKER_MUTE);
    expect(AUDIO_CMD.SPEAKER_VOLUME).toBe(CommandType.CMD_SET_DEV_SPEAKER_VOLUME);
    expect(AUDIO_CMD.DOORBELL_RINGTONE_VOLUME).toBe(CommandType.CMD_BAT_DOORBELL_SET_RINGTONE_VOLUME);
    expect(SIREN_CMD.HUB_SPK_VOLUME).toBe(CommandType.CMD_SET_HUB_SPK_VOLUME);
    expect(SIREN_CMD.HOMEBASE_TONE).toBe(CommandType.CMD_SET_TONE_FILE);
    expect(SIREN_CMD.CAMERA_TONE).toBe(CommandType.CMD_SET_DEVS_TONE_FILE);
    expect(AUDIO_CMD.HUB_PROMPT_VOLUME).toBe(CommandType.CMD_SET_PROMPT_VOLUME);
    expect(AUDIO_CMD.AUDIO_RECORDING).toBe(CommandType.CMD_SET_AUDIO_MUTE_RECORD);
  });

  it("have the expected literal values", () => {
    expect(CAMERA_CMD.CAMERA_ENABLE).toBe(1035);
    expect(LIGHT_CMD.SPOTLIGHT_BRIGHTNESS).toBe(1401);
    expect(LIGHT_CMD.SPOTLIGHT_ENABLE).toBe(1403);
    expect(LIGHT_CMD.SPOTLIGHT_COLOR_TEMP).toBe(1410);
    expect(P2P_ENVELOPE.SET_PAYLOAD).toBe(1350);
    expect(P2P_ENVELOPE.GET_CAMERA_INFO).toBe(1103);
    expect(P2P_ENVELOPE.CONTROL_PAYLOAD).toBe(1700);
    expect(DOORBELL_CMD.QUICK_RESPONSE).toBe(1706);
    expect(DOORBELL_CMD.GET_QUICK_RESPONSE_LIST).toBe(6237);
    expect(CAMERA_CMD.DOORBELL_LED).toBe(1716);
    expect(AUDIO_CMD.AUDIO_MICROPHONE).toBe(1240);
    expect(AUDIO_CMD.AUDIO_SPEAKER).toBe(1241);
    expect(AUDIO_CMD.SPEAKER_VOLUME).toBe(1230);
    expect(AUDIO_CMD.DOORBELL_RINGTONE_VOLUME).toBe(1708);
    expect(SIREN_CMD.HUB_SPK_VOLUME).toBe(1235);
    expect(SIREN_CMD.HOMEBASE_TONE).toBe(1201);
    expect(SIREN_CMD.CAMERA_TONE).toBe(1202);
    expect(AUDIO_CMD.HUB_PROMPT_VOLUME).toBe(1292);
    expect(AUDIO_CMD.AUDIO_RECORDING).toBe(1288);
  });
});
