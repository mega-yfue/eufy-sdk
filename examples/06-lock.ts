/**
 * Example 06 — read a smart lock's state and drive it.
 *
 * Resolves a device with the `lock` capability and reads its state via the typed fluent getters:
 * `lock().locked` (lock state), `lock().battery` (0–100), `lock().rssi` (dBm). Inbound lock events
 * arrive as the `lockState` semantic event over push (see example 02).
 *
 * `lock()`/`unlock()` and `setAutoLock(enabled, delaySeconds?)` are LIVE-VERIFIED on both the P2P
 * video lock (T8531) and the MQTT-only garage door (T85D0) — `dev.lock?.()` looks identical either
 * way, the capability picks the transport and the wire. The classic Wi-Fi lock takes `lock()`/`unlock()`
 * over its own keyed envelope but none of the settings writes, so `setAutoLock` is OPTIONAL on the
 * returned object, like `setRainMode(enabled)` (P2P video lock only) — guard both with `?.()`.
 *
 *   EUFY_EMAIL=… EUFY_PASSWORD=… node examples/06-lock.ts <serial> [lock|unlock|autolock-on|autolock-off|rain-on|rain-off]
 *
 * Requires `npm run build` first.
 */
import { loginClient } from "./_client.ts";

async function main(): Promise<void> {
  const sn = process.argv[2];
  const action = (process.argv[3] || "lock").toLowerCase();
  const valid = ["lock", "unlock", "autolock-on", "autolock-off", "rain-on", "rain-off"];
  if (!sn) throw new Error(`usage: node examples/06-lock.ts <serial> [${valid.join("|")}]`);
  if (!valid.includes(action)) throw new Error(`bad action "${action}" — one of ${valid.join("|")}`);

  const eufy = await loginClient();

  const dev = await eufy.getDevice(sn);
  const lock = dev.lock?.();
  if (!lock) throw new Error(`${sn} has no lock capability`);

  // Read side works today — typed fluent getters, evidence-gated (present only when reported).
  console.log(`lock ${sn}:`);
  console.log(`  locked : ${lock.locked ?? "unknown"}`);
  console.log(`  battery: ${lock.battery ?? "unknown"}%`);
  console.log(`  rssi   : ${lock.rssi ?? "unknown"} dBm`);

  switch (action) {
    case "lock":
      console.log("locking …");
      await lock.lock();
      break;
    case "unlock":
      console.log("unlocking …");
      await lock.unlock();
      break;
    case "autolock-on":
    case "autolock-off":
      if (!lock.setAutoLock) throw new Error(`${sn} has no setAutoLock (classic Wi-Fi lock?)`);
      console.log(action === "autolock-on" ? "enabling auto-lock (60s delay) …" : "disabling auto-lock …");
      await (action === "autolock-on" ? lock.setAutoLock(true, 60) : lock.setAutoLock(false));
      break;
    case "rain-on":
    case "rain-off":
      // Optional — only the P2P video lock (T8531) has this, so check before calling.
      if (!lock.setRainMode) throw new Error(`${sn} has no setRainMode (not a P2P video lock?)`);
      console.log(`setting rain mode ${action === "rain-on" ? "on" : "off"} …`);
      await lock.setRainMode(action === "rain-on");
      break;
  }

  console.log("sent — check the app");
  await eufy.disconnect();
}

main().catch((e: unknown) => {
  console.error("FATAL", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
