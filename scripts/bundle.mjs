/**
 * Collapse the emitted `dist` JavaScript into the single ESM file `dist/index.js`. The things catalog,
 * its own `exports` subpath that the barrel never imports, stays apart: `dist/catalog.js` as `tsc`
 * emitted it, loading the generated JSON as generated.
 *
 * A consumer evaluates the whole package on import — the barrel is the only door to the runtime — and
 * ~200 separate module records cost far more resident memory than the same code in one. Measured on
 * Node 22 x86-64, importing the package costs +28 MB as a tree and +15 MB bundled: module records,
 * per-file source maps and compilation units collapse into one.
 *
 * Runtime dependencies stay external, so `mqtt` and `protobufjs` keep loading on first use rather
 * than being pulled into the bundle and evaluated at import.
 *
 * The settings bundles' wire table (`bundle-wires.generated.json`) is not inlined either: it ships beside the
 * bundle and is read with `JSON.parse` at import. Measured on Node 24 x86-64, importing the package costs +21 MB
 * that way and +39 MB with the table inlined as an object literal, which V8 parses as code and whose source it
 * keeps.
 *
 * Declarations are untouched: `tsc` emits the `.d.ts` tree, `exports.types` still points at
 * `dist/index.d.ts`, and the relative specifiers inside it resolve against files this script leaves
 * in place. Only `.js` and `.js.map` are replaced.
 */

import { build } from "esbuild";
import { copyFileSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const ENTRY = join(DIST, "index.js");
const KEEP = ["index.js", "index.js.map", "catalog.js", "catalog.js.map"];
const CATALOG = join("model", "capabilities", "things-catalog.generated.json");
const WIRES = join("model", "capabilities", "bundle-wires.generated.json");

/** Loads {@link WIRES} as a read of the file shipped beside the bundle rather than inlining it. */
const wiresFromFile = {
  name: "wires-from-file",
  setup(b) {
    b.onLoad({ filter: /bundle-wires\.generated\.json$/ }, () => ({
      loader: "js",
      contents:
        'import { readFileSync } from "node:fs";\n' +
        'export default JSON.parse(readFileSync(new URL("./model/capabilities/bundle-wires.generated.json", import.meta.url), "utf8"));\n',
    }));
  },
};

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

/**
 * Every runtime dependency, kept out of the bundle.
 *
 * Bundling one would defeat the lazy loads it is there to preserve and ship a second copy of a
 * package the consumer already resolves. Read from `dependencies` so adding one cannot silently
 * change what is inlined.
 */
const external = Object.keys(pkg.dependencies ?? {});

// Written over the entry point it was built from. esbuild resolves and loads every input before it
// writes anything, so overwriting the entry is safe and saves staging the output somewhere else only
// to rename it back.
await build({
  entryPoints: [ENTRY],
  outfile: ENTRY,
  allowOverwrite: true,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  external,
  sourcemap: true,
  logLevel: "warning",
  plugins: [wiresFromFile],
});

// Everything tsc emitted except the bundle and its map, which the bundle now supersedes: the JSON data a
// module imports is inlined into it too, but for the catalog and the wire table, copied back below.
for (const file of readdirSync(DIST, { recursive: true, encoding: "utf8" })) {
  if (KEEP.includes(file)) continue;
  if (file.endsWith(".js") || file.endsWith(".js.map") || file.endsWith(".json")) rmSync(join(DIST, file));
}
copyFileSync(join("src", CATALOG), join(DIST, CATALOG));
copyFileSync(join("src", WIRES), join(DIST, WIRES));

const bytes = statSync(ENTRY).size;
console.log(`bundled dist/index.js (${(bytes / 1024 / 1024).toFixed(2)} MB, external: ${external.join(", ")})`);
