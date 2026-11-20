import { serialPn } from "../command-router.js";

/** The app's `snToPn` serial rules (synthetic serials). */
describe("serialPn", () => {
  it.each([
    ["T8W11P0000000000", "T8W11C"],
    ["T842006000000000", "T8420X"],
    ["T842000000000000", "T8420"],
    ["T852008000000000", "T8510P"],
    ["T852009000000000", "T8520P"],
    ["T852000000000000", "T8520"],
    ["T2276T0000000000", "T2276T"],
    ["T2080A0000000000", "T2080A"],
    ["T821008000000000", "T8210C"],
    ["T821000000000000", "T8210"],
    ["T841005000000000", "T8410C"],
    ["T841000000000000", "T8410"],
    ["T2261EV", "T2261EV"],
  ])("%s is %s", (sn, pn) => expect(serialPn(sn)).toBe(pn));

  it("leaves any other serial to the cloud's get_pn_by_sn", () => {
    expect(serialPn("T8000P0000000000")).toBeUndefined();
  });
});
