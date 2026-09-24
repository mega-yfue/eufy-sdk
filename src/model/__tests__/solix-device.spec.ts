/**
 * SolixDevice capability-resolution tests — using the real Smart Meter (AE1X0) record + a synthetic
 * power-station record, plus a real captured telemetry reading. Offline, deterministic.
 */
import { describe, expect, it } from "vitest";

import { SolixDevice, discoverSolixDevices, solarbankSceneReadings, type SolixDeviceRecord } from "../solix-device.js";
import { buildModelIndex, type SolixProductCategory } from "../solix-catalog.js";

const CATALOG: SolixProductCategory[] = [
  { name: "Accessory", products: [{ product_code: "AE1X0", name: "Smart Meter Gen 2" }] },
  {
    name: "Portable Power Station",
    products: [{ product_code: "A1782", name: "SOLIX F3000", p_codes: ["2301", { product_code: "2302" }] }],
  },
  // NOTE the trailing space in the category name — the live catalog returns it that way.
  { name: "Plug-in Home Battery ", products: [{ product_code: "AE103", name: "Solarbank 4 E5000 Pro" }] },
];

const METER: SolixDeviceRecord = {
  device_sn: "AE1X0EXAMPLE00001",
  product_code: "AE1X0",
  device_name: "Smart Meter Gen 2",
  device_sw_version: "V1.0.0.9",
  wifi_online: true,
  wifi_name: "example-ssid",
  rssi: "-35",
};

const SOLARBANK: SolixDeviceRecord = {
  device_sn: "SB1TESTSERIAL0001",
  product_code: "A17C1", // Solarbank 2
  device_name: "Solarbank",
  device_sw_version: "V1.2.3",
  wifi_online: true,
};

describe("SolixDevice", () => {
  it("resolves the meter's identity (name + category) from the catalog", () => {
    const d = new SolixDevice(METER, { catalog: CATALOG });
    const id = d.identity();
    expect(id.name).toBe("Smart Meter Gen 2");
    expect(id.category).toBe("Accessory");
    expect(id.serial).toBe("AE1X0EXAMPLE00001");
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
    expect(c.ssid).toBe("example-ssid");
  });

  it("evidence-gates the meterVoltageL1 getter: absent until a frame carrying tag 0xAC lands", () => {
    const d = new SolixDevice(METER, { catalog: CATALOG });
    // No frame yet → the members engine installs no getter (not merely `undefined`): the property is absent.
    expect(d.energyMeter()!.meterVoltageL1).toBeUndefined();
    expect("meterVoltageL1" in d.energyMeter()!).toBe(false);
    // A frame carrying tag 0xAC (channel_ac) is the evidence; the decoder emits meterVoltageL1 + channel_ac.
    d.applyReading({ values: { meterVoltageL1: 236.8, channel_ac: 236.8, channel_a8: 0 } });
    expect(d.energyMeter()!.meterVoltageL1).toBeCloseTo(236.8, 1);
    // Every other decoded tag is read raw via telemetry(), never a named getter.
    expect(d.telemetry().channel_a8).toBe(0);
  });

  it("evidence-gates a promoted field (meterCurrentL1 on 0xAF) and keeps reserved 0xB2 raw-only", () => {
    const d = new SolixDevice(METER, { catalog: CATALOG });
    expect("meterCurrentL1" in d.energyMeter()!).toBe(false); // no frame yet
    d.applyReading({
      deviceSn: METER.device_sn,
      values: { meterCurrentL1: 1.79, channel_af: 1.79, channel_b2: 0.007 },
    });
    expect(d.energyMeter()!.meterCurrentL1).toBeCloseTo(1.79, 2);
    // 0xB2 names no field: readable raw via telemetry(), never a member or a "meterCurrentTotal".
    expect(d.telemetry().channel_b2).toBeCloseTo(0.007, 3);
    expect("meterCurrentTotal" in d.energyMeter()!).toBe(false);
  });

  it("a meter handle reflects later readings live (the getter reads state, not a snapshot)", () => {
    const d = new SolixDevice(METER, { catalog: CATALOG });
    d.applyReading({ deviceSn: METER.device_sn, values: { meterVoltageL1: 236.8, channel_ac: 236.8 } });
    const meter = d.energyMeter()!; // handle taken after the getter is installed
    expect(meter.meterVoltageL1).toBeCloseTo(236.8, 1);
    d.applyReading({ deviceSn: METER.device_sn, values: { meterVoltageL1: 231.2, channel_ac: 231.2, channel_a8: 12 } });
    // The SAME handle sees the new reading — applyReading rebinds the store; the getter reads it live.
    expect(meter.meterVoltageL1).toBeCloseTo(231.2, 1);
    expect(d.telemetry().channel_a8).toBe(12);
  });

  it("drops a reading addressed to a DIFFERENT device (no cross-feed on a shared MQTT stream)", () => {
    const a = new SolixDevice(METER, { catalog: CATALOG });
    const b = new SolixDevice({ device_sn: "AE1X0EXAMPLE00002", product_code: "AE1X0" }, { catalog: CATALOG });
    // One SolixMqtt stream carries every watched meter; each device must keep only its own readings.
    const readingForB = { deviceSn: b.serial, values: { meterVoltageL1: 120.1, channel_ac: 120.1 } };
    a.applyReading(readingForB); // wired as mqtt.on("reading", r => a.applyReading(r)) would deliver it
    b.applyReading(readingForB);
    expect(a.energyMeter()!.meterVoltageL1).toBeUndefined(); // B's reading must not land on A
    expect(b.energyMeter()!.meterVoltageL1).toBeCloseTo(120.1, 1);
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

  it("detects battery + solarInput on a Solarbank from its product code (catalog-independent)", () => {
    const sb = new SolixDevice(SOLARBANK);
    expect(sb.has("battery")).toBe(true);
    expect(sb.has("solarInput")).toBe(true);
    expect(sb.has("energyMeter")).toBe(false);
    // battery has no typed accessors (no decode path captured yet) — callers use has() + telemetry().
    expect(sb.energyMeter()).toBeUndefined();
  });

  it("resolves a Solarbank from its 'Plug-in Home Battery ' catalog category (trailing space trimmed)", () => {
    const sb = new SolixDevice({ device_sn: "AE103EXAMPLE00001", product_code: "AE103" }, { catalog: CATALOG });
    // Category is trimmed at ingest (buildModelIndex), so consumers see the clean name, not "…Battery ".
    expect(sb.identity().category).toBe("Plug-in Home Battery");
    expect(sb.has("battery")).toBe(true);
    expect(sb.has("solarInput")).toBe(true);
    expect(sb.has("acOutput")).toBe(true);
    // NOT energyMeter: the AE1X0 meter's members are its own ff09 tag family, not a Solarbank's.
    expect(sb.has("energyMeter")).toBe(false);
  });

  it("detects a newer Solarbank (AE10x) by product code even without a catalog", () => {
    const sb = new SolixDevice({ device_sn: "AE103EXAMPLE00002", product_code: "AE103" });
    expect(sb.has("battery")).toBe(true);
    expect(sb.has("solarInput")).toBe(true);
    expect(sb.has("energyMeter")).toBe(false);
  });

  it("buildModelIndex resolves model codes and their variant codes to name + category", () => {
    const index = buildModelIndex(CATALOG);
    expect(index.get("A1782")).toEqual({ name: "SOLIX F3000", category: "Portable Power Station" });
    // both the string and object variant codes resolve to the parent product
    expect(index.get("2301")?.name).toBe("SOLIX F3000");
    expect(index.get("2302")?.name).toBe("SOLIX F3000");
  });

  it("solarbankSceneReadings extracts batteryTemperature + batterySoc (string-typed) per device", () => {
    const scene = {
      solarbank_info: {
        solarbank_list: [{ device_sn: "AE103EXAMPLE00001", device_pn: "AE103", bat_temperature: "31", bat_soc: "89" }],
      },
    };
    const readings = solarbankSceneReadings(scene);
    expect(readings).toEqual([{ deviceSn: "AE103EXAMPLE00001", values: { batteryTemperature: 31, batterySoc: 89 } }]);
    // The reading is shaped like a SolixMqtt event, so it feeds straight into applyReading.
    const dev = new SolixDevice({ device_sn: "AE103EXAMPLE00001", product_code: "AE103" });
    dev.applyReading(readings[0]);
    expect(dev.telemetry().batteryTemperature).toBe(31);
  });

  it("solarbankSceneReadings emits the attached expansion-pack count (0 on a standalone main unit)", () => {
    const scene = {
      solarbank_info: {
        solarbank_list: [
          { device_sn: "AE103EXAMPLE00001", bat_soc: "62", sub_package_num: 0 },
          // string-on-the-wire is coerced by sceneNum, like every other scene field
          { device_sn: "AE103EXAMPLE00002", bat_soc: "80", sub_package_num: "2" },
        ],
      },
    };
    const readings = solarbankSceneReadings(scene);
    expect(readings[0].values).toMatchObject({ batterySoc: 62, expansionPacks: 0 });
    expect(readings[1].values).toMatchObject({ expansionPacks: 2 });
  });

  it("solarbankSceneReadings drops entries with no usable value (never clobbers live data)", () => {
    const scene = {
      solarbank_info: {
        solarbank_list: [
          { device_sn: "AE103EXAMPLE00001", bat_temperature: "", bat_soc: "" }, // empty strings during a gap
          { bat_temperature: "30" }, // no device_sn
        ],
      },
    };
    expect(solarbankSceneReadings(scene)).toEqual([]);
    expect(solarbankSceneReadings({})).toEqual([]);
  });

  it("buildModelIndex trims the category at ingest (the live catalog has trailing whitespace)", () => {
    // The AE103 entry's category in CATALOG is "Plug-in Home Battery " (trailing space, as the live
    // product_categories endpoint returns it); the index stores the trimmed name so every consumer of
    // it — identity().category and detectSolixCapabilities — matches on the clean string.
    expect(buildModelIndex(CATALOG).get("AE103")?.category).toBe("Plug-in Home Battery");
  });

  it("discoverSolixDevices composes a wire client's reads into resolved SolixDevice models", async () => {
    // A structural stand-in for the transport SolixClient — discoverSolixDevices never imports it.
    const client = {
      getDevices: async (): Promise<SolixDeviceRecord[]> => [METER, { device_sn: "X", product_code: "A1782" }],
      getProductCatalog: async (): Promise<SolixProductCategory[]> => CATALOG,
    };
    const devices = await discoverSolixDevices(client);
    expect(devices.map((d) => d.serial)).toEqual(["AE1X0EXAMPLE00001", "X"]);
    expect(devices[0].has("energyMeter")).toBe(true);
    expect(devices[1].identity().name).toBe("SOLIX F3000");
    expect(devices[1].has("battery")).toBe(true);
  });
});
