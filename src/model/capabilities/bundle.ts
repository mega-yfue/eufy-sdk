/**
 * The products' settings bundles as data: per thing identifier, the frame each product's bundle sends for
 * every value it writes and how it reads the value back, per topology. Generated off the bundles
 * (`bundle-wires.generated.json`, do not edit by hand) and translated here into the {@link Command}
 * builders of {@link module:model/capabilities/access}, following the app's own descriptor-to-frame rule.
 *
 * @module model/capabilities/bundle
 */
import { asBool, isStationSerial } from "../../core/util.js";
import { encodeVarint, RawDpWriter } from "../../core/raw-dp-writer.js";
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
 *   one its `cmd` and JSON `payload`;
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
  /** A data point's value per value of the input `key` (the bundle's own table, `fanToString[speed]`). */
  values?: { key: string; map: Readonly<Record<string, unknown>> };
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
  /** MQTT: seconds the app waits for the reply, and how many times it sends again while none comes. */
  timeout?: number | string;
  retryCount?: number;
  needAck?: boolean;
  next?: BundleFrame[];
  after?: BundleFrame;
  /** A lock setting over its station: the `ble` the app builds the 1350 params from. */
  lock?: {
    version: number;
    tlv: string;
    cmdCode?: number;
    apiCommand?: number;
    bleCommand?: number;
    subVersion?: number;
    functionType?: number;
    needEncrypt?: boolean;
  };
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
  /**
   * A JSON (or base64 JSON) report, or a base64 protobuf one as `message`'s `toObject` ({@link toObject}), read at
   * `path` (`.`-joined keys, `k=v` the list element whose `k` is `v`; none the whole report, an object as JSON),
   * then `map`, else as is.
   */
  field?: { param: number; path?: string; message?: Messages; map?: Readonly<Record<string, string>> };
  /** A base64 report read as its UTF-8 text ({@link textOf}), through the named `transform` ({@link TRANSFORMS}). */
  text?: { param: number; asIs?: true; transform?: string };
}

/**
 * A google-protobuf message schema as the bundle's generated code holds it, the read's message first, then those it
 * holds: per message its fields in declaration order, `[number, toObject key, reader (uint32, enum, bool, string) or
 * message, repeated]`.
 */
type Messages = Readonly<Record<string, readonly (readonly [number, string, string, true?])[]>>;

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
  /** The same for the app's RTC player, whose `open_live_stream` input is its own (`RtcLivePlayerBridge`). */
  rtcLive?: Grouped<Grouped<{ start: number; stop: number }>>;
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

/**
 * The frames the app's RTC player starts and stops `model`'s live view with under `parentSn` (its own serial when it
 * is its own station), the player's single-camera page; `undefined` for a product the bundles give none.
 */
export function rtcLiveFrames(model: string, parentSn: string): Pick<LiveFrames, "start" | "stop"> | undefined {
  const entry = memberOf(memberOf(BUNDLE_WIRES.rtcLive, model), topologyOf(parentSn));
  const frames = BUNDLE_WIRES.frames ?? [];
  return entry && { start: frames[entry.start]!, stop: frames[entry.stop]! };
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

/**
 * A base64 report's text as the app decodes it: `""` for none; with `asIs` (`decodeBase64String`) a report that is
 * no base64 (`isBase64Str`) as it is, without (`decodeToBase64UrlSafe`) whatever it decodes to; then its `transform`.
 */
const textOf = (read: { asIs?: true; transform?: string }, raw: string): string => {
  const text = !raw
    ? ""
    : read.asIs && !(raw.length % 4 === 0 && /^(?!\d+$)(?:[A-Za-z0-9+/]+|[A-Za-z0-9_-]+)={0,2}$/.test(raw))
      ? raw
      : Buffer.from(raw, "base64").toString("utf8");
  return read.transform ? String(TRANSFORMS[read.transform]!(text, {})) : text;
};

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
  if (read.text?.param === param) return textOf(read.text, raw);
  if (read.field?.param === param) {
    const { path, message } = read.field;
    const from = message ? toObject(message, Buffer.from(raw === "AA==" ? "" : raw, "base64")) : decoded(raw);
    const v = (path?.split(".") ?? []).reduce<unknown>((o, k) => {
      const [key, is] = k.split("=");
      return is !== undefined && Array.isArray(o) ? o.find((e) => objectOf(e)?.[key!] === is) : objectOf(o)?.[k];
    }, from);
    if (v === undefined || v === null) return undefined;
    const text = typeof v === "object" ? JSON.stringify(v) : String(v);
    return keyed(read.field.map?.[text] ?? text);
  }
  return keyed(read.map?.[param] ? read.map[param][raw] : raw);
};

/** The raw `param` holds for the identifier's `value`: its map key, the value itself, none on a decoded param. */
const rawOn = (read: BundleRead, param: number, value: string): string | undefined => {
  if ([read.quality, read.field, read.text].some((d) => d?.param === param)) return undefined;
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
  // `HH:MM` as the two bytes [H, M] a lock schedule field takes.
  if (type === "hm" && typeof v === "string" && /^\d{1,2}:\d{2}$/.test(v)) return Buffer.from(v.split(":").map(Number));
  if (type === "utf8" && v !== undefined && v !== null) return Buffer.from(String(v), "utf8");
  if (type === "hex" && typeof v === "string" && /^([0-9a-fA-F]{2})*$/.test(v)) return Buffer.from(v, "hex");
  return undefined;
}

/**
 * A bundle's TLV hex (`A104{nowS:u32le}A228{userId}A301{value:u8}`) as fields after `A1` (the time) and `A2` (the
 * user id), which the transport adds; `{value:<type>}` is the written value. `undefined` for any other placeholder or
 * a field whose bytes miss its length.
 */
function tlvFields(tlv: string, value: unknown): { tag: number; value: Buffer }[] | undefined {
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
      bytes =
        name === "value"
          ? tlvBytes(type, value)
          : name?.startsWith("param.")
            ? tlvBytes(type, (value as { param?: Record<string, unknown> } | undefined)?.param?.[name.slice(6)])
            : undefined;
    } else {
      bytes = Buffer.from(tlv.slice(i, i + len * 2), "hex");
      i += len * 2;
    }
    if (!bytes || bytes.length !== len || Number.isNaN(tag)) return undefined;
    fields.push({ tag, value: bytes });
  }
  return fields;
}

/** A `type: "json"` frame's write: its `cmd` and its JSON `payload` (an object, its tokens filled, or JSON text). */
function mqttJsonCommand(frame: BundleFrame, fill: (x: unknown) => unknown): Command | undefined {
  if (typeof frame.mqttCmdCode !== "number" || typeof frame.cmd !== "number") return undefined;
  let payload: unknown = fill(frame.payload ?? {});
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  return {
    kind: "mqtt-json",
    mqttCmdCode: frame.mqttCmdCode,
    cmd: frame.cmd,
    payload,
    ...(typeof frame.needAck === "boolean" && { needAck: frame.needAck }),
    ...(typeof frame.timeout === "number" && { timeoutS: frame.timeout }),
    ...(typeof frame.retryCount === "number" && { retryCount: frame.retryCount }),
  };
}

/**
 * A v4 lock TLV as bytes: its hex with `{nowS:u32le}` the clock and `{param.<key>:<type>}` the written field, as the
 * settings parser writes them; `undefined` for any other placeholder or a field that does not fit.
 */
function tlvHexOf(tlv: string, value: unknown): Buffer | undefined {
  let ok = true;
  const hex = tlv.replace(/\{([^}:]+):?([^}]*)\}/g, (_, name: string, type: string) => {
    const bytes =
      name === "nowS"
        ? tlvBytes(type, Math.floor(Date.now() / 1000))
        : name.startsWith("param.")
          ? tlvBytes(type, (value as { param?: Record<string, unknown> } | undefined)?.param?.[name.slice(6)])
          : undefined;
    if (!bytes) ok = false;
    return bytes?.toString("hex") ?? "";
  });
  return ok && /^([0-9a-fA-F]{2})*$/.test(hex) ? Buffer.from(hex, "hex") : undefined;
}

/**
 * The secure-MQTT write a `mqtt` frame of `type: "ble"` is: its `payload`, the TLV the bundle writes as hex
 * with placeholders (`A104{nowS:u32le}A228{userId}A301{value:u8}`), read into fields after `A1` (the time)
 * and `A2` (the user id), which the transport adds as it does for every frame; `{value:<type>}` is the
 * written value. `undefined` for any other placeholder, or a field whose bytes miss its length.
 */
function mqttCommand(frame: BundleFrame, value: unknown, fill: (x: unknown) => unknown): Command | undefined {
  const tlv = frame.payload;
  if (frame.type === "json") return mqttJsonCommand(frame, fill);
  if (frame.type !== "ble" || typeof frame.mqttCmdCode !== "number" || typeof frame.cmdCode !== "number")
    return undefined;
  if (typeof tlv !== "string") return undefined;
  const fields = tlvFields(tlv, value);
  if (!fields) return undefined;
  return {
    kind: "mqtt-dp",
    mqttCmdCode: frame.mqttCmdCode,
    cmdCode: frame.cmdCode,
    fields,
    ...(frame.subVersion !== undefined && { subVersion: frame.subVersion }),
    ...(frame.functionType !== undefined && { functionType: frame.functionType }),
    encrypt: frame.needEncrypt !== false,
    ...(typeof frame.timeout === "number" && { timeoutS: frame.timeout }),
    ...(typeof frame.retryCount === "number" && { retryCount: frame.retryCount }),
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
function sessionCommand(
  frame: BundleFrame,
  fill: (x: unknown) => unknown,
  ctx: CommandContext,
  value?: unknown,
): Command | undefined {
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
    if (frame.lock) {
      const l = frame.lock;
      if (l.version === 4) {
        const payload = tlvHexOf(l.tlv, value);
        return payload && ({ ...command, lock: { version: 4, bleCommand: l.bleCommand ?? 0, payload } } as Command);
      }
      const fields = l.version === 2 ? tlvFields(l.tlv, value) : undefined;
      if (!fields) return undefined;
      return {
        ...command,
        lock: {
          cmdCode: l.cmdCode ?? 0,
          apiCommand: l.apiCommand ?? 0,
          fields,
          subVersion: l.subVersion ?? 0,
          functionType: l.functionType ?? 0,
          encrypt: l.needEncrypt ?? false,
        },
      } as Command;
    }
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

/** A protobuf varint at `i` of `b`: its value and the index after it, `undefined` past the end. */
function varintAt(b: Uint8Array, i: number): [number, number] | undefined {
  for (let n = 0, k = 0; i < b.length && k < 10; k++) {
    const byte = b[i++]!;
    n += (byte & 0x7f) * 2 ** (7 * k);
    if (byte < 0x80) return [n, i];
  }
  return undefined;
}

/** The protobuf field at `i` of `b`: its number, wire type, varint `[value, end]`, length-delimited `[length, start]` and end; `undefined` past the end. */
function fieldAt(b: Uint8Array, i: number) {
  const tag = varintAt(b, i);
  if (!tag) return undefined;
  const wire = tag[0] % 8;
  const len = wire === 2 ? varintAt(b, tag[1]) : undefined;
  const fixed = wire === 1 ? 8 : wire === 5 ? 4 : undefined;
  const value = wire === 0 ? varintAt(b, tag[1]) : undefined;
  const end = value ? value[1] : len ? len[0] + len[1] : fixed && tag[1] + fixed;
  return end === undefined || end > b.length ? undefined : { field: Math.floor(tag[0] / 8), wire, value, len, end };
}

/**
 * Protobuf `b` as google-protobuf's `toObject` gives message `name` of `message` (its first): an absent scalar its default
 * (`0`, `false`, `""`), an absent message none, a repeated field a list, the last of a repeated singular field, an unknown
 * field skipped; `undefined` for bytes that are not the message.
 */
function toObject(message: Messages, b: Uint8Array, name = Object.keys(message)[0]!): Row | undefined {
  const fields = message[name]!;
  const defaults: Record<string, unknown> = { string: "", bool: false, uint32: 0, enum: 0 };
  const out = Object.fromEntries(fields.map(([, key, type, many]) => [key, many ? [] : defaults[type]]));
  for (let i = 0; i < b.length;) {
    const at = fieldAt(b, i);
    if (!at) return undefined;
    const f = fields.find(([n]) => n === at.field);
    if (f) {
      const [, key, type, many] = f;
      const bytes = at.len && b.subarray(at.len[1], at.end);
      const v =
        type in message
          ? bytes && toObject(message, bytes, type)
          : type === "string"
            ? bytes && Buffer.from(bytes).toString("utf8")
            : type === "bool" && at.value
              ? at.value[0] !== 0
              : at.value?.[0];
      if (v === undefined) return undefined;
      if (many) (out[key] as unknown[]).push(v);
      else out[key] = v;
    }
    i = at.end;
  }
  return out;
}

/** A `{field: n}` message (a room and its order) as google-protobuf writes it, a zero left out; `undefined` for another value. */
function messageOf(o: unknown): readonly number[] | undefined {
  if (!o || typeof o !== "object") return undefined;
  const w = new RawDpWriter();
  for (const [k, v] of Object.entries(o))
    if (!Number.isSafeInteger(v) || (v as number) < 0) return undefined;
    else if (v) w.int(Number(k), v as number);
  return w.toBytes();
}

/**
 * Protobuf body `b` with the field at each path of `sets` (`.`-joined field numbers, `n:i` the i-th repeat of
 * `n`, as the generator decodes) set as the bundles' google-protobuf writes it: a number or boolean as a varint,
 * anything in a length-delimited field as its text, a list as that many repeats of its field ({@link messageOf}),
 * a zero, `false` or `""` left out (proto3) with the messages around it kept; every other byte as is.
 * `undefined` for bytes that are not a message, a path not in them, or a value its field cannot carry.
 */
function setProto(b: Uint8Array, sets: ReadonlyMap<string, unknown>): number[] | undefined {
  const out: number[] = [];
  const seen = new Map<number, number>();
  let hit = 0;
  for (let i = 0; i < b.length;) {
    const at = fieldAt(b, i);
    if (!at) return undefined;
    const { field, wire, len, end } = at;
    const n = seen.get(field) ?? 0;
    seen.set(field, n + 1);
    const key = n ? `${field}:${n}` : String(field);
    const inner = new Map(
      [...sets].flatMap(([p, v]) => (p.startsWith(`${key}.`) ? [[p.slice(key.length + 1), v]] : [])),
    );
    const v = sets.get(key);
    // ponytail: a negative int32 (ten bytes in google-protobuf) is not written; add it when a template takes one.
    const x = Number(v);
    const w = new RawDpWriter();
    const list = sets.get(String(field));
    if (Array.isArray(list)) {
      // The list stands for every repeat of its field, written at the first.
      const messages = n ? [] : list.map(messageOf);
      if (messages.includes(undefined)) return undefined;
      for (const m of messages) w.bytes(field, m!);
      hit += n ? 0 : 1;
    } else if (inner.size) {
      const body = len && setProto(b.subarray(len[1], end), inner);
      if (!body) return undefined;
      w.bytes(field, body);
      hit += inner.size;
    } else if (!sets.has(key)) out.push(...b.subarray(i, end));
    else if (wire === 0 && Number.isSafeInteger(x) && x >= 0) {
      if (x) w.int(field, x);
      hit++;
    } else if (wire === 2) {
      if (String(v)) w.bytes(field, Buffer.from(String(v)));
      hit++;
    } else return undefined;
    out.push(...w.toBytes());
    i = end;
  }
  return hit === sets.size ? out : undefined;
}

/**
 * A templated data-point value with its fields set as the app sets them per write, each from a token:
 * `$now` the epoch ms (a number), any other filled by `fill` (`$sn`, `$input.<key>`, …); the field `""` is
 * the whole value. The value is a JSON object, as is or hex-encoded (`hex-json`), a field by its `.`-joined path,
 * or a protobuf ({@link setProto}) in its frame's framing: bare hex (`hex`), behind its varint length in hex
 * (`hex-len`) or base64. `undefined` for any other value, or a token with no value.
 */
function templated(frame: BundleFrame, value: unknown, fill: (x: unknown) => unknown): unknown {
  const fields = objectOf(frame.template);
  if (!fields) return undefined;
  const set = (token: unknown) => (token === "$now" ? Date.now() : fill(token));
  if ("" in fields) return set(fields[""]);
  if (["hex", "hex-len", "base64"].includes(frame.encoding!) && typeof value === "string") {
    const b64 = frame.encoding === "base64";
    const raw = Buffer.from(value, b64 ? "base64" : "hex");
    const len = frame.encoding === "hex" ? [0, 0] : varintAt(raw, 0);
    const sets = new Map(Object.entries(fields).map(([k, t]) => [k, set(t)]));
    if (!len || (len[1] && len[0] + len[1] !== raw.length) || [...sets.values()].includes(undefined)) return undefined;
    const body = setProto(raw.subarray(len[1]), sets);
    const framed = body && (len[1] ? [...encodeVarint(body.length), ...body] : body);
    return framed && Buffer.from(framed).toString(b64 ? "base64" : "hex");
  }
  const hex = frame.encoding?.startsWith("hex") && typeof value === "string";
  const object = parse(hex ? Buffer.from(value as string, "hex").toString("utf8") : value);
  if (!object) return undefined;
  const out = structuredClone(object);
  for (const [path, token] of Object.entries(fields)) {
    const keys = path.split(".");
    const parent = keys.slice(0, -1).reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], out);
    const v = set(token);
    if (!parent || typeof parent !== "object" || v === undefined) return undefined;
    (parent as Record<string, unknown>)[keys[keys.length - 1]!] = v;
  }
  const json = typeof value === "string" ? JSON.stringify(out) : out;
  return hex ? Buffer.from(json as string, "utf8").toString("hex") : json;
}

/** The data-point write a `dp` frame is, its value by the input's table or templated per write, a hex value as base64. */
function dpCommand(frame: BundleFrame, fill: (x: unknown) => unknown): Command | undefined {
  // A list of one reads as its element (`String([3])`), a longer one as none of the table's keys.
  const filled = fill(frame.values ? frame.values.map[String(fill(`$input.${frame.values.key}`))] : frame.value);
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
 * (the device channel, 255 for a station), `$now` (epoch ms, a string), `$nowS` (epoch seconds), `$seq` (the bundles' `getRandom`, 1000–9999), `$input.<key>` (a key of
 * the written value, a JSON object), `$sn` (the device serial) and `$station` (its
 * station's), `$param:…` (the device's cached param, {@link BundleFrame}), `$userId` left to the transport, which fills the user id (an `account_id` key left out: the envelope's), then `{"$b64": <template>}` the filled template as base64 JSON, then the frames after it as `next`. `undefined` for a frame no builder can carry: a `ble`
 * or unknown transport, an `mqtt` one its builder refuses, an unknown body, a seal other than `ecb` or on a non-JSON body, a scalar with no integer value, a bare JSON
 * body that is not an object, a data point whose template cannot be set, a cloud call with another method, or a
 * frame after it that is any of these.
 */
export function frameCommand(frame: BundleFrame, value: unknown, ctx: CommandContext, td?: Td): Command | undefined {
  const tokens: Record<string, unknown> = {
    $value: value,
    $channel: isStationSerial(ctx.serial ?? "") ? 255 : ctx.channel,
    $now: String(Date.now()),
    $nowS: Math.floor(Date.now() / 1000),
    $seq: Math.floor(1e3 + 9e3 * Math.random()),
    $sn: ctx.serial,
    $station: ctx.stationSerial ?? ctx.serial,
  };
  const input = parse(value) ?? {};
  let unfilled = false;
  // `$input.<key>[|<transform>]`: the host's field, as the bundle's parser transforms it ({@link TRANSFORMS});
  // nothing sent where the transform refuses the value, as the parser throws on it.
  const inputOf = (ref: string) => {
    const [key, transform] = ref.split("|");
    const v = key ? input[key] : input;
    if (!transform) return v;
    const out = TRANSFORMS[transform]?.(v, input, ctx.paramValue, td);
    unfilled ||= out === undefined;
    return out;
  };
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
    x.startsWith("$input.") ? inputOf(x.slice(7)) : x.startsWith("$param:") ? param(x) : tokens[x];
  const fill = (x: unknown): unknown =>
    typeof x === "string" && (x in tokens || x.startsWith("$input.") || x.startsWith("$param:"))
      ? token(x)
      : Array.isArray(x)
        ? x.map(fill)
        : x && typeof x === "object"
          ? "$b64" in x
            ? Buffer.from(JSON.stringify(fill(x.$b64))).toString("base64")
            : spread(x as Record<string, unknown>)
          : x;
  // `"$input": "...[<key>][|<transform>]"`: the host's object (or its key), as the parser transforms it, spread in there.
  const spread = (o: Record<string, unknown>) => {
    const rest = Object.fromEntries(
      Object.entries(o).flatMap(([k, v]) =>
        (v === "$userId" && k === "account_id") || k === "$input" ? [] : [[k, fill(v)]],
      ),
    );
    const mark = o["$input"];
    if (typeof mark !== "string" || !mark.startsWith("...")) return rest;
    return { ...(inputOf(mark.slice(3)) as Record<string, unknown>), ...rest };
  };
  const transport = frame.transport ?? "p2p";
  const head =
    transport === "p2p"
      ? sessionCommand(frame, fill, ctx, value)
      : transport === "dp"
        ? dpCommand(frame, fill)
        : transport === "http"
          ? cloudCommand(frame, fill)
          : transport === "mqtt"
            ? mqttCommand(frame, value, fill)
            : undefined;
  const after = [...(frame.next ?? []), ...(frame.after ? [frame.after] : [])];
  const next = after.length
    ? frameCommand({ ...after[0]!, next: after.slice(1), after: undefined }, value, ctx, td)
    : null;
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
  // A `{paramType, param}` lock settings write (JSON): its frame is the paramType's, its marks the param's fields.
  const struct = structOf(value);
  const write = bundleEntry(identifier, ctx)?.write;
  // A frame an input field's value picks (`*sensor_id=1`: the second lens's command), else the value's.
  const frame =
    Object.entries(parse(value) ?? {})
      .map(([k, v]) => memberOf(write, `*${k}=${v}`))
      .find(Boolean) ?? frameFor(write, struct ? String(struct.paramType) : value);
  const typed =
    struct ??
    (ctx.things?.properties[identifier]?.type === "bool"
      ? value === "1"
      : /^-?\d+$/.test(value)
        ? Number(value)
        : value);
  // The parser's `td_list`: the description's enum list under the identifier, each value's int desc.
  const members = ctx.things?.properties[identifier]?.members;
  const td = members?.length ? Object.fromEntries(members.map((m) => [m.value, toInt(m.desc)])) : undefined;
  return frame && frameCommand(frame, typed, ctx, td);
}

const boolInt = (v: unknown) => (v === true || v === 1 || v === "1" || v === "true" ? 1 : 0);
/** Detection type → its bits, as `doMotionDetectionTypeToCMDValue_NVR_V2` sums them. */
const NVR_TYPES: Record<number, number> = { 0: 0x30000, 1: 3, 2: 4, 3: 8, 4: 0x8000, 7: 1 << 18 };
/** The bundles' `calculate`: percentage `r` (0–100) on `[min, max]`, 50 at `center`. */
const calculate = (min: number, max: number, center: number, r: unknown) => {
  const n = Number(r);
  if (!(n >= 0 && n <= 100)) return undefined;
  return Math.round(n <= 50 ? min + (n / 50) * (center - min) : center + ((n - 50) / 50) * (max - center));
};
/** The bundles' `toInt`: an integer, or a string of one, else `d` (NaN, sent as `null`). */
const toInt = (v: unknown, d = Number.NaN) =>
  Number.isInteger(v) ? v : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number.parseInt(v, 10) : d;
type Row = Record<string, unknown>;
/** The bundles' `h.toString().padStart(2, "0") + m.toString().padStart(2, "0")`, undefined where `toString` throws. */
const hhmm = (h: unknown, m: unknown) =>
  h == null || m == null ? undefined : String(h).padStart(2, "0") + String(m).padStart(2, "0");
const rows = (v: unknown, f: (e: Row) => Row) => (Array.isArray(v) ? v.map((e) => f((e ?? {}) as Row)) : v);

type Param = (id: number) => string | undefined;
/** A zone's geometry, the description's `normalized`, `zoneWidth`, `zoneHeight` (`parseVideoConfig`). */
type Td = Record<string, unknown>;
/** `parseVideoConfig` without a list. */
const VIDEO: Td = { normalized: 1, zoneWidth: 1280, zoneHeight: 720 };
type Point = { x: number; y: number };
/** `ZonePot.toDeviceZonePot`: normalized `min(1000, round(1000v + .5))` (NaN is 1000), else `round(1000v · size / 1000)`. */
const devicePot = (normalized: boolean, td: Td) => (p: Row) => {
  const up = (v: unknown) => ((r) => (r < 1000 ? r : 1000))(Math.round(1000 * Number(v) + 0.5));
  const px = (v: unknown, size: unknown) => Math.round((1000 * Number(v) * Number(size)) / 1000);
  return normalized ? { x: up(p.x), y: up(p.y) } : { x: px(p.x, td.zoneWidth), y: px(p.y, td.zoneHeight) };
};
/** `ZoneInfo.addPot` / `ZoneInfoIPC.addPot`: the pots as device points, only 4- or 6-point ones of the first's length. */
const polygens = (v: unknown, normalized: boolean, td: Td) => {
  const out: { points: Point[] }[] = [];
  for (const pot of v as { points: Row[] }[]) {
    const points = pot.points.map(devicePot(normalized, td));
    if ((points.length === 4 || points.length === 6) && (!out.length || out[0]!.points.length === points.length))
      out.push({ points });
  }
  return out;
};
/**
 * `toRestorePrivacyRectZoneTwoPot`: each pot's first two points a rect, `round(1000v)` normalized, else
 * `round(v · size)`, the host's `DetSensitivity` (500), `MoveDetStatus` (1 with a pot) and `Normalized` (1);
 * nothing sent where the bundle throws.
 */
const privacyRect = (v: unknown, input: Row, td: Td) => {
  try {
    const { DetSensitivity = 500, MoveDetStatus = 0, Normalized = 1 } = input;
    const [w, h] = td.normalized === 1 ? [1000, 1000] : [td.zoneWidth, td.zoneHeight];
    const k = (n: unknown, size: unknown) => Math.round(Number(n) * Number(size));
    const points = (v as { points: Row[] }[]).map(({ points: [l, r] }) => ({
      LeftPointX: k(l!.x, w),
      LeftPointY: k(l!.y, h),
      RightPointX: k(r!.x, w),
      RightPointY: k(r!.y, h),
    }));
    return {
      account: "$userId",
      DetSensitivity,
      MoveDetStatus: MoveDetStatus || (points.length ? 1 : 0),
      Normalized,
      points,
    };
  } catch {
    return undefined;
  }
};
/** `DeviceMotionDetectionParser` v4/v7 (T8217 `{5,4}`, T85M0 `{5,6}`): type → bit, the two bits it owns being 0x8003. */
// ponytail: one table for both products; read the mapping off the description's associatedValues if a third differs.
const HB3_TYPES: Record<number, number> = { 4: 0x8000, 5: 3, 6: 0x8000 };
/** `doMotionDetectionTypeToCMDValue_HB3_V3`: the selection's bits over cached param `id`'s others; `strict`, a non-string throws. */
const hb3 =
  (id: number, strict = false) =>
  (v: unknown, _: Row, param?: Param) =>
    typeof v !== "string"
      ? v || strict
        ? undefined
        : 0
      : !v
        ? 0
        : v
            .split(",")
            .reduce(
              (n, t) => n | (HB3_TYPES[Number(t)] ?? 0),
              (Number.parseInt(String(param?.(id)), 10) || 0) & ~0x8003,
            );

/**
 * The transforms a bundle's parser applies to one host field before it sends it (`$input.<key>|<name>`), or to a
 * report's text after it decodes it (a `text` read's `transform`).
 */
const TRANSFORMS: Record<string, (v: unknown, input: Row, param?: Param, td?: Td) => unknown> = {
  /** The schedule parsers: each `week` list as `[{day}]`. */
  weekDays: (v) => weekDays(v),
  /** `LightAmbientLightingSettingParser`: each loop's week a day bitmask, its `enable` 0 while `sunset2rise` is on. */
  ambientLoop: (v, input) =>
    rows(v, (e) => ({
      ...e,
      week: (Array.isArray(e.week) ? e.week : [])
        .map((d) => (d && typeof d === "object" ? (d as Row).day : d))
        .reduce((m: number, d) => m | (1 << Number(d)), 0),
      ...(boolInt(input.sunset2rise) ? { enable: 0 } : {}),
    })),
  boolInt,
  /** `DeviceMotionDetectionParser1298`: comma-listed detection types summed on their bits (`doMotionDetectionTypeToCMDValue_NVR_V2`). */
  nvrTypes: (v) =>
    v === ""
      ? 0
      : String(v)
          .split(",")
          .reduce((n, t) => n + (NVR_TYPES[Number(t)] ?? Number.NaN), 0),
  /** `VideoSettingImageEffectSetParser`: each 0–100 percentage on the device's scale (the bundles' `calculate`). */
  imageBrightness: (v) => calculate(80, 500, 256, v),
  imageContrast: (v) => calculate(50, 1000, 256, v),
  imageSaturation: (v) => calculate(1024, 20480, 4096, v),
  imageChrome: (v) => calculate(-10240, 10240, 0, v),
  /** `DeviceChimeMinibaseChimeSettingParser`: each chime's fields normalised, `trigger_type` 1. */
  chimes: (v) =>
    rows(v, (e) => ({
      chime_mac: e.chime_mac,
      chime_sn: e.chime_sn,
      enable: boolInt(e.enable),
      volume: toInt(e.volume, 13),
      voice_type: toInt(e.voice_type),
      is_play: boolInt(e.is_play),
      trigger_type: 1,
    })),
  /** `DeviceMotionDetectionParser` v4/v7: `ai_detect_type` over cached 1298, `ai_notification` over 6028 (`.includes` first: missing throws). */
  hb3Types: hb3(1298),
  hb3Notify: hb3(6028, true),
  /** `encodeModeRoomCleanRequest` / `encodeCustomOrderRequest`: each room id with its order from 1, a repeated `{1: id, 2: order}`. */
  ordered: (v) => (Array.isArray(v) ? v.map((id, i) => ({ 1: id, 2: i + 1 })) : undefined),
  /** The T2080A family's `encodeModeRoomCleanRequest`: the order from 0. */
  ordered0: (v) => (Array.isArray(v) ? v.map((id, i) => ({ 1: id, 2: i })) : undefined),
  /** The JSON `globalRooms` / `editRooms` custom order: `{roomId, cleanOrder}` from 1. */
  cleanOrder: (v) => (Array.isArray(v) ? v.map((roomId, i) => ({ roomId, cleanOrder: i + 1 })) : undefined),
  /** `ecl_toggle_do_not_disturb`: `stringToHex` of `isOn ? "1" : "0"` and the start and end times. */
  dnd: (_, i) =>
    ((s, e) => (s && e ? Buffer.from((i.isOn ? "1" : "0") + s + e).toString("hex") : undefined))(
      hhmm(i.startHour, i.startMin),
      hhmm(i.endHour, i.endMin),
    ),
  /** T2210's do-not-disturb `start_t` / `end_t`. */
  startHhmm: (_, i) => hhmm(i.startHour, i.startMin),
  endHhmm: (_, i) => hhmm(i.endHour, i.endMin),
  /** `device_cross_cam_group` (1073): the decoded text without its NULs. */
  stripNul: (v) => String(v).replace(/\0/g, ""),
  /** `filterCrossCamSensorDevices` (1072): a JSON list re-stringified without the sensors' serials, `"[]"` for a blank text, as is when no list. */
  crossCamFilter: (v) => {
    if (typeof v !== "string" || !v.trim()) return "[]";
    try {
      const list: unknown = JSON.parse(v);
      return Array.isArray(list)
        ? JSON.stringify(
            list.filter((e) => typeof e !== "string" || !/^T(90[CEFGKMPRS]0|90R1|89[01267]0|8931)/.test(e)),
          )
        : v;
    } catch {
      return v;
    }
  },
  /**
   * `asDeviceZonePot`: the host's pots (`[{points: [{x, y}]}]`, 0–1) as the device's `ZoneInfo` on the
   * description's geometry, each rect's bounds in `points`; nothing sent where the bundle throws.
   */
  zoneInfo: (v, _, __, td = VIDEO) => {
    try {
      const pots = polygens(v, td.normalized === 1, td);
      const bound = (ps: Point[]) => ({
        LeftPointX: Math.min(...ps.map((p) => p.x)),
        LeftPointY: Math.min(...ps.map((p) => p.y)),
        RightPointX: Math.max(...ps.map((p) => p.x)),
        RightPointY: Math.max(...ps.map((p) => p.y)),
      });
      const n = pots.length;
      return {
        account: "$userId",
        DetSensitivity: 0,
        MoveDetStatus: n ? 1 : 0,
        Normalized: 0,
        zonecount: n,
        polygens: pots,
        points: pots.filter((p) => p.points.length === 4).map((p) => bound(p.points)),
      };
    } catch {
      return undefined;
    }
  },
  /** `SetActiveZoneParser1204V1` (T8203): `zoneInfo` with its polygons' points flattened into `points`, once it has one. */
  zoneFlat: (v, input, param, td) => {
    const z = TRANSFORMS.zoneInfo!(v, input, param, td) as { polygens: { points: Point[] }[] } | undefined;
    if (!z?.polygens.length) return z;
    const { polygens, ...rest } = z;
    return { ...rest, points: polygens.flatMap((q) => q.points) };
  },
  /** `toRestoreHotZonePot` (`SetActiveZoneParser6021`), its flag `1 !== normalized`: `{polygens, account}`. */
  hotZone: (v, _, __, td = VIDEO) => {
    try {
      return { polygens: polygens(v, td.normalized !== 1, td), account: "$userId" };
    } catch {
      return undefined;
    }
  },
  /**
   * `asActivityZonePot`'s `ZoneInfoIPC.addPot`: the pots on the description's geometry, 4- or 6-point of the first's
   * length, a levelled one `{level, label, points, isSaved: 1}`; nothing sent where the bundle throws.
   */
  ipcActive: (v, _, __, td = VIDEO) => {
    try {
      const out: { points: Point[]; [k: string]: unknown }[] = [];
      for (const { points, level, label } of v as { points: Row[]; level?: unknown; label?: unknown }[]) {
        const ps = points.map(devicePot(td.normalized === 1, td));
        if (!(ps.length === 4 || ps.length === 6) || (out.length && out[0]!.points.length !== ps.length)) continue;
        out.push(
          level
            ? { level, label: label ?? null, points: ps, isSaved: 1 }
            : { points: ps, ...(level != null && { level }), ...(label != null && { label }) },
        );
      }
      return { polygens: out };
    } catch {
      return undefined;
    }
  },
  /** `asPrivacyZonePot`, sensor 0: every pot on the description's geometry; nothing sent where the bundle throws. */
  ipcPrivacy: (v, _, __, td = VIDEO) => {
    try {
      return {
        polygens: (v as { points: Row[] }[]).map((p) => ({ points: p.points.map(devicePot(td.normalized === 1, td)) })),
      };
    } catch {
      return undefined;
    }
  },
  /** `asPrivacyZonePot`, sensor 1: each `privacyZoneList` entry `{index, pots}` as `{index, points}`, its pots' points in one list. */
  ipcPrivacyList: (v, _, __, td = VIDEO) => {
    try {
      return {
        polygens: (v as { index: unknown; pots: { points: Row[] }[] }[]).map(({ index, pots }) => ({
          index,
          points: pots.flatMap((p) => p.points.map(devicePot(td.normalized === 1, td))),
        })),
      };
    } catch {
      return undefined;
    }
  },
  /** `SetPrivacyZoneParser1295`. */
  privacyRect: (v, input, _, td = VIDEO) => privacyRect(v, input, td),
  /** `SetActiveZoneParserV2` v4: pixel-scaled whatever the description says. */
  privacyRectPx: (v, input, _, td = VIDEO) => privacyRect(v, input, { ...td, normalized: 0 }),
  /** `SetPrivacyZoneParser1295Percent`: the pixel-scaled rects alone. */
  privacyPoints: (v, input, _, td = VIDEO) => privacyRect(v, input, { ...td, normalized: 0 })?.points,
  /** `device_response_timeout_schedule` (6440, `decodeBase64StringToJSON`: `{}` for no JSON): its `schedules` as JSON when they `loop`, else the whole. */
  timeoutSchedule: (v) => {
    let o: { schedules?: { loop?: unknown } } | null;
    try {
      o = JSON.parse(String(v));
    } catch {
      o = {};
    }
    return JSON.stringify(o?.schedules?.loop ? o.schedules : o);
  },
};

/** `x` with every `week` list of plain values as `[{day: <int>}]`, as the bundles' schedule parsers rewrite it. */
function weekDays(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(weekDays);
  if (!x || typeof x !== "object") return x;
  return Object.fromEntries(
    Object.entries(x).map(([k, v]) =>
      k === "week" && Array.isArray(v) && v.every((d) => typeof d !== "object")
        ? [k, v.map((d) => ({ day: Math.trunc(Number(d)) }))]
        : [k, weekDays(v)],
    ),
  );
}

/** `value` as a `{paramType, param}` settings write, or undefined when it is not one. */
function structOf(value: string): { paramType: number; param: Record<string, unknown> } | undefined {
  if (!value.startsWith("{")) return undefined;
  try {
    const v = JSON.parse(value) as { paramType?: unknown; param?: unknown };
    return Number.isInteger(v.paramType) && v.param && typeof v.param === "object"
      ? { paramType: v.paramType as number, param: v.param as Record<string, unknown> }
      : undefined;
  } catch {
    return undefined;
  }
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
