import { BUNDLE_WIRES } from "../bundle-wires.generated.js";
import { POWER_READ, POWER_WIRE } from "../camera.js";
import type { AvailabilityContext } from "../types.js";
import type { ThingDescription } from "../thing-description.js";

const at = (model: string, topology: "standalone" | "hb2" | "hb3", things?: ThingDescription): AvailabilityContext => ({
  model,
  homeBaseAttached: topology !== "standalone",
  ...(topology === "hb3"
    ? { stationSerial: "T8030P0000000000" }
    : topology === "hb2"
      ? { stationSerial: "T8010P0000000000" }
      : {}),
  ...(things ? { things } : {}),
});

const TOPOLOGIES = ["standalone", "hb2", "hb3"] as const;

/** The generated `camera_on_off` entry of `model` on `topology`: its write frames and read. */
const generated = (model: string, topology: string) => {
  const entry = Object.entries(BUNDLE_WIRES.wires.camera_on_off!).find(([k]) => k.split(" ").includes(model))![1];
  const pick = <T>(g: Record<string, T>) => Object.entries(g).find(([k]) => k.split(" ").includes(topology))?.[1];
  return { write: pick(entry.write), read: pick(entry.read) };
};

describe("camera power from the generated data", () => {
  it.each(TOPOLOGIES)("T8162 writes and reads 6250, 0 as on (%s)", (topology) => {
    expect(POWER_WIRE(at("T8162", topology))).toBe(6250);
    expect(POWER_READ(at("T8162", topology))).toBe("6250");
    expect(generated("T8162", topology).write!["1"]).toMatchObject({ subCmd: 6250, params: { switch: 0 } });
    expect(generated("T8162", topology).read!.map).toEqual({ 6250: { 0: "1", 1: "0" } });
  });
  it("T8410 writes 1035 as an enable bit standalone and reads 2001; attached it writes and reads 6250 only", () => {
    expect(POWER_WIRE(at("T8410", "standalone"))).toBe(1035);
    expect(generated("T8410", "standalone").write!["1"]).toEqual({ cmd: 1035, params: { switch: 1 } });
    expect(POWER_READ(at("T8410", "standalone"))).toBe("2001");
    for (const topology of ["hb2", "hb3"] as const) {
      expect(POWER_WIRE(at("T8410", topology)), topology).toBe(6250);
      expect(POWER_READ(at("T8410", topology)), topology).toBe("6250");
    }
  });
  it.each(TOPOLOGIES)("T8161 writes and reads 1035 as a disable bit (%s)", (topology) => {
    expect(POWER_WIRE(at("T8161", topology))).toBe(1035);
    expect(generated("T8161", topology).write!["1"]).toEqual({ cmd: 1035, params: { switch: false } });
    expect(POWER_READ(at("T8161", topology))).toBe("1035");
    expect(generated("T8161", topology).read!.map).toEqual({ 1035: { 0: "1", 1: "0" } });
  });
  it.each(TOPOLOGIES)("T8422 reads 2001 over 1035 (%s)", (topology) => {
    expect(POWER_READ(at("T8422", topology))).toBe("2001>1035");
  });
  it.each(TOPOLOGIES)("T84A1 has no power wire (%s)", (topology) => {
    expect(POWER_WIRE(at("T84A1", topology))).toBeUndefined();
  });
  it.each(TOPOLOGIES)("a product the data lacks falls back to 1035 (%s)", (topology) => {
    expect(POWER_WIRE(at("T0000", topology))).toBe(1035);
    expect(POWER_READ(at("T0000", topology))).toBe("1035");
  });
});

test("camera power picks the HomeBase 3 arm, the resolved variant, and no wire where the bundle builds none", async () => {
  vi.resetModules();
  vi.doMock("../bundle-wires.generated.js", () => ({
    BUNDLE_WIRES: {
      wires: {
        camera_on_off: {
          T0001: {
            write: { "standalone hb2": { "0 1": { cmd: 1035 } }, hb3: { 1: { cmd: 1350, subCmd: 6250 } } },
            read: { hb3: { order: "6250" } },
          },
          T0001__v1: { write: {}, read: {} },
        },
      },
    },
  }));
  const camera = await import("../camera.js");
  const variant = { properties: { camera_on_off: { identifier: "camera_on_off__v1" } } } as unknown as ThingDescription;
  expect(camera.POWER_WIRE(at("T0001", "hb2"))).toBe(1035);
  expect(camera.POWER_WIRE(at("T0001", "hb3"))).toBe(6250);
  expect(camera.POWER_READ(at("T0001", "hb3"))).toBe("6250");
  expect(camera.POWER_READ(at("T0001", "standalone")), "listed, nothing read").toBe("");
  expect(camera.POWER_WIRE(at("T0001", "standalone", variant)), "the variant builds no frame").toBeUndefined();
  expect(camera.POWER_WIRE(at("T0002", "hb3")), "unlisted").toBe(1035);
  vi.doUnmock("../bundle-wires.generated.js");
});
