/**
 * Example 05 — control a CAMERA's spotlight / floodlight.
 *
 * This is the `light` capability: a light built INTO a camera, driven over the camera's own wire. It is
 * a different product line from the standalone eufy Life smart lights, which use `smartLight()` — see
 * example 09. A device has one or the other, never both.
 *
 * Resolves a device with the `light` capability and drives it via the fluent `light()` accessor:
 * `on()/off()` (or `set(bool)`), plus `setBrightness(1–100)`, `setColorTemp(0 warm–100 cool)` and
 * `setEnabled(bool)` for the master switch. The accessor is `undefined` on a device without a light,
 * so guard with `?.` (or check `dev.has("light")`).
 *
 *   EUFY_EMAIL=… EUFY_PASSWORD=… node examples/05-camera-light.ts <serial> [on|off] [brightness 1-100]
 *
 * Requires `npm run build` first.
 */
import { loginClient } from "./_client.ts";

async function main(): Promise<void> {
  const sn = process.argv[2];
  const state = (process.argv[3] || "on").toLowerCase();
  const brightness = process.argv[4] ? Number(process.argv[4]) : undefined;
  if (!sn) throw new Error("usage: node examples/05-camera-light.ts <serial> [on|off] [brightness 1-100]");
  if (state !== "on" && state !== "off") throw new Error(`bad state "${state}" — one of on|off`);

  const eufy = await loginClient();

  const dev = await eufy.getDevice(sn);
  const light = dev.light?.();
  if (!light) throw new Error(`${sn} has no light capability`);

  // Confirm the action exists on this binding before calling it.
  const action = state === "on" ? "on" : "off";
  const setPower = light[action];
  if (typeof setPower !== "function") throw new Error(`${sn} light has no ${state}() action`);
  console.log(`turning light ${state} …`);
  await setPower.call(light);

  // `isOn` (the momentary lighting) and `spotlightEnabled` (the master switch) are two different facts,
  // and both are readable. The lamp is lit only while something is streaming — the vendor app lights it
  // for a live view and drops it on quitting — whereas the master switch is the SETTING a user changes
  // and expects to stay changed. A change to either arrives as `propertyChanged`.
  console.log({ lit: light.isOn, masterSwitch: light.spotlightEnabled, brightness: light.brightness });

  if (brightness !== undefined) {
    if (brightness < 1 || brightness > 100) throw new Error("brightness must be 1–100");
    // A light may be on/off-only (status-LED cams report no brightness param) — the typed read is
    // evidence-gated, so `brightness` is undefined when the device doesn't report one.
    if (light.brightness === undefined) throw new Error(`${sn} light has no brightness control`);
    if (typeof light.setBrightness !== "function") throw new Error(`${sn} light has no setBrightness() action`);
    console.log(`setting brightness ${brightness} …`);
    await light.setBrightness(brightness);
  }

  console.log("sent — watch the camera");
  await eufy.disconnect();
}

main().catch((e: unknown) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
