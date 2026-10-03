/**
 * Collapse the emitted `dist` JavaScript into the single ESM file `dist/index.js`.
 *
 * A consumer evaluates the whole package on import — `exports` has one entry and no subpaths, so the
 * barrel is the only door — and ~200 separate module records cost far more resident memory than the
 * same code in one. Measured on Node 22 x86-64, importing the package costs +28 MB as a tree and
 * +15 MB bundled: module records, per-file source maps and compilation units collapse into one.
 *
 * Runtime dependencies stay external, so `mqtt` and `protobufjs` keep loading on first use rather
 * than being pulled into the bundle and evaluated at import.
 *
 * Declarations are untouched: `tsc` emits the `.d.ts` tree, `exports.types` still points at
 * `dist/index.d.ts`, and the relative specifiers inside it resolve against files this script leaves
 * in place. Only `.js` and `.js.map` are replaced.
 */

import { build } from "esbuild";
import { readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const ENTRY = join(DIST, "index.js");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));

/**
 * Every runtime dependency, kept out of the bundle.
 *
 * Bundling one would defeat the lazy loads it is there to preserve and ship a second copy of a
 * package the consumer already resolves. Read from both `dependencies` and `peerDependencies` (a
 * native, on-demand package like `node-datachannel` is an optional peer) so adding one cannot
 * silently change what is inlined.
 */
const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {})];

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
});

// Everything tsc emitted except the bundle and its map, which the bundle now supersedes.
for (const file of readdirSync(DIST, { recursive: true, encoding: "utf8" })) {
  if (file === "index.js" || file === "index.js.map") continue;
  if (file.endsWith(".js") || file.endsWith(".js.map")) rmSync(join(DIST, file));
}

const bytes = statSync(ENTRY).size;
console.log(`bundled dist/index.js (${(bytes / 1024 / 1024).toFixed(2)} MB, external: ${external.join(", ")})`);
