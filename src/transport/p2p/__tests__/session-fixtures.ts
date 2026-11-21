import { createDecipheriv } from "node:crypto";
import { EventEmitter } from "node:events";
import { vi } from "vitest";
import { noopLogger, type Logger } from "../../../core/logger.js";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { LIVE_TRACE_MESSAGE, type LiveTrace } from "../live-trace.js";

/** Synthetic ids shared by the command-router specs — never a real device. */
export const DEVICE_SN = "T8114P0000000000";
export const STATION_SN = "T8010P0000000000";
/** The model the fixture's parent station reports, which a resolve states apart from the device on it. */
export const STATION_MODEL = "T8010";
export const ACCOUNT_ID = "0000000000000000000000000000000000000000";

/**
 * A fake connected `P2PSession`, for the specs that drive `P2PCommandRouter` without a wire.
 *
 * Every one of them needs the same two answers before the router will send anything — connected, and
 * whether a level-2 key is available — and those two cannot be allowed to disagree: a fake that reports no
 * key while answering a wait for one with `true` tests a GCM-keyed session that cannot exist. (A real session
 * holding only an RSA cipher's key does answer that way; the RSA specs drive a real session for it.) Building them together
 * here is what keeps the fakes honest and stops the next member added to the wait from having to be
 * remembered in every spec separately.
 *
 * A spec adds whatever send methods it asserts on; nothing here presumes which wire is under test.
 */
export interface FakeP2PSession extends EventEmitter {
  isConnected: boolean;
  /** The handle every trace about this session is emitted under, real sessions included. */
  traceId: string;
  hasLevel2Key: boolean;
  /** Sends once: delivery is the real session's concern, so the fake device takes each send as one command. */
  sendAcknowledged: ReturnType<typeof vi.fn>;
}

/**
 * Run `call` on fake timers, every timed wait in it expired at once, then hand back its outcome.
 *
 * The router holds a device's slot until a command's answer or its deadline; on real timers each such spec
 * waits through it. A rejection that lands while the timers run is the caller's to assert.
 */
export async function onFakeTime<T>(call: () => Promise<T>): Promise<T> {
  vi.useFakeTimers();
  try {
    const outcome = call();
    outcome.catch(() => {});
    await vi.runAllTimersAsync();
    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}

/** A connected session that either has a level-2 key or has settled that it will not get one. */
export function connectedSession(hasLevel2Key = true): FakeP2PSession {
  const session = new EventEmitter() as FakeP2PSession;
  session.isConnected = true;
  session.traceId = "station-fake";
  session.hasLevel2Key = hasLevel2Key;
  session.sendAcknowledged = vi.fn((send: () => boolean) => send());
  (session as unknown as { sendPing: () => void }).sendPing = vi.fn();
  return session;
}

/**
 * A session that has not connected, and does not while a spec waits on it.
 *
 * Every call on a station holds for this before anything is sent, so it is the state that separates a station
 * that could not be reached from one that answered and refused.
 */
export function disconnectedSession(): FakeP2PSession {
  const session = connectedSession(false);
  session.isConnected = false;
  return session;
}

/**
 * A logger that keeps every live trace passed through it, in order.
 *
 * Traces reach a host as one debug message with a payload, so collecting them here is the same view a host
 * has — including the `source` handle that groups an attempt, which asserting on an emitter would not see.
 */
export function traceCollector(): { logger: Logger; traces: (LiveTrace & { source?: string })[] } {
  const traces: (LiveTrace & { source?: string })[] = [];
  return {
    logger: {
      ...noopLogger,
      debug: (message: string, ...args: unknown[]) => {
        if (message === LIVE_TRACE_MESSAGE) traces.push(args[0] as LiveTrace & { source?: string });
      },
    },
    traces,
  };
}

/**
 * A `P2PCommandRouter` wired to one fake station session — the shared harness every command-router
 * spec needs: the same deps, the same `DEVICE_SN`/`STATION_SN`/`ACCOUNT_ID` device record, and the
 * manager registration. A spec overrides only what it exercises (a blank account id, a caller that
 * skips registration to hit the no-session path, or extra deps).
 */
export function routerWithSession(
  session: FakeP2PSession,
  opts: { accountId?: string; register?: boolean; deps?: Partial<P2PRouterDeps> } = {},
): P2PCommandRouter {
  const accountId = opts.accountId ?? ACCOUNT_ID;
  const deps: P2PRouterDeps = {
    mega: {} as P2PRouterDeps["mega"],
    listDevices: () => [
      {
        sn: DEVICE_SN,
        stationSn: STATION_SN,
        model: "T8114",
        channel: 1,
        raw: { parent_sn: STATION_SN, device_channel: 1, member: { admin_user_id: accountId } },
      } as never,
      // The parent station, listed but endpoint-less: with nothing registered, a cold open fails at
      // session resolution rather than hanging — which is what `register: false` exercises.
      {
        sn: STATION_SN,
        stationSn: STATION_SN,
        p2pDid: "",
        model: STATION_MODEL,
        raw: { member: { admin_user_id: accountId } },
      } as never,
    ],
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
    ...opts.deps,
  };
  const router = new P2PCommandRouter(deps);
  if (opts.register ?? true) {
    (router as unknown as { manager: { register(sn: string, value: unknown): void } }).manager.register(
      STATION_SN,
      session,
    );
  }
  return router;
}

/**
 * Put a real session where the app's native step of a gateway info naming a cipher puts it: sign mode 1, the level-1
 * key in the ECB slot, negotiated version `version`. Its sends then seal at once, AES-128-ECB under the level-1 key
 * for version 1.
 */
export function atSignMode1(session: object, version = 1): void {
  (session as { gatewayInfoSlots(cipherId: number, version: number): void }).gatewayInfoSlots(1, version);
}

/**
 * Open a frame a real session sent under its GCM slot: `tag(16) ‖ nonce(12) ‖ sub-header(4) ‖ ciphertext`, AAD
 * "eufy security". Answers `undefined` where it does not open.
 */
export function openSentGcm(session: object, body: Buffer): Buffer | undefined {
  const key = (session as { gcmKey?: Buffer }).gcmKey;
  if (!key) return undefined;
  try {
    const d = createDecipheriv("aes-256-gcm", key, body.subarray(16, 28));
    d.setAAD(Buffer.from("eufy security"));
    d.setAuthTag(body.subarray(0, 16));
    return Buffer.concat([d.update(body.subarray(32)), d.final()]);
  } catch {
    return undefined;
  }
}

/** Put a real session where a version-8 gateway info and its unwrapped key put it: version 8, sign mode 8, `key`. */
export function withGcmKey(session: { setLevel2Key(key: Buffer): void }, key: Buffer): void {
  atSignMode1(session, 8);
  session.setLevel2Key(key);
}
