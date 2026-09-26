import { LOCK, LOCK_SETTING_ID, type LockActions } from "../lock.js";
import { isClassicWifiLock } from "../../device-family.js";
import { bind } from "./bind.js";
import { Device } from "../../device.js";
import type { CommandContext } from "../types.js";
import type { CommandSink, Ff09SettingsReader } from "../../../core/contracts.js";

/** The bound `dev.lock()` object — every method is a member, derived in the barrel. */
const lockOf = (
  ctx: CommandContext,
  ff09Settings?: Ff09SettingsReader,
  read?: (name: string) => { value: unknown } | undefined,
) => bind<LockActions>("lock", ctx, { ff09Settings, read });

// A P2P-reachable video smart lock (T8531): full member identity + a p2p_did.
const p2pCtx: CommandContext = {
  channel: 1,
  codec: "lock",
  serial: "T8531K0000000000",
  paramIds: new Set(),
  adminUserId: "0000000000000000000000000000000000000000",
  shortUserId: "0003",
  accountName: "someone+tag",
  hasP2p: true,
};
// A standalone garage/lock (T85D0): no P2P endpoint → MQTT-only, same identity shape as the P2P lock.
const mqttCtx: CommandContext = {
  channel: 0,
  codec: "lock",
  model: "T85D0",
  serial: "T85D0K0000000000",
  paramIds: new Set(),
  adminUserId: "0000000000000000000000000000000000000000",
  shortUserId: "0003",
  accountName: "someone+tag",
  hasP2p: false,
};

// The classic Wi-Fi lock: DeviceType 51 with a serial the vendor does NOT mark as a later generation.
const classicCtx: CommandContext = {
  channel: 0,
  codec: "lock",
  deviceType: 51,
  model: "T8520N",
  serial: "T8520Q2000000000",
  paramIds: new Set([6000, 6001]),
  adminUserId: "0000000000000000000000000000000000000000",
  shortUserId: "0003",
  accountName: "someone+tag",
  hasP2p: true,
};

describe("lock capability — classic Wi-Fi lock family", () => {
  it("classifies the classic lock as DeviceType 51 in the driven T8520 serial range, and nothing else", () => {
    expect(isClassicWifiLock(classicCtx)).toBe(true);
    // The same DeviceType outside the driven range keeps the ff09 path, and so does type 53, on which no
    // unit has answered this wire.
    expect(isClassicWifiLock({ deviceType: 51, serial: "T8520Q8000000000" })).toBe(false);
    expect(isClassicWifiLock({ deviceType: 51, serial: "T8500K2000000000" })).toBe(false);
    expect(isClassicWifiLock({ deviceType: 53, serial: "T8520Q2000000000" })).toBe(false);
    expect(isClassicWifiLock({ deviceType: 189, serial: "T8531K0000000000" })).toBe(false);
    expect(isClassicWifiLock({ deviceType: 51 })).toBe(false);
    expect(isClassicWifiLock({ deviceType: 51, serial: "T852" })).toBe(false);
  });

  it("lock/unlock emit the keyed-payload intent on the classic lock, and ff09 elsewhere", async () => {
    const classic = lockOf(classicCtx);
    await classic.acts.lock!();
    await classic.acts.unlock!();
    expect(classic.sent.map((c) => c.kind)).toEqual(["keyed-payload-actuate", "keyed-payload-actuate"]);
    expect(classic.sent[0]).toMatchObject({ engage: true, adminUserId: classicCtx.adminUserId, shortUserId: "0003" });
    expect(classic.sent[1]).toMatchObject({ engage: false, deviceSn: classicCtx.serial });
    const video = lockOf(p2pCtx);
    await video.acts.lock!();
    expect(video.sent[0].kind).toBe("ff09-actuate");
  });

  it("withholds the ff09 settings writes on the classic lock, which never takes that frame", () => {
    const { acts } = lockOf(classicCtx);
    expect(acts.setAutoLock).toBeUndefined();
    expect("setAutoLock" in acts).toBe(false);
    expect(acts.setRainMode).toBeUndefined();
    expect(lockOf(p2pCtx).acts.setAutoLock).toBeTypeOf("function");
  });

  it("withholds setAutoLock on the bound device object itself, through Device.bindActions", () => {
    // The gate reads the serial, which only a command context carries: binding a real device with the
    // context the facade builds is the path a caller's `dev.lock()` object comes from.
    const noopSink: CommandSink = { dispatch: async () => undefined };
    const classic = Device.fromRecord("T8520Q2000000000", {
      model: "T8520",
      name: "Smart Lock",
      params: { 6000: "4", 6001: "66" },
    });
    classic.bindActions(classicCtx, noopSink);
    expect(classic.lock?.()?.lock).toBeTypeOf("function");
    expect(classic.lock?.()?.setAutoLock).toBeUndefined();
    const video = Device.fromRecord("T8531K0000000000", { model: "T8531", name: "Smart Lock", params: { 6000: "4" } });
    video.bindActions(p2pCtx, noopSink);
    expect(video.lock?.()?.setAutoLock).toBeTypeOf("function");
  });
});

describe("lock capability module", () => {
  it("declares the capability + schema", () => {
    expect(LOCK.capability).toBe("lock");
    expect(LOCK.properties.map((p) => p.name)).toEqual(["locked", "battery", "rssi"]);
  });

  it("lock/unlock on a P2P lock dispatch a transport-neutral ff09-actuate intent (no wire bytes, no routing key)", async () => {
    // The model layer never builds the ff09 frame itself (that's the transport routers' job, per the
    // capability↔transport decorrelation invariant) — it only supplies identity, no transport, no
    // channel/model routing key (the sink routes by topology, the router re-resolves its own tail).
    const { acts, sent } = lockOf(p2pCtx);
    await acts.unlock!();
    await acts.lock!();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({
      kind: "ff09-actuate",
      engage: false, // unlock (release)
      adminUserId: p2pCtx.adminUserId,
      username: p2pCtx.accountName,
      shortUserId: p2pCtx.shortUserId,
      deviceSn: p2pCtx.serial,
    });
    expect(sent[1]).toEqual({ ...sent[0], engage: true }); // lock (engage)
  });

  it("lock/unlock on an MQTT-only device dispatch the SAME transport-neutral ff09-actuate intent", async () => {
    // dev.lock()/.unlock() are byte-for-byte the same intent as the P2P case — the capability names no
    // transport; the sink routes P2P vs MQTT by topology, so the host never has to know this is a garage
    // door rather than a deadbolt.
    const { acts, sent } = lockOf(mqttCtx);
    await acts.unlock!();
    await acts.lock!();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({
      kind: "ff09-actuate",
      engage: false, // unlock (release)
      adminUserId: mqttCtx.adminUserId,
      username: mqttCtx.accountName,
      shortUserId: mqttCtx.shortUserId,
      deviceSn: mqttCtx.serial,
    });
    expect(sent[1]).toEqual({ ...sent[0], engage: true }); // lock (engage)
  });

  it("setRainMode on a P2P lock dispatches a transport-neutral ff09-setting-toggle intent", async () => {
    const { acts, sent } = lockOf(p2pCtx);
    await acts.setRainMode?.(true);
    expect(sent).toEqual([
      {
        kind: "ff09-setting-toggle",
        adminUserId: p2pCtx.adminUserId,
        deviceSn: p2pCtx.serial,
        settingId: LOCK_SETTING_ID.RAIN_MODE,
        value: true,
      },
    ]);
  });

  it("setRainMode is absent on an MQTT-only device (no known Rain Mode on the garage door)", () => {
    const { acts } = lockOf(mqttCtx);
    expect(acts.setRainMode).toBeUndefined();
    expect("setRainMode" in acts).toBe(false);
  });

  it.each([
    "setOneTouchLock",
    "setScramblePasscode",
    "setWifiStatus",
    "setLogEnabled",
    "setPrivacyMode",
    "setOneTouchRearLock",
  ] as const)(
    "%s is ABSENT until captured — source-confirmed-but-uncaptured toggles are not installed as keys, on either transport",
    (method) => {
      for (const ctx of [p2pCtx, mqttCtx]) {
        const acts = lockOf(ctx).acts as Record<string, unknown>;
        expect(acts[method]).toBeUndefined();
        expect(method in acts).toBe(false);
      }
    },
  );

  it("all 7 setting-id constants are distinct (no accidental collision)", () => {
    const ids = Object.values(LOCK_SETTING_ID);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("setRainMode rejects on missing member identity", async () => {
    const { acts } = lockOf({ ...p2pCtx, adminUserId: undefined });
    await expect(acts.setRainMode?.(true)).rejects.toThrow(/member identity/);
  });

  it("lock/unlock reject on missing member identity, on either transport", async () => {
    await expect(lockOf({ ...p2pCtx, adminUserId: undefined }).acts.lock!()).rejects.toThrow(/member identity/);
    await expect(lockOf({ ...mqttCtx, shortUserId: undefined }).acts.unlock!()).rejects.toThrow(/member identity/);
  });

  it("getAutoLockState delegates to the injected ff09Settings reader, on either transport", async () => {
    const snapshot = {
      enabled: true,
      delaySeconds: 60,
      isSchedule: false,
      scheduleStartTime: [0, 0] as [number, number],
      scheduleEndTime: [0, 0] as [number, number],
    };
    const ff09Settings = { getAutoLockState: vi.fn().mockResolvedValue(snapshot) } as unknown as Ff09SettingsReader;
    await expect(lockOf(p2pCtx, ff09Settings).acts.getAutoLockState!()).resolves.toEqual(snapshot);
    await expect(lockOf(mqttCtx, ff09Settings).acts.getAutoLockState!()).resolves.toEqual(snapshot);
    expect(ff09Settings.getAutoLockState).toHaveBeenCalledTimes(2);
  });

  /**
   * The member is built FROM the ff09 reader, so without one there is nothing to install. A caller learns
   * from the object's own shape, at compile time, instead of from a runtime rejection.
   */
  it("getAutoLockState is ABSENT when unbound — a provider-backed member declines rather than rejecting", () => {
    const { acts } = lockOf(p2pCtx);
    expect(acts.getAutoLockState).toBeUndefined();
    expect("getAutoLockState" in acts).toBe(false);
  });

  it("detects via the lock and safe model-name regexes", () => {
    const [lockRe, safeRe] = LOCK.detection!.modelHints!;
    expect(lockRe.test("Smart Lock")).toBe(true);
    expect(lockRe.test("Indoor Cam")).toBe(false);
    expect(safeRe.test("Smart Safe")).toBe(true);
    expect(safeRe.test("Indoor Cam")).toBe(false);
  });

  it("maps locked property to verified param 6000 and battery to param 1101 with alias 6001", () => {
    const locked = LOCK.properties.find((p) => p.name === "locked");
    expect(locked).toMatchObject({
      paramType: 6000,
      type: "bool",
      kind: "boolean",
      provenance: "verified",
      writable: true,
    });

    const battery = LOCK.properties.find((p) => p.name === "battery");
    expect(battery).toMatchObject({
      paramType: 1101,
      type: "number",
      kind: "percent",
      provenance: "verified",
      readAliases: [{ paramType: 6001 }],
    });
  });

  it("proves lock capability via param 6000", () => {
    expect(LOCK.detection?.evidenceParams).toContain(6000);
  });

  describe("device integration: state and battery properties", () => {
    const noopSink: CommandSink = { dispatch: async () => undefined };

    it("decodes param 6000 ('4'=locked, '3'=unlocked) and lock battery 6001", () => {
      const dev = Device.fromRecord("T8531K0000000000", {
        model: "T8531",
        name: "Smart Lock",
        params: {
          6000: "4",
          6001: "85",
        },
      });
      dev.bindActions(
        {
          channel: 1,
          codec: "lock",
          serial: "T8531K0000000000",
          paramIds: new Set([6000, 6001]),
        },
        noopSink,
      );

      expect(dev.lock?.()?.locked).toBe(true);
      expect(dev.lock?.()?.battery).toBe(85);
      expect(dev.getProperties().locked.value).toBe(true);
      expect(dev.getProperties().battery.value).toBe(85);
      expect(dev.getProperties().battery.paramType).toBe(6001);

      // Update to unlocked ("3")
      dev.applyParams({ 6000: "3" });
      expect(dev.lock?.()?.locked).toBe(false);
      expect(dev.getProperties().locked.value).toBe(false);
    });

    it("falls back to standard param 1101 for battery if reported instead of 6001", () => {
      const dev = Device.fromRecord("T8531K0000000000", {
        model: "T8531",
        name: "Smart Lock",
        params: {
          6000: "3",
          1101: "92",
        },
      });
      dev.bindActions(
        {
          channel: 1,
          codec: "lock",
          serial: "T8531K0000000000",
          paramIds: new Set([6000, 1101]),
        },
        noopSink,
      );

      expect(dev.lock?.()?.battery).toBe(92);
      expect(dev.getProperties().battery.value).toBe(92);
    });

    it("detects lock capability when a device reports param 6000", () => {
      const dev = Device.fromRecord("T8500K0000000000", {
        model: "T8500",
        params: {
          6000: "4",
        },
      });
      expect(dev.capabilities).toContain("lock");
    });
  });
});

/**
 * The derived surface, pinned at COMPILE time. The honesty rule made type-level: an uncaptured wire is
 * declared but not installed, so a caller learns from the compiler — not a runtime rejection — which
 * settings are writable today.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
declare const lk: LockActions;

const _locked: Exact<typeof lk.locked, boolean | undefined> = true;
const _battery: Exact<typeof lk.battery, number | undefined> = true;
const _rssi: Exact<typeof lk.rssi, number | undefined> = true;

// A read-only member gets no setter — `locked` has no confirmed write param.
const _noSetLocked: Exact<"setLocked" extends keyof LockActions ? true : false, false> = true;

// The actuation verbs are unconditional methods: every lock-family device speaks this frame.
const _lockRequired: Exact<undefined extends typeof lk.lock ? true : false, false> = true;
const _lockArgs: Exact<Parameters<typeof lk.lock>, []> = true;

// Topology-gated: rain mode exists on the P2P video lock, not on the MQTT garage door.
const _rainOptional: Exact<undefined extends typeof lk.setRainMode ? true : false, true> = true;

// UNVERIFIED writes are declared, not installed → optional, and the compiler says so.
const _oneTouchOptional: Exact<undefined extends typeof lk.setOneTouchLock ? true : false, true> = true;
const _scrambleOptional: Exact<undefined extends typeof lk.setScramblePasscode ? true : false, true> = true;
// …and being write-only, they have no getter even so.
const _noOneTouchGetter: Exact<"oneTouchLock" extends keyof LockActions ? true : false, false> = true;

// setAutoLock rides the ff09 settings frame, which the classic Wi-Fi lock never takes — so it is
// family-gated and lands optional, the same way setRainMode does; its signature is unchanged.
const _autoLockOptional: Exact<undefined extends typeof lk.setAutoLock ? true : false, true> = true;
const _autoLockArgs: Exact<Parameters<NonNullable<typeof lk.setAutoLock>>, [boolean, (number | undefined)?]> = true;
const _snapshot: Exact<
  ReturnType<NonNullable<typeof lk.getAutoLockState>>,
  Promise<import("../../../core/contracts.js").AutoLockSnapshot>
> = true;

export const _surfaceAssertions = [
  _locked,
  _battery,
  _rssi,
  _noSetLocked,
  _lockRequired,
  _lockArgs,
  _rainOptional,
  _oneTouchOptional,
  _scrambleOptional,
  _noOneTouchGetter,
  _autoLockOptional,
  _autoLockArgs,
  _snapshot,
];
