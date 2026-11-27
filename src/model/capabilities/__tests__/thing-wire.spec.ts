import { readFileSync } from "node:fs";
import { VACUUM_DP, TUYA_VACUUM_DP, ModeCtrlMethod, ModeCtrlParamMethod } from "../vacuum-clean.js";
import { MOWER_DP } from "../mower.js";
import { CAMERA_CMD } from "../camera.js";
import { LIFE_PARAMS } from "../../life-params.js";
import type { SmartLightActions } from "../smart-light.js";
import type { CommandContext } from "../types.js";
import { bind } from "./bind.js";

type Wire = {
  via: string;
  dp?: number;
  method?: string;
  tag?: number;
  code?: string;
  cmd?: { id?: number };
  subCmd?: { id?: number };
};
type Wired = Record<string, { reads: Wire[]; writes: Wire[] }>;
const wire = (name: string): Wired =>
  JSON.parse(readFileSync(new URL(`fixtures/things/${name}.json`, import.meta.url), "utf8")).wire;

/**
 * The wire each fixture's settings bundle declares, against the wire the SDK already drives. An entry
 * asserted here is the bundle agreeing with a capture or a run on a real device; a fixture entry not
 * asserted here is a lead from the bundle alone (mower control and battery-status data points, the
 * radar's command codes, the second light-effect-mode tag, the camera's other commands).
 */
describe("the settings bundle's wire agrees with the wire the SDK drives", () => {
  it("vacuum: the work-status, clean-parameter, volume and battery data points, and the mode-control methods", () => {
    const w = wire("vacuum");
    expect(w.ecl_status_state!.reads).toContainEqual({ via: "dp", dp: VACUUM_DP.WORK_STATUS, path: "state" });
    expect(w.ecl_clean_param_fan_suction!.reads).toContainEqual(expect.objectContaining({ dp: VACUUM_DP.CLEAN_PARAM }));
    expect(w.ecl_voice!.reads).toContainEqual(expect.objectContaining({ dp: VACUUM_DP.VOLUME }));
    expect(w.ecl_status_battery!.reads).toContainEqual(expect.objectContaining({ dp: VACUUM_DP.BATTERY }));
    const sent = (method: number) => ({ via: "dp", dp: VACUUM_DP.MODE_CTRL, method: String(method) });
    expect(w.ecl_start_go_home!.writes).toContainEqual(sent(ModeCtrlMethod.START_GOHOME));
    expect(w.ecl_start_auto_clean!.writes).toContainEqual(sent(ModeCtrlParamMethod.AUTO.method));
    expect(w.ecl_start_room_clean!.writes).toContainEqual(sent(ModeCtrlParamMethod.SELECT_ROOMS.method));
  });

  it("legacy vacuum: mode, run, go-home and suction on the classic data points", () => {
    const w = wire("vacuum-legacy");
    expect(w.ecl_start_auto_clean!.writes).toContainEqual(expect.objectContaining({ dp: TUYA_VACUUM_DP.MODE }));
    expect(w.ecl_stop_clean!.writes).toContainEqual(expect.objectContaining({ dp: TUYA_VACUUM_DP.PLAY_PAUSE }));
    expect(w.ecl_start_go_home!.writes).toContainEqual(expect.objectContaining({ dp: TUYA_VACUUM_DP.GO_HOME }));
    expect(w.ecl_update_suction!.writes).toContainEqual(
      expect.objectContaining({ dp: TUYA_VACUUM_DP.CLEANING_STRENGTH }),
    );
  });

  it("mower: battery, volume and child lock", () => {
    const w = wire("mower");
    expect(w.ecl_mow_get_power_level!.reads).toContainEqual({ via: "dp", dp: MOWER_DP.BATTERY });
    expect(w.ecl_mow_get_volume!.reads).toContainEqual({ via: "dp", dp: MOWER_DP.VOLUME });
    expect(w.ecl_mow_set_volume!.writes).toContainEqual({ via: "dp", dp: MOWER_DP.VOLUME });
    expect(w.ecl_mow_get_children_lock!.reads).toContainEqual({ via: "dp", dp: MOWER_DP.CHILD_LOCK });
  });

  it("smart light: the status-report tags and the command codes the capability sends", async () => {
    const w = wire("smartlight");
    for (const id of ["spotlight_switch", "device_light_brightness", "light_length", "light_effect_mode"])
      expect(w[id]!.reads.some((r) => r.via === "tlv" && LIFE_PARAMS[r.tag!] !== undefined)).toBe(true);
    const ctx: CommandContext = { channel: 0, codec: "light", paramIds: new Set<number>() };
    const { acts, sent } = bind<SmartLightActions>("smart_light", ctx);
    await acts.on!();
    await acts.refreshState!();
    const code = (id: string) => Number(w[id]!.writes.find((x) => x.via === "mqtt")!.code);
    expect(sent.map((c) => (c as { cmdCode?: number }).cmdCode)).toEqual([
      code("light_on_off"),
      code("get_device_info"),
    ]);
  });

  it("camera: night vision read from and written through its commands", () => {
    const w = wire("security").nightvision_type!;
    const reads = w.reads.map((r) => r.cmd?.id);
    expect(reads).toEqual(expect.arrayContaining([CAMERA_CMD.NIGHT_VISION_TYPE, CAMERA_CMD.IC_NIGHT_VISION_TYPE]));
    expect(w.writes.some((x) => x.subCmd?.id === CAMERA_CMD.NIGHT_VISION_TYPE)).toBe(true);
  });
});
