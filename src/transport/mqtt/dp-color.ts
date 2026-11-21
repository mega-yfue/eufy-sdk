/**
 * Command-specific fields for the `0x0206` DP custom-colour action. The T8L02 frame applies one
 * foreground RGBCW block to every reported segment, carries no background colour, and marks the
 * selection as outside the cloud catalog. Framing, account identity and publication remain in MQTT.
 */
import type { DpField } from "./dp-codec.js";
import { rgbcwBlock } from "../dp-preset.js";
import { u16le, u32le } from "../../core/util.js";

export interface DpColorSpec {
  red: number;
  green: number;
  blue: number;
  segmentCount: number;
}

/**
 * Reusable non-catalog custom-colour id, as captured from the current app: successive writes of any
 * colour reuse it unchanged.
 */
const LOCAL_COLOR_ID = 20006;
const MAX_SEGMENTS = 254;

/** Serialize a validated semantic RGB intent into the complete confirmed `0xa3`-`0xb0` field run. */
export function dpColorFields(spec: DpColorSpec): DpField[] {
  const channels = [spec.red, spec.green, spec.blue];
  if (channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    throw new Error("custom-colour RGB channels must be integers in 0..255");
  }
  if (!Number.isInteger(spec.segmentCount) || spec.segmentCount < 1 || spec.segmentCount > MAX_SEGMENTS) {
    throw new Error(`custom-colour segment count must be an integer in 1..${MAX_SEGMENTS}`);
  }

  const color = rgbcwBlock(Buffer.from(channels).toString("hex"));
  if (!color) throw new Error("custom-colour RGB channels could not be converted to RGBCW");
  const positions = Buffer.from([spec.segmentCount, ...Array.from({ length: spec.segmentCount }, (_, index) => index)]);

  return [
    { tag: 0xa3, value: u16le(LOCAL_COLOR_ID) },
    { tag: 0xa4, value: u16le(0) },
    { tag: 0xa5, value: Buffer.from([5]) },
    { tag: 0xa6, value: Buffer.concat([Buffer.from([1]), color]) },
    { tag: 0xa7, value: positions },
    { tag: 0xa8, value: Buffer.from([100]) },
    { tag: 0xa9, value: Buffer.alloc(5) },
    { tag: 0xaa, value: Buffer.from([0]) },
    { tag: 0xab, value: u16le(0) },
    { tag: 0xac, value: u32le(0xffffffff) },
    { tag: 0xad, value: Buffer.from([0]) },
    { tag: 0xae, value: Buffer.from([0]) },
    { tag: 0xaf, value: Buffer.from([0]) },
    { tag: 0xb0, value: Buffer.from([0]) },
  ];
}
