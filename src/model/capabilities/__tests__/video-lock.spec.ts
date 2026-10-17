import { describe, expect, it, vi } from "vitest";
import { LOCK, LOCK_MEMBERS, type LockActions } from "../lock.js";
import { bind } from "./bind.js";
import { Device } from "../../device.js";
import type { CommandContext, InboundSignal } from "../types.js";
import type { MediaProvider } from "../../../core/contracts.js";

const ctx: CommandContext = {
  channel: 7,
  codec: "lock",
  deviceType: 55,
  model: "T8530",
  serial: "T8530P0000000000",
  paramIds: new Set([6000]),
  adminUserId: "synthetic-admin",
  shortUserId: "0001",
  accountName: "synthetic-member",
  timezone: "UTC0",
  hasP2p: true,
  homeBaseAttached: true,
  stationSerial: "T8030P0000000000",
};
const signal = (payload: unknown, deviceType = 55): InboundSignal => ({
  source: "p2p-frame",
  stationSn: "T8000P0000000000",
  commandId: 1351,
  channel: 7,
  deviceType,
  json: { cmd: 1955, payload },
});

describe("native video lock", () => {
  it.each([
    ["lock", 1],
    ["unlock", 0],
  ] as const)("%s sends one native intent with numeric operation", async (action, operation) => {
    const { acts, sent } = bind<LockActions>("lock", ctx);
    await acts[action]!();
    expect(sent).toEqual([
      {
        kind: "set-payload",
        cmd: 1961,
        channel: ctx.channel,
        mValue3: 0,
        payload: { shortUserId: "0001", slOperation: operation, userId: ctx.adminUserId, userName: ctx.accountName },
      },
    ]);
  });
  it.each([undefined, "T8021P0000000000", "T8530P0000000000"])(
    "withholds native actuation on an unverified station %s",
    async (stationSerial) => {
      const context = { ...ctx, stationSerial };
      const { acts, sent } = bind<LockActions>("lock", context);
      for (const action of ["lock", "unlock"] as const) {
        expect(acts[action]).toBeUndefined();
        const dispatch = vi.fn();
        await expect(
          LOCK_MEMBERS[action].method({ ctx: context, sink: { dispatch }, read: () => undefined })(),
        ).rejects.toThrow(/unverified/);
        expect(dispatch).not.toHaveBeenCalled();
      }
      expect(sent).toEqual([]);
    },
  );
  it("refuses missing accountName before sending", async () => {
    const { acts, sent } = bind<LockActions>("lock", { ...ctx, accountName: undefined });
    await expect(acts.lock!()).rejects.toThrow(/missing member identity/);
    expect(sent).toEqual([]);
  });
  it("withholds ff09 settings and keeps other families unchanged", () => {
    const { acts } = bind<LockActions>("lock", ctx, { ff09Settings: { getAutoLockState: vi.fn() } });
    expect(acts.setAutoLock).toBeUndefined();
    expect(acts.getAutoLockState).toBeUndefined();
    expect(acts.setRainMode).toBeUndefined();
    const other = bind<LockActions>("lock", { ...ctx, deviceType: 189 }).acts;
    expect(other.setAutoLock).toBeTypeOf("function");
    expect(other.refreshStatus).toBeUndefined();
  });
  it.each([3, "3", 4, "4", 5, "5", undefined, false])("reads status %s without guessing a boolean", async (state) => {
    const query = vi.fn().mockResolvedValue({ code: 0, slState: state });
    const { acts } = bind<LockActions>("lock", ctx, { media: { p2pQuery: query } as unknown as MediaProvider });
    await expect(acts.refreshStatus!()).resolves.toBe(
      state === 3 || state === "3" ? false : state === 4 || state === "4" ? true : undefined,
    );
    expect(query).toHaveBeenCalledWith(1955, { payload: { timezone: "UTC0" } });
  });
  it("rejects correctly attributed device errors", async () => {
    const query = vi.fn().mockResolvedValue({ code: -106, slState: "3" });
    const media = { p2pQuery: query } as unknown as MediaProvider;
    await expect(bind<LockActions>("lock", ctx, { media }).acts.refreshStatus!()).rejects.toThrow(/-106/);
  });
  it.each(["media", "query", "timezone"])("omits refreshStatus without %s", (missing) => {
    const query = vi.fn();
    const media =
      missing === "media"
        ? undefined
        : ({ p2pQuery: missing === "query" ? undefined : query } as unknown as MediaProvider);
    const context = {
      ...ctx,
      timezone: missing === "timezone" ? undefined : ctx.timezone,
    };
    const { acts } = bind<LockActions>("lock", context, { media });
    expect(acts.refreshStatus).toBeUndefined();
    expect("refreshStatus" in acts).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
  it.each([3, "3", 4, "4"])("decodes %s into canonical state", (state) => {
    const frame = signal({ code: 0, slState: state, slBattery: "66" });
    expect(LOCK.decodeState!(frame)).toEqual({ params: { 6000: String(state), 6001: "66" } });
  });
  it.each([null, [], {}, { code: -106, slState: 3 }, { code: "0", slState: 3 }])(
    "ignores malformed/error payload %j",
    (payload) => {
      expect(LOCK.decodeState!(signal(payload))).toBeNull();
    },
  );
  it("isolates native state decoding and does not treat unknown reports as unlocked", () => {
    expect(LOCK.decodeState!(signal({ code: 0, slState: 4 }, 189))).toBeNull();
    expect(LOCK.decodeState!(signal({ code: 0, slState: 5, slBattery: "66" }))).toEqual({ params: { 6001: "66" } });
  });
  it.each([
    ["T8531", 189],
    ["T85D0", 202],
  ] as const)("preserves %s shared param decoding", (model, deviceType) => {
    const dev = Device.fromRecord(ctx.serial!, { deviceType, model, params: { 6000: "2" } });
    dev.bindActions({ ...ctx, model, deviceType }, { dispatch: async () => {} });
    expect(dev.lock?.()?.locked).toBe(false);
    dev.applyParams({ 6000: " 4" });
    expect(dev.lock?.()?.locked).toBe(true);
  });
});
