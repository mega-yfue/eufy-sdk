/**
 * The products' settings bundles as data: per thing identifier, the frame each product's bundle sends for
 * every value it writes and how it reads the value back, per topology. Generated off the bundles
 * (`bundle-wires.generated.json`, do not edit by hand) and translated here into the {@link Command}
 * builders of {@link module:model/capabilities/access}, following the app's own descriptor-to-frame rule.
 *
 * @module model/capabilities/bundle
 */
import { asBool, isStationSerial } from "../../core/util.js";
import { aiotDp, setJson, setJsonRaw, setPayload, setScalar, setStationScalar } from "./access.js";
import type { AvailabilityContext, CommandContext } from "./types.js";
import { reflectCommand, type Command, type LiveFrames, type SessionFrame } from "../../core/contracts.js";
import type { ThingMember } from "./thing-description.js";
import DATA from "./bundle-wires.generated.json" with { type: "json" };

/**
 * One frame a product's settings bundle answers a write with, by the transport it rides:
 *
 * - `p2p` (absent): a session frame as the app builds it from the outer `cmd`, its body kind, the
 *   `1350`/`1700` sub-command and `mValue3`, the header channel, the payload, the payload key a scalar body
 *   reads and how it coerces it, and the seal where the app pins one (`ecb`: level 1, on a JSON body); a
 *   1350 payload may be a list (`param_list`), merged at the top level (`unzipParams`), or carry the header
 *   byte-14 `counter` (`bump` or `current`), a 1700 one an int (`param_data`); `session` names the P2P
 *   session the app picks (`targetSn`, `appConn`, `p2pDid`, `p2pLicense`);
 * - `dp`: a robot data point, `dp` and its `value`, hex where `encoding` says so;
 * - `http`: a cloud call, its `method`, `path`, `body`, `query` and `headers` on the `domain` host;
 * - `mqtt`: a `type: "ble"` frame, `mqttCmdCode` and `cmdCode`, its `ff09` header (`subVersion`,
 *   `functionType`, `needEncrypt`) and its `payload`, the TLV as hex with placeholders; a `type: "json"`
 *   one is not sent;
 * - `ble`: not sent.
 *
 * Payloads, values and bodies carry `$value`, `$channel`, `$now`, `$nowS`, `$sn` and `$station` tokens, and
 * `$param:<id>[.<path>][|<m> | &~<m>][??<fallback>]` for a field the bundle reads off the device's cached param
 * `id`: its raw value, the `.`-joined `path` inside its (base64) JSON where given, as an int with bits `m` set or
 * cleared, else the JSON `fallback` the bundle sends when the param is unreported; none and the write is not
 * sent. `next` are the frames sent after it, `after` the cloud write sent once it succeeds.
 */
export interface BundleFrame extends SessionFrame {
  transport?: string;
  channel?: number | string;
  valueKey?: string;
  coerce?: string;
  /** The payload key a `native` body's second int reads. */
  subKey?: string;
  seal?: string;
  unzipParams?: boolean;
  session?: Readonly<Record<string, string>>;
  dp?: number;
  value?: unknown;
  template?: unknown;
  encoding?: string;
  domain?: string;
  method?: string;
  path?: string;
  query?: unknown;
  headers?: unknown;
  type?: string;
  mqttCmdCode?: number;
  cmdCode?: number;
  subVersion?: number;
  functionType?: number;
  needEncrypt?: boolean;
  /** MQTT: seconds the app waits for the reply. */
  timeout?: number | string;
  next?: BundleFrame[];
  after?: BundleFrame;
}

/**
 * How a product's bundle reads one identifier on one topology: `order` ranks params with `>` and joins
 * params read alike with `+`; `map` takes each mapped param's raw value to the identifier's value, and a
 * param without one reads as is.
 */
interface BundleRead {
  order: string;
  map?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /**
   * A quality config read (2730/2731): `param` reports `base64(JSON {cur_mode, mode_0:{quality}, mode_1:
   * {quality}})` or a bare int, the mode is picked by `select` and `map` takes its quality to the
   * identifier's value, `default` for any other quality.
   */
  quality?: { param: number; select: QualitySelect; map: Readonly<Record<string, string>> };
  /** Whole records the ranks read wrong, checked first: every `[param, raw]` reported reads `ui`. */
  exact?: readonly { record: readonly (readonly [number, string])[]; ui: string }[];
  /** A JSON (or base64 JSON) report read at `path` (`.`-joined keys), then `map`, else as is. */
  field?: { param: number; path: string; map?: Readonly<Record<string, string>> };
}

/** The config mode whose quality is read, or `{ui}`: no quality, the read is that value. */
type QualityTake = "mode_0" | "mode_1" | { ui: string };
/**
 * A config's mode: `cur_mode` is `mode_0` when the config's `cur_mode` is 0 or 1, else `mode_1`; a table
 * takes it by the config's `cur_mode`, else `otherwise`.
 */
type QualityMode =
  "cur_mode" | "mode_0" | "mode_1" | { cur_mode: Readonly<Record<string, QualityTake>>; otherwise: QualityTake };
/** A mode, or picked by what `param` reports: `absent` unreported, else `modes[int]`, else `otherwise`. */
type QualitySelect =
  | QualityMode
  | { param: number; absent: QualityMode; modes: Readonly<Record<string, QualityMode>>; otherwise: QualityMode };

/** A table whose keys are the space-joined members sharing one value. */
type Grouped<T> = Readonly<Record<string, T>>;

/**
 * Per identifier, product code (`CODE__vN` for a resolved variant), then topology (`standalone`, `hb2`,
 * `hb3`), then the written value (`*` for every value), its frame or the index of a shared one, and the read.
 * `override: "java"` marks a product whose app writes and reads the identifier in its own Java, not through
 * the bundle.
 */
interface BundleWires {
  /** The frames the writes share, a write naming one by its index here. */
  frames?: readonly BundleFrame[];
  wires: Readonly<
    Record<
      string,
      Grouped<{ write?: Grouped<Grouped<BundleFrame | number>>; read?: Grouped<BundleRead>; override?: string }>
    >
  >;
  /** Per product code, then parent topology ({@link topologyOf}), the indexes of its live and talkback frames. */
  live?: Grouped<Grouped<{ start: number; stop: number; talkStart?: number; talkStop?: number }>>;
}

const BUNDLE_WIRES = DATA as unknown as BundleWires;

/** The value of the `grouped` key listing `member`. */
function memberOf<T>(grouped: Grouped<T> | undefined, member: string): T | undefined {
  return Object.entries(grouped ?? {}).find(([key]) => key.split(" ").includes(member))?.[1];
}

/** The suffix of the variant this device's description resolved `identifier` to (`__v1`), else `""`. */
function variantOf(identifier: string, ctx: AvailabilityContext): string {
  return ctx.things?.properties[identifier]?.identifier.slice(identifier.length) ?? "";
}

/**
 * The {@link BUNDLE_WIRES} write frames and read this device selects for `identifier`: its product and
 * resolved variant, standalone unless attached (a record naming a station serial is), a T8030 station as
 * `hb3`, any other as `hb2`.
 */
export function bundleEntry(identifier: string, ctx: AvailabilityContext) {
  const groups = BUNDLE_WIRES.wires[identifier];
  const model = ctx.model ?? "";
  const entry = memberOf(groups, model + variantOf(identifier, ctx)) ?? memberOf(groups, model);
  const attached = ctx.homeBaseAttached ?? ctx.stationSerial !== undefined;
  const topology = !attached ? "standalone" : ctx.stationSerial?.startsWith("T8030") ? "hb3" : "hb2";
  const frame = (f: BundleFrame | number) => (typeof f === "number" ? BUNDLE_WIRES.frames?.[f] : f);
  const frames = (w: Grouped<BundleFrame | number> = {}) =>
    Object.fromEntries(Object.entries(w).flatMap(([k, f]) => (frame(f) ? [[k, frame(f)!]] : [])));
  const hex = Object.values(entry?.write ?? {}).some((w) => Object.values(frames(w)).some((f) => f.encoding === "hex"));
  const reads = Object.fromEntries(Object.entries(entry?.read ?? {}).map(([k, r]) => [k, hex ? base64Keys(r) : r]));
  const read = memberOf(reads, topology);
  const write = memberOf(entry?.write, topology);
  return entry && { write: write && frames(write), read, override: entry.override };
}

/**
 * The app's `getConnectType(parent_sn)`: the topology a parent serial's prefix names, a T8030 whose character 7 is
 * `1` as `hb3e`, any other parent (a device that is its own) `standalone`.
 */
function topologyOf(parent: string): string {
  if (parent.startsWith("T8030")) return parent.charAt(7) === "1" ? "hb3e" : "hb3";
  const hub: Record<string, string> = {
    T8010: "hb2",
    T8001: "hb1",
    T8002: "hb1",
    T9000: "t9000",
    T90H1: "t90h1",
    T8N00: "nvr",
    T7000: "t7000",
    T8040: "hb4",
  };
  const m80 = /^T802([0-5])/.exec(parent)?.[1];
  return m80 ? `m802${m80}` : (hub[parent.slice(0, 5)] ?? "standalone");
}

/** The bundles' `compareVersions(a, b) > 0`: dotted numbers compared part by part, a missing part 0. */
function newerThan(a: string, b: string): boolean {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++)
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/**
 * The frames the app's `open_live_stream`, `close_live_stream`, `start_intercom` and `stop_intercom` send for
 * `model` under `parentSn` (its own serial when it is its own station), with the ability the app reads off the
 * first of `params` (the parent's, then the device's) whose param 1103 is an integer
 * (`DefaultLiveMediaStrategy.getDeviceAbilityData`). A product given the parent's `firmware_main_version`
 * (`parentFirmware`) takes its `<topology>>4.2.0.0` frames above that version. `undefined` for a product the
 * bundles give no live view.
 */
export function liveFrames(
  model: string,
  parentSn: string,
  params: readonly (Readonly<Record<number, string>> | undefined)[],
  parentFirmware?: string,
): LiveFrames | undefined {
  const byTopology = memberOf(BUNDLE_WIRES.live, model);
  const topology = topologyOf(parentSn);
  const entry =
    (parentFirmware && newerThan(parentFirmware, "4.2.0.0")
      ? memberOf(byTopology, `${topology}>4.2.0.0`)
      : undefined) ?? memberOf(byTopology, topology);
  if (!entry) return undefined;
  const frames = BUNDLE_WIRES.frames ?? [];
  const ability = params.map((p) => p?.[1103]).find((v) => v !== undefined && /^[+-]?\d+$/.test(v));
  return {
    start: frames[entry.start]!,
    stop: frames[entry.stop]!,
    ...(entry.talkStart !== undefined && { talkStart: frames[entry.talkStart] }),
    ...(entry.talkStop !== undefined && { talkStop: frames[entry.talkStop] }),
    ability: Number(ability ?? 0),
  };
}

/** A read of a hex-encoded data point, its map keyed by the base64 the SDK holds the point in. */
const base64Keys = (read: BundleRead): BundleRead => ({
  ...read,
  ...(read.map && {
    map: Object.fromEntries(
      Object.entries(read.map).map(([p, m]) => [
        p,
        Object.fromEntries(Object.entries(m).map(([k, v]) => [base64OfHex(k), v])),
      ]),
    ),
  }),
  ...(read.exact && {
    exact: read.exact.map(({ record, ui }) => ({ record: record.map(([p, v]) => [p, base64OfHex(v)] as const), ui })),
  }),
});

/** The raw another param reports, for a read that looks past its own. */
type RawOf = (param: number) => string | undefined;

/** Whether the app writes and reads `identifier` on this product in its own Java, so the bundle's data does not. */
const javaOverridden = (identifier: string, ctx: AvailabilityContext): boolean =>
  bundleEntry(identifier, ctx)?.override === "java";

/** A read's `>` ranks, each its `+`-joined params. */
const ranksOf = (read: BundleRead | undefined): number[][] =>
  read?.order ? read.order.split(">").map((rank) => rank.split("+").map(Number)) : [];

/** `"true"`/`"false"` as the `"1"`/`"0"` a boolean identifier's value is keyed by. */
const keyed = (v: string | undefined): string | undefined => (v === "true" ? "1" : v === "false" ? "0" : v);

/** A report as the app parses it: base64 decoded first, then JSON; a string that is not JSON as it is. */
function decoded(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const b64 = !/^\d+$/.test(raw) && raw.length % 4 === 0 && /^[A-Za-z0-9+/_-]+=*$/.test(raw);
  try {
    return JSON.parse(b64 ? Buffer.from(raw, "base64").toString("utf8") : raw);
  } catch {
    return b64 ? undefined : raw;
  }
}

/** A report's integer as the app reads it, `NaN` for none. */
const intOf = (v: unknown): string => String(Number.parseInt(String(v), 10));

/**
 * The quality a config reports, as the app picks it: a config in the mode `select` picks (a missing quality
 * 0), or `{ui}` where the pick names the value itself; a report that is no config (a bare number, or base64
 * of one) is the quality.
 */
export function qualityOf(
  raw: unknown,
  select: QualitySelect,
  other: RawOf = () => undefined,
): number | { ui: string } | undefined {
  const config = decoded(raw);
  const cfg = objectOf(config);
  if (!cfg) return Number.isInteger(Number(config)) ? Number(config) : undefined;
  const by = typeof select === "object" && "param" in select ? other(select.param) : undefined;
  const mode =
    typeof select === "object" && "param" in select
      ? by === undefined
        ? select.absent
        : (select.modes[intOf(by)] ?? select.otherwise)
      : select;
  let take: QualityTake;
  if (mode === "cur_mode") {
    if (!("cur_mode" in cfg)) return undefined;
    take = [0, 1].includes(Number(cfg.cur_mode)) ? "mode_0" : "mode_1";
  } else take = typeof mode === "object" ? (mode.cur_mode[intOf(cfg.cur_mode)] ?? mode.otherwise) : mode;
  return typeof take === "object" ? take : Number(objectOf(cfg[take])?.quality ?? 0);
}

/**
 * The identifier's value `raw` reads as on `param`: an exact record it completes, its quality decoder, its
 * JSON field, its map, or as is.
 */
const valueOn = (read: BundleRead, param: number, raw: string, other: RawOf = () => undefined): string | undefined => {
  const exact = read.exact?.find((e) => e.record.every(([p, v]) => (p === param ? raw : other(p)) === v));
  if (exact) return keyed(exact.ui);
  const q = read.quality?.param === param ? qualityOf(raw, read.quality.select, other) : undefined;
  if (typeof q === "object") return keyed(q.ui);
  if (q !== undefined) return keyed(read.quality!.map[q] ?? read.quality!.map.default);
  if (read.field?.param === param) {
    const v = read.field.path.split(".").reduce<unknown>((o, k) => objectOf(o)?.[k], decoded(raw));
    if (v === undefined || v === null) return undefined;
    const text = typeof v === "object" ? JSON.stringify(v) : String(v);
    return keyed(read.field.map?.[text] ?? text);
  }
  return keyed(read.map?.[param] ? read.map[param][raw] : raw);
};

/** The raw `param` holds for the identifier's `value`: its map key, the value itself, none on a decoded param. */
const rawOn = (read: BundleRead, param: number, value: string): string | undefined => {
  if (read.quality?.param === param || read.field?.param === param) return undefined;
  const map = read.map?.[param];
  return map ? Object.keys(map).find((raw) => keyed(map[raw]) === value) : value;
};

/** The frame `write` sends for the identifier's `value`, or its `*` template. */
const frameFor = (write: Grouped<BundleFrame> | undefined, value: string) =>
  memberOf(write, value) ?? memberOf(write, "*");

/**
 * Whether this device reads `identifier` from `param`: the first `>` rank it reported a param of, else
 * every param its bundle reads. False without a description or a read.
 */
const readsThing =
  (identifier: string, param: number) =>
  (ctx: AvailabilityContext): boolean => {
    if (!ctx.things?.properties[identifier]) return false;
    const ranks = ranksOf(bundleEntry(identifier, ctx)?.read);
    return (ranks.find((rank) => rank.some((p) => ctx.paramIds?.has(p))) ?? ranks.flat()).includes(param);
  };

/** `toIntSafety` and `toBooleanSafety` as the app reads a scalar body's value. */
function coerced(v: unknown, how: string | undefined): number | undefined {
  if (how === "bool1") return v === true || v === 1 || v === "1" || v === "true" || v === "TRUE" ? 1 : 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return Math.trunc(v);
  const n = typeof v === "string" ? (v === "true" ? 1 : v === "false" ? 0 : parseInt(v, 10)) : NaN;
  return Number.isNaN(n) ? undefined : n;
}

/** A hex string as the base64 the SDK holds a structured data point in. */
const base64OfHex = (hex: string): string => Buffer.from(hex, "hex").toString("base64");

/** An object, or `undefined` for anything else. */
const objectOf = (x: unknown) =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : undefined;

/** An object, or the object a JSON string holds. */
const parse = (x: unknown) => {
  if (typeof x !== "string") return objectOf(x);
  try {
    return objectOf(JSON.parse(x));
  } catch {
    return undefined;
  }
};

/** A TLV value's bytes by the bundle's value type, or `undefined` for a value that type cannot hold. */
function tlvBytes(type: unknown, v: unknown): Buffer | undefined {
  const n = typeof v === "boolean" ? Number(v) : Number(v);
  const int = (size: number) => {
    if (!Number.isInteger(n) || n < 0 || n >= 2 ** (8 * size)) return undefined;
    const b = Buffer.alloc(size);
    b.writeUIntLE(n, 0, size);
    return b;
  };
  if (type === "u8") return int(1);
  if (type === "u16le") return int(2);
  if (type === "u32le") return int(4);
  if (type === "utf8" && v !== undefined && v !== null) return Buffer.from(String(v), "utf8");
  if (type === "hex" && typeof v === "string" && /^([0-9a-fA-F]{2})*$/.test(v)) return Buffer.from(v, "hex");
  return undefined;
}

/**
 * The secure-MQTT write a `mqtt` frame of `type: "ble"` is: its `payload`, the TLV the bundle writes as hex
 * with placeholders (`A104{nowS:u32le}A228{userId}A301{value:u8}`), read into fields after `A1` (the time)
 * and `A2` (the user id), which the transport adds as it does for every frame; `{value:<type>}` is the
 * written value. `undefined` for a `json` frame, any other placeholder, or a field whose bytes miss its length.
 */
function mqttCommand(frame: BundleFrame, value: unknown): Command | undefined {
  const tlv = frame.payload;
  if (frame.type !== "ble" || typeof frame.mqttCmdCode !== "number" || typeof frame.cmdCode !== "number")
    return undefined;
  if (typeof tlv !== "string") return undefined;
  const fields: { tag: number; value: Buffer }[] = [];
  for (let i = 0; i < tlv.length;) {
    const tag = parseInt(tlv.slice(i, i + 2), 16);
    const len = parseInt(tlv.slice(i + 2, i + 4), 16);
    i += 4;
    let bytes: Buffer | undefined;
    if (tlv[i] === "{") {
      const end = tlv.indexOf("}", i);
      const [name, type] = tlv.slice(i + 1, end).split(":");
      i = end + 1;
      if ((tag === 0xa1 && name === "nowS") || (tag === 0xa2 && name === "userId")) continue;
      bytes = name === "value" ? tlvBytes(type, value) : undefined;
    } else {
      bytes = Buffer.from(tlv.slice(i, i + len * 2), "hex");
      i += len * 2;
    }
    if (!bytes || bytes.length !== len || Number.isNaN(tag)) return undefined;
    fields.push({ tag, value: bytes });
  }
  return {
    kind: "mqtt-dp",
    mqttCmdCode: frame.mqttCmdCode,
    cmdCode: frame.cmdCode,
    fields,
    ...(frame.subVersion !== undefined && { subVersion: frame.subVersion }),
    ...(frame.functionType !== undefined && { functionType: frame.functionType }),
    encrypt: frame.needEncrypt !== false,
    ...(typeof frame.timeout === "number" && { timeoutS: frame.timeout }),
  };
}

/**
 * The command a `native` body is, by the app sender's `layout`: 0x2d9cb4 the string body (the `valueKey`
 * string, at most 127 bytes as the app sends, on the device's `channel`), 0x2da458 the bare int pair
 * (`valueKey` then `subKey`, on 255). `undefined` for any other layout or a value it cannot hold.
 */
function nativeCommand(
  frame: BundleFrame,
  object: Record<string, unknown> | undefined,
  channel: number,
): Command | undefined {
  const layout = Number(frame.layout);
  const cmd = frame.cmd ?? NaN;
  const value = object?.[frame.valueKey ?? ""];
  if (layout === 0x2d9cb4)
    return typeof value === "string" && Buffer.byteLength(value, "utf8") <= 127
      ? { kind: "p2p-string", cmd, value, channel }
      : undefined;
  const type = coerced(value, "int");
  const sub = coerced(object?.[frame.subKey ?? ""], "int");
  if (layout !== 0x2da458 || type === undefined || sub === undefined) return undefined;
  return { kind: "p2p-int-string", cmd, value: sub, valueSub: type, channel: 255, form: "int-pair" };
}

/**
 * The session command a `p2p` frame is, its tokens filled by `fill`. Refused where the SDK cannot send it as
 * the app does: a session other than the device's own (the default the client selects), a 1350 raw-params
 * frame (`params.cmd` 1003), or a 1700 live-start (`extValue` > 0).
 */
function sessionCommand(frame: BundleFrame, fill: (x: unknown) => unknown, ctx: CommandContext): Command | undefined {
  const filled = fill(frame.payload);
  const object = objectOf(filled);
  const header = Number(fill(frame.channel));
  const c = { ...ctx, channel: header };
  const scalar = frame.valueKey && object ? coerced(object[frame.valueKey], frame.coerce) : undefined;
  const cmd = frame.cmd ?? NaN;
  const sub = frame.subCmd ?? cmd;
  const own = ctx.homeBaseAttached ? "$station" : "$sn";
  const { targetSn = own, ...connection } = frame.session ?? {};
  if (targetSn !== own || Object.keys(connection).length) return undefined;
  if (frame.seal !== undefined && frame.seal !== "ecb") return undefined;
  if (object?.cmd === 1003 || Number(object?.extValue) > 0) return undefined;
  const counter = frame.counter === "bump" || frame.counter === "current" ? frame.counter : undefined;
  if (frame.counter !== undefined && !counter) return undefined;
  if (frame.body === "json1350" && (object || Array.isArray(filled))) {
    const command = setPayload(sub, (object ?? filled) as readonly unknown[], c, frame.mValue3, header);
    return {
      ...command,
      ...(frame.unzipParams && object && { unzip: true as const }),
      ...(counter && { counter }),
    } as Command;
  }
  if (counter || frame.unzipParams) return undefined;
  if (object && frame.body === "json") return setJsonRaw(cmd, object, c, header);
  if (frame.seal) return undefined;
  if (frame.body === "json1700" && (object || typeof filled === "number"))
    return setJson(sub, object ?? (filled as number), c);
  if (frame.body === "native")
    return nativeCommand(frame, object, isStationSerial(ctx.serial ?? "") ? 255 : ctx.channel);
  if (scalar === undefined) return undefined;
  if (frame.body === "groupA") return setScalar(cmd, scalar, c);
  if (frame.body === "pair") return setScalar(cmd, scalar, c, "int-pair");
  if (frame.body === "groupB") return setStationScalar(cmd, scalar, header);
  return undefined;
}

/**
 * A templated data-point value with its fields set as the app sets them per write, each from a token:
 * `$now` the epoch ms (a number), any other filled by `fill` (`$sn`, `$input.<key>`, …); the field `""` is
 * the whole value. The value is a JSON object, as is or hex-encoded (`hex-json`); `undefined` for any other
 * value, a protobuf among them, whose fields cannot be set without its schema, or a token with no value.
 */
function templated(frame: BundleFrame, value: unknown, fill: (x: unknown) => unknown): unknown {
  const fields = objectOf(frame.template);
  if (!fields) return undefined;
  const set = (token: unknown) => (token === "$now" ? Date.now() : fill(token));
  if ("" in fields) return set(fields[""]);
  const hex = frame.encoding?.startsWith("hex") && typeof value === "string";
  const object = parse(hex ? Buffer.from(value as string, "hex").toString("utf8") : value);
  if (!object) return undefined;
  const out = { ...object };
  for (const [key, token] of Object.entries(fields)) {
    out[key] = set(token);
    if (out[key] === undefined) return undefined;
  }
  const json = typeof value === "string" ? JSON.stringify(out) : out;
  return hex ? Buffer.from(json as string, "utf8").toString("hex") : json;
}

/** The data-point write a `dp` frame is, a templated value set per write, a hex value as base64. */
function dpCommand(frame: BundleFrame, fill: (x: unknown) => unknown): Command | undefined {
  const filled = fill(frame.value);
  const value = frame.template === undefined ? filled : templated(frame, filled, fill);
  if (typeof frame.dp !== "number") return undefined;
  if (frame.encoding?.startsWith("hex"))
    return typeof value === "string" ? aiotDp(frame.dp, base64OfHex(value)) : undefined;
  if (objectOf(value)) return aiotDp(frame.dp, JSON.stringify(value));
  return ["boolean", "number", "string"].includes(typeof value) ? aiotDp(frame.dp, value as string) : undefined;
}

/** The cloud call the app makes itself after a successful P2P rename (`sendRequestUrl`). */
const RENAME_PATH = "app/devicemanage/update_device_info";

/**
 * The rename's cloud call as the app's Java builds it (`UpdateInfoRequest`): the device and its station,
 * the new name, the security category, and whether the device is its own station, on the DeviceManage host.
 */
const renameCall = (fill: (x: unknown) => unknown): BundleFrame => ({
  transport: "http",
  method: "post",
  domain: "DeviceManage",
  path: `/${RENAME_PATH}`,
  headers: { "app-tab": "eufy_security" },
  body: {
    device_sn: "$sn",
    parent_sn: "$station",
    station_sn: "$station",
    device_name: "$value",
    category: "eufy_security",
    is_integrated: fill("$sn") === fill("$station"),
  },
});

/**
 * The cloud call an `http` frame is: its method (get, post, put or delete), the `domain` the client resolves
 * to a host (`eufy_security` when absent), the path, and the JSON body, query and headers as given.
 */
function cloudCommand(frame: BundleFrame, fill: (x: unknown) => unknown): Command | undefined {
  if (frame.path?.replace(/^\//, "") === RENAME_PATH && frame.body === undefined) frame = renameCall(fill);
  const method = String(frame.method ?? "post").toUpperCase();
  const body = frame.body === undefined ? undefined : objectOf(fill(frame.body));
  const query = frame.query === undefined ? undefined : objectOf(fill(frame.query));
  const headers = frame.headers === undefined ? undefined : objectOf(fill(frame.headers));
  if (!["GET", "POST", "PUT", "DELETE"].includes(method) || typeof frame.path !== "string") return undefined;
  if ((frame.body !== undefined && !body) || (frame.query !== undefined && !query)) return undefined;
  if (frame.headers !== undefined && !headers) return undefined;
  return {
    kind: "cloud-request",
    method: method as "GET" | "POST" | "PUT" | "DELETE",
    domain: frame.domain ?? "eufy_security",
    path: frame.path,
    ...(body && { body }),
    ...(query && { query }),
    ...(headers && { headers: headers as Record<string, string> }),
  };
}

/**
 * The {@link Command} a bundle frame is for `value` on this device, its tokens filled: `$value`, `$channel`
 * (the device channel, 255 for a station), `$now` (epoch ms, a string), `$nowS` (epoch seconds), `$input.<key>` (a key of
 * the written value, a JSON object), `$sn` (the device serial) and `$station` (its
 * station's), `$param:…` (the device's cached param, {@link BundleFrame}), a `$userId` key left to the transport, which fills the user id, then the frames after it as `next`. `undefined` for a frame no builder can carry: a `ble`
 * or unknown transport, an `mqtt` one its builder refuses, an unknown body, a seal other than `ecb` or on a non-JSON body, a scalar with no integer value, a bare JSON
 * body that is not an object, a data point whose template cannot be set, a cloud call with another method, or a
 * frame after it that is any of these.
 */
export function frameCommand(frame: BundleFrame, value: unknown, ctx: CommandContext): Command | undefined {
  const tokens: Record<string, unknown> = {
    $value: value,
    $channel: isStationSerial(ctx.serial ?? "") ? 255 : ctx.channel,
    $now: String(Date.now()),
    $nowS: Math.floor(Date.now() / 1000),
    $sn: ctx.serial,
    $station: ctx.stationSerial ?? ctx.serial,
  };
  const input = parse(value) ?? {};
  let unfilled = false;
  const param = (x: string) => {
    const [, id, path, op, m, fallback] =
      /^\$param:(\d+)((?:\.[^.|&?]+)*)(?:(\||&~)(\d+))?(?:\?\?(.*))?$/.exec(x) ?? [];
    const raw = ctx.paramValue?.(Number(id));
    const v =
      raw === undefined || !path
        ? raw
        : path
            .slice(1)
            .split(".")
            .reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], decoded(raw));
    const n = Number.parseInt(String(v), 10);
    const bits = Number.isNaN(n) ? undefined : op === "|" ? n | Number(m) : n & ~Number(m);
    const out = v === undefined ? fallback && JSON.parse(fallback) : op ? bits : v;
    unfilled ||= out === undefined;
    return out;
  };
  const token = (x: string) =>
    x.startsWith("$input.") ? input[x.slice(7)] : x.startsWith("$param:") ? param(x) : tokens[x];
  const fill = (x: unknown): unknown =>
    typeof x === "string" && (x in tokens || x.startsWith("$input.") || x.startsWith("$param:"))
      ? token(x)
      : Array.isArray(x)
        ? x.map(fill)
        : x && typeof x === "object"
          ? Object.fromEntries(Object.entries(x).flatMap(([k, v]) => (v === "$userId" ? [] : [[k, fill(v)]])))
          : x;
  const transport = frame.transport ?? "p2p";
  const head =
    transport === "p2p"
      ? sessionCommand(frame, fill, ctx)
      : transport === "dp"
        ? dpCommand(frame, fill)
        : transport === "http"
          ? cloudCommand(frame, fill)
          : transport === "mqtt"
            ? mqttCommand(frame, value)
            : undefined;
  const after = [...(frame.next ?? []), ...(frame.after ? [frame.after] : [])];
  const next = after.length ? frameCommand({ ...after[0]!, next: after.slice(1), after: undefined }, value, ctx) : null;
  if (!head || next === undefined || unfilled) return undefined;
  return next ? { ...head, next } : head;
}

/**
 * The command writing `identifier`'s `value` (a boolean's `"1"`/`"0"`, else the value as the description
 * states it) on this device, as its bundle sends it; `undefined` where the bundle sends nothing for it.
 * `$value` is a boolean for a boolean property, a number where the value is one, else the string.
 */
export function thingWrite(identifier: string, value: string, ctx: CommandContext): Command | undefined {
  if (javaOverridden(identifier, ctx)) return undefined;
  const frame = frameFor(bundleEntry(identifier, ctx)?.write, value);
  const typed =
    ctx.things?.properties[identifier]?.type === "bool" ? value === "1" : /^-?\d+$/.test(value) ? Number(value) : value;
  return frame && frameCommand(frame, typed, ctx);
}

/** The raw value `param` (by default the first the bundle reads) holds for `identifier`'s `value`. */
export function thingReadback(identifier: string, value: string, ctx: AvailabilityContext, param?: number) {
  const read = bundleEntry(identifier, ctx)?.read;
  param ??= ranksOf(read)[0]?.[0];
  const raw = read && param !== undefined ? rawOn(read, param, value) : undefined;
  return raw === undefined ? undefined : { param: param!, raw };
}

/**
 * `identifier`'s value as the bundle reads it from the params `raw` answers: the first `>` rank with a
 * reported param, the last reported of its `+` params, mapped; the description's default when none is.
 */
export function thingRead(
  identifier: string,
  ctx: AvailabilityContext,
  raw: (param: number) => string | undefined,
): string | undefined {
  if (javaOverridden(identifier, ctx)) return undefined;
  const read = bundleEntry(identifier, ctx)?.read;
  for (const rank of ranksOf(read)) {
    const param = rank.findLast((p) => raw(p) !== undefined);
    if (param !== undefined) return valueOn(read!, param, raw(param)!, raw);
  }
  return ctx.things?.properties[identifier]?.defaultValue;
}

/** The read polarity of a boolean identifier on `param`: whether its raw `"1"` (or `"true"`) reads off. */
const invertOn = (read: BundleRead | undefined, param: number): boolean => {
  const map = read?.map?.[param];
  if (!map) return false;
  const on = map["1"] ?? map["true"];
  return on !== undefined ? !asBool(on) : asBool(map["0"] ?? map["false"]);
};

/**
 * Every param `identifiers` are read on anywhere in the data, with each polarity a boolean read gives it;
 * once per param, polarity unstated, for an `enum` read.
 */
function readParams(identifiers: readonly string[], enumRead: boolean): [param: number, invert?: boolean][] {
  const seen = new Map<string, [number, boolean?]>();
  for (const id of identifiers)
    for (const entry of Object.values(BUNDLE_WIRES.wires[id] ?? {}))
      for (const read of Object.values(entry.read ?? {}))
        for (const p of ranksOf(read).flat()) {
          const invert = enumRead ? undefined : invertOn(read, p);
          seen.set(`${p}:${invert}`, [p, invert]);
        }
  return [...seen.values()];
}

/**
 * A member's fields for the thing `identifiers` its bundle-written value is (the first the description
 * lists wins), its getter on `param`, to spread into its declaration. Without a description, or where the
 * product's bundle writes nothing on this topology, the member is absent.
 *
 * A boolean member writes `"1"`/`"0"` and reads each param with the polarity the bundle's map gives it. An
 * `enumerated` member's value is the app's UI value, the description's own: it reads `map[raw]` (a quality
 * config through its decoder) and writes the UI values this topology has a frame for, labelled as the
 * description names them, a `bool` property's 0/1 as Off/On.
 */
export function bundled(identifiers: readonly string[], param: number, enumerated = false) {
  const id = (ctx: AvailabilityContext) => identifiers.find((i) => ctx.things?.properties[i]);
  const entry = (ctx: AvailabilityContext) => {
    const i = id(ctx);
    return i === undefined ? undefined : { id: i, ...bundleEntry(i, ctx) };
  };
  const reads = (p: number) => (ctx: AvailabilityContext) => {
    const i = id(ctx);
    return i !== undefined && readsThing(i, p)(ctx);
  };
  const listed = (ctx: AvailabilityContext): ThingMember[] | undefined => {
    const i = id(ctx);
    const property = i === undefined ? undefined : ctx.things!.properties[i]!;
    if (property?.type !== "bool") return property?.members.filter((m) => /^-?\d+$/.test(m.value)) as ThingMember[];
    return ["Off", "On"].map((desc, value) => ({ value: String(value), desc, isDefault: false }));
  };
  /** Whether this device's bundle frame for `value` is one the SDK can send. */
  const builds = (ctx: AvailabilityContext, value: string) =>
    thingWrite(id(ctx)!, value, ctx as CommandContext) !== undefined;
  const writeDomain = (ctx: AvailabilityContext): number[] => {
    const keys = Object.keys(entry(ctx)?.write ?? {}).flatMap((k) => k.split(" "));
    const values = keys.includes("*") ? (listed(ctx) ?? []).map((m) => m.value) : keys;
    return [...new Set(values)].filter((v) => /^-?\d+$/.test(v) && builds(ctx, v)).map(Number);
  };
  return {
    param,
    thing: identifiers,
    available: (ctx: AvailabilityContext): boolean =>
      enumerated ? writeDomain(ctx).length > 0 : id(ctx) !== undefined && (builds(ctx, "1") || builds(ctx, "0")),
    readAvailable: reads(param),
    readAliases: readParams(identifiers, enumerated)
      .filter(([p]) => p !== param)
      .map(([p, invert]) => ({
        paramType: p,
        invert,
        available: (ctx: AvailabilityContext) =>
          reads(p)(ctx) && (invert === undefined || invertOn(entry(ctx)?.read, p) === invert),
      })),
    invertFor: (ctx: AvailabilityContext): boolean | undefined =>
      enumerated ? undefined : invertOn(entry(ctx)?.read, param),
    enumValuesFor: (ctx: AvailabilityContext): Record<number, string> | undefined => {
      if (!enumerated) return undefined;
      const members = listed(ctx)?.length
        ? listed(ctx)!
        : writeDomain(ctx).map((v) => ({ value: String(v), desc: "" }));
      const options = members.map((m) => [Number(m.value), m.desc.trim()] as const);
      const named = options.filter(([, label]) => label);
      return named.length ? Object.fromEntries(named) : undefined;
    },
    writeDomainFor: (ctx: AvailabilityContext): number[] | undefined => {
      const domain = enumerated ? writeDomain(ctx) : undefined;
      return domain?.length ? domain : undefined;
    },
    coerceFor: (ctx: AvailabilityContext) => {
      const read = enumerated ? entry(ctx)?.read : undefined;
      if (!read) return undefined;
      return (raw: unknown, p: number = ranksOf(read)[0]?.[0] ?? param, other?: RawOf) => {
        const value = valueOn(read, p, typeof raw === "string" ? raw : JSON.stringify(raw), other);
        return (value !== undefined && /^-?\d+$/.test(value) ? Number(value) : value) as number | string;
      };
    },
    write: (v: boolean | number | string, ctx: CommandContext): Command | undefined => {
      const i = id(ctx);
      if (i === undefined) return undefined;
      const value = enumerated ? String(v) : asBool(v) ? "1" : "0";
      const cmd = thingWrite(i, value, ctx);
      const readback = enumerated && cmd && thingReadback(i, value, ctx);
      return readback ? reflectCommand(cmd, readback) : cmd;
    },
  };
}
