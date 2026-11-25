/**
 * Add each option's raw value to `src/model/capabilities/things-catalog.generated.json`, read from a corpus of
 * product thing descriptions:
 *
 *   node scripts/dev/catalog-raw.ts <corpus-dir>
 *
 * `<corpus-dir>` is what `things-corpus.ts` writes; only `things/<code>.json` is read. A description's enum
 * option carries `associatedValue`: the value the device stores for that option, where the option maps onto one.
 * A variant gets `raw` (option value → that stored value) from the descriptions of its products that list the
 * same option values: a value is kept where every such description agrees on it, and a variant none of whose
 * products the corpus describes that way gets none. Run it on the corpus the catalog was generated from.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** One enum option as a description carries it. */
interface Entry {
  value?: unknown;
  associatedValue?: unknown;
}

/** One catalog variant, as far as this script reads and writes it. */
export interface Variant {
  options?: (readonly [string, string])[];
  raw?: Record<string, string>;
  products: string[];
  [key: string]: unknown;
}

export interface Catalog {
  source: unknown;
  properties: Record<string, Variant[]>;
}

/** A product's option list for `identifier`, from its description under `corpus`, or `undefined`. */
type Describe = (product: string, identifier: string) => Entry[] | undefined;

/** A reader of `corpus/things/<code>.json`, each description parsed once. */
export function describer(corpus: string): Describe {
  const cache = new Map<string, Map<string, Entry[]> | undefined>();
  return (product, identifier) => {
    if (!cache.has(product)) {
      let lists: Map<string, Entry[]> | undefined;
      try {
        const text = readFileSync(join(corpus, "things", `${product}.json`), "utf8");
        const properties =
          (
            JSON.parse(text) as {
              properties?: { identifier?: string; data_type?: { specs?: { eunmList?: Entry[] } } }[];
            }
          ).properties ?? [];
        lists = new Map(properties.map((p) => [p.identifier ?? "", p.data_type?.specs?.eunmList ?? []]));
      } catch {
        lists = undefined;
      }
      cache.set(product, lists);
    }
    return cache.get(product)?.get(identifier);
  };
}

/** `catalog` with `raw` on every variant some of whose products' descriptions name raw values for its options. */
export function withRaw(catalog: Catalog, describe: Describe): Catalog {
  const properties: Record<string, Variant[]> = {};
  for (const [identifier, variants] of Object.entries(catalog.properties)) {
    properties[identifier] = variants.map((variant) => {
      const { raw: _stale, ...rest } = variant;
      const values = (variant.options ?? []).map(([value]) => value);
      if (!values.length) return rest;
      const key = [...values].sort().join(",");
      const stated = new Map<string, Set<string>>();
      for (const product of variant.products) {
        const list = describe(product, identifier);
        if (!list || [...list.map((e) => String(e.value))].sort().join(",") !== key) continue;
        for (const e of list) {
          if (e.associatedValue === undefined || e.associatedValue === null || String(e.associatedValue) === "")
            continue;
          const v = String(e.value);
          stated.set(v, (stated.get(v) ?? new Set()).add(String(e.associatedValue)));
        }
      }
      const raw = Object.fromEntries(
        values.filter((v) => stated.get(v)?.size === 1).map((v) => [v, [...stated.get(v)!][0]!]),
      );
      if (!Object.keys(raw).length) return rest;
      const out = {} as Variant;
      for (const [k, val] of Object.entries(rest)) {
        out[k] = val;
        if (k === "options") out.raw = raw;
      }
      return out;
    });
  }
  return { ...catalog, properties };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const corpus = process.argv[2];
  if (!corpus) {
    console.error("usage: node scripts/dev/catalog-raw.ts <corpus-dir>");
    process.exit(1);
  }
  const file = fileURLToPath(new URL("../../src/model/capabilities/things-catalog.generated.json", import.meta.url));
  const catalog = withRaw(JSON.parse(readFileSync(file, "utf8")) as Catalog, describer(corpus));
  writeFileSync(file, JSON.stringify(catalog));
  const counted = Object.values(catalog.properties).flat();
  console.log(
    `raw values on ${counted.filter((v) => v.raw).length} of ${counted.filter((v) => v.options?.length).length} option variants`,
  );
}
