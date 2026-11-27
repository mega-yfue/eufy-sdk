import { bind } from "./bind.js";
import { buildCommand } from "../index.js";
import type { Command } from "../../../core/contracts.js";
import type { CommandContext } from "../types.js";

/**
 * A setting whose command kind the device's transport REFUSES must NOT advertise a setter, while the
 * setting's READ stays installed. A device reached over a narrow portal (an RTC-control station, or a
 * media-only route) refuses some of the portal command kinds; a setter whose kind the portal would
 * refuse throws at dispatch though the setting reports itself writable.
 *
 * Probed through the `camera` capability, which carries both a `set-param` setter (`imageFlipped`, wire
 * 1207) and a `set-json` setter (`soundDetection`, wire 6043) beside their read getters.
 */
const IMAGE_FLIPPED = 1207; // CAMERA_CMD.ROTATE_IMAGE → set-param
const SOUND_DETECTION = 6043; // CAMERA_CMD.SOUND_DETECTION → set-json
const SENSOR_WORK_MODE = 1612; // MOTION_CMD.SENSOR_WORK_MODE — the testMode read id

// The refused sets the client hands the model (see `eufy-mega.ts`): an RTC-control station refuses every
// portal kind but set-payload/set-json; a media-only route refuses them all.
const RTC_CONTROL_REFUSED = new Set<Command["kind"]>([
  "set-param",
  "set-json-raw",
  "p2p-station-scalar",
  "p2p-int-string",
  "p2p-privacy-burst",
]);
const MEDIA_REFUSED = new Set<Command["kind"]>([...RTC_CONTROL_REFUSED, "set-payload", "set-json"]);

type Surface = Record<string, unknown>;

/** A camera context reporting both params, refusing the given kinds. */
const cameraCtx = (refusedCommandKinds: ReadonlySet<Command["kind"]> | undefined): CommandContext => ({
  channel: 0,
  codec: "camera",
  paramIds: new Set([IMAGE_FLIPPED, SOUND_DETECTION]),
  capabilities: new Set(["camera"]),
  refusedCommandKinds,
});

const bindCamera = (refusedCommandKinds: ReadonlySet<Command["kind"]> | undefined): Surface =>
  bind<Surface>("camera", cameraCtx(refusedCommandKinds)).acts;

const hasGetter = (acts: Surface, name: string): boolean =>
  typeof Object.getOwnPropertyDescriptor(acts, name)?.get === "function";

describe("a setter whose command kind the device's transport refuses", () => {
  it("drops a set-param AND a set-json setter on a media-only route, keeping the reads", () => {
    // A standalone call doorbell streams on a media track and takes no portal command at all.
    const acts = bindCamera(MEDIA_REFUSED);
    expect(hasGetter(acts, "imageFlipped")).toBe(true);
    expect(hasGetter(acts, "soundDetection")).toBe(true);
    expect(typeof acts.setImageFlipped).toBe("undefined");
    expect(typeof acts.setSoundDetection).toBe("undefined");
  });

  it("keeps every setter on a P2P device (undefined = refuses nothing — zero regression)", () => {
    const acts = bindCamera(undefined);
    expect(hasGetter(acts, "imageFlipped")).toBe(true);
    expect(typeof acts.setImageFlipped).toBe("function");
    expect(typeof acts.setSoundDetection).toBe("function");
  });

  it("on an RTC-control station keeps the set-json write but drops the set-param write", () => {
    // The RTC control channel frames set-payload/set-json only.
    const acts = bindCamera(RTC_CONTROL_REFUSED);
    expect(hasGetter(acts, "imageFlipped")).toBe(true);
    expect(typeof acts.setImageFlipped).toBe("undefined");
    expect(typeof acts.setSoundDetection).toBe("function");
  });

  /**
   * A member whose command KIND depends on the value keeps its setter as long as ONE in-domain value
   * routes. `testMode` enters over `set-payload` (`true`) and leaves over `set-param` (`false`), so a
   * sensor behind an RTC-control station can still enter test mode — probing only `false` would wrongly
   * withdraw the whole setter.
   */
  it("keeps a value-dependent setter whose true-branch routes, even when its false-branch does not", () => {
    const sensorCtx: CommandContext = {
      channel: 0,
      codec: "sensor",
      paramIds: new Set([SENSOR_WORK_MODE]),
      capabilities: new Set(["motion"]),
      refusedCommandKinds: RTC_CONTROL_REFUSED,
    };
    const acts = bind<Surface>("motion", sensorCtx).acts;
    expect(hasGetter(acts, "testMode")).toBe(true);
    expect(typeof acts.setTestMode).toBe("function");
  });

  /**
   * The momentary-action branch is gated too. The siren's `test` action emits `set-payload`, which a
   * media-only route refuses, so the action is withheld there but present on P2P.
   */
  it("drops a momentary action whose command the transport refuses, keeping it elsewhere", () => {
    const sirenCtx = (refusedCommandKinds: ReadonlySet<Command["kind"]> | undefined): CommandContext => ({
      channel: 0,
      codec: "sensor",
      paramIds: new Set([1825, 61008]), // ALARM_VOLUME + RING_STATUS → standalone-siren evidence
      capabilities: new Set(["siren"]),
      refusedCommandKinds,
    });
    expect(typeof bind<Surface>("siren", sirenCtx(undefined)).acts.test).toBe("function");
    expect(typeof bind<Surface>("siren", sirenCtx(MEDIA_REFUSED)).acts.test).toBe("undefined");
  });

  /**
   * The intent path (`buildCommand`) runs the same check on the value it is given: a `set-param` write
   * the transport refuses yields `undefined`, never a command that would throw at dispatch.
   */
  it("returns undefined from the intent path for a write the transport refuses", () => {
    const ctx = cameraCtx(RTC_CONTROL_REFUSED);
    expect(buildCommand("imageFlipped", true, ctx)).toBeUndefined();
    expect(buildCommand("imageFlipped", true, cameraCtx(undefined))).toBeDefined();
  });
});
