import { describe, expect, it } from "vitest";
import { CAMERA_CMD, type CameraActions } from "../camera.js";
import { buildCommand } from "../index.js";
import { DeviceType } from "../../device-types.js";
import { Device } from "../../device.js";
import type { CommandContext } from "../types.js";
import { bind } from "./bind.js";
import { CameraDisabledError, commandObservation, type MediaProvider } from "../../../core/contracts.js";
import { unreflectedMembers } from "../members.js";
import { parseThingsList } from "../thing-description.js";

// The product's settings-bundle data, synthetic: the spec is about the code, not the shipped data.
vi.mock("../../../model/capabilities/bundle-wires.generated.json", async () => {
  const f = await import("../../../model/capabilities/__tests__/bundle-fixture.js");
  return f.bundleData("T8410", { camera_on_off: f.power() });
});

const things = parseThingsList({
  things_list: [
    {
      profile: { product_code: "T8410" },
      properties: [{ identifier: "camera_on_off", data_type: { type: "bool", specs: { defaultValue: "1" } } }],
    },
  ],
}).T8410!;

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
  things,
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
    expect(unreflectedMembers(acts), "the bundle reads the 6250 it writes").toEqual([]);
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

  it.each([true, false])(
    "reads a reported 1035 (%s) as nothing: the bundle reads 6250, the default standing",
    (enabled) => {
      const device = Device.fromRecord("T8410P0000000000", {
        deviceType: DeviceType.INDOOR_PT_CAMERA,
        model: "T8410",
        category: "eufy_security",
        parentSn: "T8030P0000000000",
        params: { 1035: enabled ? "1" : "0" },
        things,
      });
      device.bindActions(context(), { dispatch: async () => {} });
      expect(device.camera?.()?.enabled).toBe(true);
      expect(unreflectedMembers(device.camera?.()!)).toEqual([]);
    },
  );

  it("refuses media wherever the enabled reading is false", async () => {
    const media: MediaProvider = {
      snapshotLive: async () => ({ jpeg: Buffer.from("jpeg"), width: 1, height: 1 }),
      live: async () => ({}) as never,
      record: async () => Buffer.alloc(0),
    };
    const read = () => ({ value: false });
    const attached = bind<CameraActions>("camera", context(), { media, read }).acts;
    await expect(attached.snapshotLive!()).rejects.toBeInstanceOf(CameraDisabledError);
    const reflected = bind<CameraActions>("camera", context({ paramIds: new Set([CAMERA_CMD.CAMERA_ENABLE, 2001]) }), {
      media,
      read,
    }).acts;
    await expect(reflected.snapshotLive!()).rejects.toBeInstanceOf(CameraDisabledError);
  });
});
