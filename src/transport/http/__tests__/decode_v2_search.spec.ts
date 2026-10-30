import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * The reconstruction's COST, which the output specs cannot see.
 *
 * Those specs check that the right picture comes out, and would still pass if it were reached by
 * decoding every frame on a ladder and re-encoding the result. It once was, and the bill was a
 * memory-capped caller's whole budget: recovering a 176×144 thumbnail meant ~30 candidate decodes and
 * one `jpeg-js` encode, and measured RSS moved **45 MB per thumbnail and did not come back** (glibc
 * keeps the arenas). An embedded host that allows an app tens of megabytes over its idle footprint
 * killed it on the first detection push that carried a thumbnail.
 *
 * Both halves of that bill are properties of this module, so both are pinned here:
 *   - the geometry search decodes NOTHING — it reads the entropy scan (`jpeg-scan.ts`);
 *   - the answer is the camera's own scan under a rewritten header, so nothing is ever re-encoded.
 *
 * Counting `jpeg-js` calls rather than timing or sampling RSS: the property is "this module decodes one
 * frame and encodes none", which is exact, where a stopwatch or an allocator on a shared CI host is not.
 */
vi.mock("jpeg-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jpeg-js")>();
  return { ...actual, decode: vi.fn(actual.decode), encode: vi.fn(actual.encode) };
});

const { decode, encode } = await import("jpeg-js");
const { decodeImageV2 } = await import("../decodeImageV2.js");

/** Every fixture is FULLY SYNTHETIC (no captured device data / real serials). */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const readFixture = (name: string) => Buffer.from(readFileSync(join(FIXTURE_DIR, name), "utf-8"), "base64");

describe("v2 reconstruction cost", () => {
  beforeEach(() => {
    vi.mocked(decode).mockClear();
    vi.mocked(encode).mockClear();
  });

  it.each([
    "v2_thumbnail_176x144.b64",
    "v2_thumbnail_264x200.b64",
    "v2_thumbnail_320x240_420.b64",
    "v2_thumbnail_176x144_q30.b64",
  ])("decodes one frame and encodes none (%s)", (fixture) => {
    expect(decodeImageV2(readFixture(fixture))).not.toBeNull();

    // One decode: the probe that proves the spliced JPEG decodes and measures the contrast correction.
    expect(vi.mocked(decode)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(encode)).not.toHaveBeenCalled();
  });

  /**
   * A 1280×720 frame at quality 30: too large to probe whole within the budget, and foggy under the
   * reference tables, so it needs the correction the probe measures. FULLY SYNTHETIC — a gradient
   * encoded here, cut at its SOS behind a DRI(0) segment the way the second v2 form is.
   */
  it("probes a large frame on a bounded band and still corrects its contrast", () => {
    const width = 1280;
    const height = 720;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4;
        pixels[at] = Math.round((x * 255) / (width - 1));
        pixels[at + 1] = Math.round(((x + y) * 255) / (width + height - 2));
        pixels[at + 2] = Math.round((((x * 7 + y * 3) % 256) * 255) / 255);
        pixels[at + 3] = 255;
      }
    }
    const jpeg = Buffer.from(encode({ width, height, data: pixels }, 30).data);
    const scan = jpeg.subarray(jpeg.indexOf(Buffer.from([0xff, 0xda, 0x00, 0x0c])));
    const blob = Buffer.concat([
      Buffer.from("v2_eufysecurity:"),
      Buffer.alloc(64, 0x5a),
      Buffer.from([0xff, 0xdd, 0x00, 0x04, 0x00, 0x00]),
      scan,
    ]);
    vi.mocked(decode).mockClear();

    const out = decodeImageV2(blob);
    expect(out).not.toBeNull();

    expect(vi.mocked(decode)).toHaveBeenCalledTimes(1);
    const probed = vi.mocked(decode).mock.results[0]!.value as { width: number; height: number };
    expect(probed.width).toBe(width);
    expect(probed.width * probed.height).toBeLessThanOrEqual(640 * 480);

    const sof = out!.indexOf(Buffer.from([0xff, 0xc0]));
    expect({ height: out!.readUInt16BE(sof + 5), width: out!.readUInt16BE(sof + 7) }).toEqual({ width, height });
    const dqt = out!.indexOf(Buffer.from([0xff, 0xdb]));
    expect(out![dqt + 5]).toBeGreaterThan(5);
  });

  it("decodes nothing at all when no geometry explains the scan", () => {
    const blob = readFixture("v2_thumbnail_176x144.b64");
    expect(decodeImageV2(blob.subarray(0, blob.length - 400))).toBeNull();
    expect(vi.mocked(decode)).not.toHaveBeenCalled();
  });
});
