import { describe, it, expect } from "vitest";
import { BATTERY } from "../battery.js";
import { propertiesOf } from "../members.js";
import type { AvailabilityContext } from "../types.js";
import type { Capability } from "../../types.js";

/**
 * A contact / motion sensor proves the `battery` capability from its level param (1101) like a camera,
 * but on a sensor 1101 is a non-cell sentinel, not a fuel gauge, and the sensor has none of the rest of
 * the camera power surface (charging, solar, working/record mode, cell health/temperature). So a sensor
 * must publish NO battery property — not a bogus percentage, not a dozen `unknown` camera reads — while a
 * real battery camera keeps the full surface.
 */
const published = (ctx: AvailabilityContext): number[] => propertiesOf(BATTERY.members!, ctx).map((p) => p.paramType);

const ctxOf = (codec?: AvailabilityContext["codec"]): AvailabilityContext =>
  ({ codec, capabilities: new Set<Capability>(["battery"]) }) as AvailabilityContext;

describe("battery capability on a sensor codec", () => {
  it("withholds every battery member on a sensor — no bogus 1101 level, no stray camera-power reads", () => {
    expect(published(ctxOf("sensor"))).toHaveLength(0);
  });

  it("keeps the full battery surface on a camera (zero regression)", () => {
    const names = published(ctxOf("camera"));
    expect(names).toContain(1101); // the charge level
    expect(names.length).toBeGreaterThan(1);
  });

  it("an unknown codec publishes as before — fails open, like a record with no model", () => {
    expect(published(ctxOf(undefined))).toContain(1101);
  });
});
