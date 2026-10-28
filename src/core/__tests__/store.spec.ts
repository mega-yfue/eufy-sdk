import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileSessionStore } from "../store.js";
import { FileFcmStore } from "../../transport/push/store.js";

/** A write that dies part-way, as a full disk or a killed process leaves it. */
const partialWrite = vi.hoisted(() => ({ armed: false }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeFileSync: (...args: Parameters<typeof real.writeFileSync>) => {
      if (!partialWrite.armed) return real.writeFileSync(...args);
      const [file, data, opts] = args;
      real.writeFileSync(file, String(data).slice(0, 5), opts);
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    },
  };
});

/**
 * Both file stores keep a complete, owner-only record on disk: a write that fails part-way leaves the
 * previous record readable, and every atomic save leaves the file at `0o600`, including one that existed first.
 */
describe.each([
  ["FileSessionStore", (p: string) => new FileSessionStore<unknown>(p)],
  ["FileFcmStore", (p: string) => new FileFcmStore(p) as FileSessionStore<unknown>],
])("%s", (_name, make) => {
  afterEach(() => {
    partialWrite.armed = false;
  });

  const fresh = () => join(mkdtempSync(join(tmpdir(), "store-spec-")), "s.json");

  it("keeps the previous record when a write fails part-way", () => {
    const path = fresh();
    const store = make(path);
    store.save({ token: "old-token" });

    partialWrite.armed = true;
    expect(() => store.save({ token: "new-token" })).toThrow(/ENOSPC/);
    partialWrite.armed = false;

    expect(store.load()).toEqual({ token: "old-token" });
    expect(readdirSync(join(path, ".."))).toEqual(["s.json"]);
  });

  it.skipIf(process.platform === "win32")("leaves an existing file owner-only after a save", () => {
    const path = fresh();
    writeFileSync(path, "{}", { mode: 0o644 });
    chmodSync(path, 0o644);

    make(path).save({ token: "t" });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ token: "t" });
  });

  it.skipIf(process.platform === "win32")("writes through a symlink and keeps the link", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-spec-"));
    mkdirSync(join(dir, "real"));
    const real = join(dir, "real", "target.json");
    writeFileSync(real, "{}");
    const link = join(dir, "link.json");
    symlinkSync(real, link);

    make(link).save({ token: "t" });

    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf-8"))).toEqual({ token: "t" });
    expect(readdirSync(join(dir, "real"))).toEqual(["target.json"]);
  });

  it.skipIf(process.platform === "win32")("creates the missing target of a dangling symlink and keeps the link", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-spec-"));
    mkdirSync(join(dir, "real"));
    const link = join(dir, "link.json");
    symlinkSync(join("real", "target.json"), link);

    make(link).save({ token: "t" });

    const real = join(dir, "real", "target.json");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, "utf-8"))).toEqual({ token: "t" });
    expect(statSync(real).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "real"))).toEqual(["target.json"]);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "saves in place to a writable file inside a read-only directory",
    () => {
      const path = fresh();
      writeFileSync(path, "{}", { mode: 0o644 });
      const dir = join(path, "..");
      chmodSync(dir, 0o555);
      try {
        make(path).save({ token: "t" });
      } finally {
        chmodSync(dir, 0o755);
      }

      expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ token: "t" });
      expect(readdirSync(dir)).toEqual(["s.json"]);
    },
  );
});
