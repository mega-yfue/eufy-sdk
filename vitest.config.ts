import { defineConfig } from "vitest/config";

// Vitest runs the specs as REAL ESM — the same module mode the library ships (package.json
// "type": "module"). It type-strips with esbuild (not the TS compiler), so it sidesteps the TS7
// "Go compiler, no JS API" problem that blocks ts-jest. Type-safety stays on `tsc`
// (`npm run typecheck`); this runner only exercises runtime behaviour.
export default defineConfig({
  test: {
    globals: true, // keep bare describe/it/test/expect — no per-spec imports (types via vitest/globals in tsconfig)
    include: ["src/**/*.spec.ts", "scripts/**/*.spec.ts"],
    clearMocks: true,
    // Cap parallelism the same way the old jest config did: each worker holds a full transform
    // pipeline; unbounded workers on a high-core/low-memory-cgroup box (CI, sandbox) sum past the
    // memory ceiling and the kernel SIGKILLs the run.
    maxWorkers: "50%",
  },
});
