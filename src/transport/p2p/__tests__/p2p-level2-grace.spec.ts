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
  return built;
}

function negotiate(target: P2PSession, cipherId = 3): void {
  (target as unknown as { negotiateLevel2Key(payload: Buffer, version: number): void }).negotiateLevel2Key(
    gatewayInfo(cipherId),
    8,
  );
}

/** A cipher lookup belongs to the connection that received its gateway info. */
describe("a cipher lookup across connections", () => {
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
    });
    resolveCipher?.(undefined);
    await Promise.resolve();
    await Promise.resolve();

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
    });
    rejectCipher?.(new Error("stale lookup"));
    await Promise.resolve();
    await Promise.resolve();

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
