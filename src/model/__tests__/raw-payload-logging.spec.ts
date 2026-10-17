import { describe, expect, it, vi } from "vitest";
import { Device } from "../device.js";
import { VACUUM_CLEAN } from "../capabilities/vacuum-clean.js";
import type { Logger } from "../../core/logger.js";
import type { ResolvedDevice } from "../types.js";

/**
 * A Raw-DP property is not a misdeclared one.
 *
 * Every structured payload on the clean line is declared by what its getter ANSWERS — nine consumable
 * counters are `"number"` over one base64 string, because a caller asking for hours gets a number. The
 * value must reach storage untouched all the same, and it does: a non-numeric string cannot be coerced
 * to a number, so it passes through. What used to happen is that the pass-through was announced as a
 * mistake, once per property per push — which is how a warning that means something goes unread.
 */

const RESOLVED: ResolvedDevice = {
  codec: "vacuum",
  capabilities: ["vacuum_clean"],
  properties: [
    { name: "sideBrushHours", paramType: 168, type: "number", writable: false, raw: true },
    { name: "childLock", paramType: 176, type: "bool", writable: false, raw: true },
    { name: "battery", paramType: 163, type: "number", writable: false },
  ],
  name: "vac",
  source: "model",
};

const spy = (): { logger: Logger; warn: ReturnType<typeof vi.fn> } => {
  const warn = vi.fn();
  return { logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }, warn };
};

describe("storing a Raw-DP payload", () => {
  it("keeps the payload intact and says nothing about it", () => {
    const { logger, warn } = spy();
    const dev = new Device("T8000P0000000000", RESOLVED, logger);
    const payload = "CgQIAxAB";

    dev.applyParams({ 168: payload });

    expect(dev.getProperty("sideBrushHours")?.value).toBe(payload);
    expect(warn).not.toHaveBeenCalled();
  });

  it("still reports a genuinely misdeclared scalar", () => {
    // The warning has to keep working where it means something: a property declared numeric whose wire
    // value is neither a payload nor a number. Silencing that too would trade one unread warning for
    // no warning at all.
    const { logger, warn } = spy();
    const dev = new Device("T8000P0000000000", RESOLVED, logger);

    dev.applyParams({ 163: "not-a-number" });

    expect(warn).toHaveBeenCalledOnce();
    expect(dev.getProperty("battery")?.value).toBe("not-a-number");
  });

  it("leaves a numeric value on a raw property alone", () => {
    // Some clean-line members answer from either a protobuf payload or a plain Tuya scalar, so a raw
    // property can legitimately receive a number. Marking it raw must not stop that being stored.
    const { logger } = spy();
    const dev = new Device("T8000P0000000000", RESOLVED, logger);

    dev.applyParams({ 168: 42 });

    expect(dev.getProperty("sideBrushHours")?.value).toBe(42);
  });
});

describe("storing a Raw-DP payload whose getter answers a boolean", () => {
  // DP 176 and DP 157 are protobuf messages owned by members that answer `bool` (childLock,
  // doNotDisturb). Coercing the payload as a boolean stored `false` and left every read off it blank.

  it("keeps the payload intact", () => {
    const dev = new Device("T8000P0000000000", RESOLVED);
    const payload = "BgoCCAEaAA==";

    dev.applyParams({ 176: payload });

    expect(dev.getProperty("childLock")?.value).toBe(payload);
  });

  it("still coerces a boolean wire form a plain scalar alias sends", () => {
    const dev = new Device("T8000P0000000000", RESOLVED);

    dev.applyParams({ 176: "1" });
    expect(dev.getProperty("childLock")?.value).toBe(true);

    dev.applyParams({ 176: "false" });
    expect(dev.getProperty("childLock")?.value).toBe(false);
  });
});

describe("which properties the capability marks raw", () => {
  const byName = (n: string) => VACUUM_CLEAN.properties.find((p) => p.name === n);

  it("marks every member that decodes a payload in its getter", () => {
    for (const name of ["sideBrushHours", "scheduleCount", "sceneCount", "cleanType", "doNotDisturb"]) {
      expect(byName(name)?.raw, name).toBe(true);
    }
  });

  it("leaves a plain scalar unmarked", () => {
    for (const name of ["battery", "volume", "power"]) {
      expect(byName(name)?.raw, name).toBeUndefined();
    }
  });

  it("keeps declaring what the getter answers, not what the wire carries", () => {
    // The flag says how to STORE the value; `type` goes on describing the reading, which is what a
    // caller enumerating the schema needs.
    expect(byName("sideBrushHours")?.type).toBe("number");
    expect(byName("sideBrushHours")?.unit).toBe("h");
  });
});
