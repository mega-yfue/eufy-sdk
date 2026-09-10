/**
 * Live telemetry for Anker Solix devices over the AWS-IoT MQTT plane.
 *
 * The transport is the shared `SecureMqtt` — the exact same anker AWS-IoT broker + per-user
 * client-cert mutual TLS the eufy device path uses; a Solix account's `get_user_mqtt_info` result maps
 * straight onto {@link SecureMqttCredentials}. Solix devices publish telemetry continuously on
 * `dt/{app_name}/{product_code}/{device_sn}/param_info` as an **ff09 TLV frame** (the same framing
 * family as {@link parseFf09SettingsResponse}), so this module only adds the Solix topic + a small
 * ff09 param decoder on top of the reused transport.
 *
 * Frame layout (observed on a Smart Meter Gen 2 / AE1X0):
 *   ff09 | len(u16 LE, incl. trailing XOR checksum) | 5-byte header | TLV fields | xor
 * each TLV field is `tag(1) | len(1) | value(len)`; measurement fields carry `type(1) | 4 bytes`,
 * type `0x05` = float32 LE. Field `a2` is the device serial (ASCII after a leading type byte).
 */
import { EventEmitter } from "node:events";

import { SecureMqtt, type SecureMqttCredentials } from "../transport/mqtt/secure-mqtt.js";
import type { Logger } from "../core/index.js";

/** A decoded telemetry channel: the raw value plus float/uint interpretations of a 4-byte payload. */
export interface SolixChannel {
  /** The leading type byte (`0x05` = float32 LE for the meter's measurement channels). */
  type: number;
  raw: Buffer;
  /** Present when the payload is 4 bytes: little-endian float32. */
  float?: number;
  /** Present when the payload is 4 bytes: little-endian uint32. */
  uint?: number;
}

/** A parsed ff09 param frame: the device serial (from `a2`) + the raw TLV field map keyed by tag. */
export interface SolixParamFrame {
  deviceSn?: string;
  /** tag byte → value bytes (still including the per-field leading type byte for measurement fields). */
  fields: Map<number, Buffer>;
}

/**
 * Telemetry field tags for the Smart Meter (AE1X0), keyed by ff09 tag byte. Names are the app's own
 * (recovered from the Anker app's compiled-Dart strings in `libapp.so` — module
 * `package:third_device/src/module/ae1x0/…`): the meter is 3-phase-capable and reports each quantity
 * per line (L1/L2/L3) plus an aggregate total.
 *
 * Confidence:
 * - `0xac` = `meterVoltageL1` is CONFIRMED against live data (≈237.5 V on a single-phase UK supply).
 * - The rest are a STRUCTURAL INFERENCE from a quantity-major-by-phase layout that is consistent with
 *   every observation to date: on a single-phase / single-CT install only the L1 and total slots move
 *   (a8==ab because PowerL1==PowerTotal), the L2/L3 slots read 0, and the load-responsive tags
 *   (a8/ab/af/b3) line up with PowerL1/PowerTotal/CurrentL1/ImportEnergy. Bind them hard with one
 *   known-load capture and adjust here if a magnitude disagrees.
 * - Tags 0xb5–0xb7 are left unnamed (surface as `channel_b5`..`channel_b7`). The app's Dart decoder
 *   names NO field beyond the 14 above (no frequency / power-factor / reactive / temperature field
 *   exists in libapp.so), so these are reserved/unused in the app. `b7` sits at ~0.1 at idle — a
 *   firmware-level power-factor candidate (would climb toward ~1.0 under a resistive load); unconfirmed.
 *
 * Unnamed measurement tags always still surface as `channel_<tag>`, so nothing is lost.
 */
export const SOLIX_METER_FIELD_NAMES: Readonly<Record<number, string>> = {
  0xa8: "meterPowerL1",
  0xa9: "meterPowerL2",
  0xaa: "meterPowerL3",
  0xab: "meterPowerTotal",
  0xac: "meterVoltageL1", // CONFIRMED live (≈237.5 V)
  0xad: "meterVoltageL2",
  0xae: "meterVoltageL3",
  0xaf: "meterCurrentL1",
  0xb0: "meterCurrentL2",
  0xb1: "meterCurrentL3",
  0xb2: "meterCurrentTotal",
  0xb3: "meterImportEnergy",
  0xb4: "meterExportEnergy",
};

/** Interpret one TLV value as a telemetry channel (leading type byte + payload). */
export function readSolixChannel(value: Buffer | undefined): SolixChannel | undefined {
  if (!value || value.length < 1) return undefined;
  const raw = value.subarray(1);
  const ch: SolixChannel = { type: value[0]!, raw };
  if (raw.length === 4) {
    ch.float = raw.readFloatLE(0);
    ch.uint = raw.readUInt32LE(0);
  }
  return ch;
}

/**
 * Decode an ff09 Solix param frame into its serial + TLV field map. Returns `null` for a non-ff09
 * buffer. Walks `tag|len|value` from the first `0xa1` tag to the frame's declared length (minus the
 * trailing XOR checksum byte), stopping at a `0x00` tag (padding).
 */
export function decodeSolixParamFrame(buf: Buffer): SolixParamFrame | null {
  if (buf.length < 10 || buf[0] !== 0xff || buf[1] !== 0x09) return null;
  const declaredLen = buf.readUInt16LE(2);
  const end = Math.min(buf.length, declaredLen > 0 ? declaredLen : buf.length) - 1; // last byte = XOR checksum
  const start = buf.indexOf(0xa1, 4);
  if (start < 0) return { fields: new Map() };
  const fields = new Map<number, Buffer>();
  let i = start;
  while (i + 2 <= end) {
    const tag = buf[i]!;
    if (tag === 0) break;
    const len = buf[i + 1]!;
    if (i + 2 + len > buf.length) break;
    fields.set(tag, buf.subarray(i + 2, i + 2 + len));
    i += 2 + len;
  }
  let deviceSn: string | undefined;
  const a2 = fields.get(0xa2);
  if (a2 && a2.length > 1) deviceSn = a2.subarray(1).toString("latin1").replace(/\0+$/, "") || undefined;
  return { deviceSn, fields };
}

/**
 * Reduce a param frame to named + raw telemetry values. Measurement channels (`0xa6`..`0xff`) are
 * decoded as float32 where the payload is 4 bytes; a tag in {@link SOLIX_METER_FIELD_NAMES} is emitted
 * under its name (e.g. `meterVoltageL1`), and all measurement tags additionally under `channel_<hex tag>`.
 */
export function solixReadings(frame: SolixParamFrame): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [tag, value] of frame.fields) {
    if (tag < 0xa6) continue; // a1/a2/a3 are count/serial/status, not measurements
    const ch = readSolixChannel(value);
    // 0x05 = float32 measurement channel (confirmed live); other types are non-measurement params.
    if (ch?.type !== 0x05 || ch.float === undefined) continue;
    out[`channel_${tag.toString(16)}`] = ch.float;
    const name = SOLIX_METER_FIELD_NAMES[tag];
    if (name) out[name] = ch.float;
  }
  return out;
}

/** A live telemetry sample emitted by {@link SolixMqtt} as a `reading` event. */
export interface SolixReading {
  deviceSn: string;
  productCode: string;
  topic: string;
  frame: SolixParamFrame;
  values: Record<string, number>;
}

/** The minimum device shape {@link SolixMqtt.watch} needs (as returned by `SolixClient.getDevices`). */
export interface SolixMqttDevice {
  device_sn: string;
  product_code: string;
}

/** Options for {@link SolixMqtt}. */
export interface SolixMqttOptions {
  /** `get_user_mqtt_info` result — carries endpoint, cert/key, app_name, thing_name. */
  mqttInfo: SecureMqttCredentials;
  /** Override the MQTT clientId. Defaults to the cert CN (`thing_name`), distinct from the app's id. */
  clientId?: string;
  logger?: Logger;
}

/**
 * Subscribe to a Solix device's live telemetry and emit decoded `reading` events. Reuses
 * `SecureMqtt` for the connection; adds only the Solix data topic + ff09 param decoding.
 *
 *   const mqtt = new SolixMqtt({ mqttInfo: await solix.getUserMqttInfo() });
 *   mqtt.on("reading", (r) => console.log(r.deviceSn, r.values.meterVoltageL1));
 *   await mqtt.watch(device);   // device = a SolixClient.getDevices() entry
 */
export class SolixMqtt extends EventEmitter {
  private readonly transport: SecureMqtt;
  private readonly appName: string;

  constructor(opts: SolixMqttOptions) {
    super();
    this.appName = opts.mqttInfo.app_name ?? "anker_power";
    this.transport = new SecureMqtt({
      credentials: opts.mqttInfo,
      clientId: opts.clientId ?? opts.mqttInfo.thing_name,
      reconnectPeriod: 5000,
      logger: opts.logger,
    });
    this.transport.on("error", (e) => this.emit("error", e));
    this.transport.on("message", (msg: { topic?: string; raw: unknown }) => this.onMessage(msg));
  }

  /** Connect (if needed) and subscribe to the device's telemetry topic. */
  async watch(device: SolixMqttDevice): Promise<void> {
    await this.transport.connect();
    const topic = `dt/${this.appName}/${device.product_code}/${device.device_sn}/#`;
    await this.transport.subscribe([topic]);
  }

  /** Tear down the connection. */
  async close(): Promise<void> {
    await this.transport.disconnect();
  }

  /** Decode one inbound MQTT message envelope and emit a `reading` if it carries an ff09 param frame. */
  private onMessage(msg: { topic?: string; raw: unknown }): void {
    const topic = msg.topic ?? "";
    const buf = extractFf09Payload(msg.raw);
    if (!buf) return;
    const frame = decodeSolixParamFrame(buf);
    if (!frame) return;
    const parts = topic.split("/"); // dt/{app}/{pn}/{sn}/param_info
    const reading: SolixReading = {
      deviceSn: frame.deviceSn ?? parts[3] ?? "",
      productCode: parts[2] ?? "",
      topic,
      frame,
      values: solixReadings(frame),
    };
    this.emit("reading", reading);
  }
}

/**
 * Pull the ff09 binary frame out of a received message. Solix telemetry arrives as a `{head, payload}`
 * envelope whose `payload` is a JSON string carrying base64 `data` (or `trans`); `SecureMqtt`
 * has already JSON-parsed the outer envelope. Returns the decoded frame bytes, or `null`.
 */
export function extractFf09Payload(raw: unknown): Buffer | null {
  if (Buffer.isBuffer(raw)) return raw;
  if (!raw || typeof raw !== "object") return null;
  const env = raw as { payload?: unknown; data?: unknown };
  let payload: unknown = env.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  const data = (payload as { data?: unknown; trans?: unknown } | undefined)?.data ?? env.data;
  if (typeof data !== "string") return null;
  const buf = Buffer.from(data, "base64");
  return buf.length ? buf : null;
}
