import { describe, it, expect, vi } from "vitest";
import { commandObservation, observeCommand } from "../../core/contracts.js";
import { EufyMega } from "../eufy-mega.js";
import type { AnyDeviceEvent } from "../types.js";

/**
 * The catch-all `"event"` listener's tag key.
 *
 * The tag is `eventName`, not `name`, because a semantic payload can legitimately carry its own `name`
 * — a device name arrives that way on the wire — and tagging over it would destroy data the caller
 * needs. These specs pin the key in both directions: the runtime shape, and that the same key is the
 * compile-time discriminant of {@link AnyDeviceEvent}. Asserting only one of the two is what lets the
 * declared tag and the emitted one drift apart.
 */
describe("catch-all event tag", () => {
  const client = () => new EufyMega({ email: "t@example.com", password: "x" });

  it("tags the payload with eventName", async () => {
    const eufy = client();
    const seen: AnyDeviceEvent[] = [];
    eufy.on("event", (e) => seen.push(e));

    (eufy as any).emitSemantic("motion", { deviceSn: "T8000P0000000000" });

    expect(seen).toHaveLength(1);
    expect(seen[0].eventName).toBe("motion");
  });

  /**
   * A compile-time check as much as a runtime one: this only builds if `eventName` is the union's
   * discriminant, and `ptzNotify`'s `kind` is only reachable once narrowing has happened.
   */
  it("narrows the union on eventName", () => {
    const eufy = client();
    let narrowed: string | undefined;
    eufy.on("event", (e) => {
      if (e.eventName === "ptzNotify") narrowed = e.kind;
    });

    (eufy as any).emitSemantic("ptzNotify", { stationSn: "T8000P0000000000", kind: "rotate" });

    expect(narrowed).toBe("rotate");
  });

  /** The reason for the key choice: a push payload carries the device's own name in a `name` field. */
  it("does not clobber a payload's own `name` field", () => {
    const eufy = client();
    const seen: any[] = [];
    eufy.on("event", (e) => seen.push(e));

    (eufy as any).emitSemantic("motion", { deviceSn: "T8000P0000000000", name: "Camera A" });

    expect(seen[0].name).toBe("Camera A");
    expect(seen[0].eventName).toBe("motion");
  });

  /** Tagging is the catch-all's concern; a per-name listener gets the payload as the capability built it. */
  it("still delivers to the per-name listener untagged", () => {
    const eufy = client();
    const seen: any[] = [];
    eufy.on("motion", (e) => seen.push(e));

    (eufy as any).emitSemantic("motion", { deviceSn: "T8000P0000000000" });

    expect(seen).toHaveLength(1);
    expect(seen[0].eventName).toBeUndefined();
  });

  it("refreshes retained device state before emitting an event that requires a re-read", async () => {
    const eufy = client();
    const sequence: string[] = [];
    let mode = 1;
    const device = {
      getProperty: () => ({ value: mode }),
      applyParams: vi.fn((params: Record<number, string>) => {
        mode = Number(params[1224]);
        sequence.push("refresh");
      }),
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockReturnValue({ params: { 1224: "63" } });
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    eufy.on("armingModeChanged", () => sequence.push("event"));

    (eufy as any).emitSemantic(
      "armingModeChanged",
      { deviceSn: "T8000P0000000000" },
      { refresh: { param: 1224, property: "armingMode", timeoutMs: 20_000 } },
    );

    expect(sequence).toEqual([]);
    await vi.waitFor(() => expect(sequence).toEqual(["refresh", "event"]));
    expect(device.applyParams).toHaveBeenCalledExactlyOnceWith({ 1224: "63" });
  });

  /**
   * The convergence wait polls the CLOUD through the registry's coalesced list, so an unconverged param
   * costs one account-wide list per reuse window rather than one per pass. The loop still runs at its own
   * ~500ms cadence — that is what lets state the device volunteers settle the wait between two cloud reads —
   * so the two cannot be conflated: this pins the fetch count as well as the eventual convergence.
   */
  it("applies a converged cloud record once, polling the account list once per reuse window", async () => {
    vi.useFakeTimers();
    const eufy = client();
    let mode = 1;
    let cloudMode = "1";
    let polls = 0;
    const device = {
      getProperty: () => ({ value: mode }),
      applyParams: vi.fn((params: Record<number, string>) => {
        mode = Number(params[1224]);
      }),
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockImplementation(() => ({ params: { 1224: cloudMode } }));
    vi.spyOn((eufy as any).registry, "getDevices").mockImplementation(async () => {
      polls += 1;
      if (polls === 3) cloudMode = "63";
      return [];
    });
    const seen: number[] = [];
    eufy.on("armingModeChanged", () => seen.push(mode));

    (eufy as any).emitSemantic(
      "armingModeChanged",
      { deviceSn: "T8000P0000000000" },
      { refresh: { param: 1224, property: "armingMode", timeoutMs: 20_000 } },
    );
    await vi.advanceTimersByTimeAsync(11_000);

    expect(seen).toEqual([63]);
    expect(polls, "one account-wide list per 5s reuse window, not one per 500ms pass").toBe(3);
    expect(device.applyParams).toHaveBeenCalledExactlyOnceWith({ 1224: "63" });
    vi.useRealTimers();
  });

  /**
   * A signal whose re-read never shows the param move is dropped, and the drop is logged: without the
   * line, a signal that arrived against a lagging cloud is indistinguishable from one that never came.
   */
  it("logs when a refresh-driven event is dropped because its param never moved", async () => {
    vi.useFakeTimers();
    const info = vi.fn();
    const eufy = new EufyMega({
      email: "t@example.com",
      password: "x",
      logger: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
    });
    const device = { getProperty: () => ({ value: 1 }), applyParams: vi.fn() };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockReturnValue({ params: { 1224: "1" } });
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    const seen: unknown[] = [];
    eufy.on("armingModeChanged", (e) => seen.push(e));

    (eufy as any).emitSemantic(
      "armingModeChanged",
      { deviceSn: "T8000P0000000000" },
      { refresh: { param: 1224, property: "armingMode", timeoutMs: 2_000 } },
    );
    await vi.advanceTimersByTimeAsync(3_000);

    expect(seen).toEqual([]);
    expect(info).toHaveBeenCalledExactlyOnceWith(
      "[eufy] T8000P0000000000: armingModeChanged arrived but armingMode (param 1224) did not change within " +
        "2000ms of re-reading, so the event is not announced",
    );
    vi.useRealTimers();
  });

  it("logs nothing when the refresh-driven event's param moves", async () => {
    const info = vi.fn();
    const eufy = new EufyMega({
      email: "t@example.com",
      password: "x",
      logger: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
    });
    let mode = 1;
    const device = {
      getProperty: () => ({ value: mode }),
      applyParams: (params: Record<number, string>) => {
        mode = Number(params[1224]);
      },
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockReturnValue({ params: { 1224: "63" } });
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    const seen: number[] = [];
    eufy.on("armingModeChanged", () => seen.push(mode));

    (eufy as any).emitSemantic(
      "armingModeChanged",
      { deviceSn: "T8000P0000000000" },
      { refresh: { param: 1224, property: "armingMode", timeoutMs: 20_000 } },
    );

    await vi.waitFor(() => expect(seen).toEqual([63]));
    expect(info).not.toHaveBeenCalled();
  });

  it("serializes consecutive valueless transitions so each event observes its own state", async () => {
    vi.useFakeTimers();
    const eufy = client();
    let mode = 1;
    let cloudMode = "1";
    const device = {
      getProperty: () => ({ value: mode }),
      applyParams: (params: Record<number, string>) => {
        mode = Number(params[1224]);
      },
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockImplementation(() => ({ params: { 1224: cloudMode } }));
    vi.spyOn((eufy as any).registry, "getDevices").mockImplementation(async () => {
      cloudMode = cloudMode === "1" ? "63" : "1";
      return [];
    });
    const seen: number[] = [];
    eufy.on("armingModeChanged", () => seen.push(mode));
    const options = { refresh: { param: 1224, property: "armingMode", timeoutMs: 20_000 } };

    (eufy as any).emitSemantic("armingModeChanged", { deviceSn: "T8000P0000000000" }, options);
    (eufy as any).emitSemantic("armingModeChanged", { deviceSn: "T8000P0000000000" }, options);
    await vi.advanceTimersByTimeAsync(11_000);

    expect(seen).toEqual([63, 1]);
    vi.useRealTimers();
  });

  it("refreshes and emits after an observed command even when no push event arrives", async () => {
    const eufy = client();
    let mode = 1;
    const device = {
      getProperty: () => ({ value: mode }),
      applyParams: (params: Record<number, string>) => {
        mode = Number(params[1224]);
      },
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockReturnValue({ params: { 1224: "63" } });
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    vi.spyOn(eufy as any, "routeCommand").mockResolvedValue(undefined);
    const order: string[] = [];
    const reset = vi.spyOn((eufy as any).p2p, "resetStandaloneSession").mockImplementation(async () => {
      order.push("reset");
    });
    const seen: number[] = [];
    eufy.on("armingModeChanged", () => {
      seen.push(mode);
      order.push("event");
    });
    const command = observeCommand(
      { kind: "set-param", param: 1224, value: 63, form: "auto", channel: 0 },
      {
        event: "armingModeChanged",
        expected: 63,
        param: 1224,
        property: "armingMode",
        resetStandaloneSession: true,
        timeoutMs: 20_000,
      },
    );

    await (eufy as any).commandSinkFor("T8000P0000000000").dispatch(command);

    expect((eufy as any).routeCommand).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(seen).toEqual([63]));
    expect(order).toEqual(["event", "reset"]);
    expect(reset).toHaveBeenCalledExactlyOnceWith("T8000P0000000000");
  });

  it("reports an acknowledged write whose observation never converges, naming what it waited for", async () => {
    vi.useFakeTimers();
    const eufy = client();
    const device = {
      getProperty: () => ({ value: 1 }),
      applyParams: () => undefined,
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    /** A device that acknowledges the write on the wire and never reports the value it asked for. */
    vi.spyOn((eufy as any).registry, "require").mockReturnValue({ params: { 1224: "1" } });
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    vi.spyOn(eufy as any, "routeCommand").mockResolvedValue(undefined);
    const faults: unknown[] = [];
    const unconfirmed: unknown[] = [];
    eufy.on("error", (error) => faults.push(error));
    eufy.on("commandUnconfirmed", (info) => unconfirmed.push(info));
    const command = observeCommand(
      { kind: "set-param", param: 1224, value: 63, form: "auto", channel: 0 },
      { event: "armingModeChanged", expected: 63, param: 1224, property: "armingMode", timeoutMs: 20_000 },
    );

    await (eufy as any).commandSinkFor("T8000P0000000000").dispatch(command);
    await vi.advanceTimersByTimeAsync(21_000);

    expect(unconfirmed).toEqual([
      {
        sn: "T8000P0000000000",
        property: "armingMode",
        param: 1224,
        expected: 63,
        observed: "1",
        timeoutMs: 20_000,
      },
    ]);
    expect(faults, "an outcome dispatch never waited for is not a fault of this client").toEqual([]);
    vi.useRealTimers();
  });

  it("names the unconfirmed member even when the last poll outlives the window", async () => {
    vi.useFakeTimers();
    const eufy = client();
    (eufy as any).liveDevices.set(
      "T8000P0000000000",
      new WeakRef({ getProperty: () => ({ value: 1 }), applyParams: () => undefined }),
    );
    vi.spyOn((eufy as any).registry, "require").mockReturnValue({ params: { 1224: "1" } });
    /**
     * The device list never answers, which is what happens live: the window closes on the poll rather than
     * on the loop, and that rejection used to escape unattributed as "semantic event refresh timed out".
     */
    vi.spyOn((eufy as any).registry, "getDevices").mockImplementation(() => new Promise(() => undefined));
    vi.spyOn(eufy as any, "routeCommand").mockResolvedValue(undefined);
    const faults: Error[] = [];
    const unconfirmed: unknown[] = [];
    eufy.on("error", (error) => faults.push(error));
    eufy.on("commandUnconfirmed", (info) => unconfirmed.push(info));
    const command = observeCommand(
      { kind: "set-param", param: 1224, value: 63, form: "auto", channel: 0 },
      { event: "armingModeChanged", expected: 63, param: 1224, property: "armingMode", timeoutMs: 20_000 },
    );

    await (eufy as any).commandSinkFor("T8000P0000000000").dispatch(command);
    await vi.advanceTimersByTimeAsync(21_000);

    expect(unconfirmed).toEqual([
      {
        sn: "T8000P0000000000",
        property: "armingMode",
        param: 1224,
        expected: 63,
        observed: "1",
        timeoutMs: 20_000,
      },
    ]);
    expect(faults.map((error) => error.message)).toEqual([]);
    vi.useRealTimers();
  });

  /**
   * The station's MODE_SWITCH push trails the write that caused it — by seconds to over a minute — and the
   * write's own observation has already converged and announced the change by then. The push then finds
   * the new mode on hand and nothing left to move; that is an echo, not a write that failed to land.
   */
  it("lets a transition push whose state is already on hand lapse without a fault", async () => {
    vi.useFakeTimers();
    const eufy = client();
    (eufy as any).liveDevices.set(
      "T8000P0000000000",
      new WeakRef({ getProperty: () => ({ value: 5 }), applyParams: () => undefined }),
    );
    vi.spyOn((eufy as any).registry, "require").mockReturnValue({ params: { 1224: "5" } });
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    const faults: Error[] = [];
    const seen: unknown[] = [];
    eufy.on("error", (error) => faults.push(error));
    eufy.on("armingModeChanged", (e) => seen.push(e));

    (eufy as any).emitSemantic(
      "armingModeChanged",
      { deviceSn: "T8000P0000000000" },
      { refresh: { param: 1224, property: "armingMode", timeoutMs: 20_000 } },
    );
    await vi.advanceTimersByTimeAsync(21_000);

    expect(faults.map((error) => error.message)).toEqual([]);
    expect(seen).toEqual([]);
    vi.useRealTimers();
  });

  it("keeps a genuine fault after the acknowledgement on the error bus", async () => {
    const eufy = client();
    (eufy as any).liveDevices.set(
      "T8000P0000000000",
      new WeakRef({ getProperty: () => undefined, applyParams: () => undefined }),
    );
    vi.spyOn((eufy as any).registry, "require").mockImplementation(() => {
      throw new Error("synthetic registry fault");
    });
    vi.spyOn(eufy as any, "routeCommand").mockResolvedValue(undefined);
    const faults: Error[] = [];
    const unconfirmed: unknown[] = [];
    eufy.on("error", (error) => faults.push(error));
    eufy.on("commandUnconfirmed", (info) => unconfirmed.push(info));
    const command = observeCommand(
      { kind: "set-param", param: 1224, value: 63, form: "auto", channel: 0 },
      { event: "armingModeChanged", expected: 63, param: 1224, property: "armingMode", timeoutMs: 20_000 },
    );

    await (eufy as any).commandSinkFor("T8000P0000000000").dispatch(command);

    await vi.waitFor(() => expect(faults.map((error) => error.message)).toEqual(["synthetic registry fault"]));
    expect(unconfirmed).toEqual([]);
  });

  it("completes convergence and standalone reset before dispatching the next observed command", async () => {
    const eufy = client();
    let mode = 1;
    let cloudMode = "1";
    const device = {
      getProperty: () => ({ value: mode }),
      applyParams: (params: Record<number, string>) => {
        mode = Number(params[1224]);
      },
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockImplementation(() => ({ params: { 1224: cloudMode } }));
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    vi.spyOn(eufy as any, "routeCommand").mockImplementation(async (...args: unknown[]) => {
      cloudMode = String(commandObservation(args[1] as never)!.expected);
    });
    const reset = vi.spyOn((eufy as any).p2p, "resetStandaloneSession").mockResolvedValue(undefined);
    const seen: number[] = [];
    eufy.on("armingModeChanged", () => seen.push(mode));
    const command = (expected: number) =>
      observeCommand(
        { kind: "set-param", param: 1224, value: expected, form: "auto", channel: 0 },
        {
          event: "armingModeChanged",
          expected,
          param: 1224,
          property: "armingMode",
          resetStandaloneSession: true,
          timeoutMs: 20_000,
        },
      );
    const sink = (eufy as any).commandSinkFor("T8000P0000000000");

    const disarm = sink.dispatch(command(63));
    const home = sink.dispatch(command(1));
    await Promise.all([disarm, home]);

    await vi.waitFor(() => expect(seen).toEqual([63, 1]));
    expect(reset).toHaveBeenCalledTimes(2);
  });

  it("rejects a queued observed command before routing when disconnect supersedes it", async () => {
    const eufy = client();
    let mode = 1;
    let cloudMode = "1";
    let finishReset!: () => void;
    const resetGate = new Promise<void>((resolve) => {
      finishReset = resolve;
    });
    const device = {
      getProperty: () => ({ value: mode }),
      applyParams: (params: Record<number, string>) => {
        mode = Number(params[1224]);
      },
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockImplementation(() => ({ params: { 1224: cloudMode } }));
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    const route = vi.spyOn(eufy as any, "routeCommand").mockImplementation(async (...args: unknown[]) => {
      cloudMode = String(commandObservation(args[1] as never)!.expected);
    });
    vi.spyOn((eufy as any).p2p, "resetStandaloneSession").mockReturnValue(resetGate);
    const command = (expected: number) =>
      observeCommand(
        { kind: "set-param", param: 1224, value: expected, form: "auto", channel: 0 },
        {
          event: "armingModeChanged",
          expected,
          param: 1224,
          property: "armingMode",
          resetStandaloneSession: true,
          timeoutMs: 20_000,
        },
      );
    const sink = (eufy as any).commandSinkFor("T8000P0000000000");

    await sink.dispatch(command(63));
    const queued = sink.dispatch(command(1));
    const queuedResult = expect(queued).rejects.toThrow(/superseded by disconnect/);
    await eufy.disconnect();
    finishReset();

    await queuedResult;
    expect(route).toHaveBeenCalledOnce();
  });

  it("acknowledges an observed command without failing when authoritative readback expires", async () => {
    vi.useFakeTimers();
    const eufy = client();
    const device = { getProperty: () => ({ value: 1 }), applyParams: vi.fn() };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockReturnValue({ params: { 1224: "1" } });
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    vi.spyOn(eufy as any, "routeCommand").mockResolvedValue(undefined);
    const reportError = vi.spyOn(eufy as any, "reportError").mockImplementation(() => undefined);
    const unconfirmed: unknown[] = [];
    eufy.on("commandUnconfirmed", (info) => unconfirmed.push(info));
    const command = observeCommand(
      { kind: "set-param", param: 1224, value: 63, form: "auto", channel: 0 },
      { event: "armingModeChanged", expected: 63, param: 1224, property: "armingMode", timeoutMs: 20_000 },
    );

    await expect((eufy as any).commandSinkFor("T8000P0000000000").dispatch(command)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(unconfirmed, "the caller is answered on its own channel and never failed").toHaveLength(1);
    expect(reportError, "a write the device ignored is an outcome, not a fault of this client").not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("releases a following write when the session recycle is still waiting on an attached viewer", async () => {
    vi.useFakeTimers();
    const eufy = client();
    let mode = 1;
    let cloudMode = "1";
    const device = {
      getProperty: () => ({ value: mode }),
      applyParams: (params: Record<number, string>) => {
        mode = Number(params[1224]);
      },
    };
    (eufy as any).liveDevices.set("T8000P0000000000", new WeakRef(device));
    vi.spyOn((eufy as any).registry, "require").mockImplementation(() => ({ params: { 1224: cloudMode } }));
    vi.spyOn((eufy as any).registry, "getDevices").mockResolvedValue([]);
    const route = vi.spyOn(eufy as any, "routeCommand").mockImplementation(async (...args: unknown[]) => {
      cloudMode = String(commandObservation(args[1] as never)!.expected);
    });
    // A viewer never detaches, so the recycle this write asks for never settles.
    vi.spyOn((eufy as any).p2p, "resetStandaloneSession").mockReturnValue(new Promise<void>(() => {}));
    const command = (expected: number) =>
      observeCommand(
        { kind: "set-param", param: 1224, value: expected, form: "auto", channel: 0 },
        {
          event: "armingModeChanged",
          expected,
          param: 1224,
          property: "armingMode",
          resetStandaloneSession: true,
          timeoutMs: 20_000,
        },
      );
    const sink = (eufy as any).commandSinkFor("T8000P0000000000");

    await sink.dispatch(command(63));
    const queued = sink.dispatch(command(1));

    await vi.advanceTimersByTimeAsync(5_000);
    await expect(queued).resolves.toBeUndefined();
    expect(route, "the queued write reached the wire rather than waiting on the viewer").toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("allows observation policy to be replaced on a reused command object", () => {
    const command = { kind: "set-param", param: 1224, value: 63, form: "auto", channel: 0 } as const;
    const first = { event: "armingModeChanged", expected: 63, param: 1224, property: "armingMode", timeoutMs: 1 };
    const second = { ...first, expected: 1 };

    observeCommand(command, first);
    expect(() => observeCommand(command, second)).not.toThrow();
    expect(commandObservation(command)).toEqual(second);
  });
});
