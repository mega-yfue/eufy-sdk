import { describe, expect, it, vi } from "vitest";
import { StationKeyUnavailableError } from "../../../core/contracts.js";
import { P2PCommandRouter, type P2PRouterDeps } from "../command-router.js";
import { connectedSession, type FakeP2PSession } from "./session-fixtures.js";

const DEVICE_SN = "T8000P0000000000";
const STATION_SN = "T8000P0000000001";
const ACCOUNT_ID = "0000000000000000000000000000000000000000";

const HARD_GRACE_MS = 25_000;
const SETTLE_GRACE_MS = 8_000;

interface FakeSession extends FakeP2PSession {
  sendSetPayload: ReturnType<typeof vi.fn>;
  sendControlLevel2: ReturnType<typeof vi.fn>;
  sendRawLevel2: ReturnType<typeof vi.fn>;
  sendStringPayloadCommand: ReturnType<typeof vi.fn>;
  sendIntStringCommand: ReturnType<typeof vi.fn>;
}

function setup(hasLevel2Key: boolean, attached = true) {
  const session = connectedSession(hasLevel2Key) as FakeSession;
  session.sendSetPayload = vi.fn();
  session.sendControlLevel2 = vi.fn(() => true);
  session.sendRawLevel2 = vi.fn(() => true);
  session.sendStringPayloadCommand = vi.fn();
  session.sendIntStringCommand = vi.fn();
  const deps: P2PRouterDeps = {
    mega: {} as P2PRouterDeps["mega"],
    listDevices: () => [
      {
        sn: DEVICE_SN,
        stationSn: attached ? STATION_SN : DEVICE_SN,
        channel: 1,
        raw: {
          ...(attached ? { parent_sn: STATION_SN } : {}),
          device_channel: 1,
          member: { admin_user_id: ACCOUNT_ID },
        },
      } as never,
    ],
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  };
  const router = new P2PCommandRouter(deps);
  (router as unknown as { manager: { register(sn: string, value: unknown): void } }).manager.register(
    attached ? STATION_SN : DEVICE_SN,
    session,
  );
  return { router, session };
}

/**
 * The key belongs to one connection of the session, is negotiated once from its gateway-info reply, and
 * every operation that needs it asks that session. Best-effort media uses one grace per session because it
 * can proceed without the key; a command that cannot be framed without the key owns a per-call grace.
 */
describe("resolving a session defers the level-2 wait to the session", () => {
  /**
   * A camera on its own session does not wait for the key at all.
   *
   * `sendStartLiveOwnSession` reads `level2Key` when it sends, so the framing is chosen per command and not
   * per session: a start issued with no key rides level 1, and the warm-up's own re-issue two seconds later
   * rides level 2 if the key has landed by then. Blocking first buys nothing that re-issuing does not, and
   * best-effort means the caller can proceed without the key by definition — measured on three standalone
   * cameras, all three waited the full 8 s grace for a key that never arrives and then produced a keyframe
   * within 400 ms of finally starting.
   */
  it("does not wait for a key its start does not need, for a camera on its own session", async () => {
    const { router, session } = setup(false, false);
    const source = await router.sharedLiveSourceFor(DEVICE_SN);
    expect(source).toBeDefined();
    expect(session.awaitLevel2Key).not.toHaveBeenCalled();
  });

  /**
   * A caller that picks its seal ONCE waits for the negotiation to settle first.
   *
   * `sendBySessionLevel` reads `hasLevel2Key` and frames the command on that answer, with no second chance:
   * unlike a media start, which reads the key on every send and is re-issued by the warm-up, a property write
   * framed level-1 to a family that only accepts level-2 is simply ignored. So it waits, session-scoped and
   * bounded, and proceeds with whatever the negotiation concluded.
   */
  it("waits for the negotiation to settle before choosing a seal, session-scoped", async () => {
    const { router, session } = setup(false);
    await router
      .dispatchCommand(DEVICE_SN, { kind: "set-param", param: 6, value: 0, form: "auto", channel: 1 })
      .catch(() => undefined);
    expect(session.awaitLevel2Key).toHaveBeenCalledWith(SETTLE_GRACE_MS, "session");
  });

  /**
   * An attached camera's start has no level-1 form, so best-effort was the wrong ask for it: the send returns
   * without putting anything on the wire, and the warm-up then re-issues that nothing every interval until it
   * times out. Measured on a real account as 48 starts with no key, one keyframe between them, and a
   * `source-error` at the end.
   */
  it("refuses an attached camera's source where the session reports no key", async () => {
    const { router } = setup(false);
    await expect(router.sharedLiveSourceFor(DEVICE_SN)).rejects.toBeInstanceOf(StationKeyUnavailableError);
  });

  it("hands over an attached camera's source once the key is held", async () => {
    const { router } = setup(true);
    await expect(router.sharedLiveSourceFor(DEVICE_SN)).resolves.toBeDefined();
  });

  it("asks with the full grace where the key is a requirement", async () => {
    const { router, session } = setup(true);
    await router.p2pQuery(DEVICE_SN, 6237, { timeoutMs: 5 }).catch(() => {});
    expect(session.awaitLevel2Key).toHaveBeenCalledWith(HARD_GRACE_MS, "call");
  });

  /** A requirement the session reports it cannot meet is a refusal now, not a wait that ends in one. */
  it("refuses a command that requires a key the session answers it will not have", async () => {
    const { router } = setup(false);
    await expect(router.p2pQuery(DEVICE_SN, 6237, { timeoutMs: 5 })).rejects.toBeInstanceOf(StationKeyUnavailableError);
  });

  /** Most commands ride level 1 and never need the key, so nothing may make them wait for it. */
  it("does not ask at all for a command that rides level one", async () => {
    const { router, session } = setup(false);
    await router.dispatchCommand(DEVICE_SN, { kind: "p2p-int-string", cmd: 1202, value: 10, valueSub: 1, channel: 1 });
    expect(session.awaitLevel2Key).not.toHaveBeenCalled();
  });
});

/**
 * The `1350` SET_PAYLOAD envelope on a station that will never hold a level-2 key.
 *
 * Pinned to level 2 this frame is not slow on such a station, it is UNSENDABLE — and it does not say so:
 * the required-key path spends the full grace, re-prompts, spends it again, and only then refuses, so a
 * caller bounding the call more tightly than that reports a timeout and never learns the frame went
 * nowhere. A T8410 is such a station. `"auto"` is what the capability layer passes to leave the seal to
 * the session; these pin what that then does on each kind of station.
 */
describe("a set-payload whose seal is the session's", () => {
  /** How many times a fire-and-forget control is repeated on this router (`DIRECT_CMD_SENDS`). */
  const REPLAYS = 5;

  const envelope = (form?: "auto") =>
    ({ kind: "set-payload", cmd: 1224, payload: { mode_type: 63 }, channel: 0, mValue3: 0, form }) as const;

  it("sends it level-1 to a keyless own-session station, replayed, without a per-call wait", async () => {
    const { router, session } = setup(false, false);

    await router.dispatchCommand(DEVICE_SN, envelope("auto"));

    expect(session.sendSetPayload).toHaveBeenCalledTimes(REPLAYS);
    expect(session.sendControlLevel2).not.toHaveBeenCalled();
    // The settle wait, charged from connect — never the per-call grace the required-key path spends.
    expect(session.awaitLevel2Key).toHaveBeenCalledWith(SETTLE_GRACE_MS, "session");
    expect(session.awaitLevel2Key).not.toHaveBeenCalledWith(HARD_GRACE_MS, "call");
  });

  /** The behaviour every still-pinned `setPayload` keeps, and the one the fix removed from the rest. */
  it("refuses the same frame with no form, after spending both graces on a key that never comes", async () => {
    const { router, session } = setup(false, false);

    await expect(router.dispatchCommand(DEVICE_SN, envelope())).rejects.toBeInstanceOf(StationKeyUnavailableError);

    expect(session.awaitLevel2Key).toHaveBeenCalledWith(HARD_GRACE_MS, "call");
    expect(session.sendSetPayload).not.toHaveBeenCalled();
  });

  /** A keyed station is untouched by the downgrade: same envelope, same seal, same replay as before. */
  it("still seals it level-2 where the session holds a key", async () => {
    const { router, session } = setup(true, false);

    await router.dispatchCommand(DEVICE_SN, envelope("auto"));

    expect(session.sendControlLevel2).toHaveBeenCalledTimes(REPLAYS);
    expect(session.sendSetPayload).not.toHaveBeenCalled();
  });
});

/**
 * A command that cannot be framed without the key gets ONE more ask before being refused.
 *
 * The negotiation is one-shot per connection, so a gateway reply that never landed otherwise refuses every
 * later such command on that connection, although a fresh session over the same device negotiates a key
 * normally: measured, a settled session refused every level-2-only operation until it was rebuilt, at which
 * point the station answered with a cipher id straight away.
 */
describe("a required level-2 key is asked for twice before refusing", () => {
  it("proceeds when the station answers the second ask", async () => {
    const { router, session } = setup(false);
    session.keyArrivesOnReprompt = true;

    await expect(router.p2pQuery(DEVICE_SN, 6237, { timeoutMs: 5 })).rejects.not.toBeInstanceOf(
      StationKeyUnavailableError,
    );

    expect(session.repromptLevel2Key).toHaveBeenCalledTimes(1);
    expect(session.awaitLevel2Key).toHaveBeenCalledTimes(2);
  });

  it("still refuses when there is no second ask to be had", async () => {
    const { router, session } = setup(false);

    await expect(router.p2pQuery(DEVICE_SN, 6237, { timeoutMs: 5 })).rejects.toBeInstanceOf(StationKeyUnavailableError);

    expect(session.repromptLevel2Key).toHaveBeenCalledTimes(1);
  });

  it("never re-prompts a session that already holds a key", async () => {
    const { router, session } = setup(true);

    await router.p2pQuery(DEVICE_SN, 6237, { timeoutMs: 5 }).catch(() => {});

    expect(session.repromptLevel2Key).not.toHaveBeenCalled();
  });
});

/**
 * A session whose path stopped answering the heartbeat is rebuilt before anything is committed to it.
 *
 * Measured on a wired camera: idle 18 s, resumed, twenty byte-identical retransmits with no acknowledgement,
 * and a rebuilt session streaming at once — seven seconds of black screen, three of them spent discovering
 * what the unanswered heartbeat had already established.
 *
 * A station that has never ponged is untouched: silence is only evidence where an answer was once given.
 */
describe("resolving a session whose path has gone silent", () => {
  it("rebuilds it rather than handing a caller a path that stopped answering", async () => {
    const { router, session } = setup(true);
    (session as unknown as { pathAnswering: boolean }).pathAnswering = false;
    const manager = (router as unknown as { manager: { close: (sn: string) => Promise<void> } }).manager;
    const closed: string[] = [];
    manager.close = async (sn) => void closed.push(sn);

    await router.sharedLiveSourceFor(DEVICE_SN).catch(() => undefined);

    expect(closed).toContain(STATION_SN);
  });

  it("hands over a path that has never answered, that being no evidence at all", async () => {
    const { router, session } = setup(true);
    (session as unknown as { pathAnswering: boolean }).pathAnswering = true;
    const manager = (router as unknown as { manager: { close: (sn: string) => Promise<void> } }).manager;
    const closed: string[] = [];
    manager.close = async (sn) => void closed.push(sn);

    await router.sharedLiveSourceFor(DEVICE_SN).catch(() => undefined);

    expect(closed).toEqual([]);
  });
});
