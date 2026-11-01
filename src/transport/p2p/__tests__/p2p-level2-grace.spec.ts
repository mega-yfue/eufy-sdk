import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";

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
  (target as unknown as { negotiateLevel2Key(payload: Buffer): void }).negotiateLevel2Key(gatewayInfo(cipherId));
}

/**
 * The key is negotiated once per connection, from the station's `CMD_GATEWAYINFO` reply. Every operation
 * that needs it therefore asks the same question of the same session. Best-effort media uses one grace per
 * session; commands that require the key retain a per-call grace because they cannot proceed without it.
 */
describe("level-2 key wait", () => {
  it("answers at once when the key is already negotiated", async () => {
    const target = session(async () => undefined);
    target.setLevel2Key(LEVEL2_KEY);
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
    setTimeout(() => target.setLevel2Key(LEVEL2_KEY), 10);
    await expect(waiting).resolves.toBe(true);
  });

  it("removes its waiter and deadline when a key arrives early", async () => {
    vi.useFakeTimers();
    try {
      const target = session(async () => undefined);
      const waiting = target.awaitLevel2Key(25_000);
      expect((target as unknown as { level2Waiters: unknown[] }).level2Waiters).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);

      target.setLevel2Key(LEVEL2_KEY);
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
    target.setLevel2Key(LEVEL2_KEY);
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
    setTimeout(() => target.setLevel2Key(LEVEL2_KEY), 10);

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
    target.setLevel2Key(LEVEL2_KEY);
    expect(target.hasLevel2Key).toBe(true);

    await target.close();

    expect(target.hasLevel2Key).toBe(false);
  });
});

/**
 * Asking again after a negotiation concluded without a key.
 *
 * The negotiation is one-shot per connection: the station is prompted for `CMD_GATEWAYINFO` on connect, and
 * if that reply never lands the session settles "no key" and every later wait answers false at once. That is
 * correct for best-effort media, which proceeds at level-1 — but a command whose only wire is level-2 is then
 * refused for the whole life of that connection, though a fresh session negotiates a key normally.
 *
 * Measured: an own-session camera whose power rides the level-2 privacy envelope refused `setEnabled` with
 * "level-2 key not ready" and stayed refused, leaving the camera switched off; opening a stream built a new
 * session, which negotiated (cipher id observed) and let the same write through immediately.
 *
 * So a caller that cannot proceed without the key may ask the station ONE more time. Media never does — it
 * has a level-1 path and re-prompting on every frame would be noise.
 */
describe("level-2 key re-prompt", () => {
  it("re-prompts the station once when a settled negotiation left no key", async () => {
    const target = session(async () => "00".repeat(32));
    const sent: number[] = [];
    (target as unknown as { sendCommand(c: number): void }).sendCommand = (c) => sent.push(c);
    (target as unknown as { connectAddress?: object }).connectAddress = { host: "0.0.0.0", port: 1 };

    // Conclude the negotiation with no key — what a GATEWAYINFO reply that never lands amounts to.
    (target as unknown as { settleLevel2(): void }).settleLevel2();
    // The wait is then already exhausted: it answers at once rather than spending its grace.
    await expect(target.awaitLevel2Key(25_000)).resolves.toBe(false);

    const asked = target.repromptLevel2Key();

    expect(asked).toBe(true);
    expect(sent).toEqual([1100]); // CMD_GATEWAYINFO
    // Re-opened: the wait now spends its grace again instead of refusing instantly, so a reply that
    // arrives late can still satisfy it.
    const started = Date.now();
    await expect(target.awaitLevel2Key(120)).resolves.toBe(false);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it("does not re-prompt a session that already holds a key", () => {
    const target = session(async () => "00".repeat(32));
    const sent: number[] = [];
    (target as unknown as { sendCommand(c: number): void }).sendCommand = (c) => sent.push(c);
    target.setLevel2Key(LEVEL2_KEY);

    expect(target.repromptLevel2Key()).toBe(false);
    expect(sent).toEqual([]);
  });

  it("does not re-prompt a session that never negotiates one at all", () => {
    const target = session(); // no resolveCipherKey → nothing can negotiate
    const sent: number[] = [];
    (target as unknown as { sendCommand(c: number): void }).sendCommand = (c) => sent.push(c);

    expect(target.repromptLevel2Key()).toBe(false);
    expect(sent).toEqual([]);
  });

  it("asks at most once per connection, so a burst of commands cannot flood the station", () => {
    const target = session(async () => "00".repeat(32));
    const sent: number[] = [];
    (target as unknown as { sendCommand(c: number): void }).sendCommand = (c) => sent.push(c);
    (target as unknown as { connectAddress?: object }).connectAddress = { host: "0.0.0.0", port: 1 };

    expect(target.repromptLevel2Key()).toBe(true);
    expect(target.repromptLevel2Key()).toBe(false);
    expect(target.repromptLevel2Key()).toBe(false);
    expect(sent).toEqual([1100]);
  });

  /**
   * The reply to the re-prompt is negotiated like the first one. A negotiation that concluded without a
   * key leaves the gate open, so the reply to the re-prompt runs the cipher lookup again and settles the
   * re-opened wait.
   */
  it("negotiates the reply to the re-prompt after a first negotiation left no key", async () => {
    const resolveCipherKey = vi.fn(async () => undefined);
    const target = session(resolveCipherKey);
    (target as unknown as { sendCommand(c: number): void }).sendCommand = () => {};
    (target as unknown as { connectAddress?: object }).connectAddress = { host: "0.0.0.0", port: 1 };
    const reply = (): void =>
      (target as unknown as { handleFrame(h: object, p: Buffer, t: number): void }).handleFrame(
        { commandId: 1100, signCode: 0, bytesToRead: 64 },
        gatewayInfo(3),
        0,
      );

    reply();
    await expect(target.awaitLevel2Key(25_000)).resolves.toBe(false);
    expect(target.repromptLevel2Key()).toBe(true);

    const started = Date.now();
    const waiting = target.awaitLevel2Key(1_000, "call");
    reply();

    await expect(waiting).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(resolveCipherKey).toHaveBeenCalledTimes(2);
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
      { commandId: 1100, signCode: 0, bytesToRead: 64 },
      gatewayInfo(97),
      0,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resolveCipherKey).toHaveBeenCalledWith(97);
  });
});
