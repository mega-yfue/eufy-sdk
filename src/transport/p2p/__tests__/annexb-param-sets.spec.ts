import { describe, expect, it } from "vitest";
import { extractParamSets, prefixParamSets, splitAnnexbNals } from "../annexb.js";

/**
 * A decoder handed an access unit whose parameter sets were sent earlier in the stream fails with
 * `non-existing PPS 0 referenced` — it has no SPS/PPS for the first slices. Re-emitting the known
 * parameter sets ahead of the unit is what makes such a burst decodable, so this pins the emitted byte
 * order: a decoder reads them in stream order, and a PPS ahead of its SPS is as useless as none.
 */
const START = Buffer.from([0, 0, 0, 1]);

function nal(...bytes: number[]): Buffer {
  return Buffer.concat([START, Buffer.from(bytes)]);
}

/** H.264 NAL types by the low 5 bits: SPS 7, PPS 8, IDR 5. */
const h264Sps = nal(0x67, 0x42, 0x00);
const h264Pps = nal(0x68, 0xce, 0x01);
const h264Idr = nal(0x65, 0x88, 0x84);

/** H.265 NAL types by bits 1..6: VPS 32, SPS 33, PPS 34, IDR 19. */
const h265Vps = nal(0x40, 0x01, 0x0c);
const h265Sps = nal(0x42, 0x01, 0x01);
const h265Pps = nal(0x44, 0x01, 0xc1);
const h265Idr = nal(0x26, 0x01, 0xaf);

/** The NAL type byte of every NAL in a buffer, for order assertions. */
function nalTypes(buf: Buffer): number[] {
  return splitAnnexbNals(buf).map((n) => n[0]);
}

describe("prefixParamSets", () => {
  it("emits H.264 parameter sets in stream order ahead of the unit", () => {
    const sets = extractParamSets(Buffer.concat([h264Sps, h264Pps, h264Idr]))!;
    const primed = prefixParamSets(h264Idr, sets);
    expect(nalTypes(primed)).toEqual([0x67, 0x68, 0x65]);
  });

  it("emits H.265 parameter sets VPS before SPS before PPS", () => {
    const sets = extractParamSets(Buffer.concat([h265Vps, h265Sps, h265Pps, h265Idr]))!;
    const primed = prefixParamSets(h265Idr, sets);
    expect(nalTypes(primed)).toEqual([0x40, 0x42, 0x44, 0x26]);
  });

  it("leaves the unit's own bytes intact after the prefix", () => {
    const sets = extractParamSets(Buffer.concat([h264Sps, h264Pps, h264Idr]))!;
    const primed = prefixParamSets(h264Idr, sets);
    expect(primed.subarray(primed.length - h264Idr.length)).toEqual(h264Idr);
  });

  it("is a no-op for parameter sets that carry no NALs", () => {
    const primed = prefixParamSets(h264Idr, { codec: "h264", sps: [], pps: [], vps: [] });
    expect(primed).toEqual(h264Idr);
  });

  it("round-trips: the result carries the parameter sets it was primed with", () => {
    const sets = extractParamSets(Buffer.concat([h264Sps, h264Pps, h264Idr]))!;
    expect(extractParamSets(h264Idr)).toBeUndefined();
    const recovered = extractParamSets(prefixParamSets(h264Idr, sets))!;
    expect(recovered.sps).toEqual(sets.sps);
    expect(recovered.pps).toEqual(sets.pps);
  });
});
