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

import { SecureMqtt, type SecureMqttCredentials } from "./secure-mqtt.js";
import { walkFf09Tlv } from "../ff09.js";
import { buildAppShapedClientId, mqttUuidFrom } from "./app-client-id.js";
import { solixDeviceTopics, solixUserTopics } from "./topics.js";
import { genId, type Logger } from "../../core/index.js";

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
 * Telemetry field tags for the Smart Meter (AE1X0) that we emit under a stable NAME, keyed by ff09 tag
 * byte. These twelve are the meter fields the vendor app itself names, and their tag→name bindings are
 * confirmed:
 *
 * - The app's field vocabulary is exactly these twelve — voltage, current and power per line
 *   (L1/L2/L3), a power total, and cumulative import/export energy — with no current total, no
 *   frequency and no power-factor field.
 * - A live single-phase frame confirms the tag→field magnitudes: `0xac` a nominal mains voltage,
 *   `0xa8` == `0xab` an equal power pair (line power equals total on one phase, one of them going
 *   negative on export), `0xaf` the line current, `0xb3` a slowly-cumulative import counter; the L2/L3
 *   slots read 0 on a single-CT install.
 *
 * The frame carries sixteen float slots (`0xa8`..`0xb7`). The four that name no field — `0xb2`, `0xb5`,
 * `0xb6`, `0xb7` — stay raw `channel_<hex tag>` (see {@link solixReadings}). Both `0xb2` and `0xb7` read
 * zero at idle and non-zero under load, so they carry *something* load-related; what, is not established.
 * `0xb2` is dimensionally consistent with **power factor** and rules **reactive power** out: on the same
 * frame the line reads ~240 V at 1.371 A (apparent power S = V·I ≈ 328 VA), so a reactive-power slot would
 * read in the hundreds of VAR, not `0xb2`'s 0.009 — whereas a power factor P/S is a sub-unity ratio of the
 * right magnitude (~0.008). It is left raw regardless, since a single frame doesn't pin it. `0xb7` (~0.1
 * under load) has no such magnitude tell and stays fully open.
 *
 * Each name is annotated with the equivalent register from Anker's OWN vendor integration for the
 * newer Modbus-TCP meter generation (Smart Meter Gen 2), which independently corroborates the meaning
 * of each tag: our `meterPowerL1` is their `primary_phase_1_active_power`, and so on. Same physical
 * quantities, different hardware/transport (their meter reports two CT channels — `primary` and
 * `secondary` — and also exposes `reactive_power`, `power_factor` and per-phase energy, none of which
 * this single-channel ff09 frame carries).
 *
 * This table is **meter-family-specific**: the same tag carries a different quantity on another Solix
 * device (a Solarbank's `0xac` reads a power value, not a voltage), so {@link solixReadings} applies
 * these names ONLY to a frame from the meter family — see {@link SOLIX_METER_PRODUCT_PREFIXES}. Every
 * measurement tag still surfaces as `channel_<hex tag>` regardless of device, so nothing on the wire is
 * lost; the model layer names non-meter tags per capability.
 */
export const SOLIX_METER_FIELD_NAMES: Readonly<Record<number, string>> = {
  0xa8: "meterPowerL1", // Anker Modbus: primary_phase_1_active_power
  0xa9: "meterPowerL2", // Anker Modbus: primary_phase_2_active_power
  0xaa: "meterPowerL3", // Anker Modbus: primary_phase_3_active_power
  0xab: "meterPowerTotal", // Anker Modbus: primary_total_active_power
  0xac: "meterVoltageL1", // Anker Modbus: primary_phase_1_voltage
  0xad: "meterVoltageL2", // Anker Modbus: primary_phase_2_voltage
  0xae: "meterVoltageL3", // Anker Modbus: primary_phase_3_voltage
  0xaf: "meterCurrentL1", // Anker Modbus: primary_phase_1_current
  0xb0: "meterCurrentL2", // Anker Modbus: primary_phase_2_current
  0xb1: "meterCurrentL3", // Anker Modbus: primary_phase_3_current
  0xb3: "meterImportEnergy", // Anker Modbus: primary_total_forward_active_energy
  0xb4: "meterExportEnergy", // Anker Modbus: primary_total_reverse_active_energy
};

/**
 * Product-code prefixes of the Smart Meter family that {@link SOLIX_METER_FIELD_NAMES} decodes. The table
 * is meter-specific, so {@link solixReadings} applies its named fields ONLY to a frame whose product code
 * starts with one of these; a Solarbank (`AE103`) reporting the same `0xac` tag would otherwise be
 * mislabelled `meterVoltageL1` with a nonsensical (negative-power) value. These are product-code prefixes
 * used to select a decode table — not a model import — so the `transport ⊥ model` rule is untouched.
 *
 * Keep this in lockstep with `SOLIX_METER_MODELS` in `model/capabilities/solix.ts` (the same meter
 * prefixes, model-side): a prefix added there but not here grants `energyMeter` to a device whose frames
 * this decoder then refuses to name, and no guard can catch the split (the model layer can't import
 * transport). Add a meter prefix to both.
 */
export const SOLIX_METER_PRODUCT_PREFIXES: readonly string[] = ["AE1X0"];

/**
 * Product-code prefix of the gen-4 Solarbank (the `ats_ax170` family, e.g. `AE103` Solarbank 4 E5000
 * Pro) whose ff09 tag layout {@link SOLIX_SOLARBANK_FIELD_NAMES} + the SOC/temperature extraction
 * describe. Like the meter table this is family-specific — the SAME tag carries a different quantity on
 * the meter (`0xac` is line voltage there, battery power here), so the Solarbank names are applied ONLY
 * to a frame from this family. A product-code prefix used to pick a decode table, not a model import.
 * `AE10` covers the AE10x gen-4 Solarbanks and does NOT match the meter (`AE1X0`, whose 4th char is `X`).
 */
export const SOLIX_SOLARBANK_PRODUCT_PREFIX = "AE10";

/**
 * Confirmed ff09 tag → field bindings for the gen-4 Solarbank (`ats_ax170`), correlated live against the
 * app UI. Power values in watts; signed fields note their sign convention:
 * - `0xac` battery power, SIGNED (+ charging / − discharging) — the measured net pack power.
 * - `0xbc` charge power (0 unless charging); `0xad` discharge power (0 unless discharging).
 * - `0xae` AC plug power, SIGNED (+ feeding the home / − drawing in to charge).
 * - `0xaf` socket power — the unit's own on-board AC outlet (an appliance plugged into the Solarbank).
 * - `0xc4` grid input power; `0xc5` home load power.
 * SOC and temperature are NOT float channels — see {@link solixReadings}, which reads SOC from tag `0xa3`
 * (a uint8) and temperature from the `0xa4` BMS status blob. The 4 PV-string channels (`0xc6`–`0xc9`),
 * the AC currents (`0xb2`/`0xb3`) and export energy (`0xb4`) are not yet confirmed, so they stay raw
 * `channel_<hex>` until a capture pins them.
 *
 * Names are annotated with the equivalent register from Anker's OWN vendor integration for the newer
 * Modbus-TCP Solarbank generation (which includes a "Solarbank 4 E5000 Pro" config — the same product as
 * `AE103`, a newer hardware rev), cross-checking each meaning. Their integration splits our signed
 * `batteryPower` into `battery_charging_power` / `battery_discharging_power` off one register, and exposes
 * a single `pv_power` total rather than our four per-string channels; `socketPower` (the on-board AC
 * outlet) has no register there. Same quantities, different transport.
 */
export const SOLIX_SOLARBANK_FIELD_NAMES: Readonly<Record<number, string>> = {
  0xab: "photovoltaicPower", // total PV input across the strings — Anker Modbus: pv_power
  0xac: "batteryPower", // signed net pack power — Anker Modbus: battery_charging_power − battery_discharging_power
  0xbc: "chargePower", // Anker Modbus: battery_charging_power
  0xad: "dischargePower", // Anker Modbus: battery_discharging_power
  0xae: "acPlugPower", // AC plug, signed — Anker Modbus: ac_grid_output_power
  0xaf: "socketPower", // the unit's own on-board AC socket (an appliance plugged into the Solarbank) — no Anker register
  0xc4: "gridInputPower", // Anker Modbus: grid_import_power
  0xc5: "homeLoadPower", // Anker Modbus: load_power
  0xc6: "pv1Power", // the four PV-string inputs (0 when a string is unused / dark); Anker exposes only a pv_power total
  0xc7: "pv2Power",
  0xc8: "pv3Power",
  0xc9: "pv4Power",
};

/**
 * Confirmed `state_info` tag → field bindings for the gen-4 Solarbank. `state_info` is a SEPARATE push
 * topic from `param_info` and, though it shares the ff09 framing, its tags carry SETTINGS/targets, NOT
 * live measurements — so the SAME tag byte means something different here than in
 * {@link SOLIX_SOLARBANK_FIELD_NAMES} (e.g. `0xab` is live PV power in param_info, the mode's AC-socket
 * export limit here). Mapped by live observation against the app's SOC-setting screen; everything else
 * stays raw `state_<hex>` until confirmed the same way.
 */
export const SOLIX_STATE_FIELD_NAMES: Readonly<Record<number, string>> = {
  0xa9: "mode", // current operating (EMS) mode, AE103 numbering: 1 custom, 2 self-consumption, 4 rapid charge, 7 smart, 8 dynamic tariff (NOT the Modbus SOLIX_MODBUS_EMS_MODES numbering)
  0xaa: "maxLoad", // configured max home load (W) — matches get_site_device_param max_load
  // NOTE `0xab` is grid-in/out-related power but its exact meaning is not yet pinned, so it stays raw
  // `state_ab` (a diagnostic a consumer can watch) rather than being asserted under a guessed name.
};

/**
 * The Solarbank EMS `operating_mode` enumeration from Anker's OWN vendor integration for the newer
 * **Modbus-TCP** hardware rev (Solarbank 4 E5000 Pro, register `operating_mode` gated by the `0x8006`
 * capability mask). Value → English label:
 * - `0` selfConsumption — "Self-Consumption Mode"
 * - `1` timeOfUse — "Time Of Use Mode"
 * - `3` thirdPartyControl — "Third-Party Controlled"
 * - `4` custom — "Custom Mode"
 * - `5` socketOverlay — "Socket Overlay Mode"
 * - `6` smart — "Smart Mode"
 * - `7` dynamicTariff — "Dynamic Tariff Mode"
 *
 * Value `2` is unassigned there — seven modes across `{0,1,3,4,5,6,7}`, not eight.
 *
 * NOT a decoder for this SDK's ff09 `mode` (`state_info` tag `0xa9`): that OLDER cloud/MQTT `AE103`
 * numbering is DIFFERENT on every value — `1`=custom, `2`=self-consumption, `4`=rapid charge, `7`=smart,
 * `8`=dynamic tariff (recorded on the `0xa9` field above, correlated against the app). Labelling an ff09
 * `mode` value with this Modbus map would be confidently wrong. It is exported as the vendor's own
 * reference enumeration and the thing an AE103 `0xa9` correlation capture would be checked against —
 * fold the two only if such a capture proves the numbers match.
 */
export const SOLIX_MODBUS_EMS_MODES: Readonly<Record<number, string>> = {
  0: "selfConsumption", // Self-Consumption Mode (Anker: self_consumption, 0x8006 BIT0)
  1: "timeOfUse", // Time Of Use Mode (Anker: tou_mode, BIT1)
  3: "thirdPartyControl", // Third-Party Controlled (Anker: third_party_control, BIT5)
  4: "custom", // Custom Mode (Anker: custom_mode, BIT2)
  5: "socketOverlay", // Socket Overlay Mode (Anker: socket_overlay_mode, BIT4)
  6: "smart", // Smart Mode (Anker: smart_mode, BIT3)
  7: "dynamicTariff", // Dynamic Tariff Mode (Anker: dynamic_pricing, BIT6)
};

/**
 * Decode a `state_info` ff09 frame to named + raw settings values. Skips the header tags (`< 0xa5`:
 * request marker, serial, timestamps). Each settings tag is emitted under `state_<hex>` (a plain number
 * so it's watchable in a consumer while more tags get mapped) AND, when confirmed, under its name from
 * {@link SOLIX_STATE_FIELD_NAMES}. Value is read type-aware: `0x05` float32, `0x02` u16, `0x01` u8, and
 * `0x03` the whole-number settings byte (`payload[1]`).
 *
 * The header cutoff is `0xa5` here, deliberately one lower than {@link solixReadings}' `0xa6` for
 * `param_info`: the two frames are different layouts under the same ff09 framing — `state_info` carries
 * a settings value at `0xa5` (SOC), where `param_info` has a header tag. The cutoffs are not meant to
 * match; the spec pins `0xa5`'s treatment in each so they can't silently drift together.
 */
export function solixStateReadings(frame: SolixParamFrame): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [tag, value] of frame.fields) {
    if (tag < 0xa5 || !value || value.length < 2) continue;
    const type = value[0];
    const pl = value.subarray(1);
    let num: number | undefined;
    if (type === 0x05 && pl.length >= 4) num = pl.readFloatLE(0);
    else if (type === 0x02 && pl.length >= 2) num = pl.readUInt16LE(0);
    else if (type === 0x01 && pl.length >= 1) num = pl[0];
    else if (type === 0x03 && pl.length >= 2) num = pl[1]; // settings integer (fraction in pl[0])
    if (num === undefined) continue;
    out[`state_${tag.toString(16)}`] = num;
    const name = SOLIX_STATE_FIELD_NAMES[tag];
    if (name) out[name] = num;
  }
  return out;
}

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
 * buffer, a length field that doesn't fit, or a bad checksum. Validates the trailing XOR checksum first
 * (so a corrupted frame is rejected rather than yielding plausible floats), then walks `tag|len|value`
 * from the first `0xa1` tag to the declared length minus the checksum byte via the shared
 * `walkFf09Tlv` (bounded by `end`, so a field length can't overrun into the checksum).
 */
export function decodeSolixParamFrame(buf: Buffer): SolixParamFrame | null {
  if (buf.length < 10 || buf[0] !== 0xff || buf[1] !== 0x09) return null;
  const declaredLen = buf.readUInt16LE(2);
  if (declaredLen < 5 || declaredLen > buf.length) return null;
  let xor = 0;
  for (let i = 0; i < declaredLen; i++) xor ^= buf[i]!;
  if (xor !== 0) return null;
  const end = declaredLen - 1;
  const start = buf.indexOf(0xa1, 4);
  if (start < 0 || start >= end) return { fields: new Map() };
  const fields = walkFf09Tlv(buf, start, end);
  let deviceSn: string | undefined;
  const a2 = fields.get(0xa2);
  if (a2 && a2.length > 1) deviceSn = a2.subarray(1).toString("latin1").replace(/\0+$/, "") || undefined;
  return { deviceSn, fields };
}

/**
 * Reduce a param frame to named + raw telemetry values. Tags below `0xa6` are skipped — `a1`/`a2`/`a3`
 * carry the field count, the serial and the status, not measurements. A measurement channel is one whose
 * leading type byte is `0x05` (float32 LE over a 4-byte payload); any other type is a non-measurement
 * param and contributes nothing. Each measurement is emitted under `channel_<hex tag>`, and additionally
 * under its name when the tag has a confirmed one AND `productCode` is from a known family — pass the
 * telemetry topic's product code so a device outside the meter/Solarbank families keeps raw
 * `channel_<hex>` rather than borrowing another family's tag→name table. `productCode` is required (it
 * comes straight from the telemetry topic); pass `""` for a frame of unknown origin and no names apply.
 * Meter family: {@link SOLIX_METER_PRODUCT_PREFIXES}; Solarbank: {@link SOLIX_SOLARBANK_PRODUCT_PREFIX}.
 */
export function solixReadings(frame: SolixParamFrame, productCode: string): Record<string, number> {
  const out: Record<string, number> = {};
  const isMeter = SOLIX_METER_PRODUCT_PREFIXES.some((p) => productCode.startsWith(p));
  const isSolarbank = productCode.startsWith(SOLIX_SOLARBANK_PRODUCT_PREFIX);
  const floatNames = isMeter ? SOLIX_METER_FIELD_NAMES : isSolarbank ? SOLIX_SOLARBANK_FIELD_NAMES : undefined;
  for (const [tag, value] of frame.fields) {
    if (tag < 0xa6) continue;
    const ch = readSolixChannel(value);
    if (ch?.type !== 0x05 || ch.float === undefined) continue;
    out[`channel_${tag.toString(16)}`] = ch.float;
    const name = floatNames?.[tag];
    if (name) out[name] = ch.float;
  }
  if (isSolarbank) addSolarbankScalars(frame, out);
  return out;
}

/**
 * Add the Solarbank's non-float scalars that the measurement loop above cannot reach: SOC, battery
 * temperature and the SOC limits. These are family-specific — on the meter tag `0xa3` is a status byte,
 * not SOC — so this runs only for a Solarbank frame.
 *
 * - **SOC** (`batterySoc`, %) is tag `0xa3`, a `uint8` (so it is skipped by the float loop and by the
 *   `< 0xa6` guard).
 * - **Temperature** (`batteryTemperature`, °C) + **health** (`batteryHealth`, %) come from the `0xa4`
 *   BMS status blob (after its leading type byte), whose trailing struct is
 *   `[… TEMP 01 SOC SOH 00 01 00 02]`: temperature is the byte two before the SOC byte, health (SOH) the
 *   byte one after it. The parse is **self-validated**: the SOC byte inside the blob must equal tag
 *   `0xa3`, else the blob is a different/empty variant (the realtime frame carries an empty `0xa4`) and
 *   both are withheld rather than read from the wrong offset. `batteryHealth` is a CANDIDATE: its offset
 *   in the BMS blob is confirmed and its value (100 on a captured pack) fits a state-of-health percentage
 *   and the app's own `bmsHealth` field, but that it is SOH specifically is not yet hardware-correlated.
 * - **SOC limits** (`dischargeLimit`/`chargeLimit`, %) come from tag `0xb5`'s 4-byte SETTINGS-blob
 *   variant — type `0x04`, payload `[discharge, output cutoff, charge]`. Confirmed live: moving discharge
 *   10%→5% moved `b5[1]` 0x0a→0x05 while charge held at `b5[3]`=0x64.
 * - **Backup reserve** (`backupReserve`, %) comes from tag `0xb5`'s 25-byte FAST-frame variant (type
 *   `0x04`), which leads with `[backupReserve, discharge, charge, …]`. Confirmed by write-readback (it
 *   tracked the app setting 0→5→15 while the min-SOC held), so it is a distinct field from the discharge
 *   floor. The gate is exact-length-25: the 4-byte SETTINGS blob shares these offsets and is read above,
 *   so other `b5` layouts must not fall through here. `getSafetySocParams().backupReserve` (HTTP, paired
 *   with its enable switch) carries the same name from a second source; whether the two agree while that
 *   switch is OFF is not yet verified.
 * - **Grid power limits** (`gridImportLimit`/`gridExportLimit`, W) come from tag `0xdf`'s type-`0x04`
 *   blob: a `uint16` LE at offset 3 = the max power drawn FROM the grid, at offset 5 = the max power fed
 *   TO the grid. Both confirmed by write-readback in both directions. The length gate (≥7) keeps a
 *   short/empty variant from reading past its end.
 * - **Ambient light** is NOT emitted here. Tag `0xba` bit `0x20` tracks only this SDK's own
 *   `set_device_attrs` write; an app-side toggle goes via an `…/req` cmd-17 `a4` and leaves `ba`
 *   unchanged, so on every ~7 s frame `ba` would clobber the correct value read from the command
 *   channel. State comes solely from {@link SolixMqtt.handleCommand}.
 */
function addSolarbankScalars(frame: SolixParamFrame, out: Record<string, number>): void {
  const a3 = frame.fields.get(0xa3);
  const soc = a3 && a3.length >= 2 ? a3[1]! : undefined;
  if (soc !== undefined) {
    out.batterySoc = soc;
    const body = frame.fields.get(0xa4)?.subarray(1);
    if (body && body.length >= 8 && body[body.length - 6] === soc) {
      out.batteryTemperature = body[body.length - 8]!;
      out.batteryHealth = body[body.length - 5]!;
    }
  }
  const b5 = frame.fields.get(0xb5);
  if (b5 && b5[0] === 0x04 && b5.length === 4) {
    out.dischargeLimit = b5[1]!;
    out.chargeLimit = b5[3]!;
  } else if (b5 && b5[0] === 0x04 && b5.length === 25) {
    out.backupReserve = b5[1]!;
  }
  const df = frame.fields.get(0xdf);
  if (df && df[0] === 0x04 && df.length >= 7) {
    out.gridImportLimit = df.readUInt16LE(3);
    out.gridExportLimit = df.readUInt16LE(5);
  }
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
  /** `get_user_mqtt_info` result — carries endpoint, cert/key, app_name, thing_name, user_id. */
  mqttInfo: SecureMqttCredentials;
  /** Override the MQTT clientId. Defaults to the cert CN (`thing_name`), distinct from the app's id. */
  clientId?: string;
  /**
   * Account/user id (40-hex) for the arming `account_id` + heartbeat topic. Defaults to
   * `mqttInfo.user_id`; set it if the credentials omit it.
   */
  userId?: string;
  /**
   * How often (ms) to re-send the device-info arming request that keeps realtime telemetry flowing.
   * The device stops pushing `param_info` when no client keeps requesting it (the app re-arms on every
   * foreground resume + a periodic heartbeat), so a passive subscriber goes silent after the server's
   * reporting window closes. Default 25s — inside the observed ~30s cadence with keepalive 60. Set `0`
   * to disable arming (subscribe-only, the old behaviour).
   */
  armIntervalMs?: number;
  /**
   * The `head.client_id` stamped into the command/heartbeat envelopes — the app-shaped
   * `android-{app_name}-{user_id}-{mqttUuid}-{ts}` (see {@link buildAppShapedClientId}). Defaults to
   * that shape built from {@link mqttUuid}. Pass this to pin the whole string.
   */
  appClientId?: string;
  /**
   * Stable 16-hex install UUID for the app-shaped client id. Defaults to one derived deterministically
   * from the user id ({@link mqttUuidFrom}) — no storage needed, so the broker sees one stable client
   * across restarts.
   *
   * The trade this makes: the default seed is the **account** id, which every client on that account
   * shares, so two clients on one account derive the same uuid → the same `client_id`, and the broker
   * evicts one to admit the other (they take the channel from each other indefinitely). Restart
   * stability is the common case and this is the deliberate default, but pass an explicit `mqttUuid`
   * (per host/install) when more than one client runs on the same account, to be told apart.
   */
  mqttUuid?: string;
  /** The account's `site_id` for the `power_site` heartbeat. Omitted from the frame when unknown. */
  siteId?: string;
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
  private readonly userId?: string;
  private readonly appClientId: string;
  private readonly armIntervalMs: number;
  private readonly logger?: Logger;
  private readonly siteId?: string;
  private readonly watched = new Map<string, SolixMqttDevice>();
  private seq = 0;
  private armTimer?: ReturnType<typeof setInterval>;

  /**
   * Bind to one account's MQTT plane. The envelope `client_id` takes the app's shape
   * (`android-{app}-{uid}-{mqttUuid}-{ts}`); its `mqttUuid` half must be stable across restarts, or every
   * restart presents itself to the broker as a new client, so it defaults deterministically from the user
   * id (see {@link SolixMqttOptions.mqttUuid}) rather than a fresh random per instance.
   */
  constructor(opts: SolixMqttOptions) {
    super();
    this.appName = opts.mqttInfo.app_name ?? "anker_power";
    this.userId = opts.userId ?? opts.mqttInfo.user_id;
    this.armIntervalMs = opts.armIntervalMs ?? 25_000;
    this.siteId = opts.siteId;
    this.logger = opts.logger;
    const uid = this.userId ?? "anonymous";
    this.appClientId =
      opts.appClientId ??
      buildAppShapedClientId({
        appName: this.appName,
        uid,
        mqttUuid: opts.mqttUuid ?? mqttUuidFrom(`anker-solix-mqtt:${uid}`),
      });
    this.transport = new SecureMqtt({
      credentials: opts.mqttInfo,
      clientId: opts.clientId ?? opts.mqttInfo.thing_name,
      reconnectPeriod: 5000,
      logger: opts.logger,
    });
    this.transport.on("error", (e) => this.emit("error", e));
    this.transport.on("message", (msg: { topic?: string; raw: unknown }) => this.onMessage(msg));
  }

  /**
   * Connect, subscribe to the device's telemetry (+ command-reply) topics, ARM realtime reporting, and
   * start the re-arm/heartbeat timer so telemetry keeps flowing without the app. Idempotent per device.
   *
   * Subscribes to `param_info` (+ the device/account command-reply channels) AND the device's `…/req`
   * channel. `…/req` is the app→device request side — the broker copies the APP's own publishes there to
   * any co-subscriber, so watching it lets us read a control the app changed that the telemetry does NOT
   * reflect: the Solarbank's ambient light and display timeout ride an `…/req` cmd-17 (`0x68`) command
   * (tags `a4`/`a5`), and the `param_info` `ba` bit only tracks OUR `set_device_attrs` write, never the
   * app's separate command path. `onMessage` filters these — our own arming/echoes carry no
   * `a4`/`a5` — and turns an app command into a `reading` with the app-set state. A `…/req` grant denial
   * is non-fatal (only `param_info` is required); we just won't see app-side changes.
   *
   * Throws when `param_info` was not granted. A scope-denied filter comes back as SUBACK_FAILURE rather
   * than an error (see `SecureMqtt.subscribe`), so an unusable subscription otherwise looks like
   * success: the call would resolve and arm on every interval while no reading ever arrives.
   *
   * The re-arm timer is unreffed, so a caller that watches and returns can still exit.
   */
  async watch(device: SolixMqttDevice): Promise<void> {
    await this.transport.connect();
    const topics = solixDeviceTopics(this.appName, device.product_code, device.device_sn);
    const granted = await this.transport.subscribe([
      topics.paramInfo,
      topics.stateInfo,
      topics.cmdRes,
      topics.req,
      ...(this.userId ? [solixUserTopics(this.appName, this.userId).cmdRes] : []),
    ]);
    if (!granted.includes(topics.paramInfo)) {
      const scope = this.appName;
      throw new Error(
        `watch ${device.device_sn}: telemetry topic "${topics.paramInfo}" denied on credential scope ` +
          `"${scope}" — the subscription would arm but never deliver a reading`,
      );
    }
    this.watched.set(device.device_sn, device);
    if (this.armIntervalMs > 0) {
      await this.armAll();
      if (!this.armTimer) {
        this.armTimer = setInterval(() => void this.armAll(), this.armIntervalMs);
        this.armTimer.unref?.();
      }
    }
  }

  /** Tear down the connection and stop the re-arm timer. */
  async close(): Promise<void> {
    if (this.armTimer) {
      clearInterval(this.armTimer);
      this.armTimer = undefined;
    }
    this.watched.clear();
    await this.transport.disconnect();
  }

  /**
   * Set a Solarbank's display screen-off timeout — publishes the captured cmd-17 command (ff09 msgtype
   * `0x68`, tag `a5 = [01, index]`) on the device's `…/req` channel via the same envelope the arming
   * poll uses (`sign_code:1`, no per-message signature — which the device accepts for cmd 17). `index`
   * is the 1-based dropdown position (10s=1, 20s=2, 30s=3, 1m=4, 5m=5, 30m=6); "Never" is a separate
   * command not handled here. Fire-and-forget: the device does not ack on a subscribed channel.
   */
  async setDisplayTimeout(device: SolixMqttDevice, index: number): Promise<void> {
    const topic = solixDeviceTopics(this.appName, device.product_code, device.device_sn).req;
    const body = this.commandEnvelope(device, buildDisplayTimeoutFrame(index), {});
    await this.transport.publish(topic, body, { qos: 1 });
    this.logger?.debug?.(`[solix] display timeout set index=${index} on ${device.device_sn}`);
  }

  /**
   * Re-arm every watched device and send the site heartbeat. The device only pushes `param_info` while
   * a client keeps requesting it — this replays the app's `requestDeviceInfo` (cmd 17) + `power_site`
   * heartbeat (cmd 10); the request frames are reproduced byte-for-byte by {@link buildFf09Request}
   * (checksum-verified against captured frames in its spec). Best-effort: a publish failure is emitted,
   * not thrown, so one bad device doesn't stop the rest or kill the timer.
   */
  private async armAll(): Promise<void> {
    for (const device of this.watched.values()) {
      try {
        await this.arm(device);
      } catch (e) {
        this.emit("error", e);
      }
    }
    if (this.userId) {
      try {
        await this.transport.publish(solixUserTopics(this.appName, this.userId).powerSite, this.heartbeatEnvelope(), {
          qos: 1,
        });
      } catch (e) {
        this.emit("error", e);
      }
    }
  }

  /** Publish the device-info arming request (both the "info" and "realtime" ff09 variants the app sends). */
  private async arm(device: SolixMqttDevice): Promise<void> {
    const topic = solixDeviceTopics(this.appName, device.product_code, device.device_sn).req;
    for (const variant of ["info", "realtime"] as const) {
      const body = this.commandEnvelope(
        device,
        buildFf09Request(variant),
        variant === "info" ? { encoding_type: 2 } : {},
      );
      await this.transport.publish(topic, body, { qos: 1 });
    }
    this.logger?.debug?.(`[solix] armed ${device.device_sn} (param_info reporting requested)`);
  }

  /** The common `head` fields for every cmd envelope; callers add `cmd` + the per-message variable bits. */
  private makeHead(cmd: number, extra: Record<string, unknown>): Record<string, unknown> {
    return {
      version: "1.0.0.1",
      client_id: this.appClientId,
      timestamp: Math.floor(Date.now() / 1000),
      cmd_status: 2,
      sign_code: 1,
      cmd,
      ...extra,
    };
  }

  /**
   * Build the `{head, payload}` cmd-17 (requestDeviceInfo) envelope carrying a base64 ff09 request.
   * `account_id` is omitted when the user id is unknown: a live broker cannot tell an empty placeholder
   * from a real value, so sending `""` would claim an account this client does not have.
   */
  private commandEnvelope(device: SolixMqttDevice, frame: Buffer, extra: Record<string, unknown>): string {
    this.seq += 1;
    return JSON.stringify({
      head: this.makeHead(17, {
        sess_id: genId(),
        msg_seq: this.seq,
        seed: genId(),
        device_pn: device.product_code,
        device_sn: device.device_sn,
      }),
      payload: JSON.stringify({
        device_sn: device.device_sn,
        ...(this.userId ? { account_id: this.userId } : {}),
        data: frame.toString("base64"),
        ...extra,
      }),
    });
  }

  /**
   * The `power_site` heartbeat (cmd 10) envelope the app sends on a timer to keep the session alive.
   * `site_id` is omitted when unknown, for the same reason `account_id` is in {@link commandEnvelope}.
   */
  private heartbeatEnvelope(): string {
    return JSON.stringify({
      head: this.makeHead(10, { sess_id: "1", msg_seq: 1, seed: "1" }),
      payload: JSON.stringify({ user_id: this.userId ?? "", ...(this.siteId ? { site_id: this.siteId } : {}) }),
    });
  }

  /**
   * Decode one inbound MQTT message envelope and emit a `reading` if it carries an ff09 param frame. The
   * product code and the fallback serial come from the topic (`dt/{app}/{pn}/{sn}/param_info`); the frame's
   * own `a2` field wins for the serial when it carries one.
   *
   * Serial resolution matters because NOT every frame carries it: the device-info frame (which alone
   * carries SOC/temperature via tags a3/a4) has a 1-byte `a2` (a status, not a serial) and can arrive on
   * a topic whose serial segment isn't the device serial either — leaving a `deviceSn` that matches no
   * watched device, so a consumer keying on it would drop the reading (and its temperature). So when the
   * resolved serial isn't a watched device, fall back to the single watched device of this product code.
   */
  private onMessage(msg: { topic?: string; raw: unknown }): void {
    const topic = msg.topic ?? "";
    const buf = extractFf09Payload(msg.raw);
    if (!buf) return;
    // The app→device command channel: read back a control the app changed (ambient light / display
    // timeout) that the `param_info` telemetry does not reflect. See {@link handleCommand}.
    if (topic.endsWith("/req")) {
      this.handleCommand(topic, buf);
      return;
    }
    const frame = decodeSolixParamFrame(buf);
    if (!frame) return;
    const parts = topic.split("/");
    const productCode = parts[2] ?? "";
    let deviceSn = frame.deviceSn ?? parts[3] ?? "";
    if (!this.watched.has(deviceSn)) {
      const ofProduct = [...this.watched.values()].filter((d) => d.product_code === productCode);
      if (ofProduct.length === 1) deviceSn = ofProduct[0]!.device_sn;
    }
    // `state_info` shares the ff09 framing but its tags are SETTINGS, not measurements — decode with the
    // state table (its own field names + raw `state_<hex>`), never the param_info measurement table.
    const values = topic.endsWith("/state_info")
      ? solixStateReadings(frame)
      : // Pass the product code so meter tag→name binding is applied only to a meter frame; a Solarbank's
        // tags stay raw channel_<hex> (the model names them per capability) rather than being mislabelled.
        solixReadings(frame, productCode);
    this.emit("reading", { deviceSn, productCode, topic, frame, values });
  }

  /**
   * Turn an app→device cmd-17 (`0x68`) command seen on the `…/req` channel into a `reading` carrying the
   * app-set control state, so a change made in the app reflects back. The Solarbank's ambient light and
   * display timeout are set this way (byte-identical to what {@link setDisplayTimeout} publishes), and the
   * broker copies the app's publish to us as a co-subscriber. Only `0x68` frames carrying `a4`/`a5` are
   * emitted, so the arming polls (`0x40`/`0x57`) and our own echoes contribute nothing:
   * - `a4 = [01, s]` → ambient light, INVERTED (`s` 0 = on) → `ambientLightOn` 1/0. The `ba` telemetry
   *   bit only tracks our `set_device_attrs` write, so this is the ONLY read-back of an app light toggle.
   * - `a5 = [01, i]` → display timeout, `i` = 1-based dropdown index → `displayTimeoutIndex`.
   */
  private handleCommand(topic: string, buf: Buffer): void {
    if (buf.length < 10 || buf[8] !== 0x68) return; // only cmd-17 setting commands carry a4/a5
    const frame = decodeSolixParamFrame(buf);
    if (!frame) return;
    const values: Record<string, number> = {};
    const a4 = frame.fields.get(0xa4);
    if (a4 && a4.length >= 2) values.ambientLightOn = a4[1] === 0 ? 1 : 0;
    const a5 = frame.fields.get(0xa5);
    if (a5 && a5.length >= 2) values.displayTimeoutIndex = a5[1]!;
    if (Object.keys(values).length === 0) return;
    const parts = topic.split("/");
    const productCode = parts[2] ?? "";
    let deviceSn = frame.deviceSn ?? parts[3] ?? "";
    if (!this.watched.has(deviceSn)) {
      const ofProduct = [...this.watched.values()].filter((d) => d.product_code === productCode);
      if (ofProduct.length === 1) deviceSn = ofProduct[0]!.device_sn;
    }
    this.emit("reading", { deviceSn, productCode, topic, frame, values });
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
  const p = payload as { data?: unknown; trans?: unknown } | undefined;
  const data = p?.data ?? p?.trans ?? env.data;
  if (typeof data !== "string") return null;
  const buf = Buffer.from(data, "base64");
  return buf.length ? buf : null;
}

/**
 * Build the ff09 request frame the app base64-encodes into a `requestDeviceInfo` (cmd 17) command's
 * `data`. Captured live from the Anker app — request-type tag `a1`=0x22; the `realtime` variant adds
 * `a2`/`a3` params (this is the one that keeps `param_info` reporting flowing), while `info` is the bare
 * device-info fetch. Frame:
 *   `ff09 | len(u16 LE, TOTAL bytes incl. ff09+len+xor) | 5-byte header | a1 01 22
 *    [| a2 02 01 01 | a3 03 02 2c 01] | fe … <ts32 LE> | xor`
 * `fe` carries a fresh unix-timestamp nonce; the trailing byte is XOR of every preceding byte (the same
 * checksum the meter's telemetry frames use — verified to reproduce the captured frames exactly).
 */
/**
 * Build the display screen-off-timeout command frame (ff09 msgtype `0x68`, tag `a5 = [01, index]`),
 * captured live from the app on `cmd/anker_power/<pc>/<sn>/req` (cmd 17). `index` is the 1-based
 * position in the app dropdown `[10s,20s,30s,1m,5m,30m]` — live-confirmed 10s=1, 30s=3, 1m=4. "Never"
 * is a separate command (not this one). Byte-identical to the captured frames modulo the index byte.
 */
export function buildDisplayTimeoutFrame(index: number): Buffer {
  const body = Buffer.from([0x03, 0x00, 0x0f, 0x00, 0x68, 0xa1, 0x01, 0x22, 0xa5, 0x02, 0x01, index & 0xff]);
  const frame = Buffer.alloc(body.length + 5);
  frame[0] = 0xff;
  frame[1] = 0x09;
  frame.writeUInt16LE(frame.length, 2);
  body.copy(frame, 4);
  let xor = 0;
  for (let i = 0; i < frame.length - 1; i++) xor ^= frame[i]!;
  frame[frame.length - 1] = xor;
  return frame;
}

export function buildFf09Request(variant: "info" | "realtime", atUnixSec?: number): Buffer {
  const ts = Buffer.alloc(4);
  ts.writeUInt32LE((atUnixSec ?? Math.floor(Date.now() / 1000)) >>> 0);
  const body =
    variant === "info"
      ? Buffer.concat([Buffer.from([0x03, 0x00, 0x0f, 0x00, 0x40, 0xa1, 0x01, 0x22, 0xfe, 0x04]), ts])
      : Buffer.concat([
          Buffer.from([
            0x03, 0x00, 0x0f, 0x00, 0x57, 0xa1, 0x01, 0x22, 0xa2, 0x02, 0x01, 0x01, 0xa3, 0x03, 0x02, 0x2c, 0x01, 0xfe,
            0x05, 0x03,
          ]),
          ts,
        ]);
  const frame = Buffer.alloc(body.length + 5);
  frame[0] = 0xff;
  frame[1] = 0x09;
  frame.writeUInt16LE(frame.length, 2);
  body.copy(frame, 4);
  let xor = 0;
  for (let i = 0; i < frame.length - 1; i++) xor ^= frame[i]!;
  frame[frame.length - 1] = xor;
  return frame;
}
