import { describe, expect, it } from "vitest";
import { CAMERA_CMD, type CameraActions } from "../camera.js";
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

describe("T8410 power on HomeBase 3", () => {
  it.each([true, false])("wraps enabled=%s with the inverse switch and camera channel", (enabled) => {
    const command = buildCommand("enabled", enabled, context());
    expect(command).toMatchObject({
      kind: "set-payload",
      cmd: 6250,
      payload: { switch: enabled ? 0 : 1 },
      channel: 3,
      mValue3: 0,
    });
    expect(commandObservation(command!)).toBeUndefined();
  });

  it("dispatches the bound setter and aliases without confirming against stale 1035", async () => {
    const { acts, sent } = bind<CameraActions>("camera", context());
    await acts.setEnabled!(false);
    await acts.on();
    await acts.off();
    expect(sent).toMatchObject([
      { kind: "set-payload", payload: { switch: 1 } },
      { kind: "set-payload", payload: { switch: 0 } },
      { kind: "set-payload", payload: { switch: 1 } },
    ]);
    expect(sent.map(commandObservation)).toEqual([undefined, undefined, undefined]);
    expect(unreflectedMembers(acts)).toEqual(["enabled"]);
  });

  it.each(["2.3.0.9", "unknown", undefined])(
    "sends 6250 whatever the firmware (%s), as its bundle does",
    (firmwareVersion) => {
      expect(buildCommand("enabled", true, context({ firmwareVersion }))).toMatchObject({
        kind: "set-payload",
        cmd: 6250,
      });
    },
  );

  it.each([true, false])("reads startup enabled=%s with the attached enable-bit polarity", (enabled) => {
    const device = Device.fromRecord("T8410P0000000000", {
      deviceType: DeviceType.INDOOR_PT_CAMERA,
      model: "T8410",
      category: "eufy_security",
      parentSn: "T8030P0000000000",
      params: { 1035: enabled ? "1" : "0" },
    });
    expect(device.getProperty("enabled")?.value).toBe(enabled);
    device.bindActions(context(), { dispatch: async () => {} });
    expect(device.camera?.()?.enabled).toBe(enabled);
    expect(unreflectedMembers(device.camera?.()!)).toEqual(["enabled"]);
  });

  it("does not refuse media based on the unreflected power bit", async () => {
    const media: MediaProvider = {
      snapshotLive: async () => ({ jpeg: Buffer.from("jpeg"), width: 1, height: 1 }),
      live: async () => ({}) as never,
      record: async () => Buffer.alloc(0),
    };
    const read = () => ({ value: false });
    const unreflected = bind<CameraActions>("camera", context(), { media, read }).acts;
    expect((await unreflected.snapshotLive!()).jpeg).toEqual(Buffer.from("jpeg"));
    const reflected = bind<CameraActions>("camera", context({ paramIds: new Set([CAMERA_CMD.CAMERA_ENABLE, 2001]) }), {
      media,
      read,
    }).acts;
    await expect(reflected.snapshotLive!()).rejects.toBeInstanceOf(CameraDisabledError);
  });
});
