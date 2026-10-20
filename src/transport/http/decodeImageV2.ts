/**
 * V2 `v2_eufysecurity:` push-thumbnail decoder — keyless.
 *
 * The v2 format is NOT end-to-end encrypted and needs NO key: it is *head-only obfuscation*. A JPEG
 * prefix is encrypted and the rest is left as plaintext standard JPEG, in one of two cuts:
 *   - the prefix is SOI + APP0 + the two quantization tables + the SOF dimensions + the luma Huffman
 *     tables, and the plaintext tail starts at the standard DC-chrominance Huffman table
 *     (`FF C4 00 1F 01`) — the chroma DHTs, the SOS and the entire entropy-coded scan;
 *   - the prefix also covers the chroma Huffman tables, and the plaintext tail starts at a DRI segment
 *     (`FF DD 00 04`) directly in front of the 3-component SOS header and the scan. The standard
 *     Annex-K chroma tables are put back in front of that tail, which makes it the first form.
 * So we reconstruct a viewable image by splicing a freshly built standard JPEG header (correct
 * width/height/chroma-subsampling) onto that plaintext tail.
 *
 * Three unknowns live in the encrypted prefix and are recovered from the scan itself:
 *   - chroma subsampling — it decides which Huffman table each block in an MCU is coded with, so the
 *     wrong guess diverges within a few blocks and the right one walks the scan to its last byte;
 *   - the MCU count — what the scan carries, once subsampling is known;
 *   - width and height — an exact factorisation of that MCU count, chosen by row continuity.
 *
 * The camera's quantization tables are lost with that prefix too. They are not guessed: the substitute
 * tables are right up to a scale, and `contrastScale` below measures the scale the picture itself
 * implies and writes it into the DQT — which recovers the camera's own quality factor closely enough
 * that a thumbnail encoded at quality 30 comes back at 31, rather than washed out.
 *
 * Cracked keylessly 2026-06-04; verified against a live V6 production thumbnail (632×472, 4:4:4).
 *
 * @remarks
 * **Why the search reads the scan rather than decoding candidate frames.** "Does the scan fill this
 * frame?" can be asked by splicing a candidate header on and handing it to `jpeg-js`, since the decoder
 * throws on an under-filled frame. That answer is correct and unaffordable: a `jpeg-js` decode churns
 * about a megabyte of typed arrays whatever the frame size, glibc keeps the arenas rather than handing
 * them back, and the question has to be asked of every candidate geometry — tens of megabytes of
 * resident memory per thumbnail, permanently, which is more than an embedded host gives an app in
 * total. Its ENCODER is worse: ~40 MB of RSS on first use, which is what rules out correcting the
 * picture by rewriting pixels.
 *
 * `scanEntropy` answers the same question by Huffman-walking the scan and discarding every coefficient
 * it decodes: no IDCT, no component planes, no output image, one `Int32Array` of MCU count. The
 * three-hypothesis search allocates a few hundred kilobytes and runs in single-digit milliseconds, and
 * `jpeg-js` is left with the one job that needs it — one probe decode of the frame the search settles
 * on. That decode is a measurement, not a rewrite: what comes back is the camera's own scan under a
 * corrected header (see `contrastScale`), never a re-encode.
 *
 * The probe is the module's whole memory cost, and `jpeg-js` charges about 35 bytes of resident memory
 * per pixel it decodes, so the probe reads at most {@link PROBE_PIXELS} — the whole of a VGA-sized
 * thumbnail, the top rows of a larger frame. Measured after JIT warm-up: about 10 MB of resident
 * memory per thumbnail at 632×472, 1280×720 and 1920×1080 alike, where a 1920×1080 frame probed whole
 * holds about 60 MB and still exceeds {@link PROBE_MEMORY_MB}.
 *
 * Depends on `jpeg-js` (v0.4.x, BSD-3-Clause, pure-JS, **zero transitive dependencies**) for that one
 * probe decode.
 *
 * @module transport/http/decodeImageV2
 */
import { scanEntropy } from "./jpeg-scan.js";
import { decode as jpegDecode } from "jpeg-js";

/** The `v2_eufysecurity:` wrapper prefix (including the trailing colon) that tags a v2 blob. */
const V2_PREFIX = "v2_eufysecurity:";

/**
 * The plaintext start of a v2 blob whose chroma Huffman tables are encrypted too: a DRI segment (`FF DD`,
 * length 4, then two interval bytes) directly in front of the SOS header of a 3-component scan (`FF DA`,
 * length 12).
 */
const DRI_SEGMENT = Buffer.from([0xff, 0xdd, 0x00, 0x04]);
const SOS_HEADER = Buffer.from([0xff, 0xda, 0x00, 0x0c, 0x03]);

/** Zig-zag scan order — DQT segments store the 8×8 quant table in this order. */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
];

/**
 * Standard Annex-K base luma quantization table (natural order, quality 50). The original is lost with
 * the encrypted prefix; this gives a viewable image with only a mild tone shift.
 */
// prettier-ignore
const QUANT_LUMA = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

/** Standard Annex-K base chroma quantization table (natural order, quality 50); see {@link QUANT_LUMA}. */
// prettier-ignore
const QUANT_CHROMA = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
];

/**
 * The standard DC-luma Huffman table (Annex K.3), as a complete DHT segment. The chroma DHTs are part
 * of the plaintext tail (see `plaintextTail`), so only the luma tables belong in the reconstructed header.
 */
const DHT_DC_LUMA = Buffer.from("ffc4001f0000010501010101010100000000000000000102030405060708090a0b", "hex");

/** The standard AC-luma Huffman table (Annex K.3), as a complete DHT segment; see {@link DHT_DC_LUMA}. */
const DHT_AC_LUMA = Buffer.from(
  "ffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c1" +
    "1552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768" +
    "696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7" +
    "c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa",
  "hex",
);

/** The standard DC-chroma Huffman table (Annex K.3, table 1), as a complete DHT segment; see {@link DHT_DC_LUMA}. */
const DHT_DC_CHROMA = Buffer.from("ffc4001f0100030101010101010101010000000000000102030405060708090a0b", "hex");

/** The standard baseline DC-chrominance Huffman marker — the first plaintext byte of the v2 tail. */
const DC_CHROMA = DHT_DC_CHROMA.subarray(0, 5);

/** The standard AC-chroma Huffman table (Annex K.3, table 1), as a complete DHT segment; see {@link DHT_DC_LUMA}. */
const DHT_AC_CHROMA = Buffer.from(
  "ffc400b51100020102040403040705040400010277000102031104052131061241510761711322328108144291a1b1c1" +
    "09233352f0156272d10a162434e125f11718191a262728292a35363738393a434445464748494a535455565758595a636465" +
    "666768696a737475767778797a82838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2" +
    "c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae2e3e4e5e6e7e8e9eaf2f3f4f5f6f7f8f9fa",
  "hex",
);

const SOI = Buffer.from([0xff, 0xd8]);
const APP0 = Buffer.from("ffe000104a46494600010100000100010000", "hex");

/** Subsampling id → MCU pixel size [w, h]: 0 = 4:4:4, 1 = 4:2:2, 2 = 4:2:0. */
const MCU: Record<number, [number, number]> = { 0: [8, 8], 1: [16, 8], 2: [16, 16] };

function scaleQuant(base: readonly number[], quality: number): number[] {
  const factor = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * factor + 50) / 100))));
}

function dqtSegment(table: readonly number[], id: number, quality: number): Buffer {
  const q = scaleQuant(table, quality);
  const body = Buffer.alloc(65);
  body[0] = id;
  for (let i = 0; i < 64; i++) body[1 + i] = q[ZIGZAG[i]];
  return Buffer.concat([Buffer.from([0xff, 0xdb, 0x00, 0x43]), body]);
}

/** Build the SOF0 segment for a baseline JPEG of the given geometry. */
function sofSegment(width: number, height: number, subsampling: number): Buffer {
  const samplingFactors = subsampling === 2 ? 0x22 : subsampling === 1 ? 0x21 : 0x11;
  // prettier-ignore
  return Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff,
    0x03, 0x01, samplingFactors, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

/** A standard baseline JPEG header for (width, height, subsampling), ending right before the DC-chroma DHT. */
function buildHeader(width: number, height: number, subsampling: number, quality: number): Buffer {
  return Buffer.concat([
    SOI,
    APP0,
    dqtSegment(QUANT_LUMA, 0, quality),
    dqtSegment(QUANT_CHROMA, 1, quality),
    sofSegment(width, height, subsampling),
    DHT_DC_LUMA,
    DHT_AC_LUMA,
  ]);
}

interface Decoded {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * The most pixels the one probe decode reads: 640×480. A larger frame is probed on its top rows (see
 * {@link probeHeight}).
 */
const PROBE_PIXELS = 640 * 480;

/**
 * What the one probe decode may allocate before `jpeg-js` refuses it.
 *
 * A backstop above {@link PROBE_PIXELS}'s cost, not the budget itself: `jpeg-js` checks it as it
 * allocates, so by the time it refuses a decode most of that memory is already resident.
 */
const PROBE_MEMORY_MB = 24;

/** Decode a spliced header+tail; null when it is not a decodable baseline JPEG after all. */
function decodeSpliced(header: Buffer, tail: Buffer): Decoded | null {
  try {
    return jpegDecode(Buffer.concat([header, tail]), { useTArray: true, maxMemoryUsageInMB: PROBE_MEMORY_MB });
  } catch {
    return null;
  }
}

/**
 * The height of the band the probe decodes: the whole frame when it fits {@link PROBE_PIXELS}, else as
 * many whole MCU rows from the top as fit, and never less than one.
 *
 * A baseline scan with no restart markers can only be entered at its start, so a band is necessarily
 * its top rows. A header whose SOF states that shorter height makes `jpeg-js` decode those rows and
 * stop, and the contrast those rows span stands for the frame's — the substitute tables are wrong by
 * the same scale on every block, so any band measures it as long as the band spans the picture's range.
 */
function probeHeight(width: number, height: number, subsampling: number): number {
  if (width * height <= PROBE_PIXELS) return height;
  const mcuHeight = MCU[subsampling]![1];
  return Math.max(1, Math.floor(PROBE_PIXELS / width / mcuHeight)) * mcuHeight;
}

/**
 * The quality the reconstruction's substitute quant tables start at, before `contrastScale`.
 *
 * Only a starting point: it decides the numbers in the DQT the probe decode reads the picture through,
 * and the stretch is measured relative to it. 85 is what the original crack used, so a thumbnail whose
 * camera encoded near it comes out unchanged.
 */
const REFERENCE_QUALITY = 85;

/** The most a reconstruction will amplify. A nearly flat picture is a broken one, not one to amplify 50×. */
const MAX_STRETCH = 8;

/** Fraction of pixels, per end and per channel, ignored when reading a channel's range. PIL's autocontrast default. */
const CUTOFF_PERCENT = 0.5;

/** One channel's range, with `cutoff`% of the pixels trimmed off each end so a few outliers cannot set it. */
function trimmedRange(data: Uint8Array, channel: number, total: number, cutoff: number): { lo: number; hi: number } {
  const hist = new Array<number>(256).fill(0);
  for (let i = 0; i < total; i++) hist[data[i * 4 + channel]!]!++;

  let remaining = Math.floor((total * cutoff) / 100);
  let lo = 0;
  while (lo < 255 && remaining > 0) {
    if (remaining < hist[lo]!) break;
    remaining -= hist[lo]!;
    lo++;
  }
  remaining = Math.floor((total * cutoff) / 100);
  let hi = 255;
  while (hi > 0 && remaining > 0) {
    if (remaining < hist[hi]!) break;
    remaining -= hist[hi]!;
    hi--;
  }
  return { lo, hi };
}

/**
 * How much to amplify the reconstruction, as a factor on its quantization tables.
 *
 * The v2 head takes the camera's own quant tables with it, so the substitute tables are right only up
 * to a scale — and a scale on the tables IS a scale on every dequantized coefficient, so the decoded
 * picture comes out as `128 + k·(deviation)`. Too small a `k` is the "fog": a flat, washed-out image
 * where the camera's had contrast.
 *
 * The factor that undoes it is the one that opens the picture up to the full 0–255 range, and it can
 * be applied by rewriting the DQT rather than by rewriting pixels — which is the whole point, because
 * a pixel rewrite has to be re-encoded, and `jpeg-js`'s encoder costs ~40 MB of RSS on first use — more
 * than a memory-capped host gives an app in total (see the module doc). The measurement is symmetric
 * about 128 because that is JPEG's own level-shift midpoint: the DC coefficient a block carries is its
 * deviation from mid-grey.
 *
 * RGB rather than luma, and the tightest channel wins, so amplification never clips a channel that was
 * already at the rail. A picture that already spans the range measures 1 and is left exactly as it is,
 * and a channel with no range at all is skipped rather than stretched: it says nothing about scale, and
 * amplifying it would turn a flat picture into a black-and-white one.
 */
function contrastScale(img: Decoded, cutoff = CUTOFF_PERCENT): number {
  const total = img.width * img.height;
  if (total === 0) return 1;
  let stretch = Number.POSITIVE_INFINITY;
  for (let channel = 0; channel < 3; channel++) {
    const { lo, hi } = trimmedRange(img.data, channel, total, cutoff);
    if (hi <= lo) continue;
    if (lo < 128) stretch = Math.min(stretch, 128 / (128 - lo));
    if (hi > 128) stretch = Math.min(stretch, 127 / (hi - 128));
  }
  if (!Number.isFinite(stretch)) return 1;
  return Math.min(MAX_STRETCH, Math.max(1, stretch));
}

/**
 * The quality whose Annex-K scaling is `stretch` times `REFERENCE_QUALITY`'s.
 *
 * `scaleQuant`'s factor is what multiplies the base tables, so asking for `stretch` amplification is
 * asking for a factor `stretch` times the reference's — and the quality number that produces it is the
 * factor curve read backwards. Clamped to a real baseline quality; the per-entry 1..255 clamp inside
 * `scaleQuant` then bounds what the largest stretches can actually do to the high-frequency entries.
 */
function qualityForStretch(stretch: number): number {
  const referenceFactor = REFERENCE_QUALITY < 50 ? Math.floor(5000 / REFERENCE_QUALITY) : 200 - REFERENCE_QUALITY * 2;
  const factor = referenceFactor * stretch;
  const quality = factor <= 100 ? (200 - factor) / 2 : 5000 / factor;
  return Math.min(99, Math.max(1, Math.round(quality)));
}

/**
 * The widest and tallest frame a reconstruction will claim.
 *
 * A guard on the ONE `jpeg-js` decode this module still makes, not a statement about cameras: a
 * factorisation of a corrupt scan's MCU count could otherwise name a 1×N frame of any size, and the
 * decode that follows would allocate for it. Comfortably above 4K in either direction.
 */
const MAX_EDGE = 4096;

/**
 * The shapes a camera thumbnail is allowed to have, as width ÷ height.
 *
 * Every MCU-count factorisation is a geometry the scan could hold, and most of them are absurd — a
 * 300-MCU scan factors into 480×160 and 160×480 as readily as into the 320×240 it actually is. The
 * bounds are deliberately loose (they admit 21:9 letterbox and the portrait doorbell crops) and exist
 * to keep degenerate strips out of the shear comparison, not to pick the answer.
 */
const MIN_ASPECT = 0.4;
const MAX_ASPECT = 4;

/**
 * Mean row-to-row difference of the MCU-resolution luma, for a frame `mcuWidth` MCUs across.
 *
 * The same continuity argument the pixel-level shear metric made, one measurement per MCU instead of
 * one per pixel: a real picture's rows resemble the row above them, and a wrong width wraps each row
 * at the wrong place so that every row is a shifted version of its neighbour. Reading DC coefficients
 * makes this free — they are already decoded, and no frame has to be reconstructed to compare them.
 */
function mcuRowShear(luma: Int32Array, mcuWidth: number, mcuHeight: number): number {
  if (mcuHeight < 2) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (let y = 1; y < mcuHeight; y++) {
    for (let x = 0; x < mcuWidth; x++) sum += Math.abs(luma[y * mcuWidth + x]! - luma[(y - 1) * mcuWidth + x]!);
  }
  return sum / (mcuWidth * (mcuHeight - 1));
}

/** A frame the scan could hold, and how continuous the picture looks at that shape. */
interface Geometry {
  subsampling: number;
  width: number;
  height: number;
  shear: number;
}

/**
 * The frame shape that best explains a scan's MCUs under one subsampling.
 *
 * An MCU count is exactly `mcuWidth × mcuHeight`, so the candidates are that number's divisor pairs —
 * a handful, not a ladder, and the true geometry is always among them. Row continuity then picks which
 * one. Null when no divisor pair is a plausible picture at all.
 */
function bestGeometry(luma: Int32Array, mcus: number, subsampling: number): Geometry | null {
  const [mcuPixelWidth, mcuPixelHeight] = MCU[subsampling]!;
  let best: Geometry | null = null;
  for (let mcuWidth = 1; mcuWidth <= mcus; mcuWidth++) {
    if (mcus % mcuWidth !== 0) continue;
    const mcuHeight = mcus / mcuWidth;
    const width = mcuWidth * mcuPixelWidth;
    const height = mcuHeight * mcuPixelHeight;
    if (width > MAX_EDGE || height > MAX_EDGE) continue;
    const aspect = width / height;
    if (aspect < MIN_ASPECT || aspect > MAX_ASPECT) continue;
    const shear = mcuRowShear(luma, mcuWidth, mcuHeight);
    if (!best || shear < best.shear) best = { subsampling, width, height, shear };
  }
  return best;
}

/**
 * Recover subsampling and frame geometry from the plaintext scan, decoding no pixels.
 *
 * Each subsampling hypothesis assigns a different Huffman table to each block position in an MCU, so
 * the wrong one reads the stream with the wrong code table and dies within a few blocks — only the
 * right one walks the scan to its final byte on a whole-MCU boundary. Measured on the fixtures and on
 * synthetic 4:4:4/4:2:2/4:2:0 encodings of ten geometries: exactly one hypothesis ever completes.
 */
function findGeometry(tail: Buffer): Geometry | null {
  let best: Geometry | null = null;
  for (const subsampling of [0, 1, 2]) {
    const scan = scanEntropy(tail, subsampling, [DHT_DC_LUMA, DHT_AC_LUMA]);
    if (!scan?.complete || scan.mcus < 1) continue;
    const geometry = bestGeometry(scan.luma, scan.mcus, subsampling);
    if (geometry && (!best || geometry.shear < best.shear)) best = geometry;
  }
  return best;
}

/**
 * Where the plaintext DRI + SOS starts in a v2 blob, or -1 when it has none: the DRI segment directly in
 * front of the last 3-component SOS.
 *
 * The last SOS wins: the entropy-coded scan after the real SOS stuffs every `FF` data byte with `00`,
 * so `FF DA` cannot occur there, and an earlier match can only be encrypted bytes that happen to take
 * the same shape. A tail cut at the wrong place still fails the geometry search and the probe decode.
 */
function findScanCut(data: Buffer): number {
  const sos = data.lastIndexOf(SOS_HEADER);
  if (sos < 0) return -1;
  const dri = sos - DRI_SEGMENT.length - 2;
  return dri >= 0 && data.subarray(dri, dri + DRI_SEGMENT.length).equals(DRI_SEGMENT) ? dri : -1;
}

/**
 * The plaintext tail of a v2 blob, starting at its chroma Huffman tables, or null when it has neither
 * plaintext start.
 *
 * A blob cut at the DC-chroma DHT carries those tables itself and its tail is returned as it is. A blob
 * cut at the DRI in front of the SOS lost them with the encrypted prefix; the standard Annex-K
 * chroma DHTs are prepended, which yields the same shape of tail.
 */
function plaintextTail(data: Buffer): Buffer | null {
  const cut = data.indexOf(DC_CHROMA);
  if (cut >= 0) return data.subarray(cut);
  const scan = findScanCut(data);
  if (scan < 0) return null;
  return Buffer.concat([DHT_DC_CHROMA, DHT_AC_CHROMA, data.subarray(scan)]);
}

/** True if the blob is a v2 `v2_eufysecurity:` push thumbnail. */
export function isV2Image(data: Buffer): boolean {
  return data.length >= V2_PREFIX.length && data.subarray(0, V2_PREFIX.length).toString("latin1") === V2_PREFIX;
}

/**
 * Decode a v2 blob to a plain JPEG buffer by reconstructing its header, or null if it isn't v2, the
 * plaintext scan can't be located, or no frame shape explains it.
 *
 * Three steps and no pixel rewrite: the frame shape is read out of the entropy scan, one probe decode
 * of at most 640×480 pixels both proves the spliced JPEG decodes and measures how far the
 * substitute quant tables fall short of the camera's, and the answer is the same tail under a header
 * carrying the corrected tables. See the module doc for the keyless-splice rationale and for why
 * neither the search nor the correction decodes candidate frames or re-encodes the picture.
 */
export function decodeImageV2(data: Buffer): Buffer | null {
  if (!isV2Image(data)) return null;
  const tail = plaintextTail(data);
  if (!tail) return null;

  const geometry = findGeometry(tail);
  if (!geometry) return null;

  const { width, height, subsampling } = geometry;
  const band = probeHeight(width, height, subsampling);
  const probe = decodeSpliced(buildHeader(width, band, subsampling, REFERENCE_QUALITY), tail);
  if (!probe) return null;

  const stretch = contrastScale(probe);
  const header = buildHeader(
    width,
    height,
    subsampling,
    stretch > 1.01 ? qualityForStretch(stretch) : REFERENCE_QUALITY,
  );
  return Buffer.concat([header, tail]);
}
