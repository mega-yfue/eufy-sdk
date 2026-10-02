import { afterEach, describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import type { CommandContext } from "../../model/capabilities/types.js";
import { buildCommand } from "../../model/capabilities/index.js";
import { noopLogger } from "../../core/logger.js";
import { Device } from "../../model/device.js";
import { commandObservation, type Command } from "../../core/contracts.js";

afterEach(() => vi.restoreAllMocks());

describe("camera power context", () => {
  it.each(["parent_sn", "station_sn"])(
    "uses the resolved station when raw topology is carried by %s",
    async (stationKey) => {
      const info = vi.fn();
      const client = new EufyMega({ email: "t@example.com", password: "x", logger: { ...noopLogger, info } });
      const sn = "T8410P0000000000";
      const stationSn = "T8030P0000000000";
      const internal = client as any;
      vi.spyOn(internal.registry, "record").mockResolvedValue({
        deviceType: 31,
        model: "T8410",
        category: "eufy_security",
        parentSn: stationSn,
        params: { 1035: "0" },
      });
      vi.spyOn(internal.registry, "require").mockReturnValue({
        sn,
        category: "eufy_security",
        raw: { [stationKey]: stationSn, device_channel: 3, main_sw_version: "2.3.1.0" },
      });
      const ctx: CommandContext = await internal.commandContext(sn);
      expect(ctx).toMatchObject({
        stationSerial: stationSn,
        homeBaseAttached: true,
        firmwareVersion: "2.3.1.0",
        channel: 3,
      });
      expect(buildCommand("enabled", false, ctx)).toMatchObject({
        kind: "set-payload",
        cmd: 6250,
        payload: { switch: 1 },
        channel: 3,
      });
      expect(info).toHaveBeenCalledWith(
        "[context] T8410 power-v4 type=31 channel=3 stationModel=T8030 firmware=2.3.1.0 reported1035=0 reported2001=absent",
      );
      expect(info.mock.calls.flat().join(" ")).not.toContain(sn);
      expect(info.mock.calls.flat().join(" ")).not.toContain(stationSn);
    },
  );

  it.each([true, false])("retains scalar-route confirmation after requesting enabled=%s", async (enabled) => {
    const client = new EufyMega({ email: "t@example.com", password: "x" });
    const internal = client as any;
    const sn = "T8410P0000000000";
    const record = {
      deviceType: 31,
      model: "T8410",
      category: "eufy_security",
      parentSn: "T8030P0000000000",
      params: { 1035: enabled ? "0" : "1" },
    };
    const device = Device.fromRecord(sn, record);
    internal.liveDevices.set(sn, new WeakRef(device));
    vi.spyOn(internal.registry, "require").mockImplementation(() => record);
    const refresh = vi.spyOn(internal.registry, "refreshedList").mockImplementation(async () => {
      record.params[1035] = enabled ? "1" : "0";
      return [];
    });
    const cmd = buildCommand("enabled", enabled, {
      codec: "camera",
      model: "T8410",
      deviceType: 31,
      channel: 3,
      homeBaseAttached: true,
      stationSerial: record.parentSn,
      firmwareVersion: "2.2.9.0",
      paramIds: new Set([1035]),
      capabilities: new Set(["camera"]),
    });
    expect(cmd).toMatchObject({ kind: "set-param", param: 1035, value: enabled ? 1 : 0 });
    const observation = commandObservation(cmd!);
    expect(observation).toMatchObject({ param: 1035, expected: enabled ? 1 : 0, observed: enabled });
    expect(await internal.refreshEventState(sn, observation)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(device.getProperty("enabled")?.value).toBe(enabled);
  });

  it.each([true, false])("reconciles late HomeBase topology during a poll with param changes=%s", async (changed) => {
    const client = new EufyMega({ email: "t@example.com", password: "x" });
    const internal = client as any;
    const sn = "T8410P0000000000";
    const standalone = { deviceType: 31, model: "T8410", category: "eufy_security", params: { 1035: "1" } };
    const record = { ...standalone, parentSn: "T8030P0000000000", params: { 1035: changed ? "0" : "1" } };
    const ctx: CommandContext = {
      codec: "camera",
      model: "T8410",
      deviceType: 31,
      channel: 3,
      stationSerial: record.parentSn,
      homeBaseAttached: true,
      firmwareVersion: "2.3.2.4",
      paramIds: new Set([1035]),
      capabilities: new Set(["camera"]),
    };
    const sent: Command[] = [];
    const sink = {
      dispatch: async (command: Command) => {
        sent.push(command);
      },
    };
    const device = Device.fromRecord(sn, standalone);
    device.bindActions({ ...ctx, stationSerial: undefined, homeBaseAttached: false }, sink);
    expect(device.camera?.()?.enabled).toBe(false);
    internal.liveDevices.set(sn, new WeakRef(device));
    vi.spyOn(internal.registry, "record").mockResolvedValue(record);
    vi.spyOn(internal.registry, "list").mockReturnValue([{ sn }]);
    vi.spyOn(internal.p2p, "stationKeyOf").mockReturnValue(record.parentSn);
    vi.spyOn(internal, "commandContext").mockResolvedValue(ctx);
    const bindSink = vi.spyOn(internal, "commandSinkFor").mockReturnValue(sink);
    vi.spyOn(internal.registry, "pollChanges").mockResolvedValue({
      added: [],
      removed: [],
      reported: [],
      params: changed ? [{ deviceSn: sn, paramType: 1035, from: "1", to: "0", params: record.params }] : [],
    });
    const readings: unknown[] = [];
    client.on("propertyChanged", (event) => {
      if (event.property === "enabled") readings.push(event.value);
    });
    const gains = vi.fn();
    client.on("deviceCapabilities", gains);

    await internal.pollOnce();

    expect(device.camera?.()?.enabled).toBe(!changed);
    expect(readings).toEqual(changed ? [] : [true]);
    expect(gains).not.toHaveBeenCalled();
    await device.camera?.()?.setEnabled(true);
    await device.camera?.()?.on();
    await device.camera?.()?.off();
    expect(sent).toMatchObject([
      { kind: "set-payload", payload: { switch: 0 } },
      { kind: "set-payload", payload: { switch: 0 } },
      { kind: "set-payload", payload: { switch: 1 } },
    ]);
    expect(sent.map(commandObservation)).toEqual([undefined, undefined, undefined]);
    await internal.pollOnce();
    expect(bindSink).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("does not poll stale 1035 to confirm a wrapped enabled=%s write", async (enabled) => {
    const client = new EufyMega({ email: "t@example.com", password: "x" });
    const internal = client as any;
    vi.spyOn(internal, "commandContext").mockResolvedValue({
      codec: "camera",
      model: "T8410",
      deviceType: 31,
      channel: 3,
      stationSerial: "T8030P0000000000",
      homeBaseAttached: true,
      firmwareVersion: "2.3.2.4",
      paramIds: new Set([1035]),
      capabilities: new Set(["camera"]),
    });
    const route = vi.spyOn(internal, "routeCommand").mockResolvedValue(undefined);
    const refresh = vi.spyOn(internal.registry, "refreshedList");
    await client.setProperty("T8410P0000000000", "enabled", enabled);
    expect(route).toHaveBeenCalledWith(
      "T8410P0000000000",
      expect.objectContaining({
        kind: "set-payload",
        cmd: 6250,
        payload: { switch: enabled ? 0 : 1 },
      }),
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(internal.commandRefreshes.size).toBe(0);
  });
});
