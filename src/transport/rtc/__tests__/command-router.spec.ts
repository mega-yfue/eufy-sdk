import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RtcCallSdp } from "../call.js";
import { RtcCommandRouter, type RtcLiveRoute } from "../command-router.js";
import type { RtcCommandCounter, RtcDataChannel } from "../data-channel.js";
import type { IceAgent } from "../ice.js";
import type { RtcSignalClient } from "../signal-client.js";

/** Synthetic throughout: no serial, did or license off a device, no network. */
const ROUTE: RtcLiveRoute = {
  stationSn: "T9000P0000000000",
  attached: true,
  adminUserId: "synthetic-admin",
  did: "SYNTH-000000-AAAAA",
  lic: "SYNLIC",
  host: "192.0.2.1",
  version: 4100,
  sdkVersion: "1.7.2",
  cameraSn: "T8425P0000000001",
  channel: 3,
  live: { start: '{"cmd":1003}', stop: '{"cmd":1004}' },
};
const CALL: RtcCallSdp = {
  ufrag: "abcd",
  pwd: "p".repeat(22),
  key: "k".repeat(16),
  iv: "i".repeat(12),
  audio: 1,
  video: 2,
};

/** Fake native layers: a signal client that logs in at once, a connected data channel, a connected PM ICE. */
function layers() {
  const signal = Object.assign(new EventEmitter(), {
    start: vi.fn(async () => void queueMicrotask(() => signal.emit("login", "contact"))),
    call: vi.fn(() => ({ uuid: "pm-call", ...CALL })),
    hangup: vi.fn(),
    close: vi.fn(),
  });
  const data = Object.assign(new EventEmitter(), {
    connected: true,
    command: vi.fn(async () => Buffer.alloc(0)),
    close: vi.fn(),
  });
  const agent = Object.assign(new EventEmitter(), { connected: true, write: vi.fn(), close: vi.fn() });
  const priv1 = vi.fn((_s: RtcSignalClient, _o: { counter?: RtcCommandCounter }) => data as unknown as RtcDataChannel);
  const pmIce = vi.fn(() => agent as unknown as IceAgent);
  const router = new RtcCommandRouter({
    userId: () => "synthetic-user",
    appId: "0123456789abcdef",
    layers: { signal: () => signal as unknown as RtcSignalClient, priv1, pmIce },
  });
  return { router, signal, data, agent, priv1, pmIce };
}

afterEach(() => vi.useRealTimers());

describe("RtcCommandRouter on the native layers", () => {
  it("dispatches a set-payload as a 1350 on the PRIV1 data channel, on the device's channel", async () => {
    const { router, data, priv1 } = layers();
    await router.dispatchCommand(ROUTE, { kind: "set-payload", cmd: 1214, mValue3: 0, payload: { x: 1 }, channel: 3 });
    expect(data.command).toHaveBeenCalledExactlyOnceWith(
      1350,
      JSON.stringify({ account_id: "synthetic-admin", cmd: 1214, mValue3: 0, payload: { x: 1 } }),
      3,
    );
    expect(priv1.mock.calls[0]![1]).toMatchObject({ sn: ROUTE.stationSn, version: 4100, flag: 3 });
    router.close();
  });

  it("starts a live view on a PM call with the start JSON over ANKE, under the data channel's counter", async () => {
    const { router, signal, agent, priv1, pmIce } = layers();
    await router.dispatchCommand(
      { ...ROUTE, attached: false },
      { kind: "set-json", param: 1400, data: {}, channel: 0 },
    );
    const counter = priv1.mock.calls[0]![1].counter!;
    expect(counter.word).toBe(0x01020304);
    const consumer = await router.mediaProviderFor(ROUTE).live();
    expect(signal.call).toHaveBeenCalledExactlyOnceWith(6);
    expect(pmIce).toHaveBeenCalledOnce();
    expect(agent.write).toHaveBeenCalled();
    expect(counter.word).toBe(0x01020305);
    consumer.stop();
    router.close();
    expect(agent.close).toHaveBeenCalled();
    expect(signal.hangup).toHaveBeenCalledWith("pm-call");
  });

  it("refuses a live view without the start JSON", async () => {
    const { router } = layers();
    await expect(router.mediaProviderFor({ ...ROUTE, live: undefined }).live()).rejects.toThrow("no RTC start frame");
    router.close();
  });

  it("ships without node-datachannel", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).not.toHaveProperty("node-datachannel");
  });
});
