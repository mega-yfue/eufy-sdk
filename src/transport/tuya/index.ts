/**
 * Tuya / Thingclips cloud-protocol client.
 *
 * A clean, typed base for the eufy app's Tuya backbone: deterministic eufy→Tuya account derivation,
 * exact `api.json` request assembly, the sign, and a {@link TuyaClient}. Both native seams are
 * SOLVED and transport-confirmed against `a1.tuyaeu.com`:
 *   - the final `sign` = `HMAC-SHA256(TUYA_HOME_HMAC_KEY, preimage)` ({@link HmacSigner}; the key is
 *     a constant extracted from the eufy Home/Clean APK — zero configuration needed).
 *   - the per-install `chKey` is a per-appId CONSTANT ({@link TUYA_CHKEY} = `"7cbfe6d8"`).
 *
 * This module is re-exported NAMESPACED from the package root (`export * as tuya`), so:
 *
 *   import { tuya } from "@mega-yfue/eufy-sdk";
 *   const client = new tuya.TuyaClient({ signer: new tuya.HmacSigner(), chKey: tuya.TUYA_CHKEY });
 *   await client.login(eufyUserId);
 *   await client.getDeviceDps(devId);
 *
 * STATUS: transport, signing, and login are live-verified. `publishDps` is reversed from the
 * decompile but not yet captured against a device — gated behind `allowUnverified`.
 */
export * from "./account.js";
export * from "./sign.js";
export * from "./request.js";
export * from "./client.js";
