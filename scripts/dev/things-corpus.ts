/**
 * Build the evidence corpus for the product thing descriptions: every product's description and its
 * settings bundle (the app's own per-product script, which the app runs to turn an identifier into a
 * device frame and a report back into identifiers), plus, per identifier, the wire the bundle reads it
 * from and writes it with. Static text extraction only — the vendor script is never run.
 *
 *   node scripts/dev/things-corpus.ts <out-dir> [PRODUCT_CODE...]
 *
 * Signs in with the account in the environment (see examples/_client.ts). Without product codes it
 * refreshes the codes already in `<out-dir>/things/`. A bundle is downloaded only when its md5 differs
 * from the description's `plugin_id`. Writes `<out-dir>/things/<code>.json` (raw description),
 * `<out-dir>/bundles/<code>.js` and `<out-dir>/corpus.json`. The out-dir is product data, not account
 * data, but keep it out of the repository: the bundles are the vendor's code.
 *
 *   node scripts/dev/things-corpus.ts --check <bundle.js> <identifier>   prints one extraction
 *   node scripts/dev/things-corpus.ts --fixture <out-dir> <CODE> <identifier...>
 *   node scripts/dev/things-corpus.ts --coverage <out-dir>   prints, per product, what is wired
 *
 * `--fixture` prints a spec fixture: the product's entry trimmed to the named identifiers, its bundle
 * ids and URLs synthesized, and beside it the `wire` the bundle declares for each.
 *
 * The bundles encode the wire in six shapes, one extractor each below. An extraction is a lead, not a
 * verified wire: an identifier may come out on several commands, and a constant defined with two
 * numbers resolves to its name only.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** One command a bundle names: its constant name and the number that name has in the bundle. */
export interface BundleCommand {
  name: string;
  id?: number;
}

/**
 * One wire an identifier rides. `p2p`: a security command (`cmd`, with `subCmd` when it rides a payload
 * command). `dp`: a Tuya data point, with the protobuf field `path` the value sits at, the literal
 * `value` an inline write sends, or the `method` its request encoder is called with. `tlv`: a tag in a
 * TLV status report. `mqtt`: an MQTT/BLE command code.
 */
export type Wire =
  | { via: "p2p"; cmd: BundleCommand; subCmd?: BundleCommand }
  | { via: "dp"; dp: number; path?: string; value?: string; method?: string }
  | { via: "tlv"; tag: number }
  | { via: "mqtt"; code: string };

/** What a bundle declares for one identifier. */
export interface BundleProperty {
  reads: Wire[];
  writes: Wire[];
  /** The versions its switch distinguishes (`case "v3"`). */
  versions: string[];
}

/** Every `NAME:number` the bundle defines; a name defined with two numbers maps to none. */
function numbers(src: string): Map<string, number | undefined> {
  const out = new Map<string, number | undefined>();
  for (const m of src.matchAll(/[{,]([A-Z][A-Z0-9_]{1,}):(\d+)(?=[,}])/g)) {
    const [name, n] = [m[1]!, Number(m[2])];
    out.set(name, out.has(name) && out.get(name) !== n ? undefined : n);
  }
  return out;
}

/** The `{…}` starting at `i`, braces balanced. */
function balanced(src: string, i: number): string {
  for (let depth = 0, j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
  }
  return "";
}

/**
 * Extract, per identifier of `ids`, the wire the bundle maps it to:
 *
 * 1. security parser classes — `class … extends` to the next; `getIdentify` / `this.identifier ===` name
 *    the identifiers, `getCommandIds` the reads, `cmd`/`subCmd` the writes;
 * 2. inline switch cases — `case "id": … break;` holding `cmd:`/`subCmd:` (security) or `.dp = "N"`;
 * 3. vacuum handlers — `case "ecl_x": return this.handleY(…)`, whose body sends on
 *    `finishControlCommand(…, "DP")` through `encode…(method)`;
 * 4. data-point read maps — `this.map = {DP: {id: "path"}}` and `DP: {[e.NAME]: "path"}`;
 * 5. enum tables — `NAME: "id"` constants, then `[e.NAME]: "DP" | "0x…"` (writes, reads for an
 *    `EVENT_*` constant), `DP: e.NAME` (reads) and
 *    `getXParam(C.Ax) … _[s.NAME]` with `Ax: tag` (TLV reads);
 * 6. command-to-identifier tables — `[s.CMD]: "id"` with `CMD: number` (security reads).
 */
export function extractBundle(src: string, ids: ReadonlySet<string>): Record<string, BundleProperty> {
  const num = numbers(src);
  const command = (name: string): BundleCommand => ({
    name,
    ...(num.get(name) !== undefined ? { id: num.get(name) } : {}),
  });
  const named = new Map<string, string>();
  for (const m of src.matchAll(/\b([A-Z][A-Z0-9_]+):"([a-z][a-z0-9_]+)"/g)) named.set(m[1]!, m[2]!);
  const out: Record<string, BundleProperty> = Object.create(null);
  const at = (id: string) => (out[id] ??= { reads: [], writes: [], versions: [] });
  const add = (id: string | undefined, side: "reads" | "writes", wire: Wire) => {
    if (id && ids.has(id)) at(id)[side].push(wire);
  };
  const p2p = (body: string) =>
    [...body.matchAll(/\bcmd:\w\.([A-Z][A-Z0-9_]+)(?:,subCmd:\w\.([A-Z][A-Z0-9_]+))?/g)].map((m): Wire => ({
      via: "p2p",
      cmd: command(m[1]!),
      ...(m[2] ? { subCmd: command(m[2]) } : {}),
    }));

  const starts = [...src.matchAll(/class(?:\s+\w+)?\s+extends\b/g)].map((m) => m.index!);
  starts.forEach((start, i) => {
    const body = src.slice(start, starts[i + 1] ?? src.length);
    const owners = new Set<string>();
    for (const m of body.matchAll(/getIdentify\(\)\{return"([^"]+)"\}/g)) owners.add(m[1]!);
    for (const m of body.matchAll(/"([a-z0-9_]+)"===this\.identifier/g)) owners.add(m[1]!);
    const reads = [
      ...(body.match(/getCommandIds\(\)\{return([^}]*)\}/)?.[1] ?? "").matchAll(/\w\.([A-Z][A-Z0-9_]+)/g),
    ].map((m): Wire => ({ via: "p2p", cmd: command(m[1]!) }));
    const versions = [...new Set([...body.matchAll(/case"(v\d+)"/g)].map((m) => m[1]!))];
    for (const id of owners) {
      for (const w of reads) add(id, "reads", w);
      for (const w of p2p(body)) add(id, "writes", w);
      if (ids.has(id)) at(id).versions.push(...versions);
    }
  });

  for (const m of src.matchAll(/case"([a-z][a-z0-9_]+)":((?:(?!case").)*?)break;/g)) {
    const [, id, body] = m as unknown as [string, string, string];
    for (const w of p2p(body)) add(id, "writes", w);
    const value = body.match(/binaryData=("[^"]*"|!0|!1)/)?.[1];
    for (const d of body.matchAll(/\.dp="(\d+)"/g))
      add(id, "writes", { via: "dp", dp: Number(d[1]), ...(value ? { value } : {}) });
  }

  for (const m of src.matchAll(/case"(ecl_\w+)":return this\.(\w+)\(/g)) {
    const start = src.indexOf(`${m[2]}(e){`);
    if (start < 0) continue;
    const end = src.indexOf("}handle", start);
    const body = src.slice(start, end > 0 ? end : start + 3000);
    const method = body.match(/\.encode\w+\((\d+)/)?.[1];
    for (const d of body.matchAll(/finishControlCommand\([^;]*?,"(\d+)"\)/g))
      add(m[1], "writes", { via: "dp", dp: Number(d[1]), ...(method ? { method } : {}) });
  }

  for (const m of src.matchAll(/this\.map=\{(?=\d+:\{)/g)) {
    for (const dp of balanced(src, m.index! + 9).matchAll(/(\d+):\{([^{}]*)\}/g))
      for (const e of dp[2]!.matchAll(/(\w+):"([^"]*)"/g))
        add(e[1], "reads", { via: "dp", dp: Number(dp[1]), path: e[2]! });
  }
  for (const dp of src.matchAll(/[{,](\d+):\{(\[\w\.[A-Z][^{}]*)\}/g))
    for (const e of dp[2]!.matchAll(/\[\w\.([A-Z][A-Z0-9_]+)\]:"([^"]*)"/g))
      add(named.get(e[1]!), "reads", { via: "dp", dp: Number(dp[1]), path: e[2]! });
  for (const m of src.matchAll(/\[\w\.([A-Z][A-Z0-9_]+)\]:"(\d+|0x[0-9A-Fa-f]+)"/g))
    add(
      named.get(m[1]!),
      m[1]!.startsWith("EVENT_") ? "reads" : "writes",
      m[2]!.startsWith("0x") ? { via: "mqtt", code: m[2]! } : { via: "dp", dp: Number(m[2]) },
    );
  for (const m of src.matchAll(/[{,](\d+):\w\.([A-Z][A-Z0-9_]+)(?=[,}])/g))
    add(named.get(m[2]!), "reads", { via: "dp", dp: Number(m[1]) });
  for (const m of src.matchAll(/get\w*Param\(\w\.(A[0-9A-F])\)[^;]{0,60}?_\[\w\.([A-Z][A-Z0-9_]+)\]/g)) {
    const tag = num.get(m[1]!);
    if (tag !== undefined) add(named.get(m[2]!), "reads", { via: "tlv", tag });
  }

  for (const m of src.matchAll(/\[\w\.([A-Z][A-Z0-9_]+)\]:"([a-z][a-z0-9_]+)"/g))
    if (num.has(m[1]!)) add(m[2], "reads", { via: "p2p", cmd: command(m[1]!) });

  const unique = <T>(xs: T[]) => [...new Map(xs.map((x) => [JSON.stringify(x), x])).values()];
  for (const p of Object.values(out))
    [p.reads, p.writes, p.versions] = [unique(p.reads), unique(p.writes), unique(p.versions)];
  return out;
}

/** The identifiers a raw description lists. */
function identifiers(entry: any): Set<string> {
  return new Set(
    ["properties", "actions", "events"].flatMap((k) => ((entry?.[k] ?? []) as any[]).map((x) => String(x?.identifier))),
  );
}

/** A product's entry trimmed to `keep`, with synthetic bundle ids and URLs, and the wire per identifier. */
function fixture(outDir: string, code: string, keep: string[]): unknown {
  const entry = JSON.parse(readFileSync(join(outDir, "things", `${code}.json`), "utf8"));
  const wanted = new Set(keep);
  for (const k of ["properties", "actions", "events"])
    entry[k] = ((entry[k] ?? []) as any[]).filter((x) => wanted.has(x?.identifier));
  Object.assign(entry.profile, {
    plugin_id: "0".repeat(32),
    plugin_path: `https://cdn.example/${code}Handle.mix.js`,
    plugin_id_zip: "0".repeat(32),
    plugin_path_zip: `https://cdn.example/${code}.zip`,
  });
  return {
    things_list: [entry],
    wire: extractBundle(readFileSync(join(outDir, "bundles", `${code}.js`), "utf8"), wanted),
  };
}

/**
 * Per product, the listed properties and actions: `wired` with at least one extracted wire, `named` in
 * the bundle but not wired, `absent` from the bundle (app or cloud state with no wire), and `ambiguous`
 * wired from more than one read.
 */
function coverage(
  outDir: string,
): Record<string, Record<"listed" | "wired" | "named" | "absent" | "ambiguous", number>> {
  const out: Record<string, Record<"listed" | "wired" | "named" | "absent" | "ambiguous", number>> = {};
  for (const f of readdirSync(join(outDir, "things"))) {
    const code = f.replace(/\.json$/, "");
    const entry = JSON.parse(readFileSync(join(outDir, "things", f), "utf8"));
    const src = readFileSync(join(outDir, "bundles", `${code}.js`), "utf8");
    const wired = extractBundle(src, identifiers(entry));
    const c = (out[code] = { listed: 0, wired: 0, named: 0, absent: 0, ambiguous: 0 });
    for (const x of [...(entry.properties ?? []), ...(entry.actions ?? [])] as { identifier: string }[]) {
      const w = wired[x.identifier];
      c.listed++;
      if (w) c.wired++;
      else if (src.includes(`"${x.identifier}"`)) c.named++;
      else c.absent++;
      if (w && w.reads.length > 1) c.ambiguous++;
    }
  }
  return out;
}

async function build(outDir: string, codes: string[]): Promise<void> {
  for (const d of ["things", "bundles"]) mkdirSync(join(outDir, d), { recursive: true });
  if (!codes.length) codes = readdirSync(join(outDir, "things")).map((f) => f.replace(/\.json$/, ""));
  const { loginClient } = await import("../../examples/_client.ts");
  const eufy = await loginClient();
  const mega = (eufy as unknown as { mega: import("../../src/index.js").MegaHttpClient }).mega;
  const corpus: Record<string, { updateTime: number; properties: Record<string, BundleProperty> }> = {};
  try {
    for (let i = 0; i < codes.length; i += 20) {
      const reply = await mega.getThingsList<any>(codes.slice(i, i + 20));
      for (const entry of reply?.things_list ?? []) {
        const code = entry?.profile?.product_code;
        const url = entry?.profile?.plugin_path;
        if (typeof code !== "string") continue;
        writeFileSync(join(outDir, "things", `${code}.json`), JSON.stringify(entry, null, 1));
        if (typeof url !== "string" || !url) continue;
        const file = join(outDir, "bundles", `${code}.js`);
        const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");
        if (!existsSync(file) || md5(readFileSync(file)) !== entry.profile.plugin_id)
          writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
        corpus[code] = {
          updateTime: entry.update_time,
          properties: extractBundle(readFileSync(file, "utf8"), identifiers(entry)),
        };
        console.log(
          `${code}: ${Object.keys(corpus[code].properties).length}/${identifiers(entry).size} identifiers wired`,
        );
      }
    }
    writeFileSync(join(outDir, "corpus.json"), JSON.stringify(corpus, null, 1));
  } finally {
    await eufy.disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [first, ...rest] = process.argv.slice(2);
  if (first === "--check") {
    const id = rest[1]!;
    console.log(JSON.stringify(extractBundle(readFileSync(rest[0]!, "utf8"), new Set([id]))[id] ?? null, null, 1));
  } else if (first === "--fixture") {
    console.log(JSON.stringify(fixture(rest[0]!, rest[1]!, rest.slice(2)), null, 1));
  } else if (first === "--coverage") {
    console.log(JSON.stringify(coverage(rest[0]!), null, 1));
  } else if (first) {
    await build(first, rest);
  } else {
    console.error(
      "usage: node scripts/dev/things-corpus.ts <out-dir> [PRODUCT_CODE...] | --check <bundle.js> <identifier> | --fixture <out-dir> <CODE> <identifier...> | --coverage <out-dir>",
    );
    process.exit(1);
  }
}
