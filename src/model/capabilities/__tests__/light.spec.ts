import { LIGHT, LIGHT_CMD, type LightActions } from "../light.js";
import { unobservableMembers } from "../members.js";
import { buildCommand } from "../index.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";
import type { Command } from "../../../core/contracts.js";

/**
 * Resolve an intent the way a device does. A control's write lives on the control, so the barrel — not
 * the module's own `buildCommand` — is where the property path resolves; pinning the capability keeps
 * the answer this module's alone.
 */
const intent = (action: string, value: boolean | number | string, c: CommandContext): Command | undefined =>
  buildCommand(action, value, { ...c, capabilities: new Set(["light"]) });

// Default ctx = an int-string-switch device (e.g. T8442 IndoorOutdoor). jsonCtx = a JSON-switch
// family (deviceType 47 = FloodlightCam T8425).
// Default ctx = an int-string family (deviceType 46 = IndoorOutdoor T8442). jsonCtx = JSON family
// (47 = FloodlightCam T8425). unknownCtx = a spotlight model not in either wire-format table.
const ctx = (channel = 0): CommandContext => ({
  channel,
  codec: "camera",
  deviceType: 46,
  paramIds: new Set<number>(),
});
const jsonCtx = (channel = 0): CommandContext => ({
  channel,
  codec: "camera",
  deviceType: 47,
  paramIds: new Set<number>(),
});
const unknownCtx = (channel = 0): CommandContext => ({
  channel,
  codec: "camera",
  deviceType: 99999,
  paramIds: new Set<number>(),
});

describe("light capability module", () => {
  it("declares the capability + schema", () => {
    expect(LIGHT.capability).toBe("light");
    // `colorTemp` is absent: write-only, with no read measured. The master switch's own read evidence is
    // in the describe below.
    expect(LIGHT.properties.map((p) => p.name)).toEqual(["light", "brightness", "spotlightEnabled"]);
  });

  it("detects only from real SPOTLIGHT params (NOT 1045 status LED)", () => {
    // 1045 (status LED, on every camera) must NOT be here — that's `camera`, not `light`.
    expect(LIGHT.detection?.evidenceParams).not.toContain(1045);
    expect(LIGHT.detection?.evidenceParams).toEqual(expect.arrayContaining([1400, 6080, 1401]));
    const re = LIGHT.detection!.modelHints![0];
    expect(re.test("Floodlight Cam")).toBe(true);
    expect(re.test("Wired Doorbell")).toBe(false);
  });

  describe("buildCommand — variant resolution", () => {
    it("on/off on a JSON-switch family (T8425) → set-json floodlight switch", () => {
      expect(intent("on", true, jsonCtx(3))).toEqual({
        kind: "set-json",
        param: LIGHT_CMD.FLOODLIGHT_SWITCH,
        data: { time: 0, type: 2, value: 1 },
        channel: 3,
      });
      expect((intent("off", false, jsonCtx()) as Extract<Command, { kind: "set-json" }>).data).toEqual({
        time: 0,
        type: 2,
        value: 0,
      });
    });

    it("on/off on an int-string family (T8442/default) → set-param pinned to int-string (1400)", () => {
      expect(intent("on", true, ctx(2))).toEqual({
        kind: "set-param",
        param: LIGHT_CMD.FLOODLIGHT_SWITCH,
        value: 1,
        form: "int-string",
        channel: 2,
      });
      expect(intent("off", false, ctx())).toMatchObject({
        kind: "set-param",
        form: "int-string",
        value: 0,
      });
    });

    it("on/off on a T8423 floodlight (deviceType 38) → set-param pinned to int-string (1400)", () => {
      expect(intent("on", true, { ...ctx(), deviceType: 38 })).toEqual({
        kind: "set-param",
        param: LIGHT_CMD.FLOODLIGHT_SWITCH,
        value: 1,
        form: "int-string",
        channel: 0,
      });
    });

    it("spotlightEnabled on a T8423 (deviceType 38) → int-string 1403; brightness stays direct-binary", () => {
      const t8423 = { ...ctx(), deviceType: 38 };
      expect(intent("spotlightEnabled", false, t8423)).toEqual({
        kind: "set-param",
        param: LIGHT_CMD.SPOTLIGHT_ENABLE,
        value: 0,
        form: "int-string",
        channel: 0,
      });
      expect(intent("brightness", 50, t8423)).toMatchObject({ form: "direct-binary" });
    });

    it("brightness/colorTemp/enabled → set-param pinned to direct-binary with the right param", () => {
      expect(intent("brightness", 50, ctx())).toEqual({
        kind: "set-param",
        param: LIGHT_CMD.SPOTLIGHT_BRIGHTNESS,
        value: 50,
        form: "direct-binary",
        channel: 0,
      });
      expect(intent("colorTemp", 80, ctx())).toMatchObject({
        kind: "set-param",
        param: LIGHT_CMD.SPOTLIGHT_COLOR_TEMP,
        form: "direct-binary",
        value: 80,
      });
      expect(intent("spotlightEnabled", true, ctx())).toMatchObject({
        kind: "set-param",
        param: LIGHT_CMD.SPOTLIGHT_ENABLE,
        form: "direct-binary",
        value: 1,
      });
    });

    it("rejects a brightness outside 1..100 and a color-temp outside 0..100 rather than clamping", () => {
      expect(() => intent("brightness", 0, ctx())).toThrow(
        /brightness: 0 is not a valid value \(must be in 1\.\.100\)/,
      );
      expect(() => intent("brightness", 250, ctx())).toThrow(
        /brightness: 250 is not a valid value \(must be in 1\.\.100\)/,
      );
      expect(() => intent("colorTemp", -10, ctx())).toThrow(
        /colorTemp: -10 is not a valid value \(must be in 0\.\.100\)/,
      );
      expect(() => intent("colorTemp", 999, ctx())).toThrow(
        /colorTemp: 999 is not a valid value \(must be in 0\.\.100\)/,
      );
      expect(intent("brightness", 1, ctx())).toMatchObject({ value: 1 });
      expect(intent("colorTemp", 0, ctx())).toMatchObject({ value: 0 });
    });

    it("autoSpotlight is NOT a bare bool property or a buildCommand action (composite/write-only footgun)", () => {
      // A plain toggle would re-send hardcoded defaults and clobber the user's config, so it's ONLY the
      // explicit setAutoSpotlight(on, opts) setter — buildCommand/setProperty must not accept it.
      expect(LIGHT.properties.map((p) => p.name)).not.toContain("autoSpotlight");
      expect(intent("autoSpotlight", true, jsonCtx(3))).toBeUndefined();
    });

    it("returns undefined for an unknown action", () => {
      expect(intent("totally_unknown", 1, ctx())).toBeUndefined();
    });

    it("on/off on a model NOT in either wire-format table → throws the model as the reason (don't guess)", () => {
      // A spotlight was detected but this deviceType's switch wire format is unknown → refuse
      // rather than silently send the wrong format (the silent-no-op bug). The refusal names the
      // MODEL, which a generated "not a valid value" over a boolean could never say.
      expect(() => intent("on", true, unknownCtx())).toThrow(/light: unknown spotlight switch wire format/);
      expect(() => intent("light", false, unknownCtx())).toThrow(/light: unknown spotlight switch wire format/);
    });

    it("the on()/off() verbs reject rather than throwing synchronously on such a model", async () => {
      const { acts, sent } = bind<LightActions>("light", unknownCtx());
      await expect(acts.on()).rejects.toThrow(/light: unknown spotlight switch wire format/);
      await expect(acts.off()).rejects.toThrow(/light: unknown spotlight switch wire format/);
      await expect(acts.set(true)).rejects.toThrow(/light: unknown spotlight switch wire format/);
      expect(sent).toEqual([]);
    });
  });

  describe("actions → dispatch the resolved Command through the sink", () => {
    it("on() dispatches the resolved switch command; the derived setBrightness → direct-binary", async () => {
      const { acts, sent } = bind<LightActions>("light", ctx(2)); // int-string family
      await acts.on();
      await acts.setBrightness!(40);
      expect(sent[0]).toMatchObject({
        kind: "set-param",
        param: LIGHT_CMD.FLOODLIGHT_SWITCH,
        form: "int-string",
        channel: 2,
      });
      expect(sent[1]).toMatchObject({
        kind: "set-param",
        param: LIGHT_CMD.SPOTLIGHT_BRIGHTNESS,
        form: "direct-binary",
        value: 40,
      });
    });

    it("setAutoSpotlight(on) sends the 1422 composite; opts override the carried brightness/time/mode", async () => {
      const sent: Command[] = [];
      const acts = LIGHT.actions!({
        ctx: jsonCtx(3),
        sink: { dispatch: async (c) => void sent.push(c) },
        read: () => undefined,
      });
      await acts.setAutoSpotlight!(true); // no opts → captured defaults
      expect(sent[0]).toMatchObject({
        kind: "set-payload",
        cmd: LIGHT_CMD.MOTION_ACTIVATE_LIGHT, // 1422
        channel: 3,
        mValue3: 0,
        payload: { enable: 1, brightness: 50, time: 30, mode: 1 },
      });
      await acts.setAutoSpotlight!(false, { brightness: 80, time: 120 }); // caller preserves config
      expect((sent[1] as Extract<Command, { kind: "set-payload" }>).payload).toMatchObject({
        enable: 0,
        brightness: 80,
        time: 120,
      });
    });
  });
});

/**
 * The spotlight MASTER switch is reported, so it is a read as well as a write.
 *
 * The read is what earns it a schema entry, a getter, and an announcement when its value moves. Measured
 * on a T8170: the cloud device list carries param 1403 and its value tracks the vendor app's "spotlight"
 * setting in both directions, `1 -> 0` when the setting is switched off and `0 -> 1` when it is switched
 * back on. `pollChanges` only reports a param whose PREVIOUS value differed, so the id was already in the
 * snapshot rather than newly appearing. The SDK's own param dictionary agrees, naming 1403
 * `floodlightTotalSwitch` (`app:FLOODLIGHT_TOTAL_SWITCH`) and listing the T8170 among its models.
 *
 * Distinct from `isOn` (1400), which is the momentary lighting and is bound to whichever client is
 * streaming — the vendor app lights the lamp for a live view and drops it on quitting. The master switch
 * is the SETTING a user changes and expects to stay changed, which is why it is the one a host has to be
 * told about.
 */
describe("the spotlight master switch is a read, not write-only", () => {
  const reporting = (): CommandContext => ({
    channel: 0,
    codec: "camera",
    deviceType: 46,
    paramIds: new Set([LIGHT_CMD.SPOTLIGHT_ENABLE]),
  });

  it("publishes a property for it, so a device reporting it can be read and announced", () => {
    const spec = LIGHT.properties.find((p) => p.name === "spotlightEnabled");
    expect(spec).toMatchObject({ paramType: LIGHT_CMD.SPOTLIGHT_ENABLE, type: "bool", kind: "boolean" });
    expect(spec!.writable).toBe(true);
  });

  it("installs a getter on a device that reported it, reading the polarity measured live", () => {
    const { acts } = bind<LightActions>("light", reporting(), {
      read: (name) => (name === "spotlightEnabled" ? { value: true } : undefined),
    });
    expect(acts.spotlightEnabled).toBe(true);
  });

  it("keeps its setter under the name the key would not derive", () => {
    const { acts } = bind<LightActions>("light", reporting());
    expect(typeof acts.setEnabled).toBe("function");
  });

  /**
   * `unobservableMembers` is a STATEMENT to a caller — "this is accepted and never reported back" — so
   * leaving it there would publish the very claim the measurement disproves.
   */
  it("no longer claims the device never reports it back", () => {
    const { acts } = bind<LightActions>("light", reporting());
    expect(unobservableMembers(acts as object)).not.toContain("spotlightEnabled");
  });
});
