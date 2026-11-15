import { SMOKE } from "../smoke.js";

describe("smoke capability module", () => {
  it("declares the capability + schema", () => {
    expect(SMOKE.capability).toBe("smoke");
    expect(SMOKE.properties.map((p) => p.name)).toEqual(["smokeDetected"]);
  });

  it("detects via the smoke model-name regex", () => {
    const re = SMOKE.detection!.modelHints![0];
    expect(re.test("Smoke Detector")).toBe(true);
    expect(re.test("Indoor Cam")).toBe(false);
  });
});
