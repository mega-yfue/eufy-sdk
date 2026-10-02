import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
/** The fixture guides, beside the CI script that reads them rather than in the shipped source tree. */
const FIXTURES = join(ROOT, "scripts", "ci", "__fixtures__", "doc-snippets");

/**
 * The guard's own guard.
 *
 * `scripts/ci/check-doc-snippets.mjs` exists because two snippets in `docs/vacuums.md` did not compile and
 * a reviewer found them rather than CI. Taking on faith that the checker catches that class would be the
 * same mistake in a new place — so it is run here against fixture guides carrying those exact two bugs,
 * and against one that compiles.
 *
 * `--docs` points it at the fixtures, so the real run cannot see them and this one cannot be broken by
 * editing a guide.
 */
function run(dir: string): { code: number; output: string } {
  try {
    const output = execFileSync("node", ["scripts/ci/check-doc-snippets.mjs", "--docs", dir], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    return { code: 0, output };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("the doc-snippet checker", () => {
  it("fails when the compiler cannot start instead of reporting unchecked snippets as valid", () => {
    const dir = mkdtempSync(join(tmpdir(), "doc-snippets-compiler-"));
    const preload = join(dir, "fail-compiler.cjs");
    try {
      writeFileSync(
        preload,
        'require("node:child_process").execFileSync = () => { throw new Error("synthetic compiler launch failure"); };\n' +
          'require("node:module").syncBuiltinESMExports();\n',
      );
      expect(() =>
        execFileSync(
          process.execPath,
          ["--require", preload, "scripts/ci/check-doc-snippets.mjs", "--docs", join(FIXTURES, "clean")],
          { cwd: ROOT, stdio: "pipe" },
        ),
      ).toThrow(/TypeScript checker failed without diagnostics: synthetic compiler launch failure/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catches both of the bugs it was built for, at the lines they are on", () => {
    const { code, output } = run(join(FIXTURES, "broken"));
    expect(code).not.toBe(0);
    // The two bugs. A setter that does not exist — the guide said `setLevel`, the member's `writeAs` is
    // `setSuctionLevel` — and a method read as a property, so `.find` was called on the function itself.
    expect(output).toContain("Property 'setLevel' does not exist");
    expect(output).toContain("Property 'find' does not exist");

    // The EXACT markdown lines, which is the claim worth pinning: reporting against the generated file
    // would make the output unusable, and reporting against the right file at the wrong line is worse
    // than useless because it sends a reader to innocent code. `\d+` passed for any integer while every
    // number was one too high — so the numbers are spelled out here.
    //
    //   guide.md:7 → `await dev.suction?.()?.setLevel?.(2);`
    //   guide.md:9 → `const first = scenes?.find(…);`
    expect(output).toMatch(/broken[/\\]guide\.md:7:\d+ .*'setLevel'/);
    expect(output).toMatch(/broken[/\\]guide\.md:9:\d+ .*'find'/);
  }, 120_000);

  it("passes a guide that compiles, including its skip and host markers", () => {
    // Three snippets: one real, one marked `skip` (a shape sketch that is not a statement), and one
    // naming a host function through `host`. All three have to be accepted for the run to be green.
    const { code, output } = run(join(FIXTURES, "clean"));
    expect(output).toContain("documented snippets typecheck");
    expect(code).toBe(0);
  }, 120_000);
});

test("the generated API reference is not documentation this gate owns", () => {
  // TypeDoc writes `docs/<out>/` — gitignored, and full of ```ts SIGNATURE fragments that are not
  // statements. Walking them turned a green `verify` into thousands of failures for any contributor
  // who had built the docs site; CI never generates them, which is the only reason it was not felt
  // there. The fixture mirrors the shape: a bad fence inside `api/`, and a good one beside it.
  const dir = mkdtempSync(join(tmpdir(), "doc-snippets-generated-"));
  try {
    mkdirSync(join(dir, "api"), { recursive: true });
    writeFileSync(
      join(dir, "api", "Device.md"),
      "# Device\n\n```ts\ngetProperty(name): undefined | PropertyValue\n```\n",
    );
    writeFileSync(join(dir, "guide.md"), "# Guide\n\n```ts\nconst sn2: string = sn;\nvoid sn2;\n```\n");
    const { code, output } = run(dir);
    assert.equal(code, 0, output);
    assert.match(output, /documented snippets typecheck \(1 checked\)/, "only the hand-written guide");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

test("an orphaned host marker is reported, like an orphaned skip", () => {
  // The asymmetry that hid it: a dropped `skip` fails loudly on the snippet it meant to exempt, while a
  // dropped `host` leaves the snippet compiling WITHOUT the reader's names — so it fails with "Cannot
  // find name 'bus'", which reads as a mistake in correct documentation and says nothing about why.
  //
  // Outside the repo on purpose. `rel` is relative to the REPO, so a tree above it produced names
  // starting with `..`, tsc's `*.ts` include skipped them as hidden files, and the run compiled ZERO
  // snippets and failed with "No inputs were found" — a naming bug wearing a broken-config message.
  const dir = mkdtempSync(join(tmpdir(), "doc-snippets-orphan-"));
  try {
    writeFileSync(
      join(dir, "guide.md"),
      "<!-- typecheck: host bus -->\n\nProse, which orphans it.\n\n```ts\nbus.emit('x');\n```\n",
    );
    const { code, output } = run(dir);
    assert.notEqual(code, 0);
    assert.match(output, /guide\.md:1 typecheck:host marker is not above a ```ts fence/);
    // The error it causes is reported too, so the two lines explain each other.
    assert.match(output, /Cannot find name 'bus'/);
    assert.ok(!/No inputs were found/.test(output), "a tree outside the repo still compiles");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);
