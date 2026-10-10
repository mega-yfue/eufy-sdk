import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { CMD_TRANSFER_PAYLOAD, LOCK_API_COMMAND } from "../../ff09.js";
import { buildFf09ResponseFrame } from "../../__tests__/ff09-test-fixtures.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

/**
 * `P2PCommandRouter.getAutoLockState` (the `Ff09SettingsReader` behind `dev.lock()?.getAutoLockState()`
 * on the P2P transport) — a pure GET, reusing the same fake-session harness as
 * `ff09-p2p-settings-dispatch.spec.ts`, minus the SET step.
 */
const ADMIN = "0000000000000000000000000000000000000000";
const SN = "T8531K0000000000";
const STATION_SN = "T8030P0000000000";

function buildResponseFrame(plain: Buffer, keyTime: number): string {
  return buildFf09ResponseFrame(plain, keyTime, ADMIN, SN);
}

/** a1=enabled, a2=delaySeconds(LE u16), a3=isSchedule, a4/a5=[hour,minute] schedule start/end. */
function buildResponsePlain(opts: {
  enabled: boolean;
  delaySeconds: number;
  isSchedule: boolean;
  start: [number, number];
  end: [number, number];
}): Buffer {
  const delay = Buffer.alloc(2);
  delay.writeUInt16LE(opts.delaySeconds);
  return Buffer.concat([
    Buffer.from([0x00]), // status
    Buffer.from([0xa1, 1, opts.enabled ? 1 : 0]),
    Buffer.from([0xa2, 2]),
    delay,
    Buffer.from([0xa3, 1, opts.isSchedule ? 1 : 0]),
    Buffer.from([0xa4, 2, opts.start[0], opts.start[1]]),
    Buffer.from([0xa5, 2, opts.end[0], opts.end[1]]),
  ]);
}

interface FakeSession extends FakeP2PSession {
  sendControlLevel2: (cmd: number, channel: number, accountId: string, payload: unknown, mValue3?: number) => boolean;
}

function makeRouter(plain: Buffer, opts: { noReply?: boolean } = {}) {
  const session = connectedSession() as FakeSession;
  let getCount = 0;
  session.sendControlLevel2 = vi.fn((_cmd, _channel, _accountId, payload) => {
    const p = payload as { apiCommand: number; time: number };
    if (!opts.noReply && p.apiCommand === LOCK_API_COMMAND.GET_SETTINGS) {
      getCount++;
      if (getCount === 1) {
        const lockPayload = buildResponseFrame(plain, p.time);
        queueMicrotask(() => {
          session.emit("data", {
            json: {
              cmd: CMD_TRANSFER_PAYLOAD,
              payload: { dev_sn: SN, lock_payload: lockPayload, time: p.time.toString(16) },
            },
          });
        });
      }
    }
    return true;
  });

  const deps: P2PRouterDeps = {
    mega: {} as P2PRouterDeps["mega"],
    listDevices: () => [{ sn: SN, stationSn: STATION_SN, channel: 1, raw: { device_channel: 1 } } as any],
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  };
  const router = new P2PCommandRouter(deps);
  (router as unknown as { manager: { register(sn: string, s: unknown): void } }).manager.register(STATION_SN, session);
  return router;
}

describe("P2PCommandRouter.getAutoLockState (ff09-p2p read-only GET)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("decodes a1-a5 into a full AutoLockSnapshot", async () => {
    const plain = buildResponsePlain({
      enabled: true,
      delaySeconds: 300,
      isSchedule: true,
      start: [22, 30],
      end: [6, 15],
    });
    const router = makeRouter(plain);
    const p = router.getAutoLockState(SN, { adminUserId: ADMIN, deviceSn: SN });
    await vi.advanceTimersByTimeAsync(2500);
    await expect(p).resolves.toEqual({
      enabled: true,
      delaySeconds: 300,
      isSchedule: true,
      scheduleStartTime: [22, 30],
      scheduleEndTime: [6, 15],
    });
  });

  it("decodes enabled=false / isSchedule=false correctly (falsy booleans, not just truthy)", async () => {
    const plain = buildResponsePlain({
      enabled: false,
      delaySeconds: 0,
      isSchedule: false,
      start: [0, 0],
      end: [0, 0],
    });
    const router = makeRouter(plain);
    const p = router.getAutoLockState(SN, { adminUserId: ADMIN, deviceSn: SN });
    await vi.advanceTimersByTimeAsync(2500);
    await expect(p).resolves.toEqual({
      enabled: false,
      delaySeconds: 0,
      isSchedule: false,
      scheduleStartTime: [0, 0],
      scheduleEndTime: [0, 0],
    });
  });

  it("throws if the GET reply never arrives", async () => {
    const plain = buildResponsePlain({ enabled: true, delaySeconds: 1, isSchedule: false, start: [0, 0], end: [0, 0] });
    const router = makeRouter(plain, { noReply: true });
    const p = router.getAutoLockState(SN, { adminUserId: ADMIN, deviceSn: SN });
    const assertion = expect(p).rejects.toThrow(/no settings GET reply/);
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
  });
});
