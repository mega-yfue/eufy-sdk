import type { CommandContext } from "../types.js";
import type { DpCatalog } from "../dp-catalog.js";
import { SUCTION, SUCTION_DP, SuctionLevel, type SuctionActions } from "../suction.js";
import { bind } from "./bind.js";

function suctionCtx(model?: string, category?: string, dpCatalog?: DpCatalog): CommandContext {
  return { channel: 0, codec: "vacuum", model, category, paramIds: new Set(), dpCatalog };
}

describe("suction capability module", () => {
  it("declares the capability + schema", () => {
    expect(SUCTION.capability).toBe("suction");
    expect(SUCTION.properties.map((p) => p.name)).toEqual(["suction", "boostIq"]);
  });

  it("is a vacuum-codec baseline", () => {
    expect(SUCTION.detection?.codecs).toEqual(["vacuum"]);
  });
});

describe("suction — AIoT vs legacy guard (negative exclusion)", () => {
  it("write actions are present when category is absent — defaults to AIoT", () => {
    const { acts } = bind<SuctionActions>("suction", suctionCtx("T2250"));
    expect(acts.setSuctionLevel).toBeDefined();
    expect(acts.setBoostIq).toBeDefined();
  });

  it("write actions are present when model and category are both absent — defaults to AIoT", () => {
    const { acts } = bind<SuctionActions>("suction", suctionCtx(undefined));
    expect(acts.setSuctionLevel).toBeDefined();
  });

  it("write actions are absent for eufy_home_tuya — DP 158/159 are AIoT-only (unverified for Tuya)", () => {
    // T2266 = X8 Pro (Tuya clean line); suction DP 158 is AIoT-only, not confirmed on the Tuya path.
    const { acts } = bind<SuctionActions>("suction", suctionCtx("T2266", "eufy_home_tuya"));
    expect(acts.setSuctionLevel).toBeUndefined();
    expect(acts.setBoostIq).toBeUndefined();
  });

  it("write actions are absent for eufy_home_tuya with no model — DP 158/159 are AIoT-only", () => {
    const { acts } = bind<SuctionActions>("suction", suctionCtx(undefined, "eufy_home_tuya"));
    expect(acts.setSuctionLevel).toBeUndefined();
  });

  it("dispatches DP 158 for setSuctionLevel on eufy_home category (Anker AIoT MQTT)", async () => {
    const { acts, sent } = bind<SuctionActions>("suction", suctionCtx(undefined, "eufy_home"));
    await acts.setSuctionLevel!(SuctionLevel.Turbo);
    expect(sent).toEqual([{ kind: "aiot-dp", dp: SUCTION_DP.SUCTION, value: SuctionLevel.Turbo }]);
  });

  it("dispatches DP 159 for setBoostIq on eufy_home category (Anker AIoT MQTT)", async () => {
    const { acts, sent } = bind<SuctionActions>("suction", suctionCtx(undefined, "eufy_home"));
    await acts.setBoostIq!(true);
    expect(sent).toEqual([{ kind: "aiot-dp", dp: SUCTION_DP.BOOST_IQ, value: true }]);
  });
});

describe("suction — supportedLevels from dpCatalog", () => {
  it("returns the catalog range for DP 158 when present", () => {
    const catalog: DpCatalog = { enumRanges: new Map([[SUCTION_DP.SUCTION, ["0", "1", "2", "3"]]]) };
    const { acts } = bind<SuctionActions>("suction", suctionCtx("T2351", "eufy_home", catalog));
    expect(acts.supportedLevels).toEqual([0, 1, 2, 3]);
  });

  it("filters out catalog values that are not valid SuctionLevel entries", () => {
    const catalog: DpCatalog = { enumRanges: new Map([[SUCTION_DP.SUCTION, ["0", "1", "2", "99"]]]) };
    const { acts } = bind<SuctionActions>("suction", suctionCtx(undefined, "eufy_home", catalog));
    expect(acts.supportedLevels).toEqual([0, 1, 2]);
  });

  it("maps a catalog range of level names onto the SuctionLevel scale", () => {
    const catalog: DpCatalog = {
      enumRanges: new Map([[SUCTION_DP.SUCTION, ["Quiet", "Standard", "Turbo", "Max"]]]),
    };
    const { acts } = bind<SuctionActions>("suction", suctionCtx("T2351", "eufy_home", catalog));
    expect(acts.supportedLevels).toEqual([0, 1, 2, 3]);
  });

  it("drops a level name outside the SuctionLevel scale", () => {
    const catalog: DpCatalog = { enumRanges: new Map([[SUCTION_DP.SUCTION, ["Quiet", "Hurricane", "Max"]]]) };
    const { acts } = bind<SuctionActions>("suction", suctionCtx(undefined, "eufy_home", catalog));
    expect(acts.supportedLevels).toEqual([0, 3]);
  });

  it("returns undefined when the catalog has no entry for DP 158", () => {
    const catalog: DpCatalog = { enumRanges: new Map() };
    const { acts } = bind<SuctionActions>("suction", suctionCtx(undefined, "eufy_home", catalog));
    expect(acts.supportedLevels).toBeUndefined();
  });

  it("returns undefined when no catalog is provided", () => {
    const { acts } = bind<SuctionActions>("suction", suctionCtx(undefined, "eufy_home"));
    expect(acts.supportedLevels).toBeUndefined();
  });
});
