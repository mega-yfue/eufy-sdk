/**
 * SolixDevice capability-resolution tests — using the real Smart Meter (AE1X0) record + a synthetic
 * power-station record, plus a real captured telemetry reading. Offline, deterministic.
 */
import { describe, expect, it } from "vitest";

import { SolixDevice, type SolixDeviceRecord } from "../device.js";
import type { SolixProductCategory } from "../solix-client.js";

const CATALOG: SolixProductCategory[] = [
  { name: "Accessory", products: [{ product_code: "AE1X0", name: "Smart Meter Gen 2" }] },
  { name: "Portable Power Station", products: [{ product_code: "A1782", name: "SOLIX F3000" }] },
];

const METER: SolixDeviceRecord = {
  device_sn: "6UWDNSL0G23200788",
  product_code: "AE1X0",
  device_name: "Smart Meter Gen 2",
  device_sw_version: "V1.0.0.9",
  wifi_online: true,
  wifi_name: "Xman24",
  rssi: "-35",
};

describe("SolixDevice", () => {
  it("resolves the meter's identity (name + category) from the catalog", () => {
    const d = new SolixDevice(METER, { catalog: CATALOG });
    const id = d.identity();
    expect(id.name).toBe("Smart Meter Gen 2");
    expect(id.category).toBe("Accessory");
    expect(id.serial).toBe("6UWDNSL0G23200788");
  });

  it("gives the meter identity/firmware/connectivity/energyMeter and NOT battery", () => {
    const d = new SolixDevice(METER, { catalog: CATALOG });
    expect(d.has("energyMeter")).toBe(true);
    expect(d.has("firmware")).toBe(true);
    expect(d.has("connectivity")).toBe(true);
    expect(d.has("battery")).toBe(false);
    expect(d.firmware()).toEqual({ version: "V1.0.0.9" });
    const c = d.connectivity()!;
    expect(c.online).toBe(true);
    expect(c.rssi).toBe(-35);
    expect(c.ssid).toBe("Xman24");
  });

  it("populates the energyMeter values from an applied telemetry reading", () => {
    const d = new SolixDevice(METER, { catalog: CATALOG });
    expect(d.energyMeter()!.meterVoltageL1()).toBeUndefined(); // no reading yet
    d.applyReading({ values: { meterVoltageL1: 236.8, channel_ac: 236.8, meterPowerL1: 0, channel_a8: 0 } });
    expect(d.energyMeter()!.meterVoltageL1()).toBeCloseTo(236.8, 1);
    expect(d.energyMeter()!.meterPowerL1()).toBe(0);
    expect(d.telemetry().channel_a8).toBe(0);
  });

  it("detects a power station's capabilities from its catalog category", () => {
    const ps = new SolixDevice({ device_sn: "X", product_code: "A1782" }, { catalog: CATALOG });
    expect(ps.identity().category).toBe("Portable Power Station");
    expect(ps.has("battery")).toBe(true);
    expect(ps.has("acOutput")).toBe(true);
    expect(ps.has("solarInput")).toBe(true);
    expect(ps.has("energyMeter")).toBe(false);
  });

  it("still exposes identity when no catalog is provided (falls back to the record name)", () => {
    const d = new SolixDevice(METER);
    expect(d.identity().name).toBe("Smart Meter Gen 2");
    expect(d.identity().category).toBeUndefined();
    expect(d.has("energyMeter")).toBe(true); // model-based detection, catalog-independent
  });
});
