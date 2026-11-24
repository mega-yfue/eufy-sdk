/**
 * Light-effect **catalogue** over the vendor's `light` HTTP service — `/app/light/discover/list`,
 * `/app/light/lighteffect/batchget` and `/app/light/aigc/recommend/list`, with their response parsing.
 * `light` here is the service path the vendor publishes, which is why this sits with the rest of the
 * HTTP surface.
 *
 * This module fetches a catalogue definition; `transport/dp-preset.ts` turns one into wire fields, and
 * sits at the transport root because both this and the MQTT router serialize through it.
 *
 * The catalogue is keyed by numeric id throughout and carries no model vocabulary.
 */
import type { MegaHttpClient } from "./mega-client.js";
import type { DpPresetSpec } from "../dp-preset.js";
import { b8, specIsSerializable } from "../dp-preset.js";

/**
 * One entry in the light-effect gallery — the browsable catalogue behind {@link listLightEffects}.
 * `buildable` says whether the entry's definition can be turned into wire fields at all: false when it
 * carries no layers, or a layer shape this SDK cannot encode.
 */
export interface LightEffectSummary {
  /** The catalogue id that identifies this effect on the wire. */
  lightId: number;
  /** Display name from the catalogue (e.g. "Presidents Day"), when present. */
  name?: string;
  /** Preview swatch — `"RRGGBB|RRGGBB…"` — when the catalogue entry carries one. */
  colors?: string;
  /** Whether this entry can be serialized to wire fields. */
  buildable: boolean;
}

/**
 * The default `lightId` window {@link listLightEffects} scans. eufy has NO endpoint that returns the
 * whole gallery: `/app/light/discover/list` surfaces only the holiday carousel, and the app's own
 * category tabs (favorite / daily / holiday / nature / moods / culture — the AI "aigc" scenes are a
 * separate keyword resource, see {@link listAiSceneRecommendations}) are backed by a server-hosted
 * catalogue the app fetches by id. The effects sit in a dense numeric band starting at `10001`; this
 * inclusive `[min, max]` brackets it, and `batchget` returns an entry only for ids that actually
 * exist, so scanning enumerates every populated effect across all categories.
 */
const LIGHT_EFFECT_ID_WINDOW: readonly [number, number] = [10001, 10999];

/** How many ids one `batchget` call carries. The endpoint accepts at least this many per request. */
const BATCHGET_CHUNK = 100;

/**
 * Recursively collect every numeric `scene_id` / `light_id` anywhere in a `discover/list` response, at
 * any nesting depth. The carousel groups scenes under categories (and the exact shape isn't fully
 * pinned), so keying on one fixed path drops whole categories — this walks the whole tree instead.
 */
function collectEffectIds(node: unknown, into: Set<number>): void {
  if (Array.isArray(node)) {
    for (const v of node) collectEffectIds(v, into);
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if ((k === "scene_id" || k === "light_id") && typeof v === "number") into.add(v);
      else collectEffectIds(v, into);
    }
  }
}

/**
 * Unpack one `batchget` entry's effect definition. A catalogue entry carries its payload either on the
 * first `light_effect[]` element or flat on the entry itself, and `params` arrives as either a JSON
 * string or an already-parsed object — normalize both shapes once, here, so the summary and the spec
 * paths can never drift on what they consider a layer.
 */
function parseEntry(entry: Record<string, unknown>): {
  params: Record<string, unknown>;
  layers: DpPresetSpec["layers"];
  brightness?: number;
  colors?: string;
} {
  const effect0 = (Array.isArray(entry.light_effect) ? entry.light_effect[0] : undefined) as
    Record<string, unknown> | undefined;
  const rawParams = (effect0?.params ?? entry.params) as string | Record<string, unknown> | undefined;
  let parsed: unknown;
  try {
    parsed = typeof rawParams === "string" ? JSON.parse(rawParams || "{}") : rawParams;
  } catch {
    parsed = undefined;
  }
  const params: Record<string, unknown> =
    parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const brightness = (effect0?.brightness ?? entry.brightness) as number | undefined;
  const colors = (effect0?.rgb_hex ?? entry.rgb_hex) as string | undefined;
  return {
    params,
    layers: Array.isArray(params.layer) ? (params.layer as DpPresetSpec["layers"]) : [],
    brightness: typeof brightness === "number" ? brightness : undefined,
    colors: typeof colors === "string" && colors ? colors : undefined,
  };
}

/** Parse one `batchget` catalogue entry into a {@link LightEffectSummary}, or `undefined` if it has no id. */
function toLightEffectSummary(entry: Record<string, unknown>): LightEffectSummary | undefined {
  const lightId = typeof entry.light_id === "number" ? entry.light_id : undefined;
  if (lightId === undefined) return undefined;
  const { params, layers, colors } = parseEntry(entry);
  return {
    lightId,
    name: typeof entry.name === "string" ? entry.name : undefined,
    colors,
    buildable: specIsSerializable({
      speed: params.light_effect_speed,
      layerExecutionMode: params.layer_execution_mode,
      layers,
    }),
  };
}

/**
 * Browse the light-effect gallery — the catalogue of `lightId`s that `setEffect` accepts. Unions every
 * scene/light id found anywhere in the `/app/light/discover/list` carousel (walked recursively) with a
 * scan over the default `LIGHT_EFFECT_ID_WINDOW` (the dense id band holding the app's category tabs) plus any
 * `ids` given, then resolves them via `/app/light/lighteffect/batchget` (which returns an entry only
 * for ids that exist). Pass `idRange` to widen/narrow the scan or `ids` to fetch specific ones.
 *
 * `batchget` is issued in chunks of `BATCHGET_CHUNK` (100) ids — the scanned set runs to the hundreds,
 * so one request does not swallow it whole.
 */
export async function listLightEffects(
  mega: MegaHttpClient,
  opts: { idRange?: [number, number]; ids?: number[] } = {},
): Promise<LightEffectSummary[]> {
  const discover = await mega.request<unknown>("light", "/app/light/discover/list", {});
  const discoverIdSet = new Set<number>();
  collectEffectIds(discover, discoverIdSet);
  const [lo, hi] = opts.idRange ?? LIGHT_EFFECT_ID_WINDOW;
  const windowIds: number[] = [];
  for (let id = lo; id <= hi; id++) windowIds.push(id);
  const ids = [...new Set([...(opts.ids ?? []), ...discoverIdSet, ...windowIds])];
  if (!ids.length) return [];

  const seen = new Set<number>();
  const out: LightEffectSummary[] = [];
  for (let i = 0; i < ids.length; i += BATCHGET_CHUNK) {
    const batch = await mega.request<{ list?: Array<Record<string, unknown>> }>(
      "light",
      "/app/light/lighteffect/batchget",
      { light_id: ids.slice(i, i + BATCHGET_CHUNK) },
    );
    for (const entry of batch.list ?? []) {
      const summary = toLightEffectSummary(entry);
      if (summary && !seen.has(summary.lightId)) {
        seen.add(summary.lightId);
        out.push(summary);
      }
    }
  }
  out.sort((a, b) => a.lightId - b.lightId);
  return out;
}

/**
 * List the **AI-generated ambient scenes** ("aigc") — e.g. "Enchanting Starry Night", "Moonlit
 * Serenity". A DIFFERENT resource from {@link listLightEffects}'s id-addressable catalogue:
 * `/app/light/aigc/recommend/list` returns scene **keywords only, with NO `lightId`**, so they can't be
 * driven through `setEffect` — the app turns a chosen keyword into an applied effect via a server-side
 * generate step the SDK hasn't reversed yet. Surfaced for visibility. Needs a `region` (400s
 * without one) and, for some accounts, a device `sn`; `region` defaults to `"eu"` (the endpoint
 * returned an identical list across every shard tried).
 */
export async function listAiSceneRecommendations(
  mega: MegaHttpClient,
  opts: { region?: string; sn?: string } = {},
): Promise<string[]> {
  const body: Record<string, unknown> = { region: opts.region ?? "eu" };
  if (opts.sn) body.sn = opts.sn;
  const res = await mega.request<{ list?: Array<{ keywords?: unknown }> }>(
    "light",
    "/app/light/aigc/recommend/list",
    body,
  );
  return (res.list ?? []).map((e) => e.keywords).filter((k): k is string => typeof k === "string" && k.length > 0);
}

/**
 * Fetch a gallery effect by exact catalog `lightId` and parse it into the {@link DpPresetSpec} the
 * MQTT router serializes — the "Auto inside setEffect" resolution. Matches the EXACT id (never
 * substitutes a neighbour — the write is done on the light's answer whatever its status byte says). Only effects with directly-serializable
 * `params.layer` data are supported; flat/grouped entries throw a clear error rather than emit a guess.
 */
export async function resolveLightEffect(mega: MegaHttpClient, lightId: number): Promise<DpPresetSpec> {
  const batch = await mega.request<{ list?: Array<Record<string, unknown>> }>(
    "light",
    "/app/light/lighteffect/batchget",
    { light_id: [lightId] },
  );
  const entry = (batch.list ?? []).find((e) => e.light_id === lightId);
  if (!entry) throw new Error(`light effect ${lightId} not found in the catalog`);
  const { params, layers, brightness } = parseEntry(entry);
  if (!layers.length) {
    throw new Error(
      `light effect ${lightId} (${JSON.stringify(entry.name)}) has no directly-serializable layer ` +
        `params — flat/grouped catalog entries aren't supported over this wire`,
    );
  }
  return {
    lightId: lightId,
    speed: b8(params.light_effect_speed),
    layerExecutionMode: b8(params.layer_execution_mode),
    layers,
    brightness,
  };
}
