import { readFileSync } from "node:fs";
import { catalog } from "../catalog.js";

/**
 * `@mega-yfue/eufy-sdk/catalog` is the build of `src/catalog.ts` (tsc maps `src/` onto `dist/`), and its data
 * keeps a product's option set in its description's order, with that product's own labels.
 */
describe("things catalog subpath", () => {
  it("exports the catalog module, with T8410's and T8416's night-vision sets in their own order", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(pkg.exports["./catalog"]).toEqual({ types: "./dist/catalog.d.ts", default: "./dist/catalog.js" });
    const setOf = (code: string) => catalog.properties.nightvision_type_new?.find((v) => v.products.includes(code));
    expect(setOf("T8410")?.options).toEqual([
      ["100", "night_vision_off"],
      ["101", "night_vision_infrared"],
      ["102", "night_vision_infrared"],
    ]);
    expect(setOf("T8416")?.options).toEqual([
      ["101", "night_vision_infrared"],
      ["102", "night_vision_infrared"],
      ["100", "night_vision_off"],
    ]);
  });
});
