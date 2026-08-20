/**
 * Per-SKU DP capability catalog — the parsed result of a `get_product_data_point` API call.
 *
 * The response carries one entry per data point, each declaring `dp_id`, a stable `code`, a
 * human `name`, an access `mode`, a `data_type` and a `property` blob. Only the enum ranges are
 * read here; the names and writability that same call reports are already resolved offline into
 * `CLEAN_PARAMS`, so what this adds is the per-SKU narrowing a shared dictionary cannot carry —
 * two products with the same DP can offer different value sets.
 *
 * Still defensive at every step: a missing key or a mismatched shape yields an empty catalog and
 * capabilities fall back to their safe defaults, because a wrong range is worse than none.
 *
 * @module model/capabilities/dp-catalog
 */

/** The parsed DP capability catalog for one product SKU. */
export interface DpCatalog {
  /**
   * For enum-type DPs: the valid integer values as declared in the catalog.
   * Absent for non-enum DPs (bool, raw, integer, string).
   */
  readonly enumRanges: ReadonlyMap<number, readonly number[]>;
}

/** Returned whenever the API call fails or the response shape is not recognised. */
export const EMPTY_DP_CATALOG: DpCatalog = {
  enumRanges: new Map(),
};

/**
 * Parse a `get_product_data_point` response into a {@link DpCatalog}.
 *
 * `raw` is the response's `data` object, already unwrapped by the transport — so the entry array
 * sits at the top level under `data_point_list`.
 *
 * An entry's declared type is `data_type` and its constraint blob is `property`; a range is read
 * only from an enum entry, since that is the only type whose `property` states a closed set.
 * `data_type` is matched case-insensitively — its casing is the server's to choose and nothing
 * here should depend on it.
 *
 * Returns {@link EMPTY_DP_CATALOG} on any shape mismatch — never throws.
 */
export function parseDpCatalog(raw: unknown): DpCatalog {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_DP_CATALOG;
  const r = raw as Record<string, unknown>;
  const list = r.data_point_list;
  if (!Array.isArray(list) || list.length === 0) return EMPTY_DP_CATALOG;

  let found = 0;
  const enumRanges = new Map<number, readonly number[]>();

  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;

    const rawId = e.dp_id;
    const dpId = typeof rawId === "number" ? rawId : typeof rawId === "string" ? Number(rawId) : NaN;
    if (!Number.isInteger(dpId) || dpId <= 0) continue;

    found++;

    const dataType = typeof e.data_type === "string" ? e.data_type.toLowerCase() : "";
    if (dataType === "enum") {
      const range = parseEnumRange(e.property);
      if (range.length > 0) enumRanges.set(dpId, range);
    }
  }

  if (found === 0) return EMPTY_DP_CATALOG;
  return { enumRanges };
}

/**
 * Parse an enum entry's `property` blob into the integer values it allows.
 *
 * The blob is a JSON string in the Tuya schema convention — `{"type":"enum","range":["0","1"]}`,
 * whose members are STRINGS even for a numeric scale. A bare array, or an array already parsed
 * out of JSON, is accepted on the same terms.
 */
function parseEnumRange(values: unknown): readonly number[] {
  if (values === null || values === undefined) return [];
  // Plain array of numbers or numeric strings
  if (Array.isArray(values)) return toNumberArray(values);
  // JSON-stringified: "[0,1,2,3]" or "{\"range\":[\"0\",\"1\",\"2\",\"3\"]}"
  if (typeof values === "string") {
    try {
      const parsed: unknown = JSON.parse(values);
      if (Array.isArray(parsed)) return toNumberArray(parsed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const obj = parsed as Record<string, unknown>;
        if (Array.isArray(obj.range)) return toNumberArray(obj.range);
      }
    } catch {
      // not valid JSON — ignore
    }
  }
  return [];
}

function toNumberArray(arr: unknown[]): readonly number[] {
  const result: number[] = [];
  for (const v of arr) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isInteger(n)) result.push(n);
  }
  return result;
}
