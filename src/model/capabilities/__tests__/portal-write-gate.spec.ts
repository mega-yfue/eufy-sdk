import { bind } from "./bind.js";
import { portalCommandKindsFor } from "../../device-family.js";
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

type CameraSurface = Record<string, unknown>;

/** A camera context reporting both params, with the portal reach of the given route class. */
const cameraCtx = (portalCommandKinds: ReadonlySet<string> | undefined): CommandContext => ({
  channel: 0,
  codec: "camera",
  paramIds: new Set([IMAGE_FLIPPED, SOUND_DETECTION]),
  capabilities: new Set(["camera"]),
  portalCommandKinds: portalCommandKinds as CommandContext["portalCommandKinds"],
});

const bindCamera = (portalCommandKinds: ReadonlySet<string> | undefined): CameraSurface =>
  bind<CameraSurface>("camera", cameraCtx(portalCommandKinds)).acts;

const hasGetter = (acts: CameraSurface, name: string): boolean =>
  typeof Object.getOwnPropertyDescriptor(acts, name)?.get === "function";

describe("a setter whose command kind the device's transport cannot carry", () => {
  it("drops a set-param AND a set-json setter on a media-only route, keeping the reads", () => {
    // A standalone call doorbell streams on a media track and carries no portal command at all.
    const acts = bindCamera(portalCommandKindsFor("media-only"));
    expect(hasGetter(acts, "imageFlipped")).toBe(true);
    expect(hasGetter(acts, "soundDetection")).toBe(true);
    expect(typeof acts.setImageFlipped).toBe("undefined");
    expect(typeof acts.setSoundDetection).toBe("undefined");
  });

  it("keeps every setter on a P2P device (undefined = unrestricted — zero regression)", () => {
    const acts = bindCamera(portalCommandKindsFor("p2p"));
    expect(portalCommandKindsFor("p2p")).toBeUndefined();
    expect(hasGetter(acts, "imageFlipped")).toBe(true);
    expect(typeof acts.setImageFlipped).toBe("function");
    expect(typeof acts.setSoundDetection).toBe("function");
  });

  it("on an RTC-control station keeps the set-json write but drops the set-param write", () => {
    // The RTC control channel frames set-payload/set-json only.
    const acts = bindCamera(portalCommandKindsFor("rtc-control"));
    expect(hasGetter(acts, "imageFlipped")).toBe(true);
    expect(typeof acts.setImageFlipped).toBe("undefined");
    expect(typeof acts.setSoundDetection).toBe("function");
  });
});
