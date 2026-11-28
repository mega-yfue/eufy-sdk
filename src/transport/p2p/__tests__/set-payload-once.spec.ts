import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../../core/contracts.js";
import { ACCOUNT_ID, connectedSession, routerWithSession, type FakeP2PSession } from "./session-fixtures.js";

/**
 * A `set-payload` marked `once` (a dog camera's treat toss): one envelope through ONE `sendAcknowledged` send —
 * never the replay burst, never an answer wait, never a resend on silence or on a result code — and one at a
 * time per device. A dispensing command repeated is a second treat.
 */

/** A standalone camera: its own station, so the router resolves its own session. */
const CAMERA_SN = "T7200P0000000000";
/** The record's channel. The command states its own, and the router must send on the command's. */
const RECORD_CHANNEL = 0;
const COMMAND_CHANNEL = 3;

interface OnceSession extends FakeP2PSession {
  sendSetPayload: ReturnType<typeof vi.fn>;
  sendControlLevel2: ReturnType<typeof vi.fn>;
}

const toss = (value: number): Command => ({
  kind: "set-payload",
  cmd: 7001,
  payload: { value },
  channel: COMMAND_CHANNEL,
  once: true,
});

function harness(
  opts: { send?: (...args: unknown[]) => void; attached?: boolean; level2?: boolean; ecbKeyOnly?: boolean } = {},
) {
  const session = connectedSession(opts.level2 ?? false) as OnceSession;
  session.setPayloadKeyOnly = opts.ecbKeyOnly ?? false;
  session.sendSetPayload = vi.fn(opts.send ?? (() => {}));
  session.sendControlLevel2 = vi.fn(() => true);
  const member = { admin_user_id: ACCOUNT_ID };
  const stationSn = opts.attached ? "T8010P0000000000" : CAMERA_SN;
  const router = routerWithSession(session, {
    register: false,
    deps: {
      listDevices: () =>
        [
          {
            sn: CAMERA_SN,
            stationSn,
            model: "T7200",
            channel: RECORD_CHANNEL,
            raw: { ...(opts.attached ? { parent_sn: stationSn } : {}), device_channel: RECORD_CHANNEL, member },
          },
          ...(opts.attached ? [{ sn: stationSn, stationSn, model: "T8010", raw: { member } }] : []),
        ] as never,
    },
  });
  (router as unknown as { manager: { register(sn: string, value: unknown): void } }).manager.register(
    stationSn,
    session,
  );
  const dispatch = (cmd: Command) => router.dispatchCommand(CAMERA_SN, cmd);
  return { session, router, dispatch };
}

const sentValues = (session: OnceSession) =>
  session.sendSetPayload.mock.calls.map((c) => (c[1] as { value: number }).value);

describe("P2PCommandRouter set-payload once", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends one envelope inside one acknowledged send, with the admin id, on the command's channel", async () => {
    const { session, dispatch } = harness();
    await expect(dispatch(toss(2))).resolves.toBe(false);
    expect(session.sendAcknowledged).toHaveBeenCalledTimes(1);
    expect(session.sendSetPayload).toHaveBeenCalledTimes(1);
    expect(session.sendSetPayload).toHaveBeenCalledWith(
      7001,
      { value: 2 },
      { accountId: ACCOUNT_ID, channel: COMMAND_CHANNEL },
    );
    expect(session.sendControlLevel2).not.toHaveBeenCalled();
  });

  it("does not wait for an answer or resend when the device stays silent", async () => {
    vi.useFakeTimers();
    const { session, dispatch } = harness();
    const outcome = dispatch(toss(3));
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(outcome).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(session.sendSetPayload).toHaveBeenCalledTimes(1);
  });

  it("does not resend on a retryable or a failing result code that arrives while it is in flight", async () => {
    vi.useFakeTimers();
    const h = harness({
      send: () =>
        queueMicrotask(() => {
          // Results the answered route would recognise as this envelope's (same command id and channel).
          h.session.emit("commandResult", { code: 5, channel: COMMAND_CHANNEL, commandId: 1350 });
          h.session.emit("commandResult", { code: -108, channel: COMMAND_CHANNEL, commandId: 1350 });
        }),
    });
    const outcome = h.dispatch(toss(1));
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(outcome).resolves.toBe(false);
    expect(h.session.sendSetPayload).toHaveBeenCalledTimes(1);
  });

  it("holds a second request until the first has been handed over", async () => {
    const { session, router, dispatch } = harness();
    const internals = router as unknown as { resolveSession: (...args: unknown[]) => Promise<unknown> };
    const real = internals.resolveSession.bind(router);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const resolveSpy = vi.fn(async (...args: unknown[]) => {
      if (resolveSpy.mock.calls.length === 1) await held;
      return real(...args);
    });
    internals.resolveSession = resolveSpy;

    const first = dispatch(toss(1));
    const second = dispatch(toss(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(session.sendSetPayload).not.toHaveBeenCalled();

    release();
    await Promise.all([first, second]);
    expect(resolveSpy).toHaveBeenCalledTimes(2);
    expect(sentValues(session)).toEqual([1, 3]);
  });

  it("rejects without retrying when the session cannot send, and the next request still goes", async () => {
    let calls = 0;
    const { session, dispatch } = harness({
      send: () => {
        calls += 1;
        if (calls === 1) throw new Error("not connected");
      },
    });
    const first = dispatch(toss(1));
    const second = dispatch(toss(2));
    await expect(first).rejects.toThrow("not connected");
    await expect(second).resolves.toBe(false);
    expect(sentValues(session)).toEqual([1, 2]);
  });

  it("refuses a session that holds a level-2 key, sending nothing", async () => {
    const { session, dispatch } = harness({ level2: true });
    await expect(dispatch(toss(2))).rejects.toThrow("own keyless session only");
    expect(session.sendSetPayload).not.toHaveBeenCalled();
    expect(session.sendControlLevel2).not.toHaveBeenCalled();
  });

  it("keeps one request in flight per device: the next waits until the first is acknowledged", async () => {
    const { session, dispatch } = harness();
    const acknowledge: (() => void)[] = [];
    session.sendAcknowledged.mockImplementation((send: () => boolean, onSettled?: () => void) => {
      const sent = send();
      if (onSettled) acknowledge.push(onSettled);
      return sent;
    });

    await expect(dispatch(toss(1))).resolves.toBe(false); // the caller settles at the handoff
    const second = dispatch(toss(3));
    await new Promise((r) => setTimeout(r, 20));
    expect(sentValues(session)).toEqual([1]); // the first is not acknowledged yet

    acknowledge[0]!();
    await expect(second).resolves.toBe(false);
    expect(sentValues(session)).toEqual([1, 3]);
  });

  it("gives the device's turn back after the hold when the session reports nothing", async () => {
    vi.useFakeTimers();
    const { session, dispatch } = harness();
    session.sendAcknowledged.mockImplementation((send: () => boolean) => send()); // never reports settled

    const first = dispatch(toss(1));
    await vi.advanceTimersByTimeAsync(10);
    await expect(first).resolves.toBe(false);
    const second = dispatch(toss(3));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sentValues(session)).toEqual([1]);
    await vi.advanceTimersByTimeAsync(600);
    await expect(second).resolves.toBe(false);
    expect(sentValues(session)).toEqual([1, 3]);
  });

  it("rejects, sending nothing, when the session closes while its key settles", async () => {
    const { session, dispatch } = harness();
    session.awaitLevel2Key.mockImplementation(async () => {
      session.isConnected = false; // closed during the wait
      return false;
    });
    await expect(dispatch(toss(2))).rejects.toThrow("session closed before the send");
    expect(session.sendAcknowledged).not.toHaveBeenCalled();
    expect(session.sendSetPayload).not.toHaveBeenCalled();
  });

  it("refuses a session that holds only an RSA cipher's set-payload key, sending nothing", async () => {
    const { session, dispatch } = harness({ ecbKeyOnly: true });
    await expect(dispatch(toss(2))).rejects.toThrow("own keyless session only");
    expect(session.sendSetPayload).not.toHaveBeenCalled();
    expect(session.sendControlLevel2).not.toHaveBeenCalled();
  });

  it("sends nothing for requests whose time ran out while they waited, counted from when each was asked for", async () => {
    vi.useFakeTimers();
    const { session, router, dispatch } = harness();
    const internals = router as unknown as { resolveSession: (...args: unknown[]) => Promise<unknown> };
    const real = internals.resolveSession.bind(router);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const resolveSpy = vi.fn(async (...args: unknown[]) => {
      if (resolveSpy.mock.calls.length === 1) await held;
      return real(...args);
    });
    internals.resolveSession = resolveSpy;

    // The first request's station takes longer than the deadline to come up; the second waits behind it.
    const first = dispatch(toss(1));
    const second = dispatch(toss(3));
    first.catch(() => {});
    second.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_001);
    release();

    await expect(first).rejects.toThrow("not sent");
    await expect(second).rejects.toThrow("not sent");
    // The second never reached the station: its time was up when its turn came.
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(session.sendAcknowledged).not.toHaveBeenCalled();
    expect(session.sendSetPayload).not.toHaveBeenCalled();
  });

  it("refuses a camera behind a HomeBase, sending nothing", async () => {
    const { session, dispatch } = harness({ attached: true });
    await expect(dispatch(toss(2))).rejects.toThrow("own keyless session only");
    expect(session.sendSetPayload).not.toHaveBeenCalled();
    expect(session.sendControlLevel2).not.toHaveBeenCalled();
  });
});
