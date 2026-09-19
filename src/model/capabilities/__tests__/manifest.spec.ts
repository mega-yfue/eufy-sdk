import { buildActions, CAPABILITY_MODULES, describeCapabilities } from "../index.js";
import { Device } from "../../device.js";
import type { Capability } from "../../types.js";
import type { CapabilityModule, CommandContext } from "../types.js";
import { borrowedBy } from "../members.js";
import type { ValueMember } from "../members.js";
import type { Command, CommandSink, MediaProvider } from "../../../core/contracts.js";

/**
 * The manifest is the SDK's answer to "what does this device expose" for a caller outside the package,
 * so what it claims has to be true of the object a caller then reaches for. What this locks:
 *
 *  1. an unbound device says so, rather than describing itself as exposing nothing,
 *  2. the described reads are the INSTALLED ones — the evidence gate is observable from outside,
 *  3. enumeration and the member tables agree, so "read the live object" is safe rather than merely
 *     convenient — this is what fails if someone hand-writes a getter in an `actions()` factory,
 *  4. describing a device reads no VALUES: no getter is invoked and nothing observed leaks in,
 *  5. it survives a JSON round-trip, since a host consumes it over a wire it does not share with us,
 *  6. a provider-gated method is described only on a device bound to that provider.
 */
const MODULES = Object.values(CAPABILITY_MODULES);
const BINDABLE = MODULES.filter((m) => m.actions || m.members);
const sink: CommandSink = { dispatch: async () => undefined };
const camelCase = (id: string): string => id.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Every param any module reads — the "device reported everything" evidence set. */
const allParams = (): Set<number> =>
  new Set(
    MODULES.flatMap((m) =>
      m.properties.flatMap((p) => [p.paramType, ...(p.readAliases?.map((alias) => alias.paramType) ?? [])]),
    ),
  );

/**
 * `model` is optional and worth passing wherever the fixture names one: without it a model-gated read
 * installs on everything, so a fixture claiming to be a particular camera proves nothing about that
 * camera. That is how a `T8410` record came to assert it installs a battery `level` — the record said
 * one model and the context it was bound with knew none.
 */
const ctxWith = (paramIds: Set<number>, model?: string): CommandContext => ({
  channel: 0,
  codec: "camera",
  paramIds,
  capabilities: new Set(MODULES.map((m) => m.capability)),
  ...(model ? { model } : {}),
});

/** Describe the bound objects of a synthetic device that HAS every capability. */
const describeAll = (paramIds: Set<number>, media?: MediaProvider): ReturnType<typeof describeCapabilities> =>
  describeCapabilities(
    buildActions(
      BINDABLE.map((m) => m.capability),
      { ctx: ctxWith(paramIds), sink, read: () => undefined, media },
    ),
  );

/**
 * The reads a module's table says a device with THESE params installs — the second computation the
 * builder deliberately does not do, kept here so the two can be compared.
 */
const tableReads = (m: CapabilityModule, paramIds: Set<number>): string[] =>
  Object.entries(m.members ?? {})
    .filter(([, member]) => "type" in member && !member.writeOnly && !member.unexposed)
    .filter(([, member]) => {
      const v = member as ValueMember;
      // A getter installs only where the member is available for this device — the same one
      // availability decision the manifest and setter apply (here the ctx is a plain camera).
      if (v.available && !v.available(ctxWith(paramIds))) return false;
      // Either wire installs a `readsFrom` member: its own param where it has one, or the OWNER's
      // payload that carries the same value on the other device family — exactly as `bindMembers`
      // resolves it. Its own `available` above still applies.
      const borrowed = borrowedBy(v, m.members ?? {});
      const evident = (x: ValueMember): boolean =>
        x.realtime === true ||
        (x.param !== undefined && paramIds.has(x.param)) ||
        x.readAliases?.some((a) => paramIds.has(a.paramType)) === true;
      return evident(v) || (borrowed !== undefined && paramIds.has(borrowed.param));
    })
    .map(([name]) => name);

describe("describeCapabilities — enumeration of the live bound objects", () => {
  it("describes only the alarm-output members installed for each verified siren family", () => {
    const describeSiren = (ctx: CommandContext) =>
      describeCapabilities(buildActions(["siren"], { ctx, sink, read: () => undefined })).find(
        (entry) => entry.capability === "siren",
      )!;
    const homeBase = describeSiren({
      channel: 0,
      codec: "station",
      deviceType: 0,
      model: "T8010",
      accountName: "tester",
      capabilities: new Set(["siren"]),
      paramIds: new Set([1281, 1282]),
    });
    const camera = describeSiren({
      channel: 1,
      codec: "camera",
      deviceType: 9,
      model: "T8114",
      homeBaseAttached: true,
      capabilities: new Set(["siren"]),
      paramIds: new Set([1015]),
    });
    const standalone = describeSiren({
      channel: 16,
      codec: "sensor",
      deviceType: 123,
      capabilities: new Set(["siren"]),
      paramIds: new Set([61008, 1825]),
    });
    const unverified = describeSiren({
      channel: 0,
      codec: "camera",
      deviceType: 9,
      homeBaseAttached: false,
      capabilities: new Set(["siren"]),
      paramIds: new Set([61008]),
    });

    expect(homeBase.reads.map((read) => read.accessor)).toEqual(["alarmTone"]);
    expect(homeBase.actions.map((action) => action.name)).toEqual([
      "setAlarmVolume",
      "setAlarmTone",
      "trigger",
      "stop",
    ]);
    expect(homeBase.actions.find((action) => action.name === "trigger")?.args).toEqual([
      { name: "seconds", kind: "seconds", min: 1, description: "A positive whole-number duration." },
    ]);
    expect(camera.reads).toEqual([]);
    expect(camera.actions.map((action) => action.name)).toEqual(["trigger", "stop"]);
    expect(standalone.reads.map((read) => read.accessor)).toEqual(["active", "volume"]);
    expect(standalone.actions.map((action) => action.name)).toEqual(["setVolume", "test", "stop"]);
    expect(unverified.reads).toEqual([]);
    expect(unverified.actions).toEqual([]);
  });

  it("agrees with the member tables on which reads a device installed", () => {
    const params = allParams();
    for (const d of describeAll(params)) {
      const module = CAPABILITY_MODULES[d.capability];
      expect(d.reads.map((r) => r.accessor).sort()).toEqual(tableReads(module, params).sort());
    }
  });

  it("describes only the reads the device reported, not the theoretical set", () => {
    const battery = CAPABILITY_MODULES.battery;
    const level = battery.members!.level as ValueMember;
    const only = describeAll(new Set([level.param!])).find((d) => d.capability === "battery")!;
    expect(only.reads.map((r) => r.accessor)).toEqual(["level"]);
    const all = describeAll(allParams()).find((d) => d.capability === "battery")!;
    expect(all.reads.length).toBeGreaterThan(1);
  });

  it("publishes what a value means, not just how it is stored", () => {
    const battery = describeAll(allParams()).find((d) => d.capability === "battery")!;
    expect(battery.reads.find((r) => r.accessor === "level")).toMatchObject({
      property: "battery",
      type: "number",
      kind: "percent",
      unit: "%",
      writable: false,
    });
  });

  it("names the accessor each capability is reached under", () => {
    for (const d of describeAll(allParams())) expect(d.accessor).toBe(camelCase(d.capability));
  });

  it("marks a read writable only where its own setter is installed beside it", () => {
    for (const d of describeAll(allParams())) {
      const bound = buildActions([d.capability], { ctx: ctxWith(allParams()), sink, read: () => undefined })[
        camelCase(d.capability) as keyof ReturnType<typeof buildActions>
      ] as Record<string, unknown>;
      const installed = Object.getOwnPropertyDescriptors(bound);
      for (const r of d.reads.filter((r) => r.writable)) {
        const member = CAPABILITY_MODULES[d.capability].members![r.accessor] as ValueMember;
        const setter = member.writeAs ?? `set${r.accessor[0].toUpperCase()}${r.accessor.slice(1)}`;
        expect(typeof installed[setter]?.value).toBe("function");
      }
    }
  });

  it("lists a described action by the name it is installed under, and the rest as undescribed", () => {
    for (const d of describeAll(allParams())) {
      const bound = buildActions([d.capability], { ctx: ctxWith(allParams()), sink, read: () => undefined })[
        camelCase(d.capability) as keyof ReturnType<typeof buildActions>
      ] as Record<string, unknown>;
      const methods = Object.entries(Object.getOwnPropertyDescriptors(bound))
        .filter(([, p]) => typeof p.value === "function")
        .map(([name]) => name);
      expect([...d.actions.map((a) => a.name), ...d.undescribedActions].sort()).toEqual(methods.sort());
    }
  });

  it("announces the events a capability emits, including the ones it decodes itself", () => {
    const described = describeAll(allParams());
    expect(described.find((d) => d.capability === "ptz")!.events).toEqual(["ptzNotify"]);
    expect(described.find((d) => d.capability === "battery")!.events).toEqual(["batteryAlert"]);
  });

  /**
   * A stateful action says which read it REFLECTS, and the domain is published there — once.
   *
   * The derived argument deliberately carries no `values` of its own: a second copy beside the read's
   * `enumValues` could only drift from it. So a caller offering the control reads the domain off the
   * reflected read, and that indirection is the thing to hold, because it is what makes one declaration
   * serve the check, the refusal message and the offered control alike.
   *
   * A member that states its own `args[0].values` is the exception, and means the two genuinely differ —
   * a device reporting a value it will not accept back. No member states one today.
   */
  it("points an action at the read whose domain it accepts, rather than restating it", () => {
    const arming = describeAll(allParams()).find((d) => d.capability === "arming")!;
    const setMode = arming.actions.find((a) => a.name === "setMode")!;
    expect(setMode.reflects).toBe("mode");
    expect(arming.reads.find((r) => r.accessor === setMode.reflects)!.values).toEqual([0, 1, 2, 3, 4, 5, 6, 47, 63]);
    expect(setMode.args![0].values).toBeUndefined();
  });

  /** An action taking nothing SAYS so, so a caller can offer it as a plain button. */
  it("states an empty argument list for an action that takes none", () => {
    const lock = describeAll(allParams()).find((d) => d.capability === "lock")!;
    expect(lock.actions.find((a) => a.name === "lock")!.args).toEqual([]);
  });

  it("describes a provider-gated method only on a device bound to that provider", () => {
    const withoutMedia = describeAll(allParams()).find((d) => d.capability === "camera")!;
    const withMedia = describeAll(allParams(), {
      snapshotStored: async () => Buffer.alloc(0),
    } as MediaProvider).find((d) => d.capability === "camera")!;
    const named = (d: typeof withMedia): string[] => [...d.actions.map((a) => a.name), ...d.undescribedActions];
    expect(named(withoutMedia)).not.toContain("snapshotStored");
    expect(named(withMedia)).toContain("snapshotStored");
  });
});

describe("Device.describe — the manifest a caller renders from", () => {
  // A battery camera, since the record reports a level and the spec below asserts the `level` read
  // installs. `T8410` is mains-only (see MAINS_CAMERA_MODELS), so that assertion was only true because
  // the bind context carried no model for the gate to read.
  const record = { deviceType: 30, model: "T8114", category: "eufy_security", params: { 1101: "88", 1102: "1" } };
  const bound = (): Device => {
    const dev = Device.fromRecord("T8000P0000000000", record);
    dev.bindActions(ctxWith(new Set([1101, 1102]), record.model), sink);
    return dev;
  };

  it("says a device is unbound rather than describing it as exposing nothing", () => {
    const dev = Device.fromRecord("T8000P0000000000", record);
    const m = dev.describe();
    expect(m.bound).toBe(false);
    expect(m.details).toEqual([]);
    expect(m.capabilities).toEqual(dev.capabilities);
    expect(m).toMatchObject({ sn: "T8000P0000000000", codec: "camera", source: "model" });
  });

  it("describes what the device installed once it is bound", () => {
    const m = bound().describe();
    expect(m.bound).toBe(true);
    const battery = m.details.find((d) => d.capability === "battery")!;
    expect(battery.reads.map((r) => r.accessor)).toContain("level");
  });

  it("carries shape only — no observed value reaches the manifest", () => {
    const dev = bound();
    const leaked: string[] = [];
    const walk = (v: unknown, path: string): void => {
      if (!v || typeof v !== "object") return;
      for (const [k, child] of Object.entries(v)) {
        if (k === "value" || k === "ts") leaked.push(`${path}.${k}`);
        walk(child, `${path}.${k}`);
      }
    };
    walk(dev.describe(), "manifest");
    expect(leaked).toEqual([]);
    expect(JSON.stringify(dev.describe())).not.toContain("88");
  });

  /**
   * A getter that throws is the only unfalsifiable proof: a `decode` read calls into the injected codec,
   * so spreading or stringifying a bound object here would reach the transport through it.
   */
  it("invokes no getter while describing", () => {
    const battery = {};
    Object.defineProperty(battery, "level", {
      get: () => {
        throw new Error("getter invoked");
      },
      enumerable: true,
      configurable: true,
    });
    const described = describeCapabilities({ battery } as never);
    expect(described.find((d) => d.capability === "battery")!.reads.map((r) => r.accessor)).toEqual(["level"]);
  });

  it("survives the round-trip a host consumes it over", () => {
    const m = bound().describe();
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
  });

  it("describes every capability the device bound, and none it lacks", () => {
    const dev = bound();
    const m = dev.describe();
    const described = new Set<Capability>(m.details.map((d) => d.capability));
    for (const cap of described) expect(dev.has(cap)).toBe(true);
    expect(m.details.every((d) => (dev as unknown as Record<string, () => unknown>)[d.accessor]())).toBe(true);
  });
});

/**
 * A claimed event is described only where the evidence for it is.
 *
 * The AI-detection ids are shared verbatim across the camera families, so the id table alone reports
 * every camera as classifying vehicles and dogs. A claim narrows the DESCRIPTION to the units with
 * evidence; what the dispatch index decodes is deliberately untouched, which the decode specs hold.
 */
describe("describeCapabilities — events claimed on evidence", () => {
  const motionEvents = (params: number[], extra: Partial<CommandContext> = {}): readonly string[] =>
    describeCapabilities(
      buildActions(["motion"], {
        ctx: { ...ctxWith(new Set(params)), ...extra },
        sink,
        read: () => undefined,
      }),
      { codec: "camera", capabilities: new Set<Capability>(["motion"]), ...extra },
    ).find((entry) => entry.capability === "motion")!.events;

  const AI_DETECT_TYPE = 1298;
  const PIR = 1011;

  it("claims a vehicle only where the device reports the bitmask that has a vehicle bit", () => {
    expect(motionEvents([PIR, AI_DETECT_TYPE])).toContain("vehicleDetected");
    expect(motionEvents([PIR])).not.toContain("vehicleDetected");
  });

  it("claims a dog only for a device that hangs off a station", () => {
    expect(motionEvents([PIR], { homeBaseAttached: true })).toContain("dogDetected");
    expect(motionEvents([PIR], { homeBaseAttached: false })).not.toContain("dogDetected");
  });

  /**
   * Narrowing on a fact the context does not carry would withdraw the event from every caller that
   * describes a device without resolving its parent — so an absent topology withdraws nothing.
   */
  it("withdraws nothing for a device whose topology is not stated", () => {
    expect(motionEvents([PIR])).toContain("dogDetected");
  });

  /** Unclaimed rows are the common case and must not be touched by the claim resolution. */
  it("leaves an unclaimed detection on every device that binds the capability", () => {
    for (const events of [motionEvents([PIR]), motionEvents([PIR, AI_DETECT_TYPE], { homeBaseAttached: true })]) {
      expect(events).toEqual(expect.arrayContaining(["motion", "petDetection", "soundDetected", "cryingDetected"]));
    }
  });

  /**
   * A standalone motion sensor binds this capability — it IS motion detection by device type — and
   * reports no AI classification at all. Its own motion id is not claimed, so it keeps that.
   */
  it("claims no AI classification for a device outside the camera families", () => {
    const sensor = motionEvents([PIR], { codec: "sensor", homeBaseAttached: true });
    expect(sensor).toEqual(["motion"]);
  });
});

/** A command never leaves the manifest path — describing a device is a read of its shape. */
describe("describing a device sends nothing", () => {
  it("dispatches no command", () => {
    const sent: Command[] = [];
    const dev = Device.fromRecord("T8000P0000000000", { deviceType: 30, model: "T8114", params: { 1101: "88" } });
    dev.bindActions(ctxWith(allParams(), "T8114"), { dispatch: async (c) => void sent.push(c) });
    dev.describe();
    expect(sent).toEqual([]);
  });
});
