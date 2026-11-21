import { setScalar, setJson } from "../access.js";
import { CAMERA_CMD } from "../camera.js";
import { LIGHT_CMD } from "../light.js";
import type { CommandContext } from "../types.js";

const ctx = (channel = 0): CommandContext => ({ channel, codec: "camera", paramIds: new Set<number>() });

describe("command intent builders", () => {
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
