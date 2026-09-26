import { describe, expect, it, vi } from "vitest";
import { P2PCommandRouter } from "../command-router.js";

/**
 * A shared live source is created once per station+channel; every later caller joins the existing one,
 * so the options it passes are dropped. The failure mode that drop produces is a battery camera
 * streaming unbounded because whichever egress opened the source first did not pass `powered`. Nothing
 * can be re-applied from a later caller, so a conflict against a LIVE source is reported — while a
 * source that has since stopped is dropped and rebuilt from the new options. A local power-policy
 * change is separate: it updates the existing source directly.
 */
function poweredOf(source: unknown): string | undefined {
  return (source as { opts: { powered?: string } }).opts.powered;
}

function routerWithSession(logger: { warn: ReturnType<typeof vi.fn> }) {
  const router = new P2PCommandRouter({
    mega: {} as never,
    logger: logger as never,
    listDevices: () => [],
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  });
  (router as unknown as { resolveSession: unknown }).resolveSession = async () => ({
    session: { on: () => {}, off: () => {} },
    parentSn: "T8000P0000000000",
    channel: 0,
    accountId: "",
    homeBaseAttached: false,
  });
  return router;
}

/** Replace source construction with a recorder, so a spec reads the options an egress passed. */
function interceptSourceOptions(router: P2PCommandRouter): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = [];
  (router as unknown as { sharedLiveSourceFor: unknown }).sharedLiveSourceFor = async (
    _sn: string,
    opts: Record<string, unknown>,
  ) => {
    seen.push(opts);
    throw new Error("stop here — only the options matter");
  };
  return seen;
}

/**
 * The options the FIRST caller passes have to actually REACH the source it builds. Construction and
 * conflict reporting are separate contracts: a warning proves that later options were compared, not that
 * the first options were applied to the source.
 */
describe("shared live source construction", () => {
  it("uses a power claim changed while the source was waiting for its session", async () => {
    const router = routerWithSession({ warn: vi.fn() });
    const pendingSession = Promise.withResolvers<Record<string, unknown>>();
    (router as any).resolveSession = () => pendingSession.promise;
    const opening = router.sharedLiveSourceFor("T8000P0000000000", { powered: "wired" });
    router.updatePowerTier("T8000P0000000000", "battery");
    pendingSession.resolve({
      session: { on: () => {}, off: () => {} },
      parentSn: "T8000P0000000000",
      channel: 0,
      accountId: "",
      homeBaseAttached: false,
    });
    expect(poweredOf(await opening)).toBe("battery");
  });

  it("builds the source with the power hint the first caller passed", async () => {
    const router = routerWithSession({ warn: vi.fn() });
    const source = await router.sharedLiveSourceFor("T8000P0000000000", { powered: "battery" });
    expect(poweredOf(source)).toBe("battery");
  });

  it("carries a wired hint through just as faithfully", async () => {
    const router = routerWithSession({ warn: vi.fn() });
    const source = await router.sharedLiveSourceFor("T8000P0000000000", { powered: "wired" });
    expect(poweredOf(source)).toBe("wired");
  });

  it("passes the budget timings the first caller chose", async () => {
    const router = routerWithSession({ warn: vi.fn() });
    const source = await router.sharedLiveSourceFor("T8000P0000000000", {
      powered: "battery",
      batteryBudgetMs: 8000,
      budgetGraceMs: 5000,
    });
    const opts = (source as unknown as { opts: { batteryBudgetMs?: number; budgetGraceMs?: number } }).opts;
    expect(opts.batteryBudgetMs).toBe(8000);
    expect(opts.budgetGraceMs).toBe(5000);
  });

  /**
   * A stopped source's pull is dead, so re-using it protects nothing — while keeping it meant the first
   * caller's options outlived the session they were chosen for, still dictating the budget for a pull
   * warmed hours later.
   */
  it("rebuilds from the new caller's options once a stopped source has no consumers", async () => {
    const logger = { warn: vi.fn() };
    const router = routerWithSession(logger);

    const first = await router.sharedLiveSourceFor("T8000P0000000000", { powered: "battery" });
    (first as unknown as { _state: string })._state = "stopped";

    const second = await router.sharedLiveSourceFor("T8000P0000000000", { powered: "wired" });

    expect(second).not.toBe(first);
    expect(poweredOf(second)).toBe("wired");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("still joins a source that is running, rather than rebuilding under its consumers", async () => {
    const router = routerWithSession({ warn: vi.fn() });
    const first = await router.sharedLiveSourceFor("T8000P0000000000", { powered: "battery" });
    const second = await router.sharedLiveSourceFor("T8000P0000000000", { powered: "battery" });
    expect(second).toBe(first);
  });
});

/**
 * Both snapshot egresses can be the call that CREATES the source — an install polling a still on a
 * battery camera warms the pull before anyone watches — so they carry the hint like every other egress.
 */
describe("shared live source options from the snapshot egresses", () => {
  it("arms the budget when snapshotLive is what warmed the source", async () => {
    const router = routerWithSession({ warn: vi.fn() });
    const seen = interceptSourceOptions(router);

    await router
      .mediaProviderFor("T8000P0000000000")
      .snapshotLive({ powered: "battery" })
      .catch(() => {});

    expect(seen).toEqual([{ powered: "battery" }]);
  });
});

/**
 * The pre-event window is fixed when a source is CONSTRUCTED — nothing can widen a pull that consumers
 * are already attached to. So whichever egress opens the source decides whether a window exists at all,
 * and an egress that cannot ask for one silently denies it to every egress that joins later: a still
 * polled seconds before a recording leaves that recording nothing to drain, however much it asked for.
 * Every egress therefore carries it, for exactly the reason every egress carries `powered`.
 */
describe("the pre-event window every egress may be the one to configure", () => {
  it("configures the window when a live stream opens the source", async () => {
    const router = routerWithSession({ warn: vi.fn() });
    const seen = interceptSourceOptions(router);

    await router
      .mediaProviderFor("T8000P0000000000")
      .live({ preBufferSeconds: 4 })
      .catch(() => {});

    expect(seen[0]).toMatchObject({ preBufferSeconds: 4 });
  });

  it("configures the window when a still opens the source", async () => {
    const router = routerWithSession({ warn: vi.fn() });
    const seen = interceptSourceOptions(router);

    await router
      .mediaProviderFor("T8000P0000000000")
      .snapshotLive({ preBufferSeconds: 4 })
      .catch(() => {});

    expect(seen[0]).toMatchObject({ preBufferSeconds: 4 });
  });

  it("configures the window when a readable opens the source", async () => {
    const router = routerWithSession({ warn: vi.fn() });
    const seen = interceptSourceOptions(router);

    await router.mediaProviderFor("T8000P0000000000").openReadable!({ preBufferSeconds: 4 }).catch(() => {});

    expect(seen[0]).toMatchObject({ preBufferSeconds: 4 });
  });

  it("configures the window when talkback opens the source", async () => {
    const router = routerWithSession({ warn: vi.fn() });
    const seen = interceptSourceOptions(router);

    await router.mediaProviderFor("T8000P0000000000").talkback!({ preBufferSeconds: 4 }).catch(() => {});

    expect(seen[0]).toMatchObject({ preBufferSeconds: 4 });
  });

  it("configures the window when a fragment recording opens the source", async () => {
    const router = routerWithSession({ warn: vi.fn() });
    const seen = interceptSourceOptions(router);

    router.mediaProviderFor("T8000P0000000000").recordFragments!({ preBufferSeconds: 4 });
    await Promise.resolve();

    expect(seen[0]).toMatchObject({ preBufferSeconds: 4 });
  });

  /**
   * A window the caller did not ask for is not one to invent: retaining media costs memory on every
   * frame, and only a caller knows whether anything will ever drain it.
   */
  it("configures no window when no egress asked for one", async () => {
    const router = routerWithSession({ warn: vi.fn() });
    const seen = interceptSourceOptions(router);

    await router
      .mediaProviderFor("T8000P0000000000")
      .snapshotLive({})
      .catch(() => {});

    expect(seen[0].preBufferSeconds).toBeUndefined();
  });
});

describe("shared live source options", () => {
  it("warns when a later caller's options disagree with the ones the source was built from", async () => {
    const logger = { warn: vi.fn() };
    const router = routerWithSession(logger);

    const first = await router.sharedLiveSourceFor("T8000P0000000000", { powered: "battery" });
    const second = await router.sharedLiveSourceFor("T8000P0000000000", { powered: "wired" });

    expect(second).toBe(first);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/already streaming.*powered/);
  });

  it("stays quiet when the options agree, or when none are passed", async () => {
    const logger = { warn: vi.fn() };
    const router = routerWithSession(logger);

    await router.sharedLiveSourceFor("T8000P0000000000", { powered: "battery" });
    await router.sharedLiveSourceFor("T8000P0000000000", { powered: "battery" });
    await router.sharedLiveSourceFor("T8000P0000000000");

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("names every option that was dropped, not just the first", async () => {
    const logger = { warn: vi.fn() };
    const router = routerWithSession(logger);

    await router.sharedLiveSourceFor("T8000P0000000000", { powered: "battery", keepAliveMs: 3000 });
    await router.sharedLiveSourceFor("T8000P0000000000", { powered: "wired", keepAliveMs: 9000 });

    const msg = logger.warn.mock.calls[0][0] as string;
    expect(msg).toMatch(/keepAliveMs/);
    expect(msg).toMatch(/powered/);
  });

  /** `eccPrivateKey` is a Buffer, so identity comparison warns on every call for keys that match. */
  it("treats two content-equal keys as agreeing", async () => {
    const logger = { warn: vi.fn() };
    const router = routerWithSession(logger);

    await router.sharedLiveSourceFor("T8000P0000000000", { eccPrivateKey: Buffer.alloc(32, 7) });
    await router.sharedLiveSourceFor("T8000P0000000000", { eccPrivateKey: Buffer.alloc(32, 7) });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("still reports a key that genuinely differs", async () => {
    const logger = { warn: vi.fn() };
    const router = routerWithSession(logger);

    await router.sharedLiveSourceFor("T8000P0000000000", { eccPrivateKey: Buffer.alloc(32, 7) });
    await router.sharedLiveSourceFor("T8000P0000000000", { eccPrivateKey: Buffer.alloc(32, 9) });

    expect(logger.warn.mock.calls[0][0]).toMatch(/eccPrivateKey/);
  });

  /**
   * `live()`'s options arrive as a loose bag — a host passes per-egress settings in it too — so only
   * the names a shared source is actually built from may be reported as ignored.
   */
  it("does not name keys that were never shared-source options", async () => {
    const logger = { warn: vi.fn() };
    const router = routerWithSession(logger);

    await router.sharedLiveSourceFor("T8000P0000000000", { powered: "battery" });
    await router.sharedLiveSourceFor("T8000P0000000000", {
      powered: "wired",
      timeoutMs: 5000,
      skipKeyframes: 2,
    } as never);

    const msg = logger.warn.mock.calls[0][0] as string;
    expect(msg).toMatch(/powered/);
    expect(msg).not.toMatch(/timeoutMs/);
    expect(msg).not.toMatch(/skipKeyframes/);
  });
});
