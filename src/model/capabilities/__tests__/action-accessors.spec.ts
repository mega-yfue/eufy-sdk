import { ACTION_ACCESSOR_NAMES, accessorNamesFor, buildActions, CAPABILITY_MODULES } from "../index.js";
import type { CapabilityModule, CommandContext } from "../types.js";
import type { Capability } from "../../types.js";
import type { CommandSink } from "../../../core/contracts.js";

const MODULES = Object.values(CAPABILITY_MODULES);

/**
 * Whether a module has anything to bind an accessor onto. Either shape is enough: `battery` is all
 * members, `ptz` all hand-written actions, `camera` both.
 */
const bindable = (m: CapabilityModule): boolean => Boolean(m.actions || m.members);

/**
 * Guards the two sources of truth for the fluent-accessor set from drifting apart:
 *   - `DeviceActionMap` (the typed surface, erased at build) and
 *   - `ACTION_ACCESSOR_NAMES` (the runtime list `Device` installs from `MODULES`).
 * They're kept in sync only by convention (`camelCase(module.capability) as keyof DeviceActionMap`
 * casts, hiding a missed map entry). This locks the expected set: adding/removing a capability with
 * an `actions()` factory fails here, forcing a conscious edit of BOTH the map and this list.
 */
const EXPECTED_ACCESSORS = [
  "arming",
  "audio",
  "battery",
  "camera",
  "co",
  "contact",
  "display",
  "doorbell",
  "suction",
  "mower",
  "info",
  "keypad",
  "leak",
  "light",
  "locate",
  "lock",
  "motion",
  "ptz",
  "rtsp",
  "siren",
  "smartLight",
  "smoke",
  "vacuumClean",
  "vacuumDock",
] as const;

describe("fluent capability accessors — type/runtime coupling", () => {
  it("ACTION_ACCESSOR_NAMES is exactly the expected accessor set", () => {
    expect([...ACTION_ACCESSOR_NAMES].sort()).toEqual([...EXPECTED_ACCESSORS].sort());
  });

  it("every runtime accessor name is a camelCased id of a module that has a bindable surface", () => {
    const withSurface = MODULES.filter(bindable).map((m) =>
      m.capability.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
    );
    expect([...ACTION_ACCESSOR_NAMES].sort()).toEqual(withSurface.sort());
  });

  it("buildActions installs exactly the accessor names for a device that HAS every capability", () => {
    const ctx: CommandContext = { channel: 0, codec: "camera", paramIds: new Set() };
    const sink: CommandSink = { dispatch: async () => {} };
    const caps = MODULES.filter(bindable).map((m) => m.capability);
    const actions = buildActions(caps, { ctx, sink, read: () => undefined });
    expect(Object.keys(actions).sort()).toEqual([...EXPECTED_ACCESSORS].sort());
  });
});

describe("accessorNamesFor — a device carries only what it can answer for", () => {
  it("gives a light its own accessors and none from another line", () => {
    const names = accessorNamesFor(new Set<Capability>(["smart_light", "info"]));
    expect(names).toEqual(["smartLight", "info"]);
    expect(names).not.toContain("camera");
    expect(names).not.toContain("light");
    expect(names).not.toContain("ptz");
  });

  it("is a subset of the full name list, never inventing one", () => {
    const all = new Set(ACTION_ACCESSOR_NAMES);
    for (const cap of Object.keys(CAPABILITY_MODULES) as Capability[]) {
      for (const n of accessorNamesFor(new Set([cap]))) expect(all.has(n)).toBe(true);
    }
  });

  it("returns nothing for a device with no capabilities", () => {
    expect(accessorNamesFor(new Set())).toEqual([]);
  });

  /**
   * The name list is built from modules with a members table or an `actions()` factory; a capability that
   * is pure detection has no accessor to install.
   */
  it("omits a capability with nothing to bind", () => {
    const bare = (Object.keys(CAPABILITY_MODULES) as Capability[]).filter((c) => !bindable(CAPABILITY_MODULES[c]));
    for (const cap of bare) expect(accessorNamesFor(new Set([cap]))).toEqual([]);
  });
});
