import { setScalar, setJson, setJsonRaw, setStationScalar } from "../access.js";
import { frameCommand } from "../bundle.js";
import { CAMERA_CMD } from "../camera.js";
import { LIGHT_CMD } from "../light.js";
import type { CommandContext } from "../types.js";

const ctx = (channel = 0): CommandContext => ({ channel, codec: "camera", paramIds: new Set<number>() });

describe("command intent builders", () => {
  it("state stationAccount on the ids the app's legacy direct sender writes, never on a bundle frame", () => {
    expect(setScalar(1230, 40, ctx(3))).toMatchObject({ stationAccount: true });
    expect(setStationScalar(1235, 44, 255)).toMatchObject({ stationAccount: true });
    expect(setJsonRaw(1271, {}, ctx(3))).toMatchObject({ stationAccount: true });
    expect(setStationScalar(1224, 1, 255), "esiotkit's house mode").not.toHaveProperty("stationAccount");
    const frame = { cmd: 1230, body: "groupA", channel: "$channel", payload: { value: "$value" }, valueKey: "value" };
    expect(frameCommand(frame, 40, ctx(3))).toEqual({ kind: "set-param", param: 1230, value: 40, channel: 3 });
  });

  describe("setScalar", () => {
    it("builds the group-A scalar, or the bare pair with int-pair", () => {
      expect(setScalar(CAMERA_CMD.CAMERA_ENABLE, 1, ctx(2))).toEqual({
        kind: "set-param",
        param: CAMERA_CMD.CAMERA_ENABLE,
        value: 1,
        channel: 2,
      });
      expect(setScalar(LIGHT_CMD.SPOTLIGHT_BRIGHTNESS, 50, ctx(), "int-pair")).toMatchObject({ form: "int-pair" });
    });
  });

  describe("setJson", () => {
    it("builds a set-json intent carrying the control payload", () => {
      expect(setJson(LIGHT_CMD.FLOODLIGHT_SWITCH, { time: 0, type: 2, value: 1 }, ctx(1))).toEqual({
        kind: "set-json",
        param: LIGHT_CMD.FLOODLIGHT_SWITCH,
        data: { time: 0, type: 2, value: 1 },
        channel: 1,
      });
    });
  });
});
