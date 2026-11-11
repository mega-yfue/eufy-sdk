import { bind } from "./bind.js";
import type { Command } from "../../../core/contracts.js";
import type { CommandContext } from "../types.js";

/**
 * A setting whose command kind the device's transport cannot carry must NOT advertise a setter, while
 * the setting's READ stays installed. A device reached over a narrow portal (an RTC-control station, or
 * a media-only route) carries only a slice of the portal command kinds; a setter whose kind the portal
 * cannot frame would throw at dispatch though the setting reports itself writable.
 *
 * Probed through the `camera` capability, which carries both a `set-param` setter (`imageFlipped`, wire
 * 1207) and a `set-json` setter (`soundDetection`, wire 6043) beside their read getters.
 */
const IMAGE_FLIPPED = 1207; // CAMERA_CMD.ROTATE_IMAGE → set-param
const SOUND_DETECTION = 6043; // CAMERA_CMD.SOUND_DETECTION → set-json
const SENSOR_WORK_MODE = 1612; // MOTION_CMD.SENSOR_WORK_MODE — the testMode read id

/** The two kinds the RTC control channel frames; a media-only route frames none. */
const RTC_CONTROL = new Set<Command["kind"]>(["set-payload", "set-json"]);
const MEDIA_ONLY = new Set<Command["kind"]>();

type Surface = Record<string, unknown>;

/** A camera context reporting both params, with the portal reach of the given route. */
const cameraCtx = (portalCommandKinds: ReadonlySet<Command["kind"]> | undefined): CommandContext => ({
  channel: 0,
  codec: "camera",
  paramIds: new Set([IMAGE_FLIPPED, SOUND_DETECTION]),
  capabilities: new Set(["camera"]),
  portalCommandKinds,
});

const bindCamera = (portalCommandKinds: ReadonlySet<Command["kind"]> | undefined): Surface =>
  bind<Surface>("camera", cameraCtx(portalCommandKinds)).acts;

const hasGetter = (acts: Surface, name: string): boolean =>
  typeof Object.getOwnPropertyDescriptor(acts, name)?.get === "function";

describe("a setter whose command kind the device's transport cannot carry", () => {
  it("drops a set-param AND a set-json setter on a media-only route, keeping the reads", () => {
    // A standalone call doorbell streams on a media track and carries no portal command at all.
    const acts = bindCamera(MEDIA_ONLY);
    expect(hasGetter(acts, "imageFlipped")).toBe(true);
    expect(hasGetter(acts, "soundDetection")).toBe(true);
    expect(typeof acts.setImageFlipped).toBe("undefined");
    expect(typeof acts.setSoundDetection).toBe("undefined");
  });

  it("keeps every setter on a P2P device (undefined = unrestricted — zero regression)", () => {
    const acts = bindCamera(undefined);
    expect(hasGetter(acts, "imageFlipped")).toBe(true);
    expect(typeof acts.setImageFlipped).toBe("function");
    expect(typeof acts.setSoundDetection).toBe("function");
  });

  it("on an RTC-control station keeps the set-json write but drops the set-param write", () => {
    // The RTC control channel frames set-payload/set-json only.
    const acts = bindCamera(RTC_CONTROL);
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
      portalCommandKinds: RTC_CONTROL,
    };
    const acts = bind<Surface>("motion", sensorCtx).acts;
    expect(hasGetter(acts, "testMode")).toBe(true);
    expect(typeof acts.setTestMode).toBe("function");
  });
});
