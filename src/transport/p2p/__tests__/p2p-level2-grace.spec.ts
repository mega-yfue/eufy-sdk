import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { withGcmKey } from "./session-fixtures.js";

const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const LEVEL2_KEY = Buffer.alloc(32, 7);

/** A gateway-info payload whose only read member is the leading `cipher_id`. */
function gatewayInfo(cipherId: number): Buffer {
  const payload = Buffer.alloc(64);
  payload.writeUInt16LE(cipherId, 0);
  return payload;
}

function session(resolveCipherKey?: (cipherId: number) => Promise<string | undefined>): P2PSession {
  const built = new P2PSession({
    stationSn: STATION_SN,
    p2pDid: P2P_DID,
    ...(resolveCipherKey ? { resolveCipherKey } : {}),
  });
  connectedAgo(built, 0);
  return built;
}

/** Pretend the session connected `ms` ago, which is when its negotiation had its chance to start. */
function connectedAgo(target: P2PSession, ms: number): void {
  (target as unknown as { connectedAtMs?: number }).connectedAtMs = Date.now() - ms;
}

function negotiate(target: P2PSession, cipherId = 3): void {
  (target as unknown as { negotiateLevel2Key(payload: Buffer, version: number): void }).negotiateLevel2Key(
    gatewayInfo(cipherId),
    8,
  );
}

/**
 * The key is negotiated once per connection, from the station's `CMD_GATEWAYINFO` reply. Every operation
 * that needs it therefore asks the same question of the same session. Best-effort media uses one grace per
 * session; commands that require the key retain a per-call grace because they cannot proceed without it.
 */
describe("level-2 key wait", () => {
  it("answers at once when the key is already negotiated", async () => {
    const target = session(async () => undefined);
    withGcmKey(target, LEVEL2_KEY);
    await expect(target.awaitLevel2Key(25_000)).resolves.toBe(true);
  });

  /**
   * A station whose cipher has no key for this account will never produce one, and the negotiation is
   * one-shot — so every later wait is spent on an answer that cannot change.
   */
  it("answers at once once the negotiation concluded without a key", async () => {
    const target = session(async () => undefined);
    negotiate(target);
    await vi.waitFor(() => expect(target.hasLevel2Key).toBe(false));
    await expect(target.awaitLevel2Key(25_000)).resolves.toBe(false);
  });

  /** With no way to resolve a cipher key, the negotiation cannot even begin. */
  it("answers at once when nothing can negotiate a key at all", async () => {
    await expect(session().awaitLevel2Key(25_000)).resolves.toBe(false);
  });

  it("resolves as soon as a key arrives part-way through the grace", async () => {
    const target = session(async () => undefined);
    const waiting = target.awaitLevel2Key(25_000);
    setTimeout(() => withGcmKey(target, LEVEL2_KEY), 10);
    await expect(waiting).resolves.toBe(true);
  });

  it("removes its waiter and deadline when a key arrives early", async () => {
    vi.useFakeTimers();
    try {
      const target = session(async () => undefined);
      const waiting = target.awaitLevel2Key(25_000);
      expect((target as unknown as { level2Waiters: unknown[] }).level2Waiters).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);

      withGcmKey(target, LEVEL2_KEY);
      await expect(waiting).resolves.toBe(true);
      expect((target as unknown as { level2Waiters: unknown[] }).level2Waiters).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles every waiter and clears every deadline when the session closes", async () => {
    vi.useFakeTimers();
    try {
      const debug = vi.fn();
      const target = new P2PSession({
        stationSn: STATION_SN,
        p2pDid: P2P_DID,
        resolveCipherKey: async () => undefined,
        logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      connectedAgo(target, 0);
      const first = target.awaitLevel2Key(25_000);
      const second = target.awaitLevel2Key(25_000);
      expect((target as unknown as { level2Waiters: unknown[] }).level2Waiters).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(2);

      await target.close();
      expect((target as unknown as { level2Waiters: unknown[] }).level2Waiters).toHaveLength(0);
      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      const messages = debug.mock.calls.map(([message]) => message).join("\n");
      expect(messages).toMatch(/session closed before the level-2 key arrived/);
      expect(messages).not.toMatch(/negotiation concluded without a key/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a waiter closed when a reconnect obtains a new key before it resumes", async () => {
    const target = session(async () => undefined);
    const waiting = target.awaitLevel2Key(25_000);

    const closing = target.close();
    Object.assign(target as unknown as Record<string, unknown>, {
      closed: false,
      connectionGeneration: 3,
      level2Pending: true,
    });
    withGcmKey(target, LEVEL2_KEY);
    await closing;

    await expect(waiting).resolves.toBe(false);
  });

  it("reports a concluded negotiation as terminal rather than as a grace timeout", async () => {
    vi.useFakeTimers();
    try {
      const debug = vi.fn();
      const target = new P2PSession({
        stationSn: STATION_SN,
        p2pDid: P2P_DID,
        resolveCipherKey: async () => undefined,
        logger: { debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      connectedAgo(target, 0);
      const waiting = target.awaitLevel2Key(25_000);
      negotiate(target);
      await expect(waiting).resolves.toBe(false);

      expect(debug.mock.calls.map(([message]) => message).join("\n")).toMatch(/concluded without a key/);
      expect(debug.mock.calls.map(([message]) => message).join("\n")).not.toMatch(/within its grace/);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The grace is the session's, measured from the connect that gave the negotiation its chance. A caller
   * arriving after it has elapsed has already missed it, so waiting again buys nothing.
   */
  it("spends nothing on a session whose grace has already elapsed", async () => {
    const target = session(async () => undefined);
    connectedAgo(target, 30_000);
    const started = Date.now();
    await expect(target.awaitLevel2Key(8_000, "session")).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("waits only for what is left of the grace", async () => {
    const target = session(async () => undefined);
    connectedAgo(target, 7_960);
    const started = Date.now();
    await expect(target.awaitLevel2Key(8_000, "session")).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  /**
   * A late negotiation does not restart a best-effort session grace. Media can proceed without the key,
   * and restarting the clock would charge another fixed wait to a source that is already streaming. The
   * key still takes effect if its lookup later succeeds.
   */
  it("does not restart an elapsed session grace when negotiation begins late", async () => {
    const target = session(() => new Promise<string | undefined>(() => {}));
    connectedAgo(target, 30_000);
    negotiate(target);
    const started = Date.now();
    await expect(target.awaitLevel2Key(40, "session")).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(10);
  });

  /** A session that never connected has not had its chance yet, so the whole grace is still ahead of it. */
  it("gives an unconnected session its full grace", async () => {
    const target = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID, resolveCipherKey: async () => undefined });
    const started = Date.now();
    await expect(target.awaitLevel2Key(40, "session")).resolves.toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  /**
   * A hard command gets its own grace. Unlike best-effort media, it cannot send anything without the key,
   * and a station may not prompt the negotiation until long after connect; session age therefore cannot
   * determine whether the command's key can still arrive.
   */
  it("gives a hard caller its full grace even on an old session", async () => {
    const target = session(async () => undefined);
    connectedAgo(target, 30_000);
    const waiting = target.awaitLevel2Key(40, "call");
    setTimeout(() => withGcmKey(target, LEVEL2_KEY), 10);

    await expect(waiting).resolves.toBe(true);
  });

  /**
   * A cipher lookup belongs to the connection that received its gateway envelope. Closing and reopening
   * changes the station session key, so a lookup from the earlier connection cannot settle the new
   * connection's wait even when it completes after `closed` has returned to false.
   */
  it("ignores a cipher lookup completed by an earlier connection generation", async () => {
    let resolveCipher: ((value: string | undefined) => void) | undefined;
    const target = session(() => new Promise<string | undefined>((resolve) => (resolveCipher = resolve)));
    (target as unknown as { connectionGeneration: number }).connectionGeneration = 1;
    negotiate(target);

    await target.close();
    Object.assign(target as unknown as Record<string, unknown>, {
      closed: false,
      connectionGeneration: 3,
      level2Pending: true,
    });
    resolveCipher?.(undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect((target as unknown as { level2Pending: boolean }).level2Pending).toBe(true);
    expect(target.hasLevel2Key).toBe(false);
  });

  it("ignores a failed cipher lookup from an earlier connection generation", async () => {
    let rejectCipher: ((error: Error) => void) | undefined;
    const target = session(() => new Promise<string | undefined>((_resolve, reject) => (rejectCipher = reject)));
    const reported = vi.fn();
    target.on("error", reported);
    (target as unknown as { connectionGeneration: number }).connectionGeneration = 1;
    negotiate(target);

    await target.close();
    Object.assign(target as unknown as Record<string, unknown>, {
      closed: false,
      connectionGeneration: 3,
      level2Pending: true,
    });
    rejectCipher?.(new Error("stale lookup"));
    await Promise.resolve();
    await Promise.resolve();

    expect((target as unknown as { level2Pending: boolean }).level2Pending).toBe(true);
    expect(reported).not.toHaveBeenCalled();
  });

  it("discards a negotiated key when its connection closes", async () => {
    const target = session(async () => undefined);
    withGcmKey(target, LEVEL2_KEY);
    expect(target.hasLevel2Key).toBe(true);

    await target.close();

    expect(target.hasLevel2Key).toBe(false);
  });
});

/**
 * The app's `checkAesKeyAndResend` asks for `CMD_GATEWAYINFO` again every three seconds, without a limit, until
 * a reply names a `cipher_id` of 1 or more; a reply with `cipher_id` 0, or a refusal, leaves it asking.
 */
/**
 * The app's notify reader checks after each channel-2 frame, at most once a second, whether the slot holds a key, and
 * sends the header-only 1100 again on every third check that finds none: no frame on channel 2, no resend.
 */
describe("CMD_GATEWAYINFO re-sent by the notify reader's check", () => {
  type Internals = {
    onConnected(addr: object, socket: unknown): void;
    send(addr: unknown, type: unknown, payload?: Buffer): void;
    handleFrame(h: object, p: Buffer, t: number): void;
  };
  const CONTROL = 2;
  const notify = (target: P2PSession, commandId: number, payload: Buffer): void =>
    (target as unknown as Internals).handleFrame(
      { commandId, signCode: 0, bytesToRead: payload.length },
      payload,
      CONTROL,
    );
  const refusal = (): Buffer => Buffer.from([0x99, 0xff, 0xff, 0xff]);

  it("re-sends on every third check while no cipher has been named, through cipher 0 and a refusal, then stops", async () => {
    vi.useFakeTimers();
    try {
      const target = session(async () => undefined);
      const asked: number[] = [];
      const internals = target as unknown as Internals;
      internals.send = (_addr, _type, payload) => {
        if (payload && payload.length >= 10 && payload.readUInt16LE(8) === 1100) asked.push(Date.now());
      };
      const start = Date.now();
      internals.onConnected({ host: "<cam-lan-ip>", port: 32100 }, undefined);
      expect(asked).toEqual([start]);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(asked, "no channel-2 frame, no check").toEqual([start]);

      for (const payload of [gatewayInfo(0), refusal(), Buffer.from("{}")]) {
        notify(target, payload.length === 2 ? 1351 : 1100, payload);
        await vi.advanceTimersByTimeAsync(1_001);
      }
      expect(asked).toEqual([start, start + 10_000 + 2 * 1_001]);

      notify(target, 1100, gatewayInfo(3));
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(1_001);
        notify(target, 1351, Buffer.from("{}"));
      }
      expect(asked).toHaveLength(2);
      await target.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * Standalone indoor cameras answer the gateway-info prompt in the clear (signCode 0) with the same 133-byte
 * layout a HomeBase seals at level 1. Measured on a fleet: three indoor cameras replied in the clear;
 * negotiating from that reply produced a key one of them then accepted a level-2 live start under.
 */
describe("a gateway-info reply sent in the clear", () => {
  it("negotiates the level-2 key from it", async () => {
    const resolveCipherKey = vi.fn(async () => undefined);
    const target = session(resolveCipherKey);

    (target as unknown as { handleFrame(h: object, p: Buffer, t: number): void }).handleFrame(
      { commandId: 1100, signCode: 0, version: 8, bytesToRead: 64 },
      gatewayInfo(97),
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveCipherKey).toHaveBeenCalledWith(97, 8);
  });
});
