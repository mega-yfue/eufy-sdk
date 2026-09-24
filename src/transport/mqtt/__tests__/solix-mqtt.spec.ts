/**
 * Decoder tests for the Solix telemetry layer, using a REAL ff09 param frame captured live from a
 * Smart Meter Gen 2 (AE1X0) over AWS-IoT MQTT — deterministic, offline, no network.
 */
import { describe, expect, it } from "vitest";

import {
  buildDisplayTimeoutFrame,
  buildFf09Request,
  decodeSolixParamFrame,
  extractFf09Payload,
  readSolixChannel,
  solixReadings,
  solixStateReadings,
  SOLIX_MODBUS_EMS_MODES,
} from "../solix-mqtt.js";

// Captured from dt/anker_power/AE1X0/AE1X0EXAMPLE00001/param_info (grid idle; voltage ~237.5 V).
const FRAME_HEX =
  "ff09a00003010f0405a10134a2120041453158304558414d504c453030303031a3020100a6050309000001" +
  "a8050500000000a9050500000000aa050500000000ab050500000000ac050500806d43ad050500000000" +
  "ae050500000000af050500000000b0050500000000b1050500000000b2050500000000b3050500000000" +
  "b4050500000000b5050500000000b6050500000000b7050500000000b802010344";
const FRAME = Buffer.from(FRAME_HEX, "hex");

// A SECOND live AE1X0 capture, this one with the meter under load (a small net grid import): the REAL
// on-wire frame with only the device serial redacted to the synthetic id and the trailing XOR
// recomputed for that swap — NOT a synthesised one. This matters for the a8/ab pair: `meterPowerL1 ==
// meterPowerTotal` here because the DEVICE itself reported the two slots equal (its own bytes), so the
// L1==total mirror is independently corroborated by a real observation, not by writing the same bytes
// to both slots. It carries a real line current + voltage, a cumulative import counter, and `0xb2`/`0xb7`
// reading non-zero under load (0 at idle) — the whole point of a load-varying frame the idle one can't be.
const LOAD_FRAME_HEX =
  "ff09a00003010f0405a10134a2120041453158304558414d504c453030303031a3020100a6050309000001" +
  "a80505cdcc2c40a9050500000000aa050500000000ab0505cdcc2c40ac0505cd4c6f43ad050500000000" +
  "ae050500000000af0505ee7caf3fb0050500000000b1050500000000b20505bc74133cb305054c379442" +
  "b4050500000000b5050500000000b6050500000000b70505cdcccc3db8020103ff";
const LOAD_FRAME = Buffer.from(LOAD_FRAME_HEX, "hex");

describe("Solix MQTT param decoding", () => {
  it("parses the ff09 frame's serial and TLV fields", () => {
    const frame = decodeSolixParamFrame(FRAME)!;
    expect(frame.deviceSn).toBe("AE1X0EXAMPLE00001");
    expect(frame.fields.has(0xac)).toBe(true);
    expect(frame.fields.get(0xa1)).toEqual(Buffer.from([0x34]));
  });

  it("rejects a non-ff09 buffer", () => {
    expect(decodeSolixParamFrame(Buffer.from("deadbeef", "hex"))).toBeNull();
  });

  it("reads a float32 channel from a type-0x05 value", () => {
    const ch = readSolixChannel(Buffer.from("0500806d43", "hex"))!;
    expect(ch.type).toBe(0x05);
    expect(ch.float).toBeCloseTo(237.5, 1);
  });

  it("names the twelve app fields for a meter frame, keeps reserved tags (0xb2) raw-only, emits every float as channel_<hex>", () => {
    const values = solixReadings(decodeSolixParamFrame(FRAME)!, "AE1X0");
    expect(values.meterVoltageL1).toBeCloseTo(237.5, 1);
    expect(values["channel_ac"]).toBeCloseTo(237.5, 1);
    // The named electrical fields + energy counters are emitted (0 on this idle single-phase frame).
    expect(values.meterPowerL1).toBe(0);
    expect(values.meterPowerTotal).toBe(0);
    expect(values.meterCurrentL1).toBe(0);
    expect(values.meterImportEnergy).toBe(0);
    expect(values["channel_a8"]).toBe(0);
    // 0xb2 names no field — it stays raw channel_b2 only, never a "meterCurrentTotal".
    expect(values["channel_b2"]).toBe(0);
    expect("meterCurrentTotal" in values).toBe(false);
    // a6 is a non-float type (0x03) → excluded from readings
    expect(values["channel_a6"]).toBeUndefined();
  });

  it("binds the meter fields against a real load-varying frame (L1 power == total, current, import; b2 constant)", () => {
    const values = solixReadings(decodeSolixParamFrame(LOAD_FRAME)!, "AE1X0");
    // The checksum-validated frame decodes (a corrupted one returns null and would fail here).
    expect(decodeSolixParamFrame(LOAD_FRAME)).not.toBeNull();
    // L1 line power equals the aggregate total on a single-phase install — the a8/ab mirror. Here the
    // device reported both slots as 2.7 W independently, so the equality corroborates the binding.
    expect(values.meterPowerL1).toBeCloseTo(2.7, 2);
    expect(values.meterPowerTotal).toBe(values.meterPowerL1);
    expect(values.meterVoltageL1).toBeCloseTo(239.3, 1);
    expect(values.meterCurrentL1).toBeCloseTo(1.371, 2);
    expect(values.meterImportEnergy).toBeCloseTo(74.108, 2);
    // 0xb2 reads 0.009 under a 1.371 A line current — three orders off a current total, so NOT one, and
    // unnamed. (It is 0 at idle and non-zero here, so it tracks something load-related, just not current.)
    expect(values["channel_b2"]).toBeCloseTo(0.009, 3);
    expect("meterCurrentTotal" in values).toBe(false);
    // L2/L3 slots are unconnected on a single-CT install → reported as 0 (present, not fabricated).
    expect(values.meterPowerL2).toBe(0);
    expect(values.meterCurrentL3).toBe(0);
  });

  it("withholds the meter tag→name table from a non-meter (Solarbank) frame, and from an unknown origin", () => {
    // A Solarbank (AE103) reports tag 0xac too, but it is a power value there, not a voltage — so the
    // meter name must NOT be borrowed. Every tag still surfaces raw as channel_<hex>.
    const solarbank = solixReadings(decodeSolixParamFrame(FRAME)!, "AE103");
    expect(solarbank.meterVoltageL1).toBeUndefined();
    expect(solarbank.meterPowerL1).toBeUndefined();
    expect(solarbank["channel_ac"]).toBeCloseTo(237.5, 1);
    // With no product code the table cannot be known to fit, so names are withheld too.
    expect(solixReadings(decodeSolixParamFrame(FRAME)!, "").meterVoltageL1).toBeUndefined();
  });

  it("extracts the ff09 payload from the {head, payload:{data}} MQTT envelope", () => {
    const envelope = { head: { cmd: 16 }, payload: JSON.stringify({ device_sn: "x", data: FRAME.toString("base64") }) };
    const buf = extractFf09Payload(envelope)!;
    expect(buf.equals(FRAME)).toBe(true);
    expect(decodeSolixParamFrame(buf)!.deviceSn).toBe("AE1X0EXAMPLE00001");
  });
});

// Build a valid ff09 param frame from TLV fields (each value = the on-wire bytes after tag+len, i.e.
// including the leading type byte), with the 5-byte header + trailing XOR checksum the decoder expects.
function buildFrame(fields: Array<[number, Buffer]>): Buffer {
  const parts: Buffer[] = [Buffer.from([0x03, 0x01, 0x0f, 0x04, 0x05])]; // header (no 0xa1 byte)
  for (const [tag, val] of fields) parts.push(Buffer.from([tag, val.length]), val);
  const body = Buffer.concat(parts);
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
const f32 = (n: number): Buffer => {
  const b = Buffer.alloc(5);
  b[0] = 0x05; // float32 measurement type
  b.writeFloatLE(n, 1);
  return b;
};

describe("Solix Solarbank (AE103 / ats_ax170) decoding", () => {
  // a4 BMS status blob: type 0x04 + serial + pad + trailing struct [.. TEMP 01 SOC SOH 00 01 00 02].
  const a4blob = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from("AE1BMSYNTH00001", "latin1"),
    Buffer.from([
      0x00, 0x00, 0x00, 0x04, 0x06, 0x06, 0x01, 0x00, 0x00, 0x3a, 0x01, 24, 0x01, 12, 100, 0x00, 0x01, 0x00, 0x02,
    ]),
  ]);
  const FRAME = buildFrame([
    [0xa1, Buffer.from([0x34])],
    [0xa2, Buffer.concat([Buffer.from([0x00]), Buffer.from("AK7DSYNTH00000001", "latin1")])],
    [0xa3, Buffer.from([0x01, 12])], // SOC = 12 (uint8)
    [0xa4, a4blob],
    [0xac, f32(510)], // battery power (charging)
    [0xad, f32(0)], // discharge power
    [0xae, f32(-500)], // AC plug power (drawing in)
    [0xaf, f32(75)], // on-board socket power (an appliance plugged into the unit)
    [0xbc, f32(510)], // charge power
    [0xc4, f32(0)], // grid input
    [0xc5, f32(360)], // home load
    [0xc6, f32(120)], // PV string 1
    // 0xdf grid-limits blob: type 0x04, u16 LE import=2500 @3 ([196,9]), export=750 @5 ([238,2]) — the
    // real layout, both values echoed later in the blob.
    [0xdf, Buffer.from([0x04, 1, 0, 196, 9, 238, 2, 1, 0, 238, 2, 0, 0, 196, 9, 0, 0, 0, 0, 0, 0])],
    [0xba, Buffer.from([0x03, 0x70, 0x08, 0x08, 0x01])], // ba FLAGS 0x70: bit 0x20 SET ⇒ ambient light OFF
  ]);

  it("names the confirmed Solarbank channels and extracts SOC (a3) + temperature (a4 blob)", () => {
    const v = solixReadings(decodeSolixParamFrame(FRAME)!, "AE103");
    expect(v.batterySoc).toBe(12); // from the a3 uint8, not a float channel
    expect(v.batteryTemperature).toBe(24); // from the a4 BMS blob, self-validated against a3 SOC
    expect(v.batteryHealth).toBe(100); // SOH % — the byte after SOC in the a4 BMS blob
    expect(v.gridImportLimit).toBe(2500); // 0xdf u16@3 — max power FROM grid (write-readback confirmed)
    expect(v.gridExportLimit).toBe(750); // 0xdf u16@5 — max power TO grid (write-readback confirmed)
    expect(v.batteryPower).toBeCloseTo(510, 0);
    expect(v.chargePower).toBeCloseTo(510, 0);
    expect(v.dischargePower).toBe(0);
    expect(v.acPlugPower).toBeCloseTo(-500, 0);
    expect(v.gridInputPower).toBe(0);
    expect(v.homeLoadPower).toBeCloseTo(360, 0);
    expect(v.socketPower).toBeCloseTo(75, 0);
    expect(v.pv1Power).toBeCloseTo(120, 0);
    // ba is NOT emitted as the light state — it's stale for app toggles (only tracks our own write) and
    // would clobber the correct value read from the …/req command channel. See addSolarbankScalars.
    expect("ambientLightOn" in v).toBe(false);
    // Raw channels still emitted alongside the names.
    expect(v["channel_ac"]).toBeCloseTo(510, 0);
  });

  it("reads backupReserve from the 25-byte FAST-frame b5 variant (leads with the reserve %)", () => {
    // Real fast-frame layout: type 0x04, [backupReserve=15, discharge=5, charge=100, …].
    const frame = buildFrame([
      [0xa1, Buffer.from([0x34])],
      [0xa3, Buffer.from([0x01, 54])],
      [0xb5, Buffer.from([0x04, 15, 5, 100, 0, 0, 0, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ]);
    const v = solixReadings(decodeSolixParamFrame(frame)!, "AE103");
    expect(v.backupReserve).toBe(15); // b5[1] — confirmed 0→5→15 tracking the app setting
    // the 4-byte-only SETTINGS fields are NOT asserted from this variant (different offsets)
    expect("dischargeLimit" in v).toBe(false);
  });

  it("does NOT read backupReserve from a type-0x04 b5 that is neither 4 nor 25 bytes", () => {
    // The gate is exact-length: only the 4-byte SETTINGS blob and the 25-byte FAST-frame variant are
    // known. Another type-0x04 b5 layout shares the leading bytes but a different meaning, so a 12-byte
    // one must NOT be read as a backup reserve (nor as the SOC limits).
    const frame = buildFrame([
      [0xa1, Buffer.from([0x34])],
      [0xa3, Buffer.from([0x01, 54])],
      [0xb5, Buffer.from([0x04, 15, 5, 100, 0, 0, 0, 0, 0, 0, 0, 0])],
    ]);
    const v = solixReadings(decodeSolixParamFrame(frame)!, "AE103");
    expect("backupReserve" in v).toBe(false);
    expect("dischargeLimit" in v).toBe(false);
  });

  it("does NOT apply the Solarbank table to a meter frame (tag meanings differ per family)", () => {
    const meter = solixReadings(decodeSolixParamFrame(FRAME)!, "AE1X0");
    expect(meter.batteryPower).toBeUndefined();
    expect(meter.batterySoc).toBeUndefined(); // a3 is a status byte on the meter, not SOC
    expect(meter.meterVoltageL1).toBeCloseTo(510, 0); // 0xac gets the METER name instead
  });

  it("withholds temperature when the a4 blob's SOC does not match tag a3 (wrong/empty variant)", () => {
    const bad = buildFrame([
      [0xa1, Buffer.from([0x34])],
      [0xa3, Buffer.from([0x01, 12])],
      [
        0xa4,
        Buffer.concat([
          Buffer.from([0x04]),
          Buffer.from("X"),
          Buffer.from([0x18, 0x01, 99, 100, 0x00, 0x01, 0x00, 0x02]),
        ]),
      ],
    ]);
    const v = solixReadings(decodeSolixParamFrame(bad)!, "AE103");
    expect(v.batterySoc).toBe(12);
    expect(v.batteryTemperature).toBeUndefined(); // blob SOC byte (99) != a3 (12) → not trusted
  });

  it("decodes state_info SETTINGS tags (own table): a9=mode, aa=maxLoad + raw state_* (ab unnamed)", () => {
    const frame = buildFrame([
      [0xa1, Buffer.from([0x32])],
      [0xa5, Buffer.from([0x03, 0x99, 0x0c, 0x00, 0x00])], // type-03 settings int → payload[1]=0x0c=12
      [0xa6, Buffer.from([0x03, 0x00, 0x14, 0x00, 0x00])], // → 0x14 = 20
      [0xa9, Buffer.from([0x01, 0x02])], // mode raw value 2 = self-consumption (AE103 numbering)
      [0xaa, Buffer.from([0x02, 0x20, 0x03])], // u16 LE 0x0320 = 800 (max_load)
      [0xab, f32(-30)], // AC-socket export limit, watts
    ]);
    const v = solixStateReadings(decodeSolixParamFrame(frame)!);
    expect(v.mode).toBe(2);
    expect(v.maxLoad).toBe(800);
    expect(v.state_a5).toBe(12);
    expect(v.state_a6).toBe(20);
    // ab is exposed RAW only (its meaning isn't pinned) — no guessed name is asserted.
    expect(v.state_ab).toBeCloseTo(-30, 0);
    expect("acSocketExportLimit" in v).toBe(false);
    // state_info uses its OWN table — the param_info measurement names are NOT applied here (0xab is the
    // export limit here, not photovoltaicPower).
    expect("photovoltaicPower" in v).toBe(false);
  });

  it("SOLIX_MODBUS_EMS_MODES carries Anker's seven Modbus operating modes (values 0,1,3-7; 2 unassigned)", () => {
    expect(
      Object.keys(SOLIX_MODBUS_EMS_MODES)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([0, 1, 3, 4, 5, 6, 7]);
    expect(SOLIX_MODBUS_EMS_MODES[0]).toBe("selfConsumption");
    expect(SOLIX_MODBUS_EMS_MODES[6]).toBe("smart");
    expect(SOLIX_MODBUS_EMS_MODES[7]).toBe("dynamicTariff");
    expect(SOLIX_MODBUS_EMS_MODES[2]).toBeUndefined(); // Anker leaves value 2 unassigned
  });

  it("the 0xa5 header cutoff differs by design: state_info decodes it, param_info skips it", () => {
    // A float at 0xa5 exercises the cutoff itself (not the type filter). state_info reads from 0xa5;
    // param_info's header runs to 0xa5 and floats start at 0xa6 — so the two constants must not match.
    const frame = buildFrame([
      [0xa1, Buffer.from([0x32])],
      [0xa5, f32(123)],
      [0xa6, f32(45)],
    ]);
    expect(solixStateReadings(decodeSolixParamFrame(frame)!).state_a5).toBeCloseTo(123, 0);
    const p = solixReadings(decodeSolixParamFrame(frame)!, "AE103");
    expect("channel_a5" in p).toBe(false); // param_info skips < 0xa6
    expect(p.channel_a6).toBeCloseTo(45, 0);
  });

  it("decodes SOC limits from tag b5's SHORT settings blob (04 + [discharge, cutoff, charge])", () => {
    const frame = buildFrame([
      [0xa1, Buffer.from([0x34])],
      [0xa3, Buffer.from([0x01, 12])],
      // The settings blob is EXACTLY 4 bytes: type 0x04 + [discharge 5, low-power 5, charge 100].
      [0xb5, Buffer.from([0x04, 0x05, 0x05, 0x64])],
    ]);
    const v = solixReadings(decodeSolixParamFrame(frame)!, "AE103");
    expect(v.dischargeLimit).toBe(5);
    expect(v.chargeLimit).toBe(100);
  });

  it("does NOT decode SOC limits from the LONGER fast-frame b5 blob (it is a different structure)", () => {
    // The msgtype-0x05 fast frame also carries a type-0x04 `b5`, but a 25-byte one whose bytes are
    // NOT the limits (live capture: `04 00 00 64 00…1a…` = discharge byte 0). Decoding it reset the HA
    // slider to 0 every ~7 s, so only the exact 4-byte settings blob is accepted.
    const frame = buildFrame([
      [0xa1, Buffer.from([0x34])],
      [0xa3, Buffer.from([0x01, 12])],
      [0xb5, Buffer.from([0x04, 0x00, 0x00, 0x64, 0, 0, 0, 0, 0, 0x1a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
    ]);
    const v = solixReadings(decodeSolixParamFrame(frame)!, "AE103");
    expect("dischargeLimit" in v).toBe(false);
    expect("chargeLimit" in v).toBe(false);
  });

  it("does NOT read SOC limits from the b5 FLOAT variant (only the type-0x04 blob carries them)", () => {
    const frame = buildFrame([
      [0xa1, Buffer.from([0x34])],
      [0xa3, Buffer.from([0x01, 12])],
      [0xb5, f32(0)], // the fast-frame variant: b5 is a float, not the settings blob
    ]);
    const v = solixReadings(decodeSolixParamFrame(frame)!, "AE103");
    expect("dischargeLimit" in v).toBe(false);
    expect("chargeLimit" in v).toBe(false);
  });
});

// XOR-of-all-bytes == 0 iff the trailing checksum equals the XOR of every preceding byte — the ff09
// convention. Proven against the two live-captured requestDeviceInfo `data` frames.
const xorAll = (b: Buffer): number => b.reduce((a, x) => a ^ x, 0);

describe("Solix requestDeviceInfo ff09 request builder", () => {
  // From cmd/anker_power/AE1X0/<sn>/req, payload.data (base64), captured live. The fe-nonce carries a
  // unix timestamp at frame offset 14 ('info') / 24 ('realtime'), just before the trailing XOR byte.
  const infoCaptured = Buffer.from("/wkTAAMADwBAoQEi/gSau6NqOQ==", "base64");
  const realtimeCaptured = Buffer.from("/wkdAAMADwBXoQEiogIBAaMDAiwB/gUDmrujag0=", "base64");

  it("the checksum convention matches the real captured arming frames", () => {
    expect(xorAll(infoCaptured)).toBe(0); // trailing byte IS the XOR of all the rest
    expect(xorAll(realtimeCaptured)).toBe(0);
    expect(infoCaptured.subarray(0, 2).toString("hex")).toBe("ff09");
    expect(infoCaptured.readUInt16LE(2)).toBe(infoCaptured.length); // declared len = total bytes
  });

  it("rebuilds the captured arming frames byte-for-byte at their captured timestamps", () => {
    // Inject each capture's own timestamp so the only variable is fixed → full byte-equality settles
    // that the builder reproduces the real frames exactly (not just length/checksum/tag presence).
    expect(buildFf09Request("info", infoCaptured.readUInt32LE(14)).equals(infoCaptured)).toBe(true);
    expect(buildFf09Request("realtime", realtimeCaptured.readUInt32LE(24)).equals(realtimeCaptured)).toBe(true);
  });

  it("builds a well-formed 'info' request (a1=0x22, valid ff09 + checksum)", () => {
    const f = buildFf09Request("info");
    expect(f.subarray(0, 2).toString("hex")).toBe("ff09");
    expect(f.readUInt16LE(2)).toBe(f.length); // len field = total frame bytes
    expect(f.length).toBe(19); // same size as the captured 'info' frame
    expect(xorAll(f)).toBe(0); // checksum valid
    expect(f.includes(Buffer.from([0xa1, 0x01, 0x22]))).toBe(true); // request-type tag
  });

  it("builds a well-formed 'realtime' request (extra a2/a3 params)", () => {
    const f = buildFf09Request("realtime");
    expect(f.subarray(0, 2).toString("hex")).toBe("ff09");
    expect(f.readUInt16LE(2)).toBe(f.length);
    expect(f.length).toBe(29); // same size as the captured 'realtime' frame
    expect(xorAll(f)).toBe(0);
    expect(f.includes(Buffer.from([0xa1, 0x01, 0x22]))).toBe(true);
    expect(f.includes(Buffer.from([0xa2, 0x02, 0x01, 0x01]))).toBe(true);
    expect(f.includes(Buffer.from([0xa3, 0x03, 0x02, 0x2c, 0x01]))).toBe(true);
  });

  // The display screen-off-timeout command (cmd 17, ff09 msgtype 0x68, tag a5=[01,index]) — captured
  // live from the app on cmd/anker_power/AE103/<sn>/req. These three are the exact frames observed for
  // the 10s / 30s / 1m dropdown picks, so the builder is pinned byte-for-byte incl. the XOR checksum.
  it("builds the display-timeout command byte-for-byte at the live-captured indices", () => {
    expect(buildDisplayTimeoutFrame(1).toString("hex")).toBe("ff09110003000f0068a10122a5020101a6"); // 10s
    expect(buildDisplayTimeoutFrame(3).toString("hex")).toBe("ff09110003000f0068a10122a5020103a4"); // 30s
    expect(buildDisplayTimeoutFrame(4).toString("hex")).toBe("ff09110003000f0068a10122a5020104a3"); // 1m
    const f = buildDisplayTimeoutFrame(6); // 30m (inferred from the 1-based index)
    expect(f.subarray(0, 2).toString("hex")).toBe("ff09");
    expect(xorAll(f)).toBe(0);
    expect(f.includes(Buffer.from([0xa5, 0x02, 0x01, 0x06]))).toBe(true);
  });
});
