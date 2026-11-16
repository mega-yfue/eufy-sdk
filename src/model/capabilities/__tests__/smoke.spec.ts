import { SMOKE, SMOKE_MEMBERS } from "../smoke.js";
import { parseThingsList } from "../thing-description.js";
import { resolveDevice } from "../../registry.js";

describe("smoke capability module", () => {
  it("reads smoke as bit 0 of the settings bundle's 1823, not a guessed id", () => {
    expect(SMOKE.properties.map((p) => [p.name, p.paramType])).toEqual([["smokeDetected", 1823]]);
    expect(SMOKE.detection?.evidenceParams).toEqual([1823]);
    expect(["0", "1", "3", "8"].map(SMOKE_MEMBERS.smokeDetected.coerce)).toEqual([false, true, true, false]);
  });

  it("detects from the reported param or the product's description, never the owner's name", () => {
    const things = (...ids: string[]) =>
      parseThingsList({
        things_list: [{ profile: { product_code: "T0000" }, properties: ids.map((identifier) => ({ identifier })) }],
      }).T0000!;
    const caps = (rec: object) => resolveDevice({ category: "eufy_security", model: "T0000", ...rec }).capabilities;
    expect(caps({ params: { 1823: "0" } })).toContain("smoke");
    expect(caps({ params: {}, things: things("sensor_smoke_status") })).toContain("smoke");
    expect(caps({ params: {}, name: "Smoke Detector", things: things("nightvision_type") })).not.toContain("smoke");
  });
});
