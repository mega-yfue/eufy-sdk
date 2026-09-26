import { DISPLAY, DISPLAY_MEMBERS, DISPLAY_PARAM } from "../display.js";
import { CAPABILITY_MODULES, detectCapabilities } from "../index.js";
import { DISPLAY_PARAMS, SECURITY_PARAMS } from "../../param-dictionary.js";
import { namespaceForCodec, paramDef } from "../../param-namespace.js";
import { Device, UNKNOWN_PARAM_PREFIX } from "../../device.js";
import type { ValueMember } from "../members.js";
import { bind } from "./bind.js";

/**
 * The record the live T87A0 reported (2026-09-04, redacted). Six params, and what each one becomes is
 * the whole subject of this file.
 */
const CAPTURED = {
  category: "eufy_mega",
  model: "T87A0",
  deviceType: 1,
  name: "Eufy Smart Display",
  params: {
    8001: "100",
    8002: "1",
    8003: "2.9.05",
    8004: "T8000P0000000000",
    8005: "Smart Display E10",
    8006: "T87A0",
  },
} as const;

/**
 * The Smart Display capability, and the two partitions that make it safe to have.
 *
 * The device is interesting for what it CANNOT do: no P2P path at all, six params in an id range no
 * other line uses, and three of those six illegible from one capture. So most of what is worth pinning
 * here is absence — that nothing was invented, and that nothing from another line can reach it.
 */
/**
 * The names a caller actually gets on `dev.display()`, bound the way a device binds it. Every display id
 * is reported, so only `unexposed` can keep a member off the surface.
 */
const getterNames = (): string[] =>
  Object.keys(
    bind<Record<string, unknown>>("display", {
      channel: 0,
      codec: "display",
      paramIds: new Set(Object.values(DISPLAY_PARAM)),
    }).acts,
  );

describe("display capability", () => {
  it("publishes one typed read, and keeps the rest readable without one", () => {
    // A typed getter is a recommendation, not just a decoding. Only the charge earns one: it is the sole
    // read a caller could not get another way. The identity strings restate what `info` already answers
    // from the registry and the cloud record — their whole evidence is that agreement — and 8003 is
    // `guessed`, which must not reach a surface where a caller cannot see the label.
    expect(getterNames()).toEqual(["battery"]);
    // 8003 is in the SCHEMA all the same, `unexposed`, so its type and its `guessed` label have a home
    // and `getProperty` answers for it. 8005 and 8006 have no spec and are named by the dictionary.
    expect(DISPLAY.properties?.map((p) => p.paramType)).toEqual([8001, 8003]);
    for (const id of [8003, 8005, 8006]) expect(DISPLAY_PARAMS[id]).toBeDefined();
  });

  it("names no param whose meaning one value cannot settle", () => {
    // The device also reported 8002 ("1") and 8004 (a serial-shaped string). `1` fits any flag, and a
    // serial could be the display's or its station's. A name for either would be read downstream as a
    // fact. 8001 was in this list too until the maintainer identified it as the battery — which is the
    // point of the list: it holds what is unknown, not what is unknowable.
    for (const id of [8002, 8004]) {
      expect(DISPLAY_PARAMS[id]).toBeUndefined();
      expect(DISPLAY.properties?.some((p) => p.paramType === id)).toBe(false);
    }
    // An unnamed id is not lost — it arrives as `unknown_8002`, which is what makes the next capture
    // able to identify it the way 8001 was identified.
    expect(Object.keys(DISPLAY_PARAMS).map(Number).sort()).toEqual([8001, 8003, 8005, 8006]);
  });

  it("reads the display's battery off its own id, not the security line's", () => {
    // The two mean the same thing on different wires: a camera's charge is param 1101 in the security
    // space, a display's is 8001 in this one. Reading both from one capability would be a claim that the
    // ecosystems share a param space, which is the door this line was split to close.
    const battery = DISPLAY_MEMBERS.battery as ValueMember;
    expect(battery.param).toBe(8001);
    expect(battery.kind).toBe("percent");
    expect(battery.unit).toBe("%");
    // And the security module is untouched: it still reads 1101 and knows nothing about 8001.
    const security = CAPABILITY_MODULES.battery.properties ?? [];
    expect(security.some((p) => p.paramType === 8001)).toBe(false);
  });

  it("offers no write at all, because no display write is captured", () => {
    // An AIoT write is fire-and-forget: the device acknowledges nothing, so a guessed frame looks
    // exactly like success. Read-only is the honest surface until a capture pins one.
    for (const [name, member] of Object.entries(DISPLAY_MEMBERS)) {
      const m = member as ValueMember;
      expect(m.write, `${name} has a write builder`).toBeUndefined();
      expect(m.writeAs, `${name} declares a setter name`).toBeUndefined();
    }
  });

  it("labels the version-shaped string as the guess it is, and keeps it off the typed surface", () => {
    // "2.9.05" on one device and nothing corroborates the mapping. The two identity ids are `mega`
    // because their VALUES were independently known facts — the retail name and the model code — which
    // is evidence about what an id means, not a shape that suggests it. `battery` is only `verified`:
    // the id is real, but its NAME came from the maintainer rather than the cloud data-point list.
    expect(DISPLAY_PARAMS[8003]?.provenance).toBe("guessed");
    expect(DISPLAY_PARAMS[8001]?.provenance).toBe("verified");
    expect(DISPLAY_PARAMS[8005]?.provenance).toBe("mega");
    expect(DISPLAY_PARAMS[8006]?.provenance).toBe("mega");
    // The label survives into the schema, which is the point of `unexposed` over dropping the member:
    // asked from either side, the answer carries the same provenance.
    expect(DISPLAY.properties?.find((p) => p.paramType === 8003)?.provenance).toBe("guessed");
    // And the guess has no typed getter, which is the rule it would otherwise break.
    expect(getterNames()).not.toContain("softwareVersion");
  });

  it("reads its own id space, not the security dictionary", () => {
    // Asserting the mapping constant is nearly tautological, so this asserts the CONSEQUENCE: a real
    // device's params, named. 8005 and 8006 have no capability spec, so the dictionary is the only thing
    // that can name them — and only the `display` dictionary holds them. Point the codec at `security`
    // and they arrive as `unknown_8005` / `unknown_8006` instead, which is the regression this catches
    // and which asserting the table against itself does not.
    const props = Device.fromRecord("DISPLAYSN", CAPTURED as never).getProperties();
    expect(props.modelName?.value).toBe("Smart Display E10");
    expect(props.modelCode?.value).toBe("T87A0");
    // The charge and the version-shaped string come through their specs, so they would be named either
    // way — but the charge must be a NUMBER, which is the spec's `coerce` and not the dictionary's.
    expect(props.battery?.value).toBe(100);
    expect(props.softwareVersion?.value).toBe("2.9.05");
    // And the two nobody can read are not dropped: they are what makes the next capture able to
    // identify them the way 8001 was identified.
    expect(props[`${UNKNOWN_PARAM_PREFIX}8002`]?.value).toBe("1");
    expect(props[`${UNKNOWN_PARAM_PREFIX}8004`]).toBeDefined();

    // The mapping itself, last: it is what the assertions above ride on, and on its own it would only
    // be the table agreeing with itself.
    expect(namespaceForCodec("display")).toBe("display");
    expect(paramDef("display", 8005)?.name).toBe("modelName");
    expect(paramDef("security", 8005)).toBeUndefined();
    for (const id of Object.values(DISPLAY_PARAM)) {
      expect(SECURITY_PARAMS[id], `security params now claim ${id}`).toBeUndefined();
    }
  });

  it("attaches to a Smart Display that has reported nothing yet", () => {
    // By codec, not by an evidence param. A device on this line has no other capability to carry it, so
    // a unit that has not reported its params should still resolve as a display rather than as nothing.
    expect(detectCapabilities({ model: "T87A0", category: "eufy_mega" } as never, "display")).toContain("display");
  });

  it("stays off every other codec", () => {
    for (const codec of ["camera", "station", "sensor", "lock", "keypad", "vacuum", "mower", "light"] as const) {
      expect(detectCapabilities({ model: "T87A0", name: "Smart Display E10" } as never, codec)).not.toContain(
        "display",
      );
    }
  });
});
