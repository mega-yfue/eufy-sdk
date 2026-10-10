import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createCipheriv } from "node:crypto";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { CMD_TRANSFER_PAYLOAD, LOCK_API_COMMAND } from "../../ff09.js";
import type { EufyDevice } from "../../../core/types.js";
import { u16le, u32be } from "../../../core/util.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

/**
 * `sendFf09Autolock` (the `ff09-autolock` intent handler behind `dev.lock()?.setAutoLock`
 * for a P2P video lock) — the P2P sibling of `transport/mqtt/__tests__/ff09-mqtt-settings-dispatch.spec.ts`,
 * mocked the same way `p2p_level2.spec.ts` mocks a session: the shared `connectedSession` fixture standing
 * in for `P2PSession`, with `sendControlLevel2` mocked to inspect
 * each outbound envelope and, for the GET, synchronously emit a `data` event carrying a
 * correctly-encrypted device reply built with the SAME cipher `transport/ff09.ts` documents — so the
 * whole GET→decrypt→SET flow runs for real against a fake session, no live P2P connection.
 *
 * No live broker/session: the session manager is seeded with a fake session directly (via
 * `manager.register`), and `deps.listDevices` returns a synthetic device record pointing at it.
 */
const ADMIN = "0000000000000000000000000000000000000000";
const SN = "T8531K0000000000";
const STATION_SN = "T8030P0000000000";

/** Build a minimally-valid ff09 response frame wrapping `plain` (mirrors decryptFf09Frame's own doc). */
function buildResponseFrame(plain: Buffer, keyTime: number): string {
  const key = Buffer.concat([Buffer.from(ADMIN.slice(-12), "ascii"), u32be(keyTime)]);
  const iv = Buffer.alloc(16);
  Buffer.from(SN, "ascii").copy(iv);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const body = Buffer.concat([Buffer.from([0x03, 0x00, 0x02]), Buffer.from([0x48, 0x35]), ct]);
  const size = 2 + 2 + body.length + 1;
  const sizeBuf = Buffer.alloc(2);
  sizeBuf.writeUInt16LE(size);
  const preXor = Buffer.concat([Buffer.from([0xff, 0x09]), sizeBuf, body]);
  let xor = 0;
  for (const b of preXor) xor ^= b;
  return Buffer.concat([preXor, Buffer.from([xor])]).toString("hex");
}

/** The settings-response TLV: status + a1..a6 (only a2/a4/a5 matter to the dispatcher). */
function buildResponsePlain(delaySeconds: number, a7: number, a8: number): Buffer {
  return Buffer.concat([
    Buffer.from([0x00]), // status
    Buffer.from([0xa1, 1, 1]),
    Buffer.from([0xa2, 2]),
    u16le(delaySeconds),
    Buffer.from([0xa3, 1, 0]),
    Buffer.from([0xa4, 2]),
    u16le(a7),
    Buffer.from([0xa5, 2]),
    u16le(a8),
  ]);
}

interface FakeSession extends FakeP2PSession {
  sendControlLevel2: (cmd: number, channel: number, accountId: string, payload: unknown, mValue3?: number) => boolean;
}

/** Every call to `sendControlLevel2`, decoded for assertions. */
interface Call {
  cmd: number;
  channel: number;
  payload: { apiCommand: number; lock_payload: string; seq_num: number; time: number };
}

function makeRouter(opts: {
  delay: number;
  a7: number;
  a8: number;
  /** Emit the GET reply's `time` as a hex string (real observed shape) or decimal (defensive fallback). */
  replyTimeAsHex: boolean;
  /** Skip emitting a GET reply entirely (times out). */
  noReply?: boolean;
}) {
  const calls: Call[] = [];
  const session = connectedSession() as FakeSession;
  session.sendControlLevel2 = vi.fn((cmd, channel, _accountId, payload) => {
    const p = payload as Call["payload"];
    calls.push({ cmd, channel, payload: p });
    if (
      !opts.noReply &&
      p.apiCommand === LOCK_API_COMMAND.GET_SETTINGS &&
      calls.filter((c) => c.payload.apiCommand === LOCK_API_COMMAND.GET_SETTINGS).length === 1
    ) {
      const plain = buildResponsePlain(opts.delay, opts.a7, opts.a8);
      const lockPayload = buildResponseFrame(plain, p.time);
      queueMicrotask(() => {
        session.emit("data", {
          json: {
            cmd: CMD_TRANSFER_PAYLOAD,
            payload: {
              dev_sn: SN,
              lock_payload: lockPayload,
              time: opts.replyTimeAsHex ? p.time.toString(16) : p.time,
            },
          },
        });
      });
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
  return { router, calls, session };
}

describe("P2PCommandRouter.claimsDevice", () => {
  it("claims a device with a usable p2p_did endpoint, declines one without", () => {
    expect(P2PCommandRouter.claimsDevice({ p2pDid: "DID-XYZ" } as EufyDevice)).toBe(true);
    expect(P2PCommandRouter.claimsDevice({ p2pDid: "" } as EufyDevice)).toBe(false); // MQTT-only lock/garage
    expect(P2PCommandRouter.claimsDevice({} as EufyDevice)).toBe(false);
  });
});

describe("P2PCommandRouter.sendFf09Autolock (ff09-autolock command-router branch)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("GETs current settings then SETs, changing only A4/A5 and preserving A7/A8 read from the GET reply", async () => {
    const { router, calls } = makeRouter({ delay: 59, a7: 11, a8: 22, replyTimeAsHex: true });
    const p = router.dispatchCommand(SN, {
      kind: "ff09-autolock",
      adminUserId: ADMIN,
      deviceSn: SN,
      enabled: true,
      delaySeconds: 200,
    });
    await vi.advanceTimersByTimeAsync(2500);
    await p;

    const getCalls = calls.filter((c) => c.payload.apiCommand === LOCK_API_COMMAND.GET_SETTINGS);
    const setCalls = calls.filter((c) => c.payload.apiCommand === LOCK_API_COMMAND.SET_SETTINGS);
    expect(getCalls.length).toBeGreaterThan(0);
    expect(setCalls.length).toBeGreaterThan(0);
    // Every repeated GET/SET send used the SAME channel — re-resolved from the device record (the intent carries none).
    expect(calls.every((c) => c.channel === 1)).toBe(true);

    const { decryptFf09Frame, parseFf09SettingsResponse } = await import("../../ff09.js");
    const last = setCalls[0]!.payload;
    const plain = decryptFf09Frame({
      lockPayload: last.lock_payload,
      keyTime: last.time,
      adminUserId: ADMIN,
      deviceSn: SN,
    });
    const parsed = parseFf09SettingsResponse(Buffer.concat([Buffer.from([0]), plain]));
    expect(parsed.fields.get(0xa4)?.[0]).toBe(1); // enable = true
    expect(parsed.fields.get(0xa5)?.readUInt16LE(0)).toBe(200); // delay override
    expect(parsed.fields.get(0xa7)?.readUInt16LE(0)).toBe(11); // preserved from GET
    expect(parsed.fields.get(0xa8)?.readUInt16LE(0)).toBe(22); // preserved from GET
  });

  it("preserves the current delay when delaySeconds is omitted", async () => {
    const { router, calls } = makeRouter({ delay: 77, a7: 1, a8: 2, replyTimeAsHex: true });
    const p = router.dispatchCommand(SN, {
      kind: "ff09-autolock",
      adminUserId: ADMIN,
      deviceSn: SN,
      enabled: false,
    });
    await vi.advanceTimersByTimeAsync(2500);
    await p;

    const setCalls = calls.filter((c) => c.payload.apiCommand === LOCK_API_COMMAND.SET_SETTINGS);
    const { decryptFf09Frame, parseFf09SettingsResponse } = await import("../../ff09.js");
    const last = setCalls[0]!.payload;
    const plain = decryptFf09Frame({
      lockPayload: last.lock_payload,
      keyTime: last.time,
      adminUserId: ADMIN,
      deviceSn: SN,
    });
    const parsed = parseFf09SettingsResponse(Buffer.concat([Buffer.from([0]), plain]));
    expect(parsed.fields.get(0xa5)?.readUInt16LE(0)).toBe(77); // preserved current delay
    expect(parsed.fields.get(0xa4)?.[0]).toBe(0); // enable = false
  });

  it("matches the GET reply whose `time` is a decimal number (defensive coercion, not just hex-string)", async () => {
    const { router, calls } = makeRouter({ delay: 42, a7: 3, a8: 4, replyTimeAsHex: false });
    const p = router.dispatchCommand(SN, {
      kind: "ff09-autolock",
      adminUserId: ADMIN,
      deviceSn: SN,
      enabled: true,
    });
    await vi.advanceTimersByTimeAsync(2500);
    await p;
    const setCalls = calls.filter((c) => c.payload.apiCommand === LOCK_API_COMMAND.SET_SETTINGS);
    expect(setCalls.length).toBeGreaterThan(0);
  });

  it("throws if the GET reply never arrives (refuses to write settings blind)", async () => {
    const { router } = makeRouter({ delay: 1, a7: 1, a8: 1, replyTimeAsHex: true, noReply: true });
    const p = router.dispatchCommand(SN, {
      kind: "ff09-autolock",
      adminUserId: ADMIN,
      deviceSn: SN,
      enabled: true,
    });
    const assertion = expect(p).rejects.toThrow(/no settings GET reply/);
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
  });

  it("does not throw when the SET step gets no explicit ack (fire-and-forget)", async () => {
    // sendControlLevel2 always returns true (accepted for send) — there is no ack-wait for the SET
    // step at the P2P router layer (matches sendFf09Actuate's existing fire-and-forget lock/unlock).
    const { router, calls } = makeRouter({ delay: 90, a7: 1, a8: 2, replyTimeAsHex: true });
    const p = router.dispatchCommand(SN, {
      kind: "ff09-autolock",
      adminUserId: ADMIN,
      deviceSn: SN,
      enabled: true,
    });
    await vi.advanceTimersByTimeAsync(2500);
    await expect(p).resolves.toBeUndefined();
    expect(calls.some((c) => c.payload.apiCommand === LOCK_API_COMMAND.SET_SETTINGS)).toBe(true);
  });
});
