import { describe, expect, it } from "vitest";
import { extractParamSets, prefixParamSets, updatedParamSets } from "../annexb.js";
import { H264, H265, START_CODE, nalTypes } from "./live-source-fixtures.js";

/**
 * A decoder handed an access unit whose parameter sets were sent earlier in the stream fails with
 * `non-existing PPS 0 referenced` — it has no SPS/PPS for the first slices. Re-emitting the known
 * parameter sets ahead of the unit is what makes such a burst decodable, so this pins the emitted byte
 * order: a decoder reads them in stream order, and a PPS ahead of its SPS is as useless as none.
 */
const nal = (...bytes: number[]): Buffer => Buffer.concat([START_CODE, Buffer.from(bytes)]);

const h264Sps = nal(...H264.sps);
const h264Pps = nal(...H264.pps);
const h264Idr = nal(...H264.idr);
const h265Vps = nal(...H265.vps);
const h265Sps = nal(...H265.sps);
const h265Pps = nal(...H265.pps);
const h265Idr = nal(...H265.idr);

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

describe("updatedParamSets", () => {
  const complete = extractParamSets(Buffer.concat([h264Sps, h264Pps, h264Idr]))!;

  it("carries the current sets forward across a unit that announces none", () => {
    expect(updatedParamSets(h264Idr, complete)).toBe(complete);
  });

  it("keeps a PPS still in force when a unit re-states only the SPS", () => {
    const folded = updatedParamSets(Buffer.concat([h264Sps, h264Idr]), complete)!;
    expect(folded.pps).toEqual(complete.pps);
    expect(folded.sps).toEqual(complete.sps);
  });

  it("takes the newer value of a kind that IS re-announced", () => {
    const changed = nal(0x67, 0x4d, 0x00);
    const folded = updatedParamSets(Buffer.concat([changed, h264Idr]), complete)!;
    expect(folded.sps[0]).toEqual(changed.subarray(4));
  });

  it("replaces everything on a codec change — other sets describe another bitstream", () => {
    const folded = updatedParamSets(Buffer.concat([h265Vps, h265Sps, h265Pps, h265Idr]), complete)!;
    expect(folded.codec).toBe("h265");
    expect(folded.sps).toHaveLength(1);
    expect(folded.sps[0]).toEqual(h265Sps.subarray(4));
  });

  it("answers undefined while nothing has been announced yet", () => {
    expect(updatedParamSets(h264Idr, undefined)).toBeUndefined();
  });
});
