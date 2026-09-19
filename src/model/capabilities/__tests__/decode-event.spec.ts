import { decodeEvent, CAPABILITY_MODULES, buildEventIndex, resolveHits } from "../index.js";
import type { CapabilityModule, InboundSignal } from "../types.js";
import type { Capability } from "../../types.js";

/** Barrel decodeEvent: the declarative index dispatch across all modules + escape-hatch path. */
describe("decodeEvent — unified inbound dispatch", () => {
  describe("push source (declarative index)", () => {
    const push = (eventType: number, extra: Partial<Extract<InboundSignal, { source: "push" }>> = {}) =>
      decodeEvent({ source: "push", eventType, deviceSn: "D1", payload: {}, ...extra });

    it("motion push (3101) → motion", () => {
      expect(push(3101)).toEqual([
        { event: "motion", payload: expect.objectContaining({ deviceSn: "D1", eventType: 3101 }) },
      ]);
    });

    it("doorbell press (3103) → doorbellPress", () => {
      expect(push(3103)[0]).toMatchObject({ event: "doorbellPress" });
    });

    it("face (3102) → personDetected", () => {
      expect(push(3102)[0]).toMatchObject({ event: "personDetected" });
    });

    it("lock events resolve via a RANGE (257 and 771 both → lockState)", () => {
      expect(push(257)[0]).toMatchObject({ event: "lockState" });
      expect(push(771)[0]).toMatchObject({ event: "lockState" });
      expect(push(256)).toEqual([]); // just below the range
      expect(push(772)).toEqual([]); // just above
    });

    it("carries the thumbnail through", () => {
      expect(push(3101, { thumbnailUrl: "http://x/y.jpg" })[0].payload).toMatchObject({
        thumbnailUrl: "http://x/y.jpg",
      });
    });

    it("CusPushEvent sensor pushes map too: PIR motion (14) → motion, door (3) → contactState", () => {
      expect(push(14)[0]).toMatchObject({ event: "motion" });
      expect(push(3)[0]).toMatchObject({ event: "contactState" });
    });

    it("battery threshold pushes → batteryAlert with a discriminating state", () => {
      expect(push(6)[0]).toMatchObject({ event: "batteryAlert", payload: { state: "low" } });
      expect(push(7)[0]).toMatchObject({ event: "batteryAlert", payload: { state: "hot" } });
      expect(push(11)[0]).toMatchObject({ event: "batteryAlert", payload: { state: "full" } });
    });

    it("an unmapped eventType → no events", () => {
      expect(push(9999)).toEqual([]);
    });
  });

  describe("poll source (declarative index)", () => {
    it("contact param (1550) change → contactState", () => {
      const ev = decodeEvent({ source: "poll", deviceSn: "D2", paramType: 1550, from: "0", to: "1", params: {} });
      expect(ev).toEqual([
        { event: "contactState", payload: { deviceSn: "D2", paramType: 1550, from: "0", to: "1", open: true } },
      ]);
    });

    /**
     * The battery level has no poll event of its own, and must not get one back: "param 1101 moved" is
     * exactly what the generic `propertyChanged` announcement says, and it carries the coerced 0-100
     * number where a mapped event's payload carried the raw `from`/`to` strings. A semantic event earns
     * its name by carrying something a bare property change cannot.
     */
    it("battery param (1101) change → nothing (the level is announced generically)", () => {
      expect(decodeEvent({ source: "poll", deviceSn: "D2", paramType: 1101, to: "80", params: {} })).toEqual([]);
    });

    it("an unmapped param → no events", () => {
      expect(decodeEvent({ source: "poll", deviceSn: "D2", paramType: 9999, params: {} })).toEqual([]);
    });
  });

  describe("p2p-frame source (escape hatch — ptz)", () => {
    const rotateFrame = {
      source: "p2p-frame",
      stationSn: "S1",
      commandId: 1351,
      channel: 0,
      json: { cmd: 6030 },
    } as const;

    it("a 1351 rotate frame → ptzNotify", () => {
      expect(decodeEvent(rotateFrame)[0]).toMatchObject({
        event: "ptzNotify",
        payload: { stationSn: "S1", kind: "rotate" },
      });
    });

    it("gates on device capabilities: a device WITHOUT ptz gets no ptzNotify", () => {
      expect(decodeEvent(rotateFrame, new Set(["camera"]))).toEqual([]);
    });

    it("gates on device capabilities: a device WITH ptz still decodes", () => {
      expect(decodeEvent(rotateFrame, new Set(["ptz"]))[0]).toMatchObject({ event: "ptzNotify" });
    });
  });

  describe("mqtt source", () => {
    it("no module maps mqtt yet → no events (foundation only)", () => {
      expect(decodeEvent({ source: "mqtt", deviceSn: "V1", topic: "t", raw: {} })).toEqual([]);
    });
  });
});

/**
 * Shared push/poll ids resolved by capability.
 *
 * Push ids are namespaced per device family, not globally: `SmartDropPushEvent.TAMPERED_WARNING` and
 * `CusPushEvent.ALARM` are both 10, and SmartDrop's battery ids 6/7/11 are `CusPushEvent`'s
 * BATTERY_LOW/HOT/FULL. A single-entry index would let whichever module registered last win for every
 * device, so the id must resolve against the target device's capabilities.
 */
describe("decodeEvent — ids shared across device families", () => {
  const push = (eventType: number, caps?: Capability[]) =>
    decodeEvent({ source: "push", eventType, deviceSn: "D1", payload: {} }, caps ? new Set(caps) : undefined);

  it("emits a single-claimant id with or without capability context", () => {
    expect(push(3101)[0]).toMatchObject({ event: "motion" });
    expect(push(3101, ["motion"])[0]).toMatchObject({ event: "motion" });
  });

  /**
   * Capabilities disambiguate a contested id; they are not an allow-list. Capability detection is
   * evidence-based and can under-report, so gating every push on it would silently drop real events.
   */
  it("does NOT gate an uncontested id on capabilities", () => {
    expect(push(3101, ["lock"])[0]).toMatchObject({ event: "motion" });
  });

  it("keeps the battery reading of a shared id for a battery device", () => {
    expect(push(6, ["battery"])[0]).toMatchObject({ event: "batteryAlert", payload: { state: "low" } });
  });

  /**
   * A mapping's static payload is the discriminator — for the alarm rows, the only thing separating a
   * fired alarm from a countdown. Push bodies carry short generic keys straight off the wire, so the
   * raw body must never overwrite it.
   */
  it("does not let the raw push body overwrite a mapping's discriminator", () => {
    const [ev] = decodeEvent(
      { source: "push", eventType: 6, deviceSn: "D1", payload: { state: "wire-wins" } },
      new Set<Capability>(["battery"]),
    );

    expect(ev.payload).toMatchObject({ state: "low" });
  });
});

/**
 * The contested-id paths, driven from synthetic modules.
 *
 * Nothing in the shipped tree claims an id twice yet (the next describe pins that), so these are the
 * only specs that exercise the resolution at all — without them the index could go back to one entry
 * per id and every test would stay green.
 */
describe("event index — resolution when two families claim one id", () => {
  const mod = (capability: Capability, emit: string): CapabilityModule =>
    ({ capability, properties: [], events: [{ source: "push", match: 4242, emit }] }) as unknown as CapabilityModule;

  const contested = buildEventIndex([mod("battery", "batteryAlert"), mod("lock", "lockState")]);
  const hits = contested.push.exact.get(4242) ?? [];

  it("keeps both claimants rather than letting the last registration win", () => {
    expect(hits.map((h) => h.emit).sort()).toEqual(["batteryAlert", "lockState"]);
  });

  it("picks the claimant the device's capabilities match", () => {
    expect(resolveHits(hits, new Set<Capability>(["lock"])).map((h) => h.emit)).toEqual(["lockState"]);
  });

  it("emits nothing when the device matches neither claimant", () => {
    expect(resolveHits(hits, new Set<Capability>(["motion"]))).toEqual([]);
  });

  /** Naming the wrong event — a tamper reported as a battery alert — is worse than staying silent. */
  it("emits nothing rather than guessing when the device family is unknown", () => {
    expect(resolveHits(hits, undefined)).toEqual([]);
  });
});

/**
 * The event vocabulary, locked.
 *
 * A capability announces its events two ways — the declarative id table, and `emits` for the ones its
 * own decoder produces from a frame no id can name — and the manifest publishes the union. The typed
 * event map that would otherwise keep this honest is a TYPE and erases at build, so a runtime list is
 * the only thing that catches an event added to a module and never announced (invisible to a caller
 * reading a manifest) or announced and never emitted (a caller subscribing to silence).
 */
describe("the announced event vocabulary", () => {
  it("is exactly this set", () => {
    const announced = new Set(
      Object.values(CAPABILITY_MODULES).flatMap((m) => [...(m.events ?? []).map((e) => e.emit), ...(m.emits ?? [])]),
    );
    expect([...announced].sort()).toEqual(
      [
        "alarm",
        "armingModeChanged",
        "batteryAlert",
        "contactState",
        "cryingDetected",
        "dogDetected",
        "doorbellPress",
        "lockState",
        "motion",
        "packageDelivered",
        "packageStranded",
        "packageTaken",
        "personDetected",
        "petDetection",
        "ptzNotify",
        "smartLightState",
        "soundDetected",
        "strangerDetected",
        "vehicleDetected",
      ].sort(),
    );
  });

  /** `emits` is for what the id table CANNOT express; a name in both is one of them declared twice. */
  it("declares an id-table event in the table alone", () => {
    for (const m of Object.values(CAPABILITY_MODULES)) {
      const tabled = new Set((m.events ?? []).map((e) => e.emit));
      for (const name of m.emits ?? []) expect(tabled.has(name)).toBe(false);
    }
  });
});

/**
 * Visibility over which ids are contested.
 *
 * Adding an `events` row for an id another family already claims is legitimate — that is what the
 * per-capability resolution exists for — but it changes that id from "always emits" to "emits only
 * with capability context". This test states the current set so the effect is deliberate rather than
 * discovered later from a misreported event.
 */
describe("event index — contested ids", () => {
  it("lists every push/poll id claimed by more than one capability", () => {
    const claims = new Map<string, string[]>();
    for (const mod of Object.values(CAPABILITY_MODULES))
      for (const e of mod.events ?? []) {
        if (Array.isArray(e.match)) continue; // ranges are the coarse fallback, not exact claims
        const key = `${e.source}:${e.match}`;
        claims.set(key, [...(claims.get(key) ?? []), mod.capability]);
      }

    const contested = [...claims].filter(([, caps]) => caps.length > 1).map(([id, caps]) => `${id} ${caps.sort()}`);

    expect(contested.sort()).toEqual([]);
  });
});

/**
 * The expanded event surface.
 *
 * Detection kinds each get their own name rather than one event with a discriminator, matching how
 * hosts model them and how the existing pet/package events already behave.
 */
describe("decodeEvent — detection sub-events and station events", () => {
  const push = (eventType: number, caps?: Capability[]) =>
    decodeEvent({ source: "push", eventType, deviceSn: "D1", payload: {} }, caps ? new Set(caps) : undefined);

  it("splits the AI detections into distinct events", () => {
    expect(push(3104)[0]).toMatchObject({ event: "cryingDetected" });
    expect(push(3105)[0]).toMatchObject({ event: "soundDetected" });
    expect(push(3107)[0]).toMatchObject({ event: "vehicleDetected" });
    expect(push(3108)[0]).toMatchObject({ event: "dogDetected" });
  });

  /**
   * 3106 is declared identically in the doorbell, indoor and HB3-paired vocabularies, so it belongs to
   * the camera-wide capability rather than to the doorbell one. A camera with no doorbell has to
   * decode it, and a doorbell — which holds both capabilities — has to decode it once, not twice.
   */
  it("decodes a pet detection for every camera, and once for a device that is also a doorbell", () => {
    expect(push(3106)[0]).toMatchObject({ event: "petDetection" });
    expect(push(3106, ["motion"]).map((e) => e.event)).toEqual(["petDetection"]);
    expect(push(3106, ["motion", "doorbell"]).map((e) => e.event)).toEqual(["petDetection"]);
  });

  it("tags the dog sub-behaviours without inventing separate event names", () => {
    expect(push(3109)[0]).toMatchObject({ event: "dogDetected", payload: { kind: "lick" } });
    expect(push(3110)[0]).toMatchObject({ event: "dogDetected", payload: { kind: "poop" } });
  });

  /**
   * A recognised person and an explicitly unrecognised one mean opposite things to a host, so the
   * stranger id no longer folds into personDetected. This changes an existing event's meaning.
   */
  it("reports an unrecognised person separately from a known one", () => {
    expect(push(3102)[0]).toMatchObject({ event: "personDetected" });
    expect(push(3111)[0]).toMatchObject({ event: "personDetected" });
    expect(push(3112)[0]).toMatchObject({ event: "strangerDetected" });
  });

  it("reports a stranded package", () => {
    expect(push(3304)[0]).toMatchObject({ event: "packageStranded" });
  });

  it("reports a guard-mode change and the alarm lifecycle", () => {
    expect(push(9)[0]).toMatchObject({
      event: "armingModeChanged",
      refresh: { param: 1224, property: "armingMode", timeoutMs: 20_000 },
    });
    expect(push(10)[0]).toMatchObject({ event: "alarm", payload: { phase: "triggered" } });
    expect(push(16)[0]).toMatchObject({ event: "alarm", payload: { phase: "delayed" } });
  });
});

/**
 * Contact state normalised across its two sources.
 *
 * Push and poll carry the same fact under different raw keys — the push's opaque single-letter `e` and
 * the poll's 1550 param value — so a host reading one had no portable way to read the other. Both now
 * normalise to `open`. Polarity is the V6 app's `CusPushMode.isSensorOpen()`: exactly `"1"` is open,
 * anything else is closed.
 */
describe("contactState — open normalised across push and poll", () => {
  const push = (payload: Record<string, unknown>) =>
    decodeEvent({ source: "push", eventType: 3, deviceSn: "D1", payload })[0].payload;
  const poll = (to?: string) =>
    decodeEvent({ source: "poll", deviceSn: "D1", paramType: 1550, from: "x", to, params: {} })[0].payload;

  it('reads the push wire key: "1" is open, "0" is closed', () => {
    expect(push({ e: "1" })).toMatchObject({ open: true });
    expect(push({ e: "0" })).toMatchObject({ open: false });
  });

  it("treats any other push value as closed, as the app does", () => {
    expect(push({ e: "2" })).toMatchObject({ open: false });
  });

  it("reads the poll param the same way", () => {
    expect(poll("1")).toMatchObject({ open: true });
    expect(poll("0")).toMatchObject({ open: false });
  });

  /** `undefined` must mean "this signal said nothing", not "closed" — a host has to tell them apart. */
  it("omits open entirely when the signal carried no contact value", () => {
    expect(push({})).not.toHaveProperty("open");
    expect(push({ e: "" })).not.toHaveProperty("open");
    expect(poll(undefined)).not.toHaveProperty("open");
  });

  /** The derived field is authoritative over a raw body that happens to use the same key. */
  it("is not overwritten by a raw push field of the same name", () => {
    expect(push({ e: "1", open: "wire-wins" })).toMatchObject({ open: true });
  });
});
