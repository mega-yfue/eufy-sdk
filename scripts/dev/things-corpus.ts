/**
 * Build the evidence corpus for the product thing descriptions: every product's description and its
 * settings bundle (the app's own per-product script), plus, per property identifier, the commands the
 * bundle reads it from and writes it with. Static text extraction only — the vendor script is never run.
 *
 *   node scripts/dev/things-corpus.ts <out-dir> [PRODUCT_CODE...]
 *
 * Signs in with the account in the environment (see examples/_client.ts). Without product codes it
 * takes every code `get_products` lists. Writes `<out-dir>/things/<code>.json` (raw description),
 * `<out-dir>/bundles/<code>.js` and `<out-dir>/corpus.json`. The out-dir is product data, not account
 * data, but keep it out of the repository: the bundles are the vendor's code.
 *
 *   node scripts/dev/things-corpus.ts --check <bundle.js> <identifier>   prints one extraction
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One command a bundle names: its constant name and the number that name has in the bundle. */
export interface BundleCommand {
  name: string;
  id?: number;
}

/** What a bundle's parser for one identifier declares. */
export interface BundleProperty {
  /** Commands the parser decodes the property from (`getCommandIds`). */
  reads: BundleCommand[];
  /** Commands the parser builds a write with: `cmd`, and `subCmd` when the write rides a payload command. */
  writes: { cmd: BundleCommand; subCmd?: BundleCommand }[];
  /** The versions its switch distinguishes (`case "v3"`). */
  versions: string[];
  /** Whether a write carries an MQTT command code. */
  mqtt: boolean;
}

/** Every `NAME:number` the bundle's constant tables define; a name defined with two numbers maps to none. */
function constants(src: string): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>();
  for (const m of src.matchAll(/[{,]([A-Z][A-Z0-9_]{2,}):(\d+)(?=[,}])/g)) {
    const [name, n] = [m[1]!, Number(m[2])];
    out.set(name, out.has(name) && out.get(name) !== n ? undefined : n);
  }
  return out;
}

/**
 * Extract, per identifier, what the bundle's parser class declares. A class is the source between one
 * `class … extends` and the next; it belongs to every identifier it names — the one `getIdentify`
 * returns and any it compares `this.identifier` against.
 */
export function extractBundle(src: string): Record<string, BundleProperty> {
  const table = constants(src);
  const command = (name: string): BundleCommand => ({
    name,
    ...(table.get(name) !== undefined ? { id: table.get(name) } : {}),
  });
  const starts = [...src.matchAll(/class(?:\s+\w+)?\s+extends\b/g)].map((m) => m.index!);
  const out: Record<string, BundleProperty> = Object.create(null);
  starts.forEach((start, i) => {
    const body = src.slice(start, starts[i + 1] ?? src.length);
    const ids = new Set<string>();
    for (const m of body.matchAll(/getIdentify\(\)\{return"([^"]+)"\}/g)) ids.add(m[1]!);
    for (const m of body.matchAll(/"([a-z0-9_]+)"===this\.identifier/g)) ids.add(m[1]!);
    if (!ids.size) return;
    const reads = [
      ...(body.match(/getCommandIds\(\)\{return([^}]*)\}/)?.[1] ?? "").matchAll(/\w\.([A-Z][A-Z0-9_]+)/g),
    ].map((m) => command(m[1]!));
    const writes = [...body.matchAll(/cmd:\w\.([A-Z][A-Z0-9_]+)(?:,subCmd:\w\.([A-Z][A-Z0-9_]+))?/g)].map((m) => ({
      cmd: command(m[1]!),
      ...(m[2] ? { subCmd: command(m[2]) } : {}),
    }));
    const unique = <T>(xs: T[]) => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];
    const property: BundleProperty = {
      reads: unique(reads),
      writes: unique(writes),
      versions: [...new Set([...body.matchAll(/case"(v\d+)"/g)].map((m) => m[1]!))],
      mqtt: body.includes("mqttCmdCode"),
    };
    for (const id of ids) out[id] ??= property;
  });
  return out;
}

async function build(outDir: string, codes: string[]): Promise<void> {
  const { loginClient } = await import("../../examples/_client.ts");
  const eufy = await loginClient();
  const mega = (eufy as unknown as { mega: import("../../src/index.js").MegaHttpClient }).mega;
  try {
    if (!codes.length) {
      const walk = (n: any): string[] => [
        ...((n?.products ?? []) as any[]).map((p) => String(p.code)),
        ...((n?.sub_categories ?? []) as any[]).flatMap(walk),
      ];
      codes = [...new Set(((await mega.getProducts<any>())?.categories ?? []).flatMap(walk))].sort();
    }
    for (const d of ["things", "bundles"]) mkdirSync(join(outDir, d), { recursive: true });
    const corpus: Record<string, { version: string; updateTime: number; properties: Record<string, BundleProperty> }> =
      {};
    for (let i = 0; i < codes.length; i += 20) {
      const reply = await mega.getThingsList<any>(codes.slice(i, i + 20));
      for (const entry of reply?.things_list ?? []) {
        const code = entry?.profile?.product_code;
        const url = entry?.profile?.plugin_path;
        if (typeof code !== "string") continue;
        writeFileSync(join(outDir, "things", `${code}.json`), JSON.stringify(entry, null, 1));
        if (typeof url !== "string" || !url) continue;
        const src = await (await fetch(url)).text();
        writeFileSync(join(outDir, "bundles", `${code}.js`), src);
        corpus[code] = {
          version: String(entry.version),
          updateTime: entry.update_time,
          properties: extractBundle(src),
        };
        console.log(`${code}: ${Object.keys(corpus[code].properties).length} identifiers`);
      }
    }
    writeFileSync(join(outDir, "corpus.json"), JSON.stringify(corpus, null, 1));
  } finally {
    await eufy.disconnect();
  }
}

const [first, ...rest] = process.argv.slice(2);
if (first === "--check") {
  console.log(JSON.stringify(extractBundle(readFileSync(rest[0]!, "utf8"))[rest[1]!] ?? null, null, 1));
} else if (first) {
  await build(first, rest);
} else {
  console.error(
    "usage: node scripts/dev/things-corpus.ts <out-dir> [PRODUCT_CODE...] | --check <bundle.js> <identifier>",
  );
  process.exit(1);
}
