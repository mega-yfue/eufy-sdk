import { CO } from "../co.js";

describe("co capability module", () => {
  it("declares the capability + schema", () => {
    expect(CO.capability).toBe("co");
    expect(CO.properties.map((p) => p.name)).toEqual(["coDetected"]);
  });

  it("detects via the co/carbon model-name regex", () => {
    const re = CO.detection!.modelHints![0];
    expect(re.test("Carbon Monoxide Detector")).toBe(true);
    expect(re.test("Indoor Cam")).toBe(false);
  });
});
