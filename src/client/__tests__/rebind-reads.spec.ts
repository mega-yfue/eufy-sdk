import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";

/**
 * Re-binding a device's reads after a realtime report widened the evidence.
 *
 * A robot's state exists only on its realtime feed, so the first report is what makes its typed reads
 * exist at all. That makes this path load-bearing — and it is reached from a fire-and-forget call on a
 * message handler, which is what these specs pin: one report must cost one cloud round-trip however many
 * capabilities decoded it, a failure must not turn every later report into another attempt, and the host
 * must learn the reads arrived.
 */
function withDevice(logger?: { warn: (m: string) => void }) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", logger: logger as never });
  // A `Device` stand-in over the three methods this path calls. The announcement half has its own spec
  // (`realtime-property-changes.spec.ts`); here it answers nothing so only the re-bind is observable.
  const dev = {
    bindActions: vi.fn(),
    applyParams: vi.fn(),
    announcements: vi.fn(() => []),
    reresolve: vi.fn(() => []),
  };
  (eufy as never as { liveDevices: Map<string, WeakRef<object>> }).liveDevices.set("VAC", new WeakRef(dev));
  (eufy as never as { boundParamIds: Map<string, ReadonlySet<number>> }).boundParamIds.set("VAC", new Set([0]));
  const registry = (eufy as never as { registry: { record: (sn: string) => Promise<unknown> } }).registry;
  const record = vi
    .spyOn(registry, "record")
    .mockResolvedValue({ params: {}, dpParams: { 153: "work-status" } } as never);
  const context = vi.spyOn(eufy as never as { commandContext: () => unknown }, "commandContext");
  context.mockResolvedValue({ paramIds: new Set([0, 153]) } as never);
  const report = (...slices: Record<number, string>[]) =>
    (
      eufy as never as {
        applyRealtimeReport: (sn: string, s: readonly { params: Record<number, string> }[]) => void;
      }
    ).applyRealtimeReport(
      "VAC",
      slices.map((params) => ({ params })),
    );
  return { eufy, dev, record, context, report, settle: () => new Promise((r) => setTimeout(r, 0)) };
}

describe("rebindReads", () => {
  beforeEach(() => vi.restoreAllMocks());

  /**
   * A robot's report is decoded by two capabilities over disjoint id sets. Handled slice by slice, each
   * one widens the evidence on its own and the first report costs two concurrent
   * device-list reads — and announces itself twice.
   */
  it("re-binds once for a report two capabilities decoded", async () => {
    const { eufy, context, record, report, settle } = withDevice();
    const seen: unknown[] = [];
    eufy.on("deviceState", (s) => seen.push(s));

    report({ 153: "work-status" }, { 158: "suction" });
    await settle();

    expect(context).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(2); // the report, then again once the reads exist
  });

  it("does not re-bind again for ids it has already seen", async () => {
    const { context, report, settle } = withDevice();

    report({ 153: "work-status" });
    await settle();
    report({ 153: "work-status-2" });
    await settle();

    expect(context).toHaveBeenCalledTimes(1);
  });

  /**
   * The evidence advances whether or not the re-bind lands. A failure that left it un-advanced would make
   * every subsequent report try again — an uncached cloud POST per message, for as long as the device
   * keeps talking.
   */
  it("does not retry on every later report after a failure", async () => {
    const { context, report, settle } = withDevice({ warn: () => {} });
    context.mockRejectedValue(new Error("record gone") as never);

    report({ 153: "work-status" });
    await settle();
    report({ 153: "work-status-2" });
    await settle();

    expect(context).toHaveBeenCalledTimes(1);
  });

  /**
   * `error` on an EventEmitter throws when nothing is listening, and this path is un-awaited — the throw
   * would surface as an unhandled rejection and abort the host process.
   */
  it("logs a failure instead of throwing when the host has no error listener", async () => {
    const warn = vi.fn();
    const { eufy, context, report, settle } = withDevice({ warn });
    context.mockRejectedValue(new Error("record gone") as never);

    report({ 153: "work-status" });
    await settle();

    expect(eufy.listenerCount("error")).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("record gone"));
  });

  it("emits the failure to a host that does listen", async () => {
    const { eufy, context, report, settle } = withDevice();
    context.mockRejectedValue(new Error("record gone") as never);
    const errors: Error[] = [];
    eufy.on("error", (e) => errors.push(e));

    report({ 153: "work-status" });
    await settle();

    expect(errors.map((e) => e.message)).toEqual(["record gone"]);
  });

  /**
   * The report that creates the reads is announced before they are installed, so a host reading them from
   * that event would see nothing. The same event fires again once they exist, which is what makes
   * "re-read on `deviceState`" true on the first report rather than only from the second.
   */
  it("announces the state again once the reads are installed", async () => {
    const { eufy, dev, report, settle } = withDevice();
    const seen: unknown[] = [];
    eufy.on("deviceState", (s) => seen.push(s));

    report({ 153: "work-status" });
    expect(seen).toHaveLength(1);
    expect(dev.bindActions).not.toHaveBeenCalled();
    await settle();

    expect(dev.bindActions).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(2);
  });

  /**
   * The ids come back through the cloud record, which for a realtime-only line carries none of them — so
   * replacing the evidence with what the record knows would un-know the reported ids and re-trigger on the
   * next report.
   */
  it("widens the evidence rather than replacing it with what the record knows", async () => {
    const { eufy, context, report, settle } = withDevice();
    context.mockResolvedValue({ paramIds: new Set([0]) } as never);

    report({ 153: "work-status" });
    await settle();

    const bound = (eufy as never as { boundParamIds: Map<string, ReadonlySet<number>> }).boundParamIds.get("VAC");
    expect([...bound!].sort((a, b) => a - b)).toEqual([0, 153]);
  });

  /**
   * A property gated on a realtime-only param is outside the schema until that param is evidence, and
   * the report that made it evidence was stored before the property existed. Re-resolving first and
   * applying the record's realtime params again is what lands that value under the property's name.
   */
  it("re-resolves against the record and re-applies its realtime params before binding", async () => {
    const { dev, record, report, settle } = withDevice();

    report({ 153: "work-status" });
    await settle();

    const rec = await record.mock.results[0]!.value;
    expect(dev.reresolve).toHaveBeenCalledWith(rec);
    expect(dev.applyParams).toHaveBeenLastCalledWith({ 153: "work-status" });
    expect(dev.reresolve.mock.invocationCallOrder[0]).toBeLessThan(dev.bindActions.mock.invocationCallOrder[0]!);
  });
});
