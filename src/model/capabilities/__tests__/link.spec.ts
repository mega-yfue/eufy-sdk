import { LINK } from "../link.js";
import { resolveDevice } from "../../registry.js";

describe("link capability module", () => {
  it("declares the check-in and signal reads", () => {
    expect(LINK.capability).toBe("link");
    expect(LINK.properties.map((p) => p.name)).toEqual(["lastSeen", "rssi"]);
  });

  it("lands on any security device that reports either param, and on none that reports neither", () => {
    const caps = (params: Record<number, string>, model = "T8900") =>
      resolveDevice({ model, category: "eufy_security", params }).capabilities;
    expect(caps({ 1550: "0", 1551: "1700000000" })).toContain("link");
    expect(caps({ 1655: "1", 1141: "-63" }, "T8960")).toContain("link");
    expect(caps({ 1550: "0" })).not.toContain("link");
  });
});
