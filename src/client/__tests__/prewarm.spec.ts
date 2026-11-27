import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { PushClient } from "../../transport/push/push-client.js";
import type { EufyDevice } from "../../core/types.js";
import { DeviceType } from "../../model/device-types.js";

/**
 * Speculative pre-warm is **opt-in**, and these specs pin why.
 *
 * Pre-warm opens a station's P2P session on an event nobody asked for, and a session heartbeats the
 * device it is open to. Wired stations are warmed at login and never idle-detach, and an attached
 * camera's session lives on its wired base — so the only station a pre-warm can actually open is a
 * standalone battery camera, the one device class the on-demand session lifecycle exists to let sleep.
 * A default that pre-warms therefore spends battery on every host that never asked for the feature,
 * which is why the event list starts empty and a caller opts in per event, and may further restrict
 * which power tiers it applies to.
 *
 * The policy is exercised through the private seam the push handler calls, with the registry seeded so
 * the station key and its power tier resolve through the real code rather than a stub.
 */
const BATTERY_LEVEL_PARAM = 1101;

const BASE_SN = "T8000P0000000000";
const CHILD_SN = "T8000P0000000001";
const SOLO_BATTERY_SN = "T8000P0000000002";
const SOLO_WIRED_SN = "T8000P0000000003";

/**
 * A wired base, a battery camera attached to it, a standalone battery camera, a standalone wired one.
 *
 * The model codes are the classifier's own vocabulary rather than decoration: `T8010` resolves to a
 * station and `T8x99` to a camera, so a record never claims a class its model contradicts. Battery is
 * evidenced the way the capability declares it — by reporting the level param — not by the model.
 */
function fleet(): EufyDevice[] {
  const common = { category: "eufy_security", api: "mega", realtime: "p2p", p2pDid: "XXXXXXX-000000-XXXXX" };
  return [
    { ...common, sn: BASE_SN, model: "T8010", deviceClass: "homebase", stationSn: BASE_SN },
    {
      ...common,
      sn: CHILD_SN,
      model: "T8199",
      deviceClass: "camera",
      stationSn: BASE_SN,
      params: { [BATTERY_LEVEL_PARAM]: "88" },
      raw: { parent_sn: BASE_SN },
    },
    {
      ...common,
      sn: SOLO_BATTERY_SN,
      model: "T8299",
      deviceClass: "camera",
      stationSn: SOLO_BATTERY_SN,
      params: { [BATTERY_LEVEL_PARAM]: "88" },
    },
    { ...common, sn: SOLO_WIRED_SN, model: "T8399", deviceClass: "camera", stationSn: SOLO_WIRED_SN },
  ] as unknown as EufyDevice[];
}

function makeClient(opts: Record<string, unknown> = {}, devices: EufyDevice[] = fleet()) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", ...opts });
  vi.spyOn((eufy as any).registry, "list").mockReturnValue(devices);
  const prewarm = vi.spyOn((eufy as any).p2p, "prewarm").mockResolvedValue(undefined);
  const fire = (event: string, deviceSn: string) => (eufy as any).prewarmForEvent(event, deviceSn);
  return { eufy, prewarm, fire };
}

describe("event pre-warm policy", () => {
  beforeEach(() => vi.restoreAllMocks());

  /** The four events a caller is most likely to opt into, plus the raw signal underneath them. */
  const events = ["doorbellPress", "personDetected", "petDetection", "packageDelivered", "motion"];

  it.each(events)("does not pre-warm %s with default options", (event) => {
    const c = makeClient();

    c.fire(event, SOLO_BATTERY_SN);

    expect(c.prewarm).not.toHaveBeenCalled();
  });

  it("pre-warms an opted-in event", () => {
    const c = makeClient({ prewarmEvents: ["doorbellPress"] });

    c.fire("doorbellPress", SOLO_BATTERY_SN);

    expect(c.prewarm).toHaveBeenCalledTimes(1);
  });

  it("pre-warms only the events opted into", () => {
    const c = makeClient({ prewarmEvents: ["doorbellPress"] });

    c.fire("personDetected", SOLO_BATTERY_SN);

    expect(c.prewarm).not.toHaveBeenCalled();
  });

  /** The tier list is a restriction on top of the event list, so opting in alone reaches both tiers. */
  it("reaches a battery station once opted in", () => {
    const c = makeClient({ prewarmEvents: ["personDetected"] });

    c.fire("personDetected", SOLO_BATTERY_SN);

    expect(c.prewarm).toHaveBeenCalledWith(SOLO_BATTERY_SN, undefined);
  });

  it("declines a battery station when only wired tiers are allowed", () => {
    const c = makeClient({ prewarmEvents: ["personDetected"], prewarmTiers: ["wired"] });

    c.fire("personDetected", SOLO_BATTERY_SN);

    expect(c.prewarm).not.toHaveBeenCalled();
  });

  it("still pre-warms a wired station when only wired tiers are allowed", () => {
    const c = makeClient({ prewarmEvents: ["personDetected"], prewarmTiers: ["wired"] });

    c.fire("personDetected", SOLO_WIRED_SN);

    expect(c.prewarm).toHaveBeenCalledWith(SOLO_WIRED_SN, undefined);
  });

  /** An empty tier list is an off switch of its own, so a caller can disable without losing their list. */
  it("pre-warms nothing when no tier is allowed", () => {
    const c = makeClient({ prewarmEvents: ["personDetected"], prewarmTiers: [] });

    c.fire("personDetected", SOLO_WIRED_SN);
    c.fire("personDetected", SOLO_BATTERY_SN);

    expect(c.prewarm).not.toHaveBeenCalled();
  });

  /**
   * A battery camera behind a wired base is the tier the gate reads: the session it would open is the
   * base's, which is wired, already open, and drains nothing.
   */
  it("resolves the tier of the station it would open, not of the device that reported", () => {
    const c = makeClient({ prewarmEvents: ["personDetected"], prewarmTiers: ["wired"] });

    c.fire("personDetected", CHILD_SN);

    expect(c.prewarm).toHaveBeenCalledWith(BASE_SN, undefined);
  });

  /** The tier gate is only as good as the record behind it, so an unknown station is not assumed wired. */
  it("declines a station the account does not report", () => {
    const c = makeClient({ prewarmEvents: ["personDetected"], prewarmTiers: ["wired"] }, []);

    c.fire("personDetected", SOLO_BATTERY_SN);

    expect(c.prewarm).not.toHaveBeenCalled();
  });

  /** Same hole one level up: the device is known, the base it names is not, so its tier is unknowable. */
  it("declines a child whose station has no record", () => {
    const orphan = fleet().filter((device) => device.sn !== BASE_SN);
    const c = makeClient({ prewarmEvents: ["personDetected"], prewarmTiers: ["wired"] }, orphan);

    c.fire("personDetected", CHILD_SN);

    expect(c.prewarm).not.toHaveBeenCalled();
  });

  /** A HomeBase S1 Pro answers no P2P lookup; a camera behind one is reached over RTC, never P2P. */
  it("declines a camera behind a HomeBase S1 Pro (T9000)", () => {
    const s1Pro = "T9000P0000000000";
    const s1ProChild = "T8000P0000000004";
    const common = { category: "eufy_security", api: "mega", realtime: "p2p", p2pDid: "XXXXXXX-000000-XXXXX" };
    const devices = [
      ...fleet(),
      {
        ...common,
        sn: s1Pro,
        model: "T9000",
        deviceClass: "homebase",
        stationSn: s1Pro,
        raw: { device_type: DeviceType.STATION_9000 },
      },
      { ...common, sn: s1ProChild, model: "T8199", deviceClass: "camera", stationSn: s1Pro, raw: { parent_sn: s1Pro } },
    ] as unknown as EufyDevice[];
    const c = makeClient({ prewarmEvents: ["personDetected"], prewarmTiers: ["wired"] }, devices);

    c.fire("personDetected", s1ProChild);
    c.fire("personDetected", s1Pro);

    expect(c.prewarm).not.toHaveBeenCalled();
  });

  it("passes the configured hold window through", () => {
    const c = makeClient({ prewarmEvents: ["doorbellPress"], prewarmMs: 5_000 });

    c.fire("doorbellPress", SOLO_WIRED_SN);

    expect(c.prewarm).toHaveBeenCalledWith(SOLO_WIRED_SN, 5_000);
  });

  /** `autoRealtime: false` means the SDK manages no connectivity, so it may not open a session either. */
  it("pre-warms nothing when connectivity is caller-managed", () => {
    const c = makeClient({ prewarmEvents: ["doorbellPress"], autoRealtime: false });

    c.fire("doorbellPress", SOLO_WIRED_SN);

    expect(c.prewarm).not.toHaveBeenCalled();
  });
});

/**
 * The gates above are worth nothing if the push handler stops consulting them, so this pins the wiring
 * rather than the policy: every semantic event a push decodes to is offered to the same seam, with the
 * serial the event carries. The FCM socket is not opened — the store supplies persisted credentials and
 * `connect` is answered locally, which is all `startPush` waits for.
 */
describe("push events reach the pre-warm policy", () => {
  beforeEach(() => vi.restoreAllMocks());

  const MOTION_PUSH_EVENT = 3101;
  const UNKNOWN_SN = "T8000P0000000009";

  /** A client whose push channel is started against persisted credentials, with the socket answered locally. */
  async function startedPush(capabilitiesForDevice: (sn: string) => Set<string> | undefined) {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const eufy = new EufyMega({
      email: "t@example.com",
      password: "x",
      logger,
      pushStore: {
        load: () => ({
          creds: { fid: "f", androidId: "0", securityToken: "0", fcmToken: "t", createdAt: 0 },
          persistentIds: [],
        }),
        save: () => {},
        clear: () => {},
      },
    });
    Object.defineProperty((eufy as any).mega, "auth", {
      configurable: true,
      get: () => ({ userId: "u", authToken: "t" }),
    });
    vi.spyOn((eufy as any).mega, "registerPushToken").mockResolvedValue(undefined);
    vi.spyOn((eufy as any).registry, "capabilitiesForDevice").mockImplementation(capabilitiesForDevice as never);
    vi.spyOn(PushClient.prototype, "connect").mockImplementation(function (this: PushClient) {
      this.emit("connect");
    });
    const policy = vi.spyOn(eufy as any, "prewarmForEvent").mockReturnValue(undefined);
    return { client: await (eufy as any).startPush(), policy, logger };
  }

  it("offers each decoded event and its device to the policy", async () => {
    const { client, policy } = await startedPush(() => new Set(["motion"]));
    client.emit("push", { deviceSn: SOLO_BATTERY_SN, eventType: MOTION_PUSH_EVENT, payload: {} });

    expect(policy).toHaveBeenCalledWith("motion", SOLO_BATTERY_SN);
  });

  /**
   * Every push leaves one debug record of what its serial named and how many semantic events it decoded
   * to, so a push that arrived and mapped to nothing is told apart from one that never arrived. The record
   * never carries the serial.
   */
  it("logs each push with the device it named and its event count, without the serial", async () => {
    const { client, logger } = await startedPush((sn) => (sn === SOLO_BATTERY_SN ? new Set(["motion"]) : undefined));
    client.emit("push", { deviceSn: SOLO_BATTERY_SN, eventType: MOTION_PUSH_EVENT, payload: {} });
    client.emit("push", { deviceSn: UNKNOWN_SN, eventType: MOTION_PUSH_EVENT, payload: {} });
    client.emit("push", { payload: {} });

    const lines = logger.debug.mock.calls.map(([m]) => m as string).filter((m) => m.startsWith("[push] in:"));
    expect(lines).toEqual([
      "[push] in: eventType=3101 device=known events=1",
      "[push] in: eventType=3101 device=unknown events=1",
      "[push] in: eventType=undefined device=none events=0",
    ]);
    expect(lines.join()).not.toMatch(/T8000P/);
  });
});
