/**
 * What a param application is worth ANNOUNCING — the changed properties a host can be told about, with
 * the value the getter now answers.
 *
 * `applyParams` already returns the property names whose value moved, resolved through the family-gated
 * `specByParam` map with alias promotion, per-model enums and per-id polarity applied. This is the
 * second half: which of those names the SDK will stand behind, and the value beside each.
 *
 * The rules under test are the ones a caller relies on. Only a SCHEMA property is announced, because
 * the schema is what the SDK published and `getProperty` serves every entry — a dictionary-named or
 * `unknown_<pt>` param is a thing the SDK makes no claim about. The value comes out of live state
 * through the SAME narrowing the getter uses, never a second conversion of the wire value, so the
 * payload cannot disagree with the getter beside it. And EVERY schema property is announced: there is no
 * per-member opt-out and no central filter on `kind`.
 */
import { parseThingsList } from "../capabilities/thing-description.js";
import { describe, it, expect } from "vitest";
import { Device, UNKNOWN_PARAM_PREFIX } from "../index.js";
import type { CloudRecord } from "../index.js";

/**
 * A battery camera: reports its level (1101), its motion detection (1011) and its enablement (1035).
 *
 * A eufyCam, and the model matters: a mains camera reports 1101 as a sentinel, so the battery reads are
 * withheld from its schema and there is no `battery` property for this file to announce. The fixture
 * has to name hardware that actually has a cell.
 */
const camera: CloudRecord = { deviceType: 9, model: "T8114", params: { 1101: "50", 1011: "1", 1035: "0" } };

/** Announce whatever applying `params` moved — the two calls the client makes, as one step. */
const announce = (dev: Device, params: Record<number, string>) => dev.announcements(dev.applyParams(params));

describe("Device.announcements", () => {
  it("announces a changed camera Wi-Fi signal through the existing numeric read", () => {
    const dev = Device.fromRecord("sn", { ...camera, params: { 1142: "-62" } });
    expect(announce(dev, { 1142: "-55" })).toEqual([{ property: "wifiRssi", value: -55 }]);
  });

  it("names a changed schema property and the value its getter now answers", () => {
    const dev = Device.fromRecord("sn", camera);

    expect(announce(dev, { 1101: "60" })).toEqual([{ property: "battery", value: 60 }]);
  });

  /**
   * The value is read out of live state, not re-derived from the wire — so a `bool` whose param is a
   * disable flag is announced in the polarity the getter answers in, with no second copy of the
   * convention to drift from it. 1035 is the camera's disable bit: raw `"1"` reads as NOT enabled.
   */
  it("announces a value in the polarity the getter reads it in", () => {
    const things = parseThingsList({
      things_list: [{ profile: { product_code: "T0000" }, properties: [{ identifier: "camera_on_off" }] }],
    }).T0000;
    const dev = Device.fromRecord("sn", { ...camera, things });

    expect(announce(dev, { 1035: "1" })).toEqual([{ property: "enabled", value: false }]);
  });

  it("says nothing about a property whose value did not move", () => {
    const dev = Device.fromRecord("sn", camera);

    expect(announce(dev, { 1101: "50" })).toEqual([]);
  });

  /**
   * A param the dictionary names but no capability claims on this device is NOT announced: nothing
   * published it, so announcing it would promise a value the SDK never agreed to serve. Diagnostics
   * reach it through `inspectDevice`.
   */
  it("declines a dictionary-named param that is not in this device's schema", () => {
    const dev = Device.fromRecord("sn", camera);
    const dictionaryOnly = 1019; // named `enableHdr` in SECURITY_PARAMS, claimed by no capability

    const changed = dev.applyParams({ [dictionaryOnly]: "1" });

    expect(changed).toEqual(["enableHdr"]);
    expect(dev.announcements(changed)).toEqual([]);
  });

  it("declines an unknown_<pt> passthrough", () => {
    const dev = Device.fromRecord("sn", camera);

    const changed = dev.applyParams({ 999999: "whatever" });

    expect(changed).toEqual([`${UNKNOWN_PARAM_PREFIX}999999`]);
    expect(dev.announcements(changed)).toEqual([]);
  });

  /**
   * A stored value that is not its declared type answers `undefined` rather than a lie — the same
   * guarantee the getter gives. A HomeBase sometimes returns a string where a scalar is expected, and
   * `coerceByType` keeps it raw so the mismatch stays visible.
   */
  it("names the property with no value when the stored value is not its declared type", () => {
    const dev = Device.fromRecord("sn", camera);

    expect(announce(dev, { 1101: "not-a-number" })).toEqual([{ property: "battery" }]);
  });

  /**
   * A property whose stored value is a PAYLOAD rather than the value is announced by name alone.
   * Shipping a config blob as if it were the value would be worse than saying "this moved, re-read it";
   * the flag for it is `PropertySpec.raw`, which `propertiesOf` sets on exactly those specs.
   */
  it("names a payload-backed property with no value", () => {
    const dev = Device.fromRecord("sn", {
      deviceType: 9,
      model: "T8410",
      params: { 1271: Buffer.from(JSON.stringify({ time_out: 60 })).toString("base64") },
    });

    const announced = announce(dev, { 1271: Buffer.from(JSON.stringify({ time_out: 120 })).toString("base64") });

    expect(announced).toEqual([{ property: "snoozeTime" }]);
  });

  /**
   * EVERY schema property, with no per-member opt-out and no central filter on `kind`.
   *
   * An entry sensor's `lastSeen` moves whenever the sensor checks in, which duplicates what
   * `deviceState` already carries — so a caller that wants liveness reads that instead. Which of a
   * device's truths a host acts on is the host's call, not a judgement this SDK makes on its behalf:
   * suppressing a value here means a caller that DOES want it (a robot's live clean progress is the
   * clear case) cannot get it at all, and the alternative costs that caller one `if` on the name.
   */
  it("announces every changed schema property, liveness included", () => {
    const dev = Device.fromRecord("sn", {
      model: "T8900",
      category: "eufy_security",
      params: { 1550: "0", 1551: "1" },
    });

    expect(announce(dev, { 1550: "1", 1551: "2" })).toEqual([
      { property: "contact", value: true },
      { property: "lastSeen", value: 2 },
    ]);
  });

  /** A name the device does not hold at all is declined rather than announced with no value. */
  it("declines a name that is not this device's property", () => {
    const dev = Device.fromRecord("sn", camera);

    expect(dev.announcements(["notAProperty"])).toEqual([]);
  });
});
