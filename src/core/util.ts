/**
 * Small shared utilities used across the SDK.
 */

/**
 * A restartable single-shot timer — the arm / cancel / re-arm pattern the P2P lifecycle repeats in
 * several places (session idle-detach, stream linger, battery budget + its grace, the warm-up
 * deadline). {@link arm} (re)schedules, replacing any pending fire; {@link cancel} clears it; the
 * handle clears itself right before firing so {@link pending} reads `false` inside the callback. The
 * timer is `unref`'d so a pending fire never keeps the process alive.
 */
export class Timer {
  private handle?: ReturnType<typeof setTimeout>;

  /** (Re)arm to run `fn` after `ms`, cancelling any already-pending fire. */
  arm(ms: number, fn: () => void): void {
    this.cancel();
    this.handle = setTimeout(() => {
      this.handle = undefined;
      fn();
    }, ms);
    this.handle.unref?.();
  }

  /** Cancel a pending fire. No-op if not armed. */
  cancel(): void {
    if (this.handle) {
      clearTimeout(this.handle);
      this.handle = undefined;
    }
  }

  /** Whether a fire is currently scheduled. */
  get pending(): boolean {
    return this.handle !== undefined;
  }
}

/**
 * Exhaustiveness guard for discriminated unions. Placed in a `switch` `default` (or the else of an
 * `if`-chain) over every variant: if a new variant is added and left unhandled, the call fails to
 * typecheck (its type is no longer `never`), and at runtime it throws instead of silently falling
 * through.
 */
export function assertNever(value: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
}

/**
 * Coerce a property value to a boolean WITHOUT the `Boolean("false") === true` footgun (every
 * non-empty string — including `"false"` and `"0"` — is truthy under `Boolean()`). Only an explicit
 * `true` / `1` / `"1"` / `"true"` (case-insensitive) enables; everything else is `false`.
 */
export function asBool(value: unknown): boolean {
  if (typeof value === "string") return value === "1" || value.toLowerCase() === "true";
  return value === true || value === 1;
}

/**
 * Round to an integer and clamp into `[min, max]`. For scalar device params that take a bounded int
 * (volume/brightness/color-temp 0..100, etc.), dispatched fire-and-forget — a non-numeric or
 * out-of-range input must never reach the wire as-is. NaN input (e.g. `Number("x")`) fails safe to
 * `min`: `Math.max`/`Math.min` propagate NaN rather than ignoring it, so that has to be checked
 * explicitly, not relied on implicitly.
 */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Order-insensitive deep structural equality. Used for change detection over decoded param values
 * (`boolean | number | string | object | array`): a re-serialized param whose object keys come back
 * in a different order must NOT read as "changed" (a `JSON.stringify` compare is key-order sensitive
 * and flaps). Primitives compare with `Object.is` (so `NaN === NaN`, `+0 !== -0`); arrays compare
 * length then elementwise; plain objects compare the same key set recursively; anything else
 * (functions, class instances, Buffers, …) falls back to `Object.is`.
 */
export function structuralEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  const aArr = Array.isArray(a);
  const bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr && bArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!structuralEqual(a[i], b[i])) return false;
    return true;
  }

  // Plain-object compare (the decoded-JSON case). Non-plain objects rarely reach here — param values
  // are JSON-derived — and are handled correctly enough by same-keys + recursive compare.
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, k)) return false;
    if (!structuralEqual(aObj[k], bObj[k])) return false;
  }
  return true;
}

/**
 * Coerce `value` to one of the numeric values of a fixed enum-object (e.g. `Watermark`,
 * `HubAlarmTone`, `DoorbellRingtone`), or `undefined` if it isn't one. Unlike `clamp` (for a
 * continuous range), an enum has a small fixed set of real options — silently rounding/clamping a bad
 * index to the nearest valid one would send a WRONG-but-plausible value on a fire-and-forget write,
 * not a safe default. Anything outside the set is rejected instead.
 */
export function coerceEnumValue(enumObj: Record<string, number>, value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && Object.values(enumObj).includes(n) ? n : undefined;
}

/** The valid values of an enum-object, `/`-joined — for the "not a valid option (valid: 0/1/2)" errors. */
export function enumValues(enumObj: Record<string, number>): string {
  return Object.values(enumObj).join("/");
}

/**
 * Invert an enum-object (`name → wire value`) into the `raw → label` form a published option set
 * takes, so a named set is declared ONCE — as the enum callers write against — and the published
 * domain cannot drift from it.
 */
export function enumLabels(enumObj: Readonly<Record<string, number>>): Record<number, string> {
  return Object.fromEntries(Object.entries(enumObj).map(([name, value]) => [value, name]));
}

/**
 * Parse `text` as a JSON object, or `undefined` on any failure — never throws. Shared by the MQTT
 * and Tuya transport layers; sits here so each module doesn't define its own copy.
 */
export function jsonObject(text: unknown): Record<string, unknown> | undefined {
  if (typeof text !== "string") return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

// ── Fixed-width integer encoders → a fresh Buffer ────────────────────────────────────────────────
// The wire protocols pack scalars as little/big-endian words; these return a standalone Buffer to
// `Buffer.concat` into a frame. Values are masked/coerced so an out-of-range or signed input can't
// throw or write garbage (`>>> 0` also normalizes negatives to their unsigned 32-bit form).

/** 16-bit unsigned, little-endian. */
export function u16le(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n & 0xffff);
  return b;
}

/** 16-bit unsigned, big-endian. */
export function u16be(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n & 0xffff);
  return b;
}

/** 32-bit unsigned, little-endian. */
export function u32le(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** 32-bit unsigned, big-endian. */
export function u32be(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

/** The serial prefixes the app's request builder counts as a station (`SnKtx.isStation`). */
const STATION_SERIAL_PREFIXES = [
  "T8001",
  "T8002",
  "T8020",
  "T8010",
  "T8030",
  "T8040",
  "T8023",
  "T8021",
  "T9000",
  "T8N00",
  "T7000",
  "T8025",
];

/** Whether the app counts `sn` as a station, whose requests go on channel 255. @internal */
export function isStationSerial(sn: string): boolean {
  return STATION_SERIAL_PREFIXES.some((prefix) => sn.startsWith(prefix));
}
