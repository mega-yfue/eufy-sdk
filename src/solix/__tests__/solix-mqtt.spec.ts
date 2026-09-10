/**
 * Decoder tests for the Solix telemetry layer, using a REAL ff09 param frame captured live from a
 * Smart Meter Gen 2 (AE1X0) over AWS-IoT MQTT — deterministic, offline, no network.
 */
import { describe, expect, it } from "vitest";

import { decodeSolixParamFrame, extractFf09Payload, readSolixChannel, solixReadings } from "../solix-mqtt.js";

// Captured from dt/anker_power/AE1X0/6UWDNSL0G23200788/param_info (grid idle; voltage ~237.5 V).
const FRAME_HEX =
  "ff09a00003010f0405a10134a21200365557444e534c30473233323030373838a3020100a6050309000001" +
  "a8050500000000a9050500000000aa050500000000ab050500000000ac050500806d43ad050500000000" +
  "ae050500000000af050500000000b0050500000000b1050500000000b2050500000000b3050500000000" +
  "b4050500000000b5050500000000b6050500000000b7050500000000b802010332";
const FRAME = Buffer.from(FRAME_HEX, "hex");

describe("Solix MQTT param decoding", () => {
  it("parses the ff09 frame's serial and TLV fields", () => {
    const frame = decodeSolixParamFrame(FRAME)!;
    expect(frame.deviceSn).toBe("6UWDNSL0G23200788");
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

  it("emits grid voltage (tag 0xac) and raw float channels, only for float-typed fields", () => {
    const values = solixReadings(decodeSolixParamFrame(FRAME)!);
    expect(values.gridVoltage).toBeCloseTo(237.5, 1);
    expect(values["channel_ac"]).toBeCloseTo(237.5, 1);
    // idle channels read 0
    expect(values["channel_a8"]).toBe(0);
    // a6 is a non-float type (0x03) → excluded from readings
    expect(values["channel_a6"]).toBeUndefined();
  });

  it("extracts the ff09 payload from the {head, payload:{data}} MQTT envelope", () => {
    const envelope = { head: { cmd: 16 }, payload: JSON.stringify({ device_sn: "x", data: FRAME.toString("base64") }) };
    const buf = extractFf09Payload(envelope)!;
    expect(buf.equals(FRAME)).toBe(true);
    expect(decodeSolixParamFrame(buf)!.deviceSn).toBe("6UWDNSL0G23200788");
  });
});
