import { describe, expect, it } from "vitest";
import { CAMERA_CMD, CAMERA_MEMBERS, type CameraActions } from "../camera.js";
import { buildCommand } from "../index.js";
import { DeviceType } from "../../device-types.js";
import { Device } from "../../device.js";
import type { CommandContext } from "../types.js";
import { bind } from "./bind.js";
import { CameraDisabledError, commandObservation, type MediaProvider } from "../../../core/contracts.js";
import { unreflectedMembers } from "../members.js";

const context = (extra: Partial<CommandContext> = {}): CommandContext => ({
  codec: "camera",
  deviceType: DeviceType.INDOOR_PT_CAMERA,
  model: "T8410",
  channel: 3,
  homeBaseAttached: true,
  stationSerial: "T8030P0000000000",
  firmwareVersion: "2.3.1.0",
  paramIds: new Set([CAMERA_CMD.CAMERA_ENABLE]),
  capabilities: new Set(["camera"]),
  ...extra,
});

describe("indoor camera power on HomeBase 3", () => {
  it.each([true, false])("wraps enabled=%s with the disable-bit switch and camera channel", (enabled) => {
    expect(buildCommand("enabled", enabled, context())).toEqual({
      kind: "set-payload",
      cmd: 6250,
      payload: { switch: enabled ? 0 : 1 },
      channel: 3,
      mValue3: 0,
      form: undefined,
    });
  });

  it("routes the bound setter and on/off aliases through the same payload", async () => {
    const { acts, sent } = bind<CameraActions>("camera", context());
    await acts.setEnabled(false);
    await acts.on();
    await acts.off();
    expect(sent.map((command) => command.kind)).toEqual(["set-payload", "set-payload", "set-payload"]);
    expect(sent).toMatchObject([{ payload: { switch: 1 } }, { payload: { switch: 0 } }, { payload: { switch: 1 } }]);
    expect(sent.map(commandObservation)).toEqual([undefined, undefined, undefined]);
    expect(unreflectedMembers(acts)).toEqual(["enabled"]);
  });

  it.each(["2.3.1", "2.3.1.1", "2.3.10.0", "2.4.0.0", "3.0.0.0"])("accepts firmware %s", (firmwareVersion) => {
    expect(buildCommand("enabled", false, context({ firmwareVersion }))).toMatchObject({ kind: "set-payload" });
  });

  it.each(["2.3.0.9", "2.2.9.9", "1.9.9.9", undefined, "", "unknown"])(
    "retains the scalar route for firmware %s",
    (firmwareVersion) => {
      expect(buildCommand("enabled", false, context({ firmwareVersion }))).toMatchObject({
        kind: "set-param",
        param: CAMERA_CMD.CAMERA_ENABLE,
        value: 0,
        channel: 3,
      });
    },
  );

  it.each([
    { homeBaseAttached: false },
    { homeBaseAttached: undefined },
    { stationSerial: undefined },
    { stationSerial: "T8010P0000000000" },
    { deviceType: DeviceType.INDOOR_COST_DOWN_CAMERA },
    { deviceType: DeviceType.INDOOR_PT_CAMERA_S350 },
    { deviceType: DeviceType.CAMERA2 },
  ])("retains the scalar route for an unrelated or unknown topology/family %j", (extra) => {
    expect(buildCommand("enabled", false, context(extra))).toMatchObject({ kind: "set-param" });
  });

  it.each([true, false])(
    "retains the startup enabled=%s reading without treating it as privacy-write confirmation",
    (enabled) => {
      expect(CAMERA_MEMBERS.enabled.observation.reflects(enabled, context())).toBeUndefined();
      const device = Device.fromRecord("T8410P0000000000", {
        deviceType: DeviceType.INDOOR_PT_CAMERA,
        model: "T8410",
        category: "eufy_security",
        parentSn: "T8030P0000000000",
        params: { [CAMERA_CMD.CAMERA_ENABLE]: enabled ? "1" : "0" },
      });
      expect(device.getProperty("enabled")?.value).toBe(enabled);
      device.bindActions(context(), { dispatch: async () => {} });
      expect(device.camera?.()?.enabled).toBe(enabled);
    },
  );

  it.each(["0", "1", "false", "true"])("decodes raw 1035=%s on the affected topology", (raw) => {
    const device = Device.fromRecord("T8410P0000000000", {
      deviceType: DeviceType.INDOOR_PT_CAMERA,
      model: "T8410",
      category: "eufy_security",
      parentSn: "T8030P0000000000",
      params: { 1035: raw },
    });
    expect(device.getProperty("enabled")?.value).toBe(raw === "1" || raw === "true");
    device.applyParams({ 1035: raw === "1" || raw === "true" ? "0" : "1" });
    expect(device.getProperty("enabled")?.value).toBe(raw === "0" || raw === "false");
  });

  it.each([
    { model: "T8410", parentSn: undefined },
    { model: "T8410", parentSn: "T8010P0000000000" },
    { model: "T8114", parentSn: "T8030P0000000000" },
    { model: "T8425", parentSn: "T8030P0000000000" },
    { model: "T8415", parentSn: "T8030P0000000000" },
  ])("retains the default read polarity outside T8410/HomeBase 3 %j", (extra) => {
    const device = Device.fromRecord("SN", {
      deviceType: DeviceType.INDOOR_PT_CAMERA,
      category: "eufy_security",
      params: { 1035: "0" },
      ...extra,
    });
    expect(device.getProperty("enabled")?.value).toBe(true);
  });

  it("adopts the corrected polarity when the covering station arrives on a later record", () => {
    const record = {
      deviceType: DeviceType.INDOOR_PT_CAMERA,
      model: "T8410",
      category: "eufy_security",
      params: { 1035: "1" },
    };
    const device = Device.fromRecord("T8410P0000000000", record);
    expect(device.getProperty("enabled")?.value).toBe(false);
    const attached = { ...record, parentSn: "T8030P0000000000" };
    expect(device.reresolve(attached)).toEqual([]);
    device.applyParams(attached.params);
    expect(device.getProperty("enabled")?.value).toBe(true);
  });

  it.each([true, false])("keeps attached polarity when a partial record restates the model=%s", (restatesModel) => {
    const record = {
      deviceType: DeviceType.INDOOR_PT_CAMERA,
      model: "T8410",
      category: "eufy_security",
      parentSn: "T8030P0000000000",
      params: { 1035: "1" },
    };
    const device = Device.fromRecord("T8410P0000000000", record);
    device.bindActions(context(), { dispatch: async () => {} });
    const properties = device.properties;
    const partial = {
      deviceType: record.deviceType,
      model: restatesModel ? record.model : undefined,
      params: record.params,
    };
    device.reresolve(partial);
    device.applyParams(partial.params);
    expect(device.stationSn).toBe(record.parentSn);
    expect(device.properties).toBe(properties);
    expect(device.getProperty("enabled")?.value).toBe(true);
    expect(device.camera?.()?.enabled).toBe(true);
  });

  it("keeps the direct OPEN_DEVICE readback when reported", () => {
    const ctx = context({ paramIds: new Set([1035, 2001]) });
    expect(CAMERA_MEMBERS.enabled.observation.reflects(false, ctx)).toEqual({
      param: 2001,
      expected: false,
      observed: false,
    });
    const { acts } = bind<CameraActions>("camera", ctx);
    expect(unreflectedMembers(acts)).toEqual([]);
  });

  it("keeps scalar-route write confirmation and trusted reads", () => {
    const ctx = context({ firmwareVersion: "2.2.9.0" });
    expect(CAMERA_MEMBERS.enabled.observation.reflects(true, ctx)).toEqual({
      param: 1035,
      expected: 1,
      observed: true,
    });
    const { acts } = bind<CameraActions>("camera", ctx);
    expect(unreflectedMembers(acts)).toEqual([]);
  });

  it("does not refuse a live pull based on the unreflected power bit", async () => {
    const media: MediaProvider = {
      snapshotLive: async () => ({ jpeg: Buffer.from("jpeg"), width: 1, height: 1 }),
      live: async () => ({}) as never,
      record: async () => Buffer.alloc(0),
    };
    const read = () => ({ value: false });
    const unreflected = bind<CameraActions>("camera", context(), { media, read }).acts;
    expect((await unreflected.snapshotLive!()).jpeg).toEqual(Buffer.from("jpeg"));
    const reflected = bind<CameraActions>("camera", context({ firmwareVersion: "2.2.9.0" }), { media, read }).acts;
    await expect(reflected.snapshotLive!()).rejects.toBeInstanceOf(CameraDisabledError);
  });

  it("does not invent an enablement readback from a privacy-only report", () => {
    expect(CAMERA_MEMBERS.enabled.observation.reflects(false, context({ paramIds: new Set([6250]) }))).toBeUndefined();
  });
});
