/**
 * Shared `ffmpeg` spawn helper — the ONE place that shells out to ffmpeg. It decides ffmpeg's own
 * verbosity, prepends the common flags, and routes stderr into the SDK's {@link Logger}, so no caller
 * touches `spawn("ffmpeg", …)` directly. Used by the media paths that mux via ffmpeg (`p2p/media.ts`
 * snapshot/record, `webrtc/peer.ts` container). Not byte-on-a-wire, so it sits at the transport root
 * rather than in a wire subfolder.
 *
 * Two independent dials:
 *   - **ffmpeg verbosity** — how chatty ffmpeg itself is, via `-loglevel`, from the host's
 *     `new EufyMega({ ffmpegLogLevel })` config (default `"error"`).
 *   - **where it lands** — the host {@link Logger} and its own min-level gate what's actually shown.
 *
 * So `new EufyMega({ ffmpegLogLevel: "trace", logger: new ConsoleLogger() })` surfaces ffmpeg's full
 * trace at `[ffmpeg]` debug lines; the default level + no logger stays silent.
 *
 * WHICH binary runs is a third, orthogonal dial: `new EufyMega({ ffmpegPath })`. See
 * {@link ffmpegExecutable} — a host that ships its own build must be able to name it, because the SDK
 * has no business editing the process `PATH` to reach a binary the caller already knows the path of.
 *
 * @module transport/ffmpeg
 */
import { spawn, spawnSync, type ChildProcess, type StdioOptions } from "node:child_process";
import { noopLogger, type Logger } from "../core/logger.js";

/**
 * ffmpeg's `-loglevel` values, quiet → loud. `trace` is the firehose.
 *
 * Exported so a caller can offer the set as data; not published — `FfmpegLevel` is the union a reader
 * of the reference needs, and it states the same members.
 * @internal
 */
export const FFMPEG_LEVELS = [
  "quiet",
  "panic",
  "fatal",
  "error",
  "warning",
  "info",
  "verbose",
  "debug",
  "trace",
] as const;
/** A valid ffmpeg `-loglevel`. Set via `new EufyMega({ ffmpegLogLevel })`. */
export type FfmpegLevel = (typeof FFMPEG_LEVELS)[number];

const isFfmpegLevel = (v: FfmpegLevel | undefined): v is FfmpegLevel =>
  !!v && (FFMPEG_LEVELS as readonly string[]).includes(v);

/**
 * Resolve ffmpeg's own verbosity from the SDK config a host passes (`new EufyMega({ ffmpegLogLevel })`),
 * defaulting to `"error"` (quiet); an unset/invalid value yields the default. This is ffmpeg's
 * `-loglevel`, NOT the SDK's {@link LogLevel} — the two are orthogonal (ffmpeg decides what to emit,
 * the Logger decides what's shown).
 */
export function ffmpegLogLevel(level?: FfmpegLevel): FfmpegLevel {
  return isFfmpegLevel(level) ? level : "error";
}

/**
 * Resolve WHICH ffmpeg to run from the SDK config a host passes (`new EufyMega({ ffmpegPath })`),
 * defaulting to the bare name `"ffmpeg"` so it is looked up on `PATH`.
 *
 * A host that ships its own build resolves and validates that binary itself, and an environment where
 * no `ffmpeg` is on `PATH` is ordinary — so the alternative to this option is the caller mutating
 * `process.env.PATH` process-wide to reach a file it already holds the absolute path to.
 *
 * A **blank** value counts as absent: an unset host config commonly arrives as `""` or as whitespace
 * from a config file, and neither can name a binary, so spawning it would fail as an `ENOENT` on the
 * empty string — the misleading message this option exists to remove. Any non-blank value is passed
 * through EXACTLY as given, never trimmed: a leading or trailing space is legal in a POSIX path, and
 * rewriting one would make a real file unreachable.
 *
 * The value is NOT probed here. Spawn failure surfaces to the caller as the media path's own "not
 * runnable" rejection, which is the same signal a missing `PATH` entry gives, so there is nothing for
 * an extra `stat` to add. {@link ffmpegAvailable} is the probe for a caller that wants to ask first.
 */
export function ffmpegExecutable(path?: string): string {
  return path === undefined || path.trim() === "" ? "ffmpeg" : path;
}

/**
 * Spawn ffmpeg. Prepends `-hide_banner` + the env-driven `-loglevel` (see {@link ffmpegLogLevel}) to
 * `args`, then forwards the child's stderr to `logger.debug` under an `[ffmpeg]` prefix — the logger's
 * min-level gates visibility, so a `noopLogger` (the default) swallows it. Callers pass only their
 * ffmpeg-specific args and read stdin/stdout off the returned child.
 *
 * `stdio` defaults to all-pipe; pass e.g. `["pipe", "ignore", "pipe"]` to drop stdout (stderr must
 * stay piped for forwarding to work). `level` overrides the resolved `-loglevel` (see
 * {@link ffmpegLogLevel} for precedence); `executable` picks the binary (see
 * {@link ffmpegExecutable}).
 */
export interface FfmpegSpawnOptions {
  logger?: Logger;
  stdio?: StdioOptions;
  level?: FfmpegLevel;
  /** The ffmpeg binary to run. Default: the bare name, looked up on `PATH`. */
  executable?: string;
}

export function spawnFfmpeg(args: string[], opts: FfmpegSpawnOptions = {}): ChildProcess {
  const ff = spawn(
    ffmpegExecutable(opts.executable),
    ["-hide_banner", "-loglevel", ffmpegLogLevel(opts.level), ...args],
    { stdio: opts.stdio ?? "pipe" },
  );
  ff.stderr?.on("data", (d: Buffer) => {
    const text = d.toString().trimEnd();
    if (text) (opts.logger ?? noopLogger).debug(`[ffmpeg] ${text}`);
  });
  return ff;
}

/**
 * Whether the ffmpeg a caller would actually get is runnable, by running `-version` on it. Resolves
 * the executable through {@link ffmpegExecutable}, so the answer is about the SAME binary
 * {@link spawnFfmpeg} would launch — a probe of the bare name reports "missing" on a host that ships
 * its own build, and an egress gated on that answer would silently take a degraded path instead.
 *
 * Synchronous, because it answers a branch a caller has to take before opening anything.
 */
export function ffmpegAvailable(executable?: string): boolean {
  try {
    return spawnSync(ffmpegExecutable(executable), ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

/**
 * Whether `ffprobe` is on `PATH`. The SDK never spawns it — this answers the question for a caller
 * doing its own media work, which is why it takes no executable: no SDK path would use one.
 */
export function ffprobeAvailable(): boolean {
  try {
    return spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
