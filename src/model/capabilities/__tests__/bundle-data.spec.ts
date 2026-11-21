import { thingRead, thingWrite, type BundleFrame } from "../bundle.js";
import type { ThingDescription, ThingProperty } from "../thing-description.js";
import type { CommandContext } from "../types.js";
import DATA from "../bundle-wires.generated.json" with { type: "json" };

/** The identifiers a member writes from the shipped data, `bool` where the member is a switch. */
const IDENTIFIERS: Record<string, "bool" | "enum"> = {
  camera_on_off: "bool",
  led_on_off: "bool",
  anti_theft_detection_switch: "bool",
  microphone_on_off: "bool",
  speaker_on_off: "bool",
  audio_recording_on_off: "bool",
  motion_track_status: "bool",
  notification_type: "enum",
  nightvision_type_new: "enum",
  nightvision_type: "enum",
  live_streaming_resolution: "enum",
  record_resolution: "enum",
  watermark_set: "enum",
};
const STATIONS = { standalone: undefined, hb2: "T8010P0000000000", hb3: "T8030P0000000000" } as const;

type Grouped<T> = Record<string, T>;
const data = DATA as unknown as {
  frames?: BundleFrame[];
  wires: Grouped<
    Grouped<{
      write?: Grouped<Grouped<BundleFrame | number>>;
      read?: Grouped<{ map?: Grouped<Grouped<string>>; exact?: { record: [number, string][]; ui: string }[] }>;
    }>
  >;
};
const frameOf = (f: BundleFrame | number) => (typeof f === "number" ? data.frames![f]! : f);

/** A description listing `identifier` (resolved to `variant`) with the given type. */
const described = (identifier: string, variant: string, type: string): ThingDescription =>
  ({
    properties: { [identifier]: { identifier: identifier + variant, type, members: [] } as unknown as ThingProperty },
  }) as unknown as ThingDescription;

/** Every write row of the shipped data for the member identifiers: product, variant, topology, value, frame. */
const rows = Object.entries(IDENTIFIERS).flatMap(([identifier, type]) =>
  Object.entries(data.wires[identifier] ?? {}).flatMap(([products, entry]) =>
    products.split(" ").flatMap((product) => {
      const [model, variant = ""] = product.split(/(?=__v\d+$)/);
      return Object.entries(entry.write ?? {}).flatMap(([topologies, values]) =>
        topologies.split(" ").flatMap((topology) =>
          Object.entries(values).flatMap(([keys, f]) =>
            keys
              .split(" ")
              .filter((v) => v !== "*")
              .map((value) => ({ identifier, type, model: model!, variant, topology, value, frame: frameOf(f) })),
          ),
        ),
      );
    }),
  ),
);

const NOW = 1_700_000_000_000;
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
afterEach(() => vi.restoreAllMocks());

/** The context of a row: a described `model` on channel 2, attached to the topology's station. */
const contextOf = (r: { identifier: string; type: string; model: string; variant: string; topology: string }) => {
  const station = STATIONS[r.topology as keyof typeof STATIONS];
  return {
    channel: 2,
    codec: "camera",
    model: r.model,
    serial: `${r.model}P0000000000`.slice(0, 16),
    paramIds: new Set<number>(),
    things: described(r.identifier, r.variant, r.type),
    ...(station && { stationSerial: station, homeBaseAttached: true }),
  } as CommandContext;
};

/**
 * `x` with the bundle's tokens as the app fills them on this device for `value`, no param reported (a
 * `$param:` token's `??` fallback); a `$userId` key left out.
 */
const filled = (x: unknown, value: unknown, ctx: CommandContext): unknown => {
  const tokens: Record<string, unknown> = {
    $value: value,
    $channel: ctx.channel,
    $now: String(NOW),
    $nowS: NOW / 1000,
    $sn: ctx.serial,
    $station: ctx.stationSerial ?? ctx.serial,
  };
  if (typeof x === "string" && x in tokens) return tokens[x];
  if (typeof x === "string" && x.startsWith("$param:")) return JSON.parse(x.split("??")[1]!);
  if (Array.isArray(x)) return x.map((v) => filled(v, value, ctx));
  if (x && typeof x === "object")
    return Object.fromEntries(
      Object.entries(x).flatMap(([k, v]) => (v === "$userId" ? [] : [[k, filled(v, value, ctx)]])),
    );
  return x;
};

/** The app's `toIntSafety` / `toBooleanSafety` of a scalar body's value. */
const scalar = (v: unknown, coerce?: string) =>
  coerce === "bool1" ? ([true, 1, "1", "true", "TRUE"].includes(v as never) ? 1 : 0) : Math.trunc(Number(v));

/** The command the app sends for a P2P frame of the data: its outer cmd, sub-command, body and header channel. */
function expected(f: BundleFrame, value: unknown, ctx: CommandContext): object {
  const payload = filled(f.payload, value, ctx);
  const channel = filled(f.channel, value, ctx);
  const head =
    f.body === "json1350"
      ? {
          kind: "set-payload",
          cmd: f.subCmd,
          payload,
          channel,
          mValue3: f.mValue3,
        }
      : f.body === "json1700"
        ? { kind: "set-json", param: f.subCmd, data: payload, channel }
        : {
            kind: "set-param",
            param: f.cmd,
            value: scalar((payload as Record<string, unknown>)[f.valueKey!], f.coerce),
            ...(f.body === "pair" && { form: "int-pair" }),
            channel,
          };
  return f.next?.length ? { ...head, next: expected({ ...f.next[0]!, next: f.next.slice(1) }, value, ctx) } : head;
}

describe("every write of the shipped data, as the member identifiers send it", () => {
  // `type: "json"` MQTT frames are not sent (`bundle.ts`).
  const sent = rows.filter((r) => !(r.frame.transport === "mqtt" && r.frame.type === "json"));

  it("covers the data", () => {
    expect(sent.length).toBeGreaterThan(5000);
    expect(rows.length - sent.length).toBe(6);
  });
  it.each(sent.map((r) => [`${r.model}${r.variant} ${r.identifier} ${r.topology} ${r.value}`, r] as const))(
    "%s",
    (_, r) => {
      const ctx = contextOf(r);
      const value = r.type === "bool" ? r.value === "1" : /^-?\d+$/.test(r.value) ? Number(r.value) : r.value;
      // A cached field without a fallback, its param unreported: the app's frame needs the device record.
      const unfilled = /"\$param:[^"?]*"/.test(JSON.stringify(r.frame));
      expect(thingWrite(r.identifier, r.value, ctx)).toEqual(unfilled ? undefined : expected(r.frame, value, ctx));
    },
  );
});

/** Every mapped read of the shipped data: product, variant, topology, param, raw and the value it maps to. */
const reads = Object.entries(IDENTIFIERS).flatMap(([identifier, type]) =>
  Object.entries(data.wires[identifier] ?? {}).flatMap(([products, entry]) =>
    products.split(" ").flatMap((product) => {
      const [model, variant = ""] = product.split(/(?=__v\d+$)/);
      return Object.entries(entry.read ?? {}).flatMap(([topologies, read]) =>
        topologies.split(" ").flatMap((topology) =>
          Object.entries(read.map ?? {}).flatMap(([param, map]) =>
            Object.entries(map).map(([raw, ui]) => {
              const exact = read.exact?.find(
                (e) => e.record.length === 1 && e.record[0]![0] === Number(param) && e.record[0]![1] === raw,
              );
              const value = exact?.ui ?? ui;
              return {
                identifier,
                type,
                model: model!,
                variant,
                topology,
                param: Number(param),
                raw,
                ui: value === "true" ? "1" : value === "false" ? "0" : value,
              };
            }),
          ),
        ),
      );
    }),
  ),
);

describe("every mapped read of the shipped data", () => {
  it.each(reads.map((r) => [`${r.model}${r.variant} ${r.identifier} ${r.topology} ${r.param}=${r.raw}`, r] as const))(
    "%s",
    (_, r) => {
      expect(thingRead(r.identifier, contextOf(r), (p) => (p === r.param ? r.raw : undefined))).toBe(r.ui);
    },
  );
});

describe("the shipped data", () => {
  it("has no null field outside a $param token: a field the bundle reads off the cache names its param", () => {
    const nulls = (x: unknown): boolean =>
      x === null || (typeof x === "object" && Object.values(x as object).some(nulls));
    expect(nulls(data)).toBe(false);
  });
});

/** `SecurityOutdoorModeAction` writes outdoor mode: the bundle's parser reads an object payload the bool cannot carry. */
describe("device_set_outdoor_mode", () => {
  it("is written by the app's Java action, so the data sends nothing for it", () => {
    expect(data.wires.device_set_outdoor_mode).toEqual({ T814X: { override: "java" } });
  });
});
