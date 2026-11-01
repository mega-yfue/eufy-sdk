/**
 * Anker secure-MQTT topic vocabulary + the per-line credential scope.
 *
 * Two facts about this broker drive everything here, both CONFIRMED live (2026-07-28) against a real
 * `eufy_life` light and cross-read from the disassembled V6 app
 * (`com.anker.esiotkit.security_device.mqtt.SecurityMqttConstant`, `mqtt_serve.dart`):
 *
 *  - **The device→app leg is not `/res` for every line.** `eufy_life` reports land on `/app/res`;
 *    the app subscribes four topics per light device and `/res` carries nothing. Other lines use
 *    `/res` alone.
 *  - **The topic space is partitioned by credential.** `get_user_mqtt_info` returns a DIFFERENT
 *    certificate per `app-name`, and the AWS IoT policy granting `eufy_life/...` is attached only to
 *    the `eufy_life` cert. Subscribing to a light's topics with the default credential is *silently*
 *    denied — the broker answers SUBACK with a 128 grant rather than rejecting, which is why this
 *    produced total silence instead of an error.
 *
 * Scope is derived from `EufyDevice.category` — a device-record field, not a capability — so this
 * stays on the transport side of the capability↔transport boundary.
 */
import type { EufyDevice } from "../../core/types.js";

/**
 * Which `get_user_mqtt_info` credential a device's realtime traffic rides on. `"default"` is the
 * headerless credential (observed `eufy_mega`-scoped) that serves every non-life MQTT device.
 *
 * A scope exists only where a DISTINCT credential does. `eufy_life` is one because its topic space is
 * denied to the default credential. The Clean line (`eufy_home`) is NOT: its
 * `cmd/eufy_home/<model>/<sn>/res` subscribe is confirmed against a T2351 on the
 * default credential, which is the only one `get_user_mqtt_info` was ever asked for. Giving it a scope
 * of its own would open a second connection under the SAME `thing_name` — AWS IoT treats a duplicate
 * client id as a takeover and evicts the incumbent, so both lines would flap.
 */
export type MqttScope = "default" | "eufy_life";

/** The `eufy_life` category string, as the cloud record reports it and as the topic segment. */
const EUFY_LIFE = "eufy_life";

/**
 * The fixed topic prefix for clean-line devices (vacuum/mower) — `eufy_home` — regardless of what
 * `device.category` carries in the cloud record. Confirmed live against a T2351 (2026-07-30): the
 * broker grants `cmd/eufy_home/…` on the default credential, and `device.category` may report
 * `"robovac"` or another string that is NOT the topic segment.
 */
const EUFY_HOME = "eufy_home";

/**
 * The topic prefix segment for a device — the second path component in `cmd/{prefix}/{pn}/{sn}/…`.
 * Uses `eufy_home` for clean-line devices (derived from `deviceClass`, not `category`, because the
 * cloud record's `category` field does not reliably match the topic namespace for this line).
 * Everything else falls back to `device.category`.
 */
function topicPrefix(device: EufyDevice): string {
  if (device.deviceClass === "vacuum" || device.deviceClass === "mower") return EUFY_HOME;
  return device.category;
}

/**
 * The credential scope a device's topics are granted under. Derived from `EufyDevice.category` — a
 * device record field, not a capability — so this stays on the transport side of the boundary.
 */
export function mqttScopeFor(device: EufyDevice): MqttScope {
  return device.category === EUFY_LIFE ? EUFY_LIFE : "default";
}

/**
 * The `app-name` request header value for a scope, or `undefined` for the default (headerless)
 * credential — matching the optional argument of `getUserMqttInfo`.
 */
export function mqttAppName(scope: MqttScope): string | undefined {
  return scope === EUFY_LIFE ? EUFY_LIFE : undefined;
}

/**
 * Build a topic for a device: `cmd/<prefix>/<model>/<sn>/<req|res>`. `leg` is required — the two
 * directions are one word apart and publishing to the wrong one fails silently. The prefix is
 * derived by the module-local `topicPrefix` — `eufy_home` for clean-line devices, `device.category` elsewhere.
 */
export function secureTopic(device: EufyDevice, leg: "req" | "res"): string {
  return `cmd/${topicPrefix(device)}/${device.model}/${device.sn}/${leg}`;
}

/**
 * Every topic to subscribe for a device's inbound traffic.
 *
 * `eufy_life` (smart lights) gets the app's full four-topic set: `/app/res` (the state channel),
 * `/res` (present in the app's subscribe list but observed to carry nothing on this line),
 * `synq/…/state_info` (online/offline), and `/app/ota/res` (OTA progress).
 *
 * Clean-line devices (vacuum/mower) subscribe four topics on the `eufy_home` prefix:
 *   - `cmd/…/res` — device→app DP reports and command replies (confirmed live on T2351)
 *   - `biz/…/res` — cloud→app business-layer responses (TopicManager.getBizReqTopic())
 *   - `biz/…/req` — cloud ACKs for app→cloud business requests (subscribe for ACKs)
 *   - `dt/…/param_info` — device-twin parameter push
 *
 * Every other line subscribes `/res` alone.
 */
export function subscribeTopics(device: EufyDevice): readonly string[] {
  if (device.category === EUFY_LIFE) {
    const base = `${EUFY_LIFE}/${device.model}/${device.sn}`;
    return [`cmd/${base}/app/res`, `cmd/${base}/res`, `synq/${base}/state_info`, `cmd/${base}/app/ota/res`];
  }
  if (device.deviceClass === "vacuum" || device.deviceClass === "mower") {
    const base = `${EUFY_HOME}/${device.model}/${device.sn}`;
    return [`cmd/${base}/res`, `biz/${base}/res`, `biz/${base}/req`, `dt/${base}/param_info`];
  }
  return [secureTopic(device, "res")];
}

/** A parsed inbound topic. `tail` is everything after the serial (`res`, `app/res`, `state_info`, …). */
export interface ParsedTopic {
  root: string;
  category: string;
  model: string;
  sn: string;
  tail: string;
}

/**
 * Split an inbound topic into its parts. All roots this broker uses (`cmd/…`, `synq/…`, `biz/…`,
 * `dt/…`) put the serial at index 3 regardless of how deep the tail runs, so the serial is read
 * positionally rather than from the end — `…/<sn>/app/res` and `…/<sn>/app/ota/res` would otherwise
 * yield the tail segment as the device id. Returns `undefined` on any shape this doesn't recognise,
 * so an unparsed topic leaves `deviceSn` unset instead of carrying a guess.
 */
export function parseSecureTopic(topic: string): ParsedTopic | undefined {
  const parts = topic.split("/");
  if (parts.length < 5) return undefined;
  const [root, category, model, sn] = parts;
  if (root !== "cmd" && root !== "synq" && root !== "biz" && root !== "dt") return undefined;
  if (!category || !model || !sn) return undefined;
  return { root, category, model, sn, tail: parts.slice(4).join("/") };
}

// ── Anker Solix (anker_power) topics ────────────────────────────────────────────────────────────────
//
// Solix rides the same AWS-IoT broker as the eufy secure-MQTT plane, but its topic space is keyed by
// the raw device record (`{product_code, device_sn}`) + the account `user_id`, not an `EufyDevice`. The
// builders live here so all wire-topic vocabulary stays on the transport side of the boundary and no
// caller hard-codes a topic string.

/** The per-device Solix topics for `{appName, productCode, deviceSn}`. */
export interface SolixDeviceTopics {
  /** Telemetry the device pushes (SUBSCRIBE) — ff09 `param_info` frames (live measurements). */
  paramInfo: string;
  /**
   * Settings/state the device pushes (SUBSCRIBE) — ff09 `state_info` frames. Same ff09 framing as
   * `param_info` but the TAGS carry SETTINGS/targets (mode export limit, SOC limits, max_load, toggles),
   * NOT live measurements — so it needs its own tag→name table, not the param_info one.
   */
  stateInfo: string;
  /** This device's command replies (SUBSCRIBE). */
  cmdRes: string;
  /**
   * The device's requestDeviceInfo channel (cmd 17). PUBLISH to arm reporting; also SUBSCRIBE — the
   * broker copies the APP's publishes here to any co-subscriber, which is the only way to observe a
   * control the app changed that `param_info` does not reflect (ambient light, display timeout).
   */
  req: string;
}

/** Build the per-device Solix topics. `param_info` is the telemetry we decode; `req` is arm + read-back. */
export function solixDeviceTopics(appName: string, productCode: string, deviceSn: string): SolixDeviceTopics {
  const dt = `dt/${appName}/${productCode}/${deviceSn}`;
  const cmd = `cmd/${appName}/${productCode}/${deviceSn}`;
  return {
    paramInfo: `${dt}/param_info`,
    stateInfo: `${dt}/state_info`,
    cmdRes: `${cmd}/app/res`,
    req: `${cmd}/req`,
  };
}

/** The per-account Solix topics keyed by `user_id`. */
export interface SolixUserTopics {
  /** Account-level command replies (SUBSCRIBE). */
  cmdRes: string;
  /** The `power_site` heartbeat channel (PUBLISH only). */
  powerSite: string;
}

/** Build the per-account Solix topics. Note: the account `…/req` channel is publish-side and NOT subscribed. */
export function solixUserTopics(appName: string, userId: string): SolixUserTopics {
  return { cmdRes: `cmd/${appName}/${userId}/res`, powerSite: `dt/${appName}/${userId}/power_site` };
}
