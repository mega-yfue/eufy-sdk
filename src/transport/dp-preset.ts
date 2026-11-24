/**
 * `0x020D` light-effect payload serializer for the `eufy_life` smart-light line: the catalog effect
 * definition ({@link DpPresetSpec}) → the command-specific DP fields, including the per-layer
 * header/colour/trailer encoding and the RGBCW colour approximation.
 *
 * Lives at the transport root, not under one transport folder, because two consumers need it and they
 * sit in different subfolders: `mqtt/command-router.ts` serializes an effect to send it, and
 * `http/light-catalog.ts` trial-serializes one to report whether the catalog entry is drivable at all.
 * Same reason `ff09.ts` sits here. It builds FIELDS, not a frame — the DP framing + envelope stay in
 * `mqtt/dp-codec.ts`, and nothing here names a capability or a transport.
 *
 * Header + trailer are byte-exact to the app's frames; colours run through {@link rgbcwBlock}, a
 * physically-grounded approximation of the device's on-device 5-channel (R,G,B,WarmWhite,ColdWhite)
 * mixing engine — EXACT on pure red and blue, ~18/255 mean on mixed colours, because the engine's
 * nonlinear gamut expansion isn't fully reversed.
 */
import type { DpField } from "./mqtt/dp-codec.js";
import { clamp, u32le } from "../core/util.js";

/** One layer of a gallery light effect, as the cloud catalog `params.layer[]` describes it. */
export interface DpPresetLayer {
  current_layer_type: number;
  colors?: string; // "RRGGBB|RRGGBB…"
  layer_priority?: number;
  layer_speed?: number;
  layer_range?: number | [number, number];
  interval_type?: number;
  interval_value?: number;
  layer_execution_parameter?: number;
  light_effect_post_cycle_status?: number;
  // type-0 (gradient/fill)
  color_pick_mode?: number;
  gradient_value?: number;
  flow_direction?: number;
  direction_change_mode?: number;
  length_range?: number;
  color_fill_mode?: number;
  insert_block_mode?: number;
  insert_block_range?: number | [number, number];
  insert_black_block_mode?: number;
  insert_black_block_range?: number | [number, number];
  brightness_variation_type?: number;
  brightness_range?: number | [number, number];
  light_effect_cycle_method?: number;
  execution_parameter?: number;
  is_lights_move_with_people?: number;
  // type-1 (solid)
  brightness_value?: number;
  display_mode?: number;
  color_quantity_range?: number;
  transition_mode?: number;
  unit_transition_duration?: number;
  color_switch_mode?: number;
  switch_count?: number;
  color_pick_sequence?: number;
  // type-2 (blink)
  blink_cycle_count?: number;
  blink_position_mode?: number;
  blink_interval?: number | [number, number];
  blink_quantity?: number;
  blink_asynchrony?: number;
  blink_color_switch_mode?: number;
}

/** A resolved gallery effect, produced by the client (from the HTTP catalog) and serialized here. */
export interface DpPresetSpec {
  lightId: number;
  speed: number;
  layerExecutionMode: number;
  layers: DpPresetLayer[];
  /** The catalog's own overall brightness (0-100), sent as a companion `0x0201` frame. */
  brightness?: number;
}

/**
 * Per-channel CIE `Y,x,y` from the T8L02 calibration table in the device's on-device mixing engine.
 * Fitted to captured colour→wire vectors; {@link RGBCW_SAT} is the saturation-expansion power.
 */
const RGBCW_CH: Record<"R" | "G" | "B" | "W" | "C", [number, number, number]> = {
  R: [15.932, 0.7035, 0.294],
  G: [39.83, 0.1629, 0.7208],
  B: [2.2404, 0.1472, 0.0309],
  W: [66.28, 0.4681, 0.4182],
  C: [73.58, 0.3166, 0.3397],
};
const RGBCW_X: Record<string, [number, number, number]> = Object.fromEntries(
  Object.entries(RGBCW_CH).map(([k, [Y, x, y]]) => [k, [(x * Y) / y, Y, ((1 - x - y) * Y) / y]]),
);
/** A catalog colour: exactly six hex digits, the only shape {@link rgbcwBlock} can map. */
const RGB_HEX = /^[0-9a-fA-F]{6}$/;

const RGBCW_GAMMA = 2.2;
const RGBCW_SAT = 1.65;
const dec = (b: number): number => Math.pow(b / 255, RGBCW_GAMMA);
const enc = (v: number): number => Math.round(255 * Math.pow(Math.max(0, Math.min(1, v)), 1 / RGBCW_GAMMA));
function mul3(m: number[][], v: number[]): number[] {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}
function inv3(m: number[][]): number[][] {
  const [a, b, c, d, e, f, g, h, i] = [m[0][0], m[0][1], m[0][2], m[1][0], m[1][1], m[1][2], m[2][0], m[2][1], m[2][2]];
  const A = e * i - f * h,
    B = -(d * i - f * g),
    C = d * h - e * g,
    det = a * A + b * B + c * C;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}
const RGBCW_MRGB = [
  [RGBCW_X.R[0], RGBCW_X.G[0], RGBCW_X.B[0]],
  [RGBCW_X.R[1], RGBCW_X.G[1], RGBCW_X.B[1]],
  [RGBCW_X.R[2], RGBCW_X.G[2], RGBCW_X.B[2]],
];
const RGBCW_MRGB_INV = inv3(RGBCW_MRGB);

/** "RRGGBB" → the 5-byte wire block `[R,G,B,WarmWhite,ColdWhite]` via the RGBCW approximation. */
export function rgbcwBlock(hex: string): Buffer | null {
  if (!RGB_HEX.test(hex)) return null;
  const r = parseInt(hex.slice(0, 2), 16),
    g = parseInt(hex.slice(2, 4), 16),
    b = parseInt(hex.slice(4, 6), 16);
  const target = mul3(RGBCW_MRGB, [dec(r), dec(g), dec(b)]);
  const warm = Math.max(0, Math.min(1, ((r - b) / 255) * 2 + 0.42));
  let best = { rgb: [dec(r), dec(g), dec(b)], w: 0, c: 0 };
  for (let t = 0; t <= 1.7; t += 0.005) {
    const w = t * warm,
      c = t * (1 - warm);
    if (w > 1.15 || c > 1.15) break;
    const rgb = mul3(RGBCW_MRGB_INV, [
      target[0] - (w * RGBCW_X.W[0] + c * RGBCW_X.C[0]),
      target[1] - (w * RGBCW_X.W[1] + c * RGBCW_X.C[1]),
      target[2] - (w * RGBCW_X.W[2] + c * RGBCW_X.C[2]),
    ]);
    if (rgb[0] < -1e-6 || rgb[1] < -1e-6 || rgb[2] < -1e-6) break;
    best = { rgb, w, c };
  }
  const m = Math.max(best.rgb[0], best.rgb[1], best.rgb[2], 1e-9);
  const sat = best.rgb.map((c) => m * Math.pow(Math.max(0, c) / m, RGBCW_SAT));
  return Buffer.from([enc(sat[0]), enc(sat[1]), enc(sat[2]), enc(best.w), enc(best.c)]);
}

/**
 * Any 2-byte "range" field: catalog `[a,b]` → wire `[b,a]` (reversed); bare `N` → `[N,0]`; absent →
 * `[0,0]`, since a field the catalog omits genuinely has no value to pack.
 *
 * Each component goes through {@link b8}, so a value the cloud stringified is accepted and a value of
 * an unreversed SHAPE throws instead of collapsing to zero. That distinction matters here: the write is done
 * on the light's answer whatever its status byte says, so a silently zeroed range would be advertised
 * `buildable` and then reported as applied while the light ignored it.
 */
function rangeBytes2(v: unknown): [number, number] {
  if (v === undefined || v === null) return [0, 0];
  if (Array.isArray(v)) return [b8(v[1]), b8(v[0])];
  return [b8(v), 0];
}
/**
 * A single scalar byte. THROWS on an array: several catalog fields are scalar in the shapes the
 * reverse-engineering validated, but some nature/moods effects carry a `[min,max]` pair in one of
 * these slots (e.g. `interval_value: [1,1]`), and how the app packs that into the fixed-width header
 * is NOT reversed. Silently collapsing the pair to a byte would ship a mis-packed frame that the light
 * ignores while the write reports success on its answer — worse than failing. Refuse it, exactly as
 * {@link layerTrailer} bails on an unknown layer type, until a capture pins the packing down.
 */
export const b8 = (v: unknown): number => {
  if (v === undefined || v === null) return 0;
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) {
    throw new Error(
      `light-effect carries ${JSON.stringify(v)} in a single-byte field — that shape's packing isn't ` +
        `reverse-engineered; refusing to send a silently mis-packed frame`,
    );
  }
  return n & 0xff;
};

/** The shared 8-byte per-layer header. */
function layerHeader(l: DpPresetLayer): number[] {
  return [
    b8(l.layer_priority),
    b8(l.layer_speed),
    ...rangeBytes2(l.layer_range),
    b8(l.interval_type),
    b8(l.interval_value),
    b8(l.light_effect_post_cycle_status),
    b8(l.layer_execution_parameter),
  ];
}

function layerTrailer(l: DpPresetLayer): number[] | null {
  const execOrMove = (): number => b8(l.execution_parameter ?? l.is_lights_move_with_people);
  switch (l.current_layer_type) {
    case 0:
      return [
        b8(l.color_pick_mode),
        b8(l.gradient_value),
        b8(l.flow_direction),
        b8(l.direction_change_mode),
        b8(l.length_range),
        b8(l.color_fill_mode),
        b8(l.insert_block_mode),
        ...rangeBytes2(l.insert_block_range),
        b8(l.insert_black_block_mode),
        ...rangeBytes2(l.insert_black_block_range),
        b8(l.brightness_variation_type),
        ...rangeBytes2(l.brightness_range),
        b8(l.light_effect_cycle_method),
        execOrMove(),
      ];
    case 1:
      return [
        b8(l.brightness_value),
        b8(l.display_mode),
        b8(l.color_quantity_range),
        b8(l.transition_mode),
        b8(l.unit_transition_duration),
        b8(l.color_switch_mode),
        b8(l.switch_count),
        b8(l.color_pick_sequence),
        0,
        b8(l.execution_parameter),
      ];
    case 2:
      return [
        b8(l.brightness_variation_type),
        ...rangeBytes2(l.brightness_range),
        b8(l.blink_cycle_count),
        b8(l.blink_position_mode),
        ...rangeBytes2(l.blink_interval),
        b8(l.blink_quantity),
        b8(l.blink_asynchrony),
        b8(l.blink_color_switch_mode),
        b8(l.light_effect_cycle_method),
        execOrMove(),
      ];
    default:
      return null; // an unseen layer type — refuse rather than emit a guessed shape
  }
}

/**
 * Whether {@link dpPresetFields} would succeed on this spec, decided WITHOUT building the frame.
 * An effect is drivable only if it has at least one layer, every top-level scalar fits a byte, and
 * every layer has a known `current_layer_type`, byte-sized fields, and RGB-hex colours — the same set
 * {@link dpPresetFields} accepts, checked field-for-field.
 *
 * Deliberately does not call {@link layerBlob}: a trial build runs {@link rgbcwBlock}'s gamut search
 * per colour and allocates a buffer per layer, and the catalogue runs this over every entry of a
 * many-hundred-id scan. `layerHeader`/`layerTrailer` raise every relevant throw on plain numbers, and
 * a colour only has to satisfy the same hex test `rgbcwBlock` gates on.
 */
export function specIsSerializable(spec: {
  speed?: unknown;
  layerExecutionMode?: unknown;
  layers: readonly DpPresetLayer[];
}): boolean {
  if (!spec.layers.length) return false;
  try {
    b8(spec.speed);
    b8(spec.layerExecutionMode);
    for (const l of spec.layers) {
      layerHeader(l);
      if (layerTrailer(l) === null) return false;
      const colors = (l.colors ?? "").split("|").filter(Boolean);
      if (!colors.length || !colors.every((c) => RGB_HEX.test(c))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Serialize one catalog layer to its `0xa9+idx` wire blob: header + `[00,type,count]` + colours + trailer. */
function layerBlob(l: DpPresetLayer): Buffer {
  const colors = (l.colors ?? "").split("|").filter(Boolean);
  const blocks = colors.map(rgbcwBlock);
  if (!colors.length || blocks.some((b) => b === null)) {
    throw new Error(`light-effect layer colors ${JSON.stringify(l.colors)} not parseable as RGB hex`);
  }
  const trailer = layerTrailer(l);
  if (!trailer)
    throw new Error(`light-effect layer current_layer_type=${l.current_layer_type} has no known frame shape`);
  return Buffer.concat([
    Buffer.from(layerHeader(l)),
    Buffer.from([0x00, l.current_layer_type & 0xff, colors.length & 0xff]),
    ...(blocks as Buffer[]),
    Buffer.from(trailer),
  ]);
}

/**
 * Build the `0x020D` light-effect frame's command-specific fields (`0xa3` onward — the header
 * `a3`-`a8` plus one `0xa9+idx` layer blob each). `a1`/`a2` are prepended by {@link buildDpFrame}.
 * `a7` is deliberately absent (an empty slot in every real capture).
 */
export function dpPresetFields(spec: DpPresetSpec): DpField[] {
  const fields: DpField[] = [
    { tag: 0xa3, value: u32le(spec.lightId) },
    { tag: 0xa4, value: Buffer.from([spec.speed & 0xff]) },
    { tag: 0xa5, value: Buffer.from([spec.layers.length & 0xff]) },
    { tag: 0xa6, value: Buffer.from([spec.layerExecutionMode & 0xff]) },
    { tag: 0xa8, value: Buffer.from([0]) },
  ];
  spec.layers.forEach((layer, idx) => fields.push({ tag: 0xa9 + idx, value: layerBlob(layer) }));
  return fields;
}

/** The `0xa4`-brightness `0x0201` device-info fields for the companion brightness write. */
export function dpLevelFields(level: number): DpField[] {
  return [{ tag: 0xa4, value: Buffer.from([clamp(Math.round(level), 0, 100) & 0xff]) }];
}
