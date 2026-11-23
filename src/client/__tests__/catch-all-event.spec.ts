import { describe, it, expect, vi } from "vitest";
import { commandObservation, observeCommand, reflectCommand } from "../../core/contracts.js";
import { EufyMega } from "../eufy-mega.js";
import type { AnyDeviceEvent } from "../types.js";

/**
 * The catch-all `"event"` listener's tag key.
 *
 * The tag is `eventName`, not `name`, because a semantic payload can legitimately carry its own `name`
 * — a device name arrives that way on the wire — and tagging over it would destroy data the caller
 * needs. These specs pin the key in both directions: the runtime shape, and that the same key is the
 * compile-time discriminant of {@link AnyDeviceEvent}. Asserting only one of the two is what lets the
 * declared tag and the emitted one drift apart.
 */
describe("catch-all event tag", () => {
  const client = () => new EufyMega({ email: "t@example.com", password: "x" });

  it("tags the payload with eventName", async () => {
    const eufy = client();
    const seen: AnyDeviceEvent[] = [];
    eufy.on("event", (e) => seen.push(e));

    (eufy as any).emitSemantic("motion", { deviceSn: "T8000P0000000000" });

    expect(seen).toHaveLength(1);
    expect(seen[0].eventName).toBe("motion");
  });

  /**
   * A compile-time check as much as a runtime one: this only builds if `eventName` is the union's
   * discriminant, and `ptzNotify`'s `kind` is only reachable once narrowing has happened.
   */
  it("narrows the union on eventName", () => {
    const eufy = client();
    let narrowed: string | undefined;
    eufy.on("event", (e) => {
      if (e.eventName === "ptzNotify") narrowed = e.kind;
    });

    (eufy as any).emitSemantic("ptzNotify", { stationSn: "T8000P0000000000", kind: "rotate" });

    expect(narrowed).toBe("rotate");
  });

  /** The reason for the key choice: a push payload carries the device's own name in a `name` field. */
  it("does not clobber a payload's own `name` field", () => {
    const eufy = client();
    const seen: any[] = [];
    eufy.on("event", (e) => seen.push(e));

    (eufy as any).emitSemantic("motion", { deviceSn: "T8000P0000000000", name: "Camera A" });

    expect(seen[0].name).toBe("Camera A");
    expect(seen[0].eventName).toBe("motion");
  });

  /** Tagging is the catch-all's concern; a per-name listener gets the payload as the capability built it. */
  it("still delivers to the per-name listener untagged", () => {
    const eufy = client();
    const seen: any[] = [];
    eufy.on("motion", (e) => seen.push(e));

    (eufy as any).emitSemantic("motion", { deviceSn: "T8000P0000000000" });

    expect(seen).toHaveLength(1);
    expect(seen[0].eventName).toBeUndefined();
  });

  /** The app confirms a write on the device's answer and applies it locally; it never re-reads the cloud list. */
  const STATION = "T8010P0000000000";
  const guardWrite = (mode: number) =>
    observeCommand(
      reflectCommand({ kind: "set-param", param: 1224, value: mode, channel: 0 }, { param: 1224, raw: String(mode) }),
      { event: "armingModeChanged" },
    );
  const guardNotify = (eufy: EufyMega, mode: number, channel = 255) => {
    const data = Buffer.alloc(8);
    data.writeInt32LE(mode, 0);
    (eufy as any).onP2PFrame(STATION, { stationSn: STATION, commandId: 1151, channel, data, raw: data });
  };
  const stationClient = () => {
    const eufy = client();
    vi.spyOn((eufy as any).registry, "capabilitiesForFrame").mockReturnValue(new Set(["camera"]));
    vi.spyOn((eufy as any).registry, "serialForFrame").mockReturnValue(undefined);
    vi.spyOn((eufy as any).registry, "capabilitiesForDevice").mockReturnValue(new Set(["arming"]));
    return eufy;
  };

  /** The app confirms a write on the device's answer and applies it locally; it never re-reads the cloud list. */
  it("announces a write the device answered, landing its value without any list request", async () => {
    const eufy = stationClient();
    const list = vi.spyOn((eufy as any).registry, "getDevices");
    vi.spyOn(eufy as any, "routeCommand").mockResolvedValue(true);
    const seen: unknown[] = [];
    eufy.on("armingModeChanged", (e) => seen.push(e));

    await (eufy as any).commandSinkFor(STATION).dispatch(guardWrite(63));

    expect((eufy as any).registry.paramOf(STATION, 1224)).toBe("63");
    expect(seen).toEqual([{ deviceSn: STATION }]);
    expect(list).not.toHaveBeenCalled();
  });

  /** One mode change is announced once, whether the write's answer or the station's notify moves 1224. */
  it("announces the guard mode only when 1224 moves", async () => {
    const eufy = stationClient();
    vi.spyOn(eufy as any, "routeCommand").mockResolvedValue(true);
    let seen = 0;
    eufy.on("armingModeChanged", () => seen++);

    await (eufy as any).commandSinkFor(STATION).dispatch(guardWrite(63));
    guardNotify(eufy, 63);
    await (eufy as any).commandSinkFor(STATION).dispatch(guardWrite(63));
    expect(seen).toBe(1);

    guardNotify(eufy, 1);
    expect(seen).toBe(2);
  });

  it("announces an MQTT write the device answered", async () => {
    const eufy = client();
    vi.spyOn((eufy as any).mqtt, "dispatchCommand").mockResolvedValue(true);
    const seen: unknown[] = [];
    eufy.on("cameraEnabledChanged", (e) => seen.push(e));
    const command = observeCommand(
      reflectCommand(
        { kind: "mqtt-json", mqttCmdCode: 9, cmd: 6250, payload: { switch: 0 } },
        { param: 6250, raw: "0" },
      ),
      { event: "cameraEnabledChanged" },
    );

    await (eufy as any).commandSinkFor("T8000P0000000000").dispatch(command);

    expect(seen).toEqual([{ deviceSn: "T8000P0000000000" }]);
  });

  /** The app lands the station's 1151 notify on the station's own serial, whatever channel it names. */
  it.each([255, 0])("lands a station's guard-mode notify on channel %i on the station", (channel) => {
    const eufy = stationClient();
    vi.spyOn((eufy as any).registry, "serialForFrame").mockReturnValue(channel ? undefined : "T8114P0000000000");
    vi.spyOn((eufy as any).registry, "require").mockReturnValue({ raw: {} });

    guardNotify(eufy, 1, channel);

    expect((eufy as any).registry.paramOf(STATION, 1224)).toBe("1");
    expect((eufy as any).registry.paramOf("T8114P0000000000", 1224)).toBeUndefined();
  });

  it("allows observation policy to be replaced on a reused command object", () => {
    const command = { kind: "set-param", param: 1224, value: 63, channel: 0 } as const;
    const first = { event: "armingModeChanged" };
    const second = { event: "cameraEnabledChanged" };

    observeCommand(command, first);
    expect(() => observeCommand(command, second)).not.toThrow();
    expect(commandObservation(command)).toEqual(second);
  });
});
