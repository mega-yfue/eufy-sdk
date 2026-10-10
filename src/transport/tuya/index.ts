/**
 * Tuya / Thingclips cloud-protocol client.
 *
 * A clean, typed base for the eufy app's Tuya backbone: deterministic eufy→Tuya account derivation,
 * exact `api.json` request assembly, the sign, and a small {@link TuyaClient}. No configuration is
 * required — the built-in signing key ({@link TUYA_SIGN_K}) works out of the box.
 *
 * Quick start:
 *
 *   import { tuya } from "@mega-yfue/eufy-sdk";
 *   const client = new tuya.TuyaClient();           // zero-config
 *   await client.login(eufyUserId, phoneCode);       // derives Tuya account + logs in
 *   const dps = await client.getDeviceDps(devId);   // read DPs with the live sid
 *
 *   // Or inject a previously obtained sid to skip login:
 *   const client = new tuya.TuyaClient({ sid });
 *
 * STATUS:
 *   ✅ sign = HMAC-SHA256(TUYA_SIGN_K, preimage) — reproduces a live-captured signature
 *   ✅ chKey = "7cbfe6d8" per-appId constant
 *   ✅ login() — username.token.get → RSA-encrypt(MD5(password)) → password.login.reg
 *      (shadow account must be provisioned via eufy Security app first)
 *   ✅ getDeviceDps / publishDps builders ready; publishDps gated behind allowUnverified
 */
export * from "./account.js";
export * from "./sign.js";
export * from "./et3.js";
export * from "./request.js";
export * from "./client.js";
