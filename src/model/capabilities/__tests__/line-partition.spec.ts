import { buildCommand, detectCapabilities, CAPABILITY_MODULES } from "../index.js";
import type { Capability, Codec } from "../../types.js";

/**
 * The product-line partition: a capability may only land on a device from its own ecosystem.
 *
 * eufy's retail vocabulary collides across ecosystems that share nothing but a cloud account: the
 * T8L20 smart light is sold as "Outdoor Spotlights E10", which matches the camera-spotlight
 * capability's name hint exactly. Detection evidence is OR-ed and several capabilities match on NAME
 * alone, so the partition is what keeps a device from being handed a capability whose wire it cannot
 * speak.
 */

/** Which line each codec belongs to, restated here so a change to the source map has to be deliberate. */
const EXPECTED_LINE: Record<Codec, string> = {
  station: "security",
  camera: "security",
  sensor: "security",
  lock: "security",
  keypad: "security",
  vacuum: "clean",
  mower: "clean",
  light: "life",
  printer: "print",
  display: "display",
  tracker: "tracker",
};

/** A name stuffed with trigger words from every line at once — the adversarial case. */
const POISONED = "Outdoor Spotlights Floodlight Waterfall Leak Smoke Carbon Siren Lock Safe Doorbell Vacuum";

const CODECS = Object.keys(EXPECTED_LINE) as Codec[];

function lineOf(cap: Capability): string {
  return CAPABILITY_MODULES[cap].line ?? "security";
}

describe("product-line partition", () => {
  it.each(CODECS)("never crosses lines on a %s, even with a name poisoned by every line's vocabulary", (codec) => {
    const caps = detectCapabilities(
      { model: "T8000P0000000000", category: "eufy_life", name: POISONED } as never,
      codec,
    );
    const crossed = caps.filter((c) => {
      const line = lineOf(c);
      return line !== "any" && line !== EXPECTED_LINE[codec];
    });
    expect(crossed).toEqual([]);
  });

  it("gives a poisoned Smart Display name nothing but its own line", () => {
    // This test used to pin the OPPOSITE, and the change is the point of `display` being its own line.
    // While the codec was grouped into `security`, a poisoned name attached six security capabilities —
    // light, doorbell, leak, smoke, co, lock — because detection evidence is OR-ed and each of those
    // matches on NAME alone. None was reachable: this device speaks no P2P at all, so every one of them
    // was a control that could never answer. The generic it.each above could not catch it either, since
    // a security capability on a security-line codec is not a "cross" by its own definition.
    //
    // Kept as an explicit assertion rather than deleted, because the guard that matters is the exact
    // SET: a new security module whose modelHints matched this text would be invisible to a `crossed`
    // check that is empty either way.
    const caps = detectCapabilities({ model: "T87A0", category: "eufy_mega", name: POISONED } as never, "display");
    expect(caps).toEqual(["display", "info"]);
  });

  it("keeps a smart light off the camera-spotlight capability while granting its own", () => {
    const caps = detectCapabilities(
      { model: "T8L20", category: "eufy_life", name: "Outdoor Spotlights E10" } as never,
      "light",
    );
    expect(caps).toContain("smart_light");
    expect(caps).not.toContain("light");
    expect(caps).not.toContain("camera");
  });

  it("keeps a camera off the smart-light capability (the reverse direction)", () => {
    const caps = detectCapabilities(
      { model: "T8425", category: "eufy_security", name: "Floodlight Cam", params: { 1400: "1" } } as never,
      "camera",
    );
    expect(caps).toContain("light");
    expect(caps).not.toContain("smart_light");
  });

  it("blocks a life capability from a security codec even when its own evidence matches", () => {
    // Without the partition this passes on `codecs: ["light"]` alone, so the codec baseline is fed the
    // life value while the device is classified security — the one input that isolates the line check
    // from every other guard.
    expect(detectCapabilities({ model: "T8L02", category: "eufy_life" } as never, "light")).toContain("smart_light");
    expect(detectCapabilities({ model: "T8L02", category: "eufy_life" } as never, "sensor")).not.toContain(
      "smart_light",
    );
  });

  it("still grants a line-agnostic capability everywhere", () => {
    for (const codec of CODECS) {
      expect(detectCapabilities({ model: "T8000P0000000000" } as never, codec)).toContain("info");
    }
  });

  it("puts a codec-less device on no line at all — only the line-agnostic capabilities may match", () => {
    // A separate ecosystem (its own account and backend) has no truthful codec, so it omits the field
    // rather than borrowing a eufy family's. Every line-bearing module is then unreachable, including
    // the ones a name or a param id would otherwise match on its own.
    const rec = { model: "T8000P0000000000", name: POISONED, params: { 1011: "1" } } as never;
    const caps = detectCapabilities(rec, undefined);
    for (const cap of caps) expect(lineOf(cap), cap).toBe("any");
    // The same record WITH a codec resolves plenty, so the absent codec is what withheld them.
    expect(detectCapabilities(rec, "camera").length).toBeGreaterThan(caps.length);
    // And no command can be built for a capability the device is not credited with.
    expect(buildCommand("motionDetection", true, { channel: 0, paramIds: new Set([1011]) })).toBeUndefined();
    expect(
      buildCommand("motionDetection", true, { codec: "camera", channel: 0, paramIds: new Set([1011]) }),
    ).toBeDefined();
  });

  it("pins each non-security module's declared line, so a silent retag fails here", () => {
    // `lineOf` defaults to "security", so asserting membership of the union would pass for any module
    // that simply forgot to declare one. Pin the modules that must NOT be security instead.
    expect(CAPABILITY_MODULES.smart_light.line).toBe("life");
    expect(CAPABILITY_MODULES.vacuum_clean.line).toBe("clean");
    expect(CAPABILITY_MODULES.suction.line).toBe("clean");
    expect(CAPABILITY_MODULES.locate.line).toBe("clean");
    expect(CAPABILITY_MODULES.display.line).toBe("display");
    expect(CAPABILITY_MODULES.info.line).toBe("any");
    for (const cap of Object.keys(CAPABILITY_MODULES) as Capability[]) {
      expect(["security", "life", "clean", "print", "display", "any"]).toContain(lineOf(cap));
    }
  });
});
