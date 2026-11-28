import { actionSpecOf } from "../access.js";
import { detectCapabilities } from "../index.js";
import type { CommandContext } from "../types.js";
import { TREAT, TREAT_PARAM, type TreatActions } from "../treat.js";
import { bind } from "./bind.js";

function treatCtx(model = "T7200", paramIds: ReadonlySet<number> = new Set([TREAT_PARAM.LAST_TOSS])): CommandContext {
  return { channel: 2, codec: "camera", deviceType: 72, model, paramIds };
}

describe("treat capability module", () => {
  it("declares the capability and its schema", () => {
    expect(TREAT.capability).toBe("treat");
    expect(TREAT.properties.map((p) => [p.name, p.paramType])).toEqual([["lastTossAt", 8103]]);
  });

  it("is detected from the last-toss param, or from the dog-camera device type", () => {
    expect(detectCapabilities({ params: { 8103: "1763000000" } }, "camera")).toContain("treat");
    expect(detectCapabilities({ deviceType: 72, params: {} }, "camera")).toContain("treat");
  });

  it("is not detected on an ordinary camera", () => {
    expect(detectCapabilities({ deviceType: 31, params: { 1101: "80" } }, "camera")).not.toContain("treat");
  });
});

describe("treat — toss", () => {
  // The values are the ones confirmed on the device (near short, middle, far long), written out rather than read
  // from the module's table, so a swap in the table fails here.
  it.each([
    ["near", 1],
    ["middle", 2],
    ["far", 3],
  ] as const)("tosses at %s as one set-payload marked once, with value %i", async (name, value) => {
    const { acts, sent } = bind<TreatActions>("treat", treatCtx());
    await acts.toss!(name);
    expect(sent).toEqual([{ kind: "set-payload", cmd: 7001, payload: { value }, channel: 2, once: true }]);
  });

  it.each(["medium", "toString", 2])("rejects distance %s without sending anything", async (distance) => {
    const { acts, sent } = bind<TreatActions>("treat", treatCtx());
    await expect(acts.toss!(distance as never)).rejects.toThrow("is not one of near, middle, far");
    expect(sent).toEqual([]);
  });

  it("is offered only on the model it was confirmed on", () => {
    expect(bind<TreatActions>("treat", treatCtx("T7200")).acts.toss).toBeDefined();
    expect(bind<TreatActions>("treat", treatCtx("T7203")).acts.toss).toBeUndefined();
    const noModel: CommandContext = { channel: 0, codec: "camera", deviceType: 72, paramIds: new Set() };
    expect(bind<TreatActions>("treat", noModel).acts.toss).toBeUndefined();
  });

  it("is not offered on a camera attached to a HomeBase", () => {
    const attached: CommandContext = { ...treatCtx(), homeBaseAttached: true };
    expect(bind<TreatActions>("treat", attached).acts.toss).toBeUndefined();
    const own: CommandContext = { ...treatCtx(), homeBaseAttached: false };
    expect(bind<TreatActions>("treat", own).acts.toss).toBeDefined();
  });

  it("is not offered where the device's transport refuses a set-payload", () => {
    const refused: CommandContext = { ...treatCtx(), refusedCommandKinds: new Set(["set-payload"]) };
    expect(bind<TreatActions>("treat", refused).acts.toss).toBeUndefined();
  });

  it("describes the distance argument with the three names", () => {
    const { acts } = bind<TreatActions>("treat", treatCtx());
    expect(actionSpecOf(acts.toss)).toMatchObject({
      form: "momentary",
      args: [{ name: "distance", kind: "enum", values: ["near", "middle", "far"] }],
    });
  });
});

describe("treat — last toss", () => {
  it("reads the last-toss time as a number of seconds", () => {
    const { acts } = bind<TreatActions>("treat", treatCtx(), {
      read: (name) => (name === "lastTossAt" ? { value: 1763000000 } : undefined),
    });
    expect(acts.lastTossAt).toBe(1763000000);
  });

  it("has no getter on a device that has not reported the param", () => {
    const { acts } = bind<TreatActions>("treat", treatCtx("T7200", new Set()));
    expect("lastTossAt" in (acts as object)).toBe(false);
  });
});
