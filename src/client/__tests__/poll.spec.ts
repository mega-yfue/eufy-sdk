import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { Device } from "../../model/device.js";
import type { ParamChange } from "../device-registry.js";

/**
 * The cloud-param poll loop — the producer behind the capabilities' `source:"poll"` event mappings.
 *
 * Driven through the facade end-to-end, because the decode half is covered separately
 * (`capabilities/__tests__/decode-event.spec.ts` asserts param 1550 → `contactState`, and that 1101 maps
 * to nothing now that the battery level is announced generically) and both halves passing in isolation
 * says nothing about a signal actually reaching a listener. A changed param must come out as an event.
 * Also pins the loop's lifecycle: self-rescheduling, surviving a failed pass, and stopping on disconnect.
 */
function makeClient(opts: Record<string, unknown> = {}) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", ...opts });
  Object.defineProperty((eufy as any).mega, "auth", {
    configurable: true,
    get: () => ({ userId: "u", authToken: "t" }),
  });
  vi.spyOn(eufy as any, "startPush").mockResolvedValue(undefined);
  vi.spyOn(eufy as any, "warmWiredP2P").mockResolvedValue({ required: 0, ready: 0, failed: 0, pending: 0 });
  vi.spyOn(eufy, "getMqttDevices").mockReturnValue([]);
  vi.spyOn(eufy, "getDevices").mockResolvedValue([]);
  vi.spyOn((eufy as any).registry, "list").mockReturnValue([{ sn: "a" }]);
  return eufy;
}

const paramChange = (paramType: number, from: string, to: string): ParamChange => ({
  deviceSn: "T8000P0000000000",
  paramType,
  from,
  to,
  params: { [paramType]: to },
});

/** BATTERY_PARAM.BATTERY changing from a known level. */
const batteryChange = (to: string): ParamChange => paramChange(1101, "88", to);

/**
 * A live entry sensor a caller is holding, resolved from a record that reports the contact param — so
 * the `contact` capability is granted and `contact` is a schema property with a typed getter.
 */
function liveContactSensor(eufy: EufyMega, sn = "T8000P0000000000"): Device {
  const record = { model: "T8900", category: "eufy_security", params: { 1550: "0" }, paramUpdatedAt: {} };
  const dev = Device.fromRecord(sn, record);
  vi.spyOn((eufy as any).registry, "record").mockResolvedValue(record);
  (eufy as any).liveDevices.set(sn, new WeakRef(dev));
  return dev;
}

/**
 * A live battery camera a caller is holding, reporting the three members #95 names as announced by
 * nothing: its enablement (1035), its status LED (1045) and its night-vision mode (1277).
 */
function liveCamera(eufy: EufyMega, sn = "T8000P0000000000"): Device {
  const record = {
    deviceType: 9,
    // A battery camera, because the fixture reports a battery level (1101) and is described as one.
    model: "T8114",
    params: { 1101: "88", 1035: "0", 1045: "1", 1277: "1" },
    paramUpdatedAt: {},
  };
  const dev = Device.fromRecord(sn, record);
  vi.spyOn((eufy as any).registry, "record").mockResolvedValue(record);
  (eufy as any).liveDevices.set(sn, new WeakRef(dev));
  return dev;
}

describe("cloud-param poll loop", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("announces a changed property with the value its getter now answers", async () => {
    const eufy = makeClient();
    const dev = liveContactSensor(eufy);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [paramChange(1550, "0", "1")],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: any[] = [];
    eufy.on("propertyChanged", (e) => seen.push(e));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([{ deviceSn: "T8000P0000000000", property: "contact", value: true }]);
    expect(dev.getProperty("contact")?.value).toBe(true);
  });

  /**
   * The poll's fresh values must reach the live `Device`, not only the registry's record.
   *
   * Nothing else on this path catches the device up: the read-through freshness policy fires on a READ
   * of a stale value and hands that read the stale one, so a value nothing happened to read stayed
   * behind for as long as nobody asked — measured at 11 minutes across poll boundaries.
   */
  it("lands the poll's fresh params on a Device a caller is holding", async () => {
    const eufy = makeClient();
    const dev = liveContactSensor(eufy);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [paramChange(1550, "0", "1")],
      added: [],
      removed: [],
      reported: [],
    });
    expect(dev.getProperty("contact")?.value).toBe(false);

    await (eufy as any).pollOnce();

    expect(dev.getProperty("contact")?.value).toBe(true);
  });

  /**
   * The disagreement the announcement exists to avoid: a host told "it changed" reads the getter and
   * concludes nothing did. So the params land BEFORE any event derived from them is emitted.
   */
  it("a listener reading inside a poll event handler sees the post-poll value", async () => {
    const eufy = makeClient();
    const dev = liveContactSensor(eufy);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [paramChange(1550, "0", "1")],
      added: [],
      removed: [],
      reported: [],
    });
    const readInHandler: unknown[] = [];
    eufy.on("contactState", () => readInHandler.push(dev.getProperty("contact")?.value));

    await (eufy as any).pollOnce();

    expect(readInHandler).toEqual([true]);
  });

  /** One application per device, however many of its params the pass saw move. */
  it("applies a device's params once for a pass that saw several of them move", async () => {
    const eufy = makeClient();
    const dev = liveContactSensor(eufy);
    const applyParams = vi.spyOn(dev, "applyParams");
    // `pollChanges` hands every change of one device the same post-change map — see `ParamChange.params`.
    const params = { 1550: "1", 1141: "-64" };
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [
        { deviceSn: "T8000P0000000000", paramType: 1550, from: "0", to: "1", params },
        { deviceSn: "T8000P0000000000", paramType: 1141, from: "-70", to: "-64", params },
      ],
      added: [],
      removed: [],
      reported: [],
    });

    await (eufy as any).pollOnce();

    expect(applyParams).toHaveBeenCalledExactlyOnceWith(params);
    expect(dev.getProperty("rssi")?.value).toBe(-64);
  });

  /**
   * The poll applies the CHANGES it saw, never the whole cloud snapshot.
   *
   * A realtime report lands in the registry's `dpParams`, which is deliberately kept apart from the
   * cloud record's `params` — so the cloud list still carries the pre-report value for that id long
   * after the device volunteered the new one. Applying the whole snapshot would revert live state to it
   * and announce the revert as a change, which is how an open door comes to read as closed.
   */
  it("does not revert a value a realtime report made fresher", async () => {
    const eufy = makeClient();
    const dev = liveContactSensor(eufy);
    vi.spyOn((eufy as any).registry, "applyRealtimeParams").mockImplementation(() => {});
    (eufy as any).applyRealtimeState("T8000P0000000000", { 1550: "1" });
    expect(dev.getProperty("contact")?.value).toBe(true);
    const seen: any[] = [];
    eufy.on("propertyChanged", (e) => seen.push(e));
    // The cloud list still says closed, and an unrelated param on the same device moved.
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [
        { deviceSn: "T8000P0000000000", paramType: 1141, from: "-70", to: "-64", params: { 1550: "0", 1141: "-64" } },
      ],
      added: [],
      removed: [],
      reported: [],
    });

    await (eufy as any).pollOnce();

    expect(dev.getProperty("contact")?.value).toBe(true);
    expect(seen).toEqual([{ deviceSn: "T8000P0000000000", property: "rssi", value: -64 }]);
  });

  /**
   * A poll change must be decoded against the changed device's capabilities, exactly as a push is.
   *
   * Without them `resolveHits` cannot disambiguate a param id claimed by more than one capability, so a
   * contested id resolves to nothing and a poll event declared on it is silently never emitted. The
   * resolution itself is pinned in `capabilities/__tests__/decode-event.spec.ts`; what is asserted here
   * is that the argument reaches the decode at all, which is the whole of the defect — no shipped id is
   * contested today, so nothing else about this call is observable from the outside.
   */
  it("decodes a poll change against the changed device's capabilities", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [batteryChange("81")],
      added: [],
      removed: [],
      reported: [],
    });
    const caps = vi.spyOn((eufy as any).registry, "capabilitiesForDevice").mockReturnValue(new Set(["battery"]));

    await (eufy as any).pollOnce();

    expect(caps).toHaveBeenCalledWith("T8000P0000000000");
  });

  /**
   * Camera enablement is the state #47 asked for and #95 generalised: it only ever arrives as a cloud
   * param, so re-reading was the only way to learn of a change and re-reading cannot say WHEN. Both wire
   * ids carry it under opposite polarity — 1035 is a disable bit, 2001 reports it directly — and the
   * announcement carries the value the getter reads, so the polarity is applied once, where the member
   * declares it, and there is no second copy to disagree with.
   */
  it("announces a camera enablement change, in the polarity the reporting id uses", async () => {
    const eufy = makeClient();
    const dev = liveCamera(eufy);
    const pollChanges = vi.spyOn((eufy as any).registry, "pollChanges");
    const seen: any[] = [];
    eufy.on("propertyChanged", (e) => seen.push(e));

    pollChanges.mockResolvedValue({ params: [paramChange(1035, "0", "1")], added: [], removed: [], reported: [] });
    await (eufy as any).pollOnce();
    pollChanges.mockResolvedValue({
      params: [paramChange(2001, "false", "true")],
      added: [],
      removed: [],
      reported: [],
    });
    await (eufy as any).pollOnce();

    expect(seen).toEqual([
      { deviceSn: "T8000P0000000000", property: "enabled", value: false },
      { deviceSn: "T8000P0000000000", property: "enabled", value: true },
    ]);
    expect(dev.getProperty("enabled")?.value).toBe(true);
  });

  /**
   * The whole point of the generic announcement: a camera's status LED and night vision, a floodlight's
   * brightness and a device's speaker volume are cloud params with reads that no push carries and no
   * capability declared an event for. Nothing had to be added per member for these to arrive.
   */
  it("announces the members that had no event of their own", async () => {
    const eufy = makeClient();
    liveCamera(eufy);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [
        { deviceSn: "T8000P0000000000", paramType: 1045, from: "1", to: "0", params: { 1045: "0", 1277: "2" } },
        { deviceSn: "T8000P0000000000", paramType: 1277, from: "1", to: "2", params: { 1045: "0", 1277: "2" } },
      ],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: any[] = [];
    eufy.on("propertyChanged", (e) => seen.push(e));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([
      { deviceSn: "T8000P0000000000", property: "statusLed", value: false },
      { deviceSn: "T8000P0000000000", property: "nightVision", value: 2 },
    ]);
  });

  /**
   * A property change is a device event like any other, so it reaches the catch-all beside the named
   * listener — a host fanning everything onto a bus gets it without a per-name subscription.
   */
  it("reaches the catch-all listener tagged with its event name", async () => {
    const eufy = makeClient();
    liveCamera(eufy);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [paramChange(1045, "1", "0")],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: any[] = [];
    eufy.on("event", (e) => seen.push(e));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([
      { eventName: "propertyChanged", deviceSn: "T8000P0000000000", property: "statusLed", value: false },
    ]);
  });

  /**
   * `contactState` keeps its name and now overlaps the generic announcement on the poll path — twice for
   * one movement, idempotently. It is not reducible to a property change: it is the same physical state
   * arriving on three transports with edge-triggered dedupe across them, and the FCM push path applies no
   * param at all, so retiring it would make a door-open push announce nothing.
   */
  it("announces a contact movement both semantically and as a property change", async () => {
    const eufy = makeClient();
    liveContactSensor(eufy);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [paramChange(1550, "0", "1")],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: string[] = [];
    eufy.on("event", (e) => seen.push(e.eventName));

    await (eufy as any).pollOnce();

    expect(seen).toEqual(["propertyChanged", "contactState"]);
  });

  /**
   * The value can only come from a device's own live state, so a serial no caller ever asked for has
   * none to read and nothing is announced for it. `deviceState` still reports its liveness.
   */
  it("announces nothing for a device no caller is holding", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [paramChange(1550, "0", "1")],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: any[] = [];
    eufy.on("propertyChanged", (e) => seen.push(e));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([]);
  });

  /**
   * A poll pass re-resolves the devices a caller is holding, and that path only ever ADDS — so it must
   * hand the resolver the whole record. An attached camera is granted guard mode by its curated model
   * row and withheld it again for hanging off a hub; re-resolving from a record that lost the topology
   * would hand it straight back, one param change after the caller got a device that correctly lacked it.
   */
  it("a poll pass does not hand an attached camera back the hub's guard mode", async () => {
    const eufy = makeClient();
    const record = {
      model: "T8170",
      category: "eufy_security",
      deviceType: 48,
      parentSn: "T8030P0000000000",
      params: { 1224: "1" },
      paramUpdatedAt: {},
    };
    vi.spyOn((eufy as any).registry, "record").mockResolvedValue(record);
    const dev = Device.fromRecord("T8000P0000000000", record);
    expect(dev.has("arming")).toBe(false);
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(dev));
    const gained: unknown[] = [];
    eufy.on("deviceCapabilities", (e) => gained.push(e));

    await (eufy as any).widenCapabilities("T8000P0000000000");

    expect(dev.has("arming")).toBe(false);
    expect(gained).toEqual([]);
  });

  it("emits nothing when no param changed", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: unknown[] = [];
    eufy.on("event", (e) => seen.push(e));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([]);
  });

  it("completes an unchanged poll without inventing a device report", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
      complete: true,
    });
    const completed = vi.fn();
    const reported = vi.fn();
    eufy.on("pollCompleted", completed);
    eufy.on("deviceState", reported);

    await (eufy as any).pollOnce();

    expect(completed).toHaveBeenCalledExactlyOnceWith();
    expect(reported).not.toHaveBeenCalled();
  });

  it("completes after changed properties have been applied", async () => {
    const eufy = makeClient();
    const dev = liveContactSensor(eufy);
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [paramChange(1550, "0", "1")],
      added: [],
      removed: [],
      reported: [],
      complete: true,
    });
    const seen: unknown[] = [];
    eufy.on("pollCompleted", () => seen.push(dev.getProperty("contact")?.value));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([true]);
  });

  it("re-arms after each run, so the loop keeps polling", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("survives a failing poll — reports it and keeps the loop alive", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const boom = new Error("cloud down");
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockRejectedValueOnce(boom)
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });
    const errors: unknown[] = [];
    eufy.on("error", (e) => errors.push(e));

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toContain(boom); // surfaced, not thrown

    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2); // a transient failure must not kill the loop
  });

  it("pollMs:0 disables the loop entirely", async () => {
    const eufy = makeClient({ pollMs: 0 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(poll).not.toHaveBeenCalled();
  });

  it("disconnect stops the loop (no polling after teardown)", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);

    await eufy.disconnect();
    await vi.advanceTimersByTimeAsync(60 * 1000);

    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("auto-realtime starts the loop", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    await (eufy as any).ensureRealtime();
    await vi.advanceTimersByTimeAsync(1000);

    expect(poll).toHaveBeenCalledTimes(1);
  });
});

describe("setPollInterval (runtime poll-interval change)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("reports the configured interval, and the default when unset", () => {
    expect(makeClient({ pollMs: 1234 }).pollIntervalMs).toBe(1234);
    expect(makeClient().pollIntervalMs).toBe(600_000); // DEFAULT_POLL_MS
  });

  it("updates the effective interval", () => {
    const eufy = makeClient({ pollMs: 1000 });
    eufy.setPollInterval(5000);
    expect(eufy.pollIntervalMs).toBe(5000);
  });

  it("re-arms a running loop at the new interval immediately", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1); // old 1s cadence

    eufy.setPollInterval(5000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1); // the old 1s tick no longer fires
    await vi.advanceTimersByTimeAsync(4000);
    expect(poll).toHaveBeenCalledTimes(2); // fires at the new 5s cadence
  });

  it("setPollInterval(0) stops a running loop", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const poll = vi
      .spyOn((eufy as any).registry, "pollChanges")
      .mockResolvedValue({ params: [], added: [], removed: [], reported: [] });

    (eufy as any).schedulePoll();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(1);

    eufy.setPollInterval(0);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(poll).toHaveBeenCalledTimes(1); // disabled — no further polls
  });
});

describe("device hot-plug events", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  const dev = (sn: string) => ({ sn, realtime: "p2p" }) as never;

  it("emits deviceAdded / deviceRemoved from the poll diff", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [dev("NEW")],
      removed: [dev("GONE")],
      reported: [],
    });
    const added: string[] = [];
    const removed: string[] = [];
    eufy.on("deviceAdded", (d) => added.push(d.sn));
    eufy.on("deviceRemoved", (d) => removed.push(d.sn));

    await (eufy as any).pollOnce();

    expect(added).toEqual(["NEW"]);
    expect(removed).toEqual(["GONE"]);
  });

  it("emits nothing when the roster is unchanged", async () => {
    const eufy = makeClient();
    vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
    });
    const seen: string[] = [];
    eufy.on("deviceAdded", (d) => seen.push(d.sn));
    eufy.on("deviceRemoved", (d) => seen.push(d.sn));

    await (eufy as any).pollOnce();

    expect(seen).toEqual([]);
  });
});

/**
 * Shutdown vs the fire-and-forget realtime bring-up.
 *
 * `login()` starts the channels without awaiting them, so a bring-up can finish long after the caller
 * moved on. A finished bring-up is installed only while it is still the current one: otherwise the
 * channels it built are closed on the spot, never installed and never left holding a socket.
 *
 * The bring-up therefore ASSEMBLES rather than installs — a stale one must not tear down the channels
 * a later login legitimately brought up, so the ownership check lives at the single install site.
 */
describe("disconnect during startup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  /** A push client stand-in whose only observable behaviour is whether it got closed. */
  const gatedPush = (eufy: EufyMega) => {
    const client = { close: vi.fn(), setPersistentIds: vi.fn(), on: vi.fn(), connect: vi.fn() };
    let release!: () => void;
    vi.spyOn(eufy as any, "startPush").mockReturnValue(new Promise((r) => (release = () => r(client))));
    return { client, release: () => release() };
  };

  it("closes the channels a slow bring-up opened after teardown had run", async () => {
    const eufy = makeClient();
    const push = gatedPush(eufy);

    const starting = (eufy as any).ensureRealtime();
    await eufy.disconnect();
    push.release();
    await starting;

    await vi.waitFor(() => expect(push.client.close).toHaveBeenCalled());
    expect((eufy as any).pushClient).toBeUndefined(); // never installed
  });

  /**
   * The case a single "closing" flag cannot express: `login()` clears it, so the stale bring-up would
   * finish, see nothing amiss, and overwrite the live channel — stranding the socket it was meant to
   * release and leaving the session with none.
   */
  it("does not clobber the channels a later login brought up", async () => {
    const eufy = makeClient();
    const stale = gatedPush(eufy);

    const starting = (eufy as any).ensureRealtime();
    await eufy.disconnect();

    const fresh = gatedPush(eufy); // the second login's bring-up wins the install
    const restarting = (eufy as any).ensureRealtime();
    fresh.release();
    await restarting;
    stale.release();
    await starting;

    expect((eufy as any).pushClient).toBe(fresh.client);
    expect(fresh.client.close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(stale.client.close).toHaveBeenCalled());
  });

  it("does not arm the poll loop when the bring-up finishes after a disconnect", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    const push = gatedPush(eufy);
    const poll = vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
    });

    const starting = (eufy as any).ensureRealtime();
    await eufy.disconnect();
    push.release();
    await starting;

    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).not.toHaveBeenCalled();
  });

  it("a later login brings realtime back up", async () => {
    const eufy = makeClient({ pollMs: 1000 });
    vi.spyOn((eufy as any).mega, "login").mockResolvedValue({
      status: "ok",
      session: { userId: "user-a", authToken: "token", raw: {} },
    });
    const poll = vi.spyOn((eufy as any).registry, "pollChanges").mockResolvedValue({
      params: [],
      added: [],
      removed: [],
      reported: [],
    });
    await eufy.disconnect();

    await eufy.login();
    await vi.advanceTimersByTimeAsync(1000);

    expect(poll).toHaveBeenCalled();
  });
});

/**
 * The poll baseline must be a snapshot of VALUES, not of the records the registry hands out.
 *
 * `this.devices` holds the same objects, so anything that updates one in place rewrites the baseline before
 * the next pass can diff against it. `applyRealtimeParams` does exactly that to `lastSeenMs` — a station's
 * report stamps the record the baseline is holding — so a device that reports over realtime loses the poll's
 * liveness signal. The param half is guarded against the same mutation, which no current path performs.
 */
describe("poll baseline isolation", () => {
  beforeEach(() => vi.restoreAllMocks());

  /** A registry with one device whose params a test can mutate the way the realtime path does. */
  async function registryWithDevice() {
    const { DeviceRegistry } = await import("../device-registry.js");
    const device: any = { sn: "T8000P0000000000", params: { 2001: "false" }, lastSeenMs: 1 };
    const registry = new DeviceRegistry({ mega: {} as never, onError: () => {} });
    vi.spyOn(registry, "getDevices").mockImplementation(async () => [device]);
    return { registry, device };
  }

  it("reports a change written into the record after the baseline was taken", async () => {
    const { registry, device } = await registryWithDevice();
    await registry.pollChanges(); // baseline

    device.params = { ...device.params, 2001: "true" }; // the station volunteers the new value
    const diff = await registry.pollChanges();

    expect(diff.params).toEqual([
      { deviceSn: "T8000P0000000000", paramType: 2001, from: "false", to: "true", params: { 2001: "true" } },
    ]);
  });

  /** The half that bites today: a realtime report stamps `lastSeenMs` on the record the baseline holds. */
  it("reports a device as re-reported after its record was updated in place", async () => {
    const { registry, device } = await registryWithDevice();
    await registry.pollChanges();

    device.lastSeenMs = 2;
    const diff = await registry.pollChanges();

    expect(diff.reported.map((d) => d.sn)).toEqual(["T8000P0000000000"]);
  });

  /** An unchanged pass still reports nothing, so the isolation cannot fake a change. */
  it("stays silent when nothing moved", async () => {
    const { registry } = await registryWithDevice();
    await registry.pollChanges();

    const diff = await registry.pollChanges();

    expect(diff.params).toEqual([]);
    expect(diff.reported).toEqual([]);
  });
});
