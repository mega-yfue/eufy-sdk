import { KEYPAD, KEYPAD_MEMBERS, type KeypadActions } from "../keypad.js";
import { bind } from "./bind.js";
import type { Capability } from "../../types.js";

describe("keypad capability module", () => {
  it("declares the capability + schema", () => {
    expect(KEYPAD.capability).toBe("keypad");
    expect(KEYPAD.properties.map((p) => p.name)).toEqual(["batteryLow", "charging"]);
  });

  it("is the keypad-codec baseline", () => {
    expect(KEYPAD.detection?.codecs).toEqual(["keypad"]);
  });
});

describe("keypad battery params", () => {
  it("reads `charging` from APP_CMD_KEYPAD_BATTERY_CHARGER_STATE (1655) as value ∉ {0,2} — matching the app decode", () => {
    const charging = KEYPAD.properties.find((p) => p.name === "charging");
    expect(charging?.paramType).toBe(1655);
    const decode = charging?.decode;
    expect(decode).toBeDefined();
    expect(decode!("0")).toBe(false);
    expect(decode!("2")).toBe(false);
    expect(decode!("1")).toBe(true);
    expect(decode!("3")).toBe(true);
  });

  it("keeps `batteryLow` on APP_CMD_KEYPAD_BATTERY_CAP_STATE (1653) out of the typed surface", () => {
    expect(KEYPAD.properties.find((p) => p.name === "batteryLow")?.paramType).toBe(1653);
    expect(KEYPAD_MEMBERS.batteryLow.unexposed).toBe(true);
  });

  it("binds a `charging` getter on a keypad reporting 1655, and no `batteryLow` getter", () => {
    const { acts } = bind<KeypadActions>(
      "keypad",
      {
        channel: 0,
        codec: "keypad",
        capabilities: new Set<Capability>(["keypad"]),
        paramIds: new Set([1141, 1653, 1655]),
      },
      { read: (name) => (name === "charging" ? { value: true } : undefined) },
    );
    expect(acts.charging).toBe(true);
    expect("batteryLow" in acts).toBe(false);
  });
});
