import { LEAK } from "../leak.js";
import { parseThingsList } from "../thing-description.js";
import { resolveDevice } from "../../registry.js";

describe("leak capability module", () => {
  it("declares the capability + schema", () => {
    expect(LEAK.capability).toBe("leak");
    expect(LEAK.properties.map((p) => p.name)).toEqual(["leakDetected", "lowTemperature", "lowTemperatureThreshold"]);
  });

  it("reads water and low temperature on the settings bundle's params, not a guessed id", () => {
    expect(LEAK.properties.map((p) => p.paramType)).toEqual([1820, 1822, 1873]);
    expect(LEAK.detection?.evidenceParams).toEqual([1820]);
  });

  it("detects from the reported param or the product's description, never the owner's name", () => {
    const things = (...ids: string[]) =>
      parseThingsList({
        things_list: [{ profile: { product_code: "T0000" }, properties: ids.map((identifier) => ({ identifier })) }],
      }).T0000!;
    const caps = (rec: object) => resolveDevice({ category: "eufy_security", model: "T0000", ...rec }).capabilities;
    expect(caps({ params: { 1820: "0" } })).toContain("leak");
    expect(caps({ params: {}, things: things("sensor_water_status") })).toContain("leak");
    expect(caps({ params: {}, name: "Water heater", things: things("nightvision_type") })).not.toContain("leak");
  });
});
