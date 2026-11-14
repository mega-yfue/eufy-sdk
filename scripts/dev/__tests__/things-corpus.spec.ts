import { extractBundle } from "../things-corpus.ts";

/** Synthetic minified snippets, one per shape the bundles use. Constants and numbers are made up. */
const SECURITY =
  "var P={SET_PAYLOAD:1350,NIGHT_VISION_TYPE:1277,DUP:1,ALARM_MODE:9};var Q={DUP:2};" +
  'class A extends B{getIdentify(){return"nightvision_type"}getCommandIds(){return[P.NIGHT_VISION_TYPE]}' +
  'set(e){switch(v){case"v1":return{cmd:P.SET_PAYLOAD,subCmd:P.NIGHT_VISION_TYPE}}}}' +
  'class C extends B{}const _={[P.ALARM_MODE]:"arming_selected_mode"};' +
  'switch(o){case"led_on_off":i={cmd:P.DUP,params:{}};break;}';
const VACUUM =
  'this.map={153:{ecl_status_state:"state"},154:{ecl_clean_param_fan_suction:"cleanParam.fan.suction"}};' +
  'switch(e){case"ecl_start_go_home":return this.handleEclStartGoHome(t);}' +
  'handleEclStartGoHome(e){e=s.encodeModeCtrlRequest(6,{seq:e});return this.finishControlCommand({binaryData:e},"152")}handleNext(e){}' +
  'switch(a){case"ecl_find_me":n.binaryData=!0,n.dp="103";break;}';
const MOWER =
  'var e={ECL_MOW_SET_VOLUME:"ecl_mow_set_volume"},i={ECL_MOW_GET_VOLUME:"ecl_mow_get_volume",ECL_MOW_BATTERY_STATE:"ecl_mow_battery_state"};' +
  'n={[e.ECL_MOW_SET_VOLUME]:"26"},a={26:i.ECL_MOW_GET_VOLUME,8:i.X},p={108:{[i.ECL_MOW_BATTERY_STATE]:"state"}};';
const LIGHT =
  'var n={LIGHT_ON_OFF:"light_on_off"},s={LIGHT_LENGTH:"light_length"},a={EVENT_STATUS:"event_status"},C={A3:163};' +
  'i={[n.LIGHT_ON_OFF]:"0x0201",[a.EVENT_STATUS]:"0x0204"};t.hasKey(C.A3)&&(r=t.getIntParam(C.A3),_[s.LIGHT_LENGTH]=r);';

test("security: parser class, command table, inline case, ambiguous constant by name", () => {
  const out = extractBundle(SECURITY, new Set(["nightvision_type", "led_on_off", "arming_selected_mode"]));
  expect(out.arming_selected_mode!.reads).toEqual([{ via: "p2p", cmd: { name: "ALARM_MODE", id: 9 } }]);
  expect(out.nightvision_type).toEqual({
    reads: [{ via: "p2p", cmd: { name: "NIGHT_VISION_TYPE", id: 1277 } }],
    writes: [{ via: "p2p", cmd: { name: "SET_PAYLOAD", id: 1350 }, subCmd: { name: "NIGHT_VISION_TYPE", id: 1277 } }],
    versions: ["v1"],
  });
  expect(out.led_on_off!.writes).toEqual([{ via: "p2p", cmd: { name: "DUP" } }]);
});

test("vacuum: data-point read map, handler write with its method, inline data-point write", () => {
  const out = extractBundle(
    VACUUM,
    new Set(["ecl_status_state", "ecl_clean_param_fan_suction", "ecl_start_go_home", "ecl_find_me"]),
  );
  expect(out.ecl_clean_param_fan_suction!.reads).toEqual([{ via: "dp", dp: 154, path: "cleanParam.fan.suction" }]);
  expect(out.ecl_start_go_home!.writes).toEqual([{ via: "dp", dp: 152, method: "6" }]);
  expect(out.ecl_find_me!.writes).toEqual([{ via: "dp", dp: 103, value: "!0" }]);
});

test("mower: enum tables for action and property data points, computed-key path map", () => {
  const out = extractBundle(MOWER, new Set(["ecl_mow_set_volume", "ecl_mow_get_volume", "ecl_mow_battery_state"]));
  expect(out.ecl_mow_set_volume!.writes).toEqual([{ via: "dp", dp: 26 }]);
  expect(out.ecl_mow_get_volume!.reads).toEqual([{ via: "dp", dp: 26 }]);
  expect(out.ecl_mow_battery_state!.reads).toEqual([{ via: "dp", dp: 108, path: "state" }]);
});

test("light: MQTT command code write, event code read, TLV tag read", () => {
  const out = extractBundle(LIGHT, new Set(["light_on_off", "light_length", "event_status"]));
  expect(out.event_status).toEqual({ reads: [{ via: "mqtt", code: "0x0204" }], writes: [], versions: [] });
  expect(out.light_on_off!.writes).toEqual([{ via: "mqtt", code: "0x0201" }]);
  expect(out.light_length!.reads).toEqual([{ via: "tlv", tag: 163 }]);
});

test("an identifier the description does not list is not extracted", () => {
  expect(Object.keys(extractBundle(VACUUM, new Set(["ecl_find_me"])))).toEqual(["ecl_find_me"]);
});
