import { describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { Device } from "../../model/device.js";
import { memberWrite } from "../../model/capabilities/members.js";
import { CAMERA_MEMBERS } from "../../model/capabilities/camera.js";
import { commandReflection, reflectCommand, type Command } from "../../core/contracts.js";
import type { CommandContext } from "../../model/capabilities/types.js";
import { parseThingsList } from "../../model/capabilities/thing-description.js";

// The product's settings-bundle data, synthetic: the spec is about the code, not the shipped data.
vi.mock("../../model/capabilities/bundle-wires.generated.json", async () => {
  const f = await import("../../model/capabilities/__tests__/bundle-fixture.js");
  return f.bundleData("T8410", { camera_on_off: f.power() });
});

const SENSOR = "T8000P0000000000";
const write: Command = { kind: "set-param", param: 1550, value: 1, form: "auto", channel: 0 };

/**
 * A held contact sensor whose `contact` reads param 1550, and a sink whose route answers as `routed` does:
 * `true` for a write the device answered with success, `false` for one sent unread, or a rejection.
 */
function sensor(routed: () => Promise<boolean>) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x" });
  const dev = Device.fromRecord(SENSOR, { model: "T8900", category: "eufy_security", params: { 1550: "0" } });
  const target = eufy as never as {
    liveDevices: Map<string, WeakRef<Device>>;
    boundParamIds: Map<string, ReadonlySet<number>>;
    registry: { applyRealtimeParams: () => void };
    routeCommand: () => Promise<boolean>;
    commandSinkFor(sn: string): { dispatch(cmd: Command): Promise<void> };
  };
  target.liveDevices.set(SENSOR, new WeakRef(dev));
  target.boundParamIds.set(SENSOR, new Set([1550]));
  vi.spyOn(target.registry, "applyRealtimeParams").mockImplementation(() => {});
  target.routeCommand = routed;
  const seen: unknown[] = [];
  eufy.on("propertyChanged", (e) => seen.push(e));
  return {
    dev,
    seen,
    dispatch: () => target.commandSinkFor(SENSOR).dispatch(reflectCommand({ ...write }, { param: 1550, raw: "1" })),
  };
}

describe("a write the device answered", () => {
  it("lands the value under the param its member reads and announces it", async () => {
    const { dev, seen, dispatch } = sensor(async () => true);
    await dispatch();
    expect(dev.getProperty("contact")?.value).toBe(true);
    expect(seen).toEqual([{ deviceSn: SENSOR, property: "contact", value: true }]);
  });

  it("changes nothing when it was sent unread", async () => {
    const { dev, seen, dispatch } = sensor(async () => false);
    await dispatch();
    expect(dev.getProperty("contact")?.value).toBe(false);
    expect(seen).toEqual([]);
  });

  it("changes nothing when the device refused it or never answered", async () => {
    const { dev, seen, dispatch } = sensor(() => Promise.reject(new Error("refused")));
    await expect(dispatch()).rejects.toThrow("refused");
    expect(dev.getProperty("contact")?.value).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe("a write carrying a next command", () => {
  it("routes the next one after it", async () => {
    const sent: Command[] = [];
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });
    const target = eufy as never as {
      routeCommand: (sn: string, cmd: Command) => Promise<boolean>;
      commandSinkFor(sn: string): { dispatch(cmd: Command): Promise<void> };
    };
    target.routeCommand = async (_sn, cmd) => (sent.push(cmd), false);
    const next: Command = { kind: "set-param", param: 1045, value: 1, form: "auto", channel: 0 };
    const first: Command = { kind: "set-json", param: 6014, data: { value: 1 }, channel: 0, next };
    await target.commandSinkFor(SENSOR).dispatch(first);
    expect(sent).toEqual([first, next]);
  });
  it("calls the cloud after it only once the device answered it with success", async () => {
    const sent: Command[] = [];
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });
    const target = eufy as never as {
      routeCommand: (sn: string, cmd: Command) => Promise<boolean>;
      commandSinkFor(sn: string): { dispatch(cmd: Command): Promise<void> };
    };
    let answers = false;
    target.routeCommand = async (_sn, cmd) => (sent.push(cmd), answers);
    const after: Command = { kind: "cloud-request", method: "POST", domain: "DeviceManage", path: "/app/x" };
    const rename: Command = { kind: "p2p-string", cmd: 1217, value: "Garden", channel: 0, next: after };
    await target.commandSinkFor(SENSOR).dispatch(rename);
    expect(sent, "refused or unanswered").toEqual([rename]);
    answers = true;
    await target.commandSinkFor(SENSOR).dispatch(rename);
    expect(sent).toEqual([rename, rename, after]);
  });
});

describe("a cloud write", () => {
  it("goes through the client's cloud call and counts as answered", async () => {
    const eufy = new EufyMega({ email: "t@example.com", password: "x" });
    const target = eufy as never as {
      mega: { cloudRequest: (req: unknown) => Promise<unknown> };
      routeCommand: (sn: string, cmd: Command) => Promise<boolean>;
    };
    const post = vi.spyOn(target.mega, "cloudRequest").mockResolvedValue({});
    const cmd: Command = {
      kind: "cloud-request",
      method: "POST",
      domain: "eufy_security",
      path: "/v1/x",
      body: { a: 1 },
    };
    expect(await target.routeCommand(SENSOR, cmd)).toBe(true);
    expect(post).toHaveBeenCalledWith(cmd);
  });
});

describe("a member write's readback", () => {
  const ctx = { channel: 0 } as CommandContext;
  const scalar = (value: boolean | number | string): Command => ({
    kind: "set-param",
    param: 6014,
    value: Number(value),
    form: "auto",
    channel: 0,
  });

  it("names the read param and the raw value the getter reads back, inverted where the read is", () => {
    const member = { param: 1045, type: "bool", invert: true, description: "", write: scalar } as const;
    expect(commandReflection(memberWrite("led", member, true, ctx))).toEqual({ param: 1045, raw: "0" });
  });

  it("names the read alias on a device whose primary read is not available", () => {
    const member = {
      param: 1045,
      type: "bool",
      description: "",
      readAvailable: () => false,
      readAliases: [{ paramType: 1716 }],
      write: scalar,
    } as const;
    expect(commandReflection(memberWrite("led", member, true, ctx))).toEqual({ param: 1716, raw: "1" });
  });

  it("names none where the device reported no param its product's bundle reads", () => {
    const hb3 = {
      channel: 0,
      codec: "camera",
      model: "T8410",
      stationSerial: "T8030P0000000000",
      firmwareVersion: "2.3.1.0",
      homeBaseAttached: true,
      paramIds: new Set([1035]),
      things: parseThingsList({
        things_list: [{ profile: { product_code: "T8410" }, properties: [{ identifier: "camera_on_off" }] }],
      }).T8410,
    } as unknown as CommandContext;
    expect(commandReflection(memberWrite("enabled", CAMERA_MEMBERS.enabled, true, hb3))).toBeUndefined();
  });

  it("names none for a getter that decodes the raw value", () => {
    const member = { param: 1045, type: "number", description: "", coerce: Number, write: scalar } as const;
    expect(commandReflection(memberWrite("n", member, 3, ctx))).toBeUndefined();
  });
});
