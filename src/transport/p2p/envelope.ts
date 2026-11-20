/**
 * P2P **envelope / routing command IDs** the command-router itself issues on the wire — the
 * transport-side counterpart to the capability layer's feature ids (declared inline per capability in
 * `model/capabilities/*.ts` as `CAMERA_CMD` / `LIGHT_CMD` / …). These two subsets are disjoint: a
 * capability never names an envelope, and the router never names a feature (it forwards `cmd.param`
 * opaquely), so `model/` and `transport/` share no command vocabulary and neither imports the other.
 *
 * The full id→name catalog ({@link CommandType}) + `commandName()` lookup live in `./commands.ts`;
 * only the handful the router drives directly are named here.
 */
export const P2P_ENVELOPE = {
  /** SET_PAYLOAD wrapper — `{account_id,cmd,mChannel,mValue3,payload}` envelope. */
  SET_PAYLOAD: 1350,
  /** Generic control wrapper — bare `{commandType,data}` (NOT doorbell-specific despite the name). */
  CONTROL_PAYLOAD: 1700,
  /** GET_CAMERA_INFO param-list query. */
  GET_CAMERA_INFO: 1103,
  /**
   * Rename a device (app `SET_DEVICE_NAME`): outer-cmd 1217, signCode 8, on the STATION channel 255. Body is a 261-byte struct
   * `[u32=0][u8 device_channel][name→pad128][account_id→pad128]`. **P2P-only** — the HomeBase
   * propagates the name to the cloud. See `buildStringBody`.
   */
  SET_DEVICE_NAME: 1217,
  /**
   * Rename a station/HomeBase (app `SET_HUB_NAME`), cmd 1216 — same struct/transport as
   * {@link SET_DEVICE_NAME}; the HomeBase propagates the new name to the cloud.
   */
  SET_HUB_NAME: 1216,
  /**
   * Restart a HomeBase (app `RESTART_HUB`), as captured from the app's own Restart. A station-scalar: level-2 signCode
   * 8 on the broadcast channel 255, body `[u32 value][account_id padded]` ({@link buildDirectBinaryBody}
   * with no channel), value `0`. NOT a `1350`/`1700` envelope and NOT an empty frame.
   *
   * ☠️ Neighbours are destructive: 1036 = `APP_CMD_HUB_TO_FACTORY`, 1037 = `APP_CMD_DEVS_TO_FACTORY`.
   * A slip of two here factory-resets the hub. Do not probe nearby ids.
   */
  RESTART_HUB: 1034,
} as const;
