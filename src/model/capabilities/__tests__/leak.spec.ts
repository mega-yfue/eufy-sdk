import { LEAK } from "../leak.js";

describe("leak capability module", () => {
  it("declares the capability + schema", () => {
    expect(LEAK.capability).toBe("leak");
    expect(LEAK.properties.map((p) => p.name)).toEqual(["leakDetected"]);
  });

  it("detects via the water/leak/freeze model-name regex", () => {
    const re = LEAK.detection!.modelHints![0];
    expect(re.test("Water & Freeze Sensor")).toBe(true);
    expect(re.test("Indoor Cam")).toBe(false);
  });
});
