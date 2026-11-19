import { describe, expect, it } from "vitest";

import { SOLIX_ENERGY_METER_MEMBERS, detectSolixCapabilities } from "../solix.js";
import { propertiesOf } from "../members.js";

/**
 * The Solix capability surface: one `members` table for the single feature with a confirmed readable
 * wire, and category/prefix detection for the rest. These lock the members-derived schema and detection.
 */
describe("Solix capability surface", () => {
  it("the energyMeter schema derives from its members table: the ten electrical fields, not the energy counters", () => {
    const props = propertiesOf(SOLIX_ENERGY_METER_MEMBERS);
    const names = props.map((p) => p.name).sort();
    expect(names).toEqual([
      "meterCurrentL1",
      "meterCurrentL2",
      "meterCurrentL3",
      "meterPowerL1",
      "meterPowerL2",
      "meterPowerL3",
      "meterPowerTotal",
      "meterVoltageL1",
      "meterVoltageL2",
      "meterVoltageL3",
    ]);
    // Energy counters are named on the wire (SOLIX_METER_FIELD_NAMES) but NOT members — unit scale
    // unconfirmed. And there is no "meterCurrentTotal": the app names no such field.
    expect(names).not.toContain("meterImportEnergy");
    expect(names).not.toContain("meterCurrentTotal");
    const v1 = props.find((p) => p.name === "meterVoltageL1")!;
    expect(v1.paramType).toBe(0xac);
    expect(v1.type).toBe("number");
    expect(v1.writable).toBe(false);
  });

  it("detects capabilities from catalog category + product-code prefix (identity always present)", () => {
    // A smart meter (AE1X0 prefix) → energyMeter, regardless of its "Accessory" category.
    const meter = detectSolixCapabilities({ product_code: "AE1X0EXAMPLE00001" }, "Accessory");
    expect(meter.has("energyMeter")).toBe(true);
    expect(meter.has("identity")).toBe(true);
    expect(meter.has("battery")).toBe(false);

    // A Solarbank (A17C prefix) → battery + solarInput.
    const sb = detectSolixCapabilities({ product_code: "A17C1TESTSERIAL" });
    expect(sb.has("battery")).toBe(true);
    expect(sb.has("solarInput")).toBe(true);

    // A portable power station by category → battery + acOutput + solarInput.
    const ps = detectSolixCapabilities({ product_code: "A1782X" }, "Portable Power Station");
    expect([...ps].sort()).toEqual(["acOutput", "battery", "identity", "solarInput"]);

    // firmware/connectivity gate on record fields.
    const withFields = detectSolixCapabilities({ product_code: "A1782X", device_sw_version: "1.0", wifi_online: true });
    expect(withFields.has("firmware")).toBe(true);
    expect(withFields.has("connectivity")).toBe(true);
  });
});
