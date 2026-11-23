import { EventEmitter } from "node:events";
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RtcCallSdp } from "../call.js";
import { RtcCommandRouter, type RtcLiveRoute } from "../command-router.js";
import type { RtcCommandCounter, RtcDataChannel } from "../data-channel.js";
import type { IceAgent } from "../ice.js";
import type { RtcSignalClient } from "../signal-client.js";

/** The shapes of the bundle's `rtcLive` frames: a T9000 camera's 1350 start and stop, a standalone T8170's. */
const NVR_LIVE: RtcLiveRoute["live"] = {
  start: {
    cmd: 1350,
    body: "json",
    payload: {
      cmd: 1003,
      mChannel: "$mChannel",
      account_id: "$userId",
      mValue3: 1003,
      payload: {
        accountId: "$userId",
        streamtype: 2,
        entrytype: "$entryType",
        msg_id: "$msgId",
        mChannel: "$mChannel",
      },
      msg_id: "$msgId",
      transaction: "$now",
    },
    counter: "bump",
  },
  stop: {
    cmd: 1350,
    body: "json1350",
    payload: { channel: "$channel", transaction: "$now" },
    subCmd: 1004,
    mValue3: 0,
  },
};
const SOLO_LIVE: RtcLiveRoute["live"] = {
  start: {
    cmd: 1700,
    body: "json1700",
    payload: { cmd: 1000, mChannel: "$channel", account_id: "$userId", streamtype: 2, extValue: 1000 },
    subCmd: 1000,
    counter: "bump",
  },
  stop: { cmd: 1004, body: "native", payload: {}, layout: "u32-ch" },
};

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
  live: NVR_LIVE,
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
  const priv1 = vi.fn(
    (_s: RtcSignalClient, _o: { counter?: RtcCommandCounter; answered?: () => void }) =>
      data as unknown as RtcDataChannel,
  );
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
      JSON.stringify({ account_id: "synthetic-admin", cmd: 1214, mChannel: 3, mValue3: 0, payload: { x: 1 } }),
      3,
    );
    expect(priv1.mock.calls[0]![1]).toMatchObject({ sn: ROUTE.stationSn, version: 4100, flag: 3 });
    router.close();
  });

  it("frames the native kinds as the app's RTC sender groups their ids", async () => {
    const { router, data } = layers();
    const account = Buffer.alloc(128);
    account.write("synthetic-admin");
    const u32 = (...v: number[]) => Buffer.from(new Uint32Array(v).buffer);
    await router.dispatchCommand(ROUTE, { kind: "set-param", param: 1035, value: 1, channel: 3 });
    await router.dispatchCommand(ROUTE, { kind: "p2p-station-scalar", cmd: 1235, value: 7, channel: 3 });
    await router.dispatchCommand(ROUTE, { kind: "set-param", param: 1250, value: 2, channel: 3 });
    await router.dispatchCommand(ROUTE, { kind: "set-param", param: 1013, value: 5, channel: 3, form: "int-pair" });
    await router.dispatchCommand(ROUTE, { kind: "p2p-int-string", cmd: 1202, value: 9, valueSub: 3, channel: 3 });
    await router.dispatchCommand(ROUTE, {
      kind: "p2p-int-string",
      cmd: 1201,
      value: 4,
      valueSub: 6,
      channel: 255,
      form: "int-pair",
    });
    await router.dispatchCommand(ROUTE, { kind: "set-json-raw", cmd: 1271, data: { t: 1 }, channel: 3 });
    await router.dispatchCommand(ROUTE, { kind: "set-json-raw", cmd: 1255, data: { t: 2 }, channel: 3 });
    expect(data.command.mock.calls).toEqual([
      [1035, Buffer.concat([u32(3, 1), account]), 3],
      [1235, Buffer.concat([u32(7), account]), 255],
      [1250, Buffer.concat([u32(2), account]), 3],
      [1013, u32(3, 5), 3],
      [1202, u32(3, 9), 3],
      [1201, u32(6, 4), 255],
      [1271, JSON.stringify({ account_id: "synthetic-admin", t: 1 }), 3],
      [1255, JSON.stringify({ account_id: "synthetic-admin", t: 2 }), 255],
    ]);
    router.close();
  });

  it("refuses what the app's RTC sender does not frame, before connecting", async () => {
    const { router, priv1 } = layers();
    for (const cmd of [
      { kind: "set-param", param: 1044, value: 1, channel: 3 },
      { kind: "set-param", param: 1035, value: 1, channel: 3, form: "int-pair" },
      { kind: "set-json-raw", cmd: 1035, data: {}, channel: 3 },
      { kind: "p2p-int-string", cmd: 1035, value: 1, valueSub: 3, channel: 3 },
      { kind: "p2p-string", cmd: 1217, value: "name", channel: 3 },
      { kind: "set-payload", cmd: 1214, payload: {}, channel: 3, counter: "bump" },
    ] as const)
      await expect(router.dispatchCommand(ROUTE, cmd)).rejects.toThrow("not framed by the app's RTC sender");
    expect(priv1).not.toHaveBeenCalled();
    router.close();
  });

  it("places a fresh PRIV1 call once the data channel closes", async () => {
    const { router, data, priv1 } = layers();
    const cmd = { kind: "set-json", param: 1400, data: {}, channel: 3 } as const;
    await router.dispatchCommand(ROUTE, cmd);
    data.emit("close");
    await router.dispatchCommand(ROUTE, cmd);
    expect(priv1).toHaveBeenCalledTimes(2);
    router.close();
  });

  it("re-calls a closed data channel at once twice, then after the app's 20 s backoff unless the station answered", async () => {
    const { router, data, priv1 } = layers();
    const cmd = { kind: "set-json", param: 1400, data: {}, channel: 3 } as const;
    const fail = async () => (await router.dispatchCommand(ROUTE, cmd), data.emit("close"));
    await fail();
    await fail();
    priv1.mock.calls[1]![1].answered!();
    await fail();
    await fail();
    await fail();
    expect(priv1).toHaveBeenCalledTimes(5);
    router.dispatchCommand(ROUTE, cmd).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(priv1).toHaveBeenCalledTimes(5);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 30_000);
    await router.dispatchCommand(ROUTE, cmd);
    expect(priv1).toHaveBeenCalledTimes(6);
    vi.restoreAllMocks();
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

  /** The `XZYH` command of the ANKE frame in the `i`th APP packet the PM agent wrote, opened under the PM key. */
  function sent(agent: { write: { mock: { calls: unknown[][] } } }, i: number) {
    const p = agent.write.mock.calls[i]![0] as Buffer;
    const x = p.subarray(32, 32 + p.readUInt32LE(24));
    let body = x.subarray(16);
    if (x[10] === 0x0a) {
      const d = createDecipheriv("aes-128-gcm", Buffer.from(CALL.key), body.subarray(16, 28));
      d.setAAD(Buffer.from("eufy security"));
      d.setAuthTag(body.subarray(0, 16));
      body = Buffer.concat([d.update(body.subarray(32)), d.final()]);
    }
    return { cmd: x.readUInt16LE(4), channel: x[12], flag: x[14], body };
  }

  it("starts a T9000 camera's view with its rtcLive 1350, tokens filled, as a sealed ANKE command", async () => {
    const { router, agent } = layers();
    const consumer = await router.mediaProviderFor(ROUTE).live({ entryType: 4 });
    const start = sent(agent, 0);
    const json = JSON.parse(start.body.toString()) as { payload: Record<string, unknown> } & Record<string, unknown>;
    expect(start).toMatchObject({ cmd: 1350, channel: 3, flag: 0 });
    expect(json).toMatchObject({ cmd: 1003, mChannel: 3, account_id: "synthetic-admin", mValue3: 1003, msg_id: 1 });
    expect(json.payload).toMatchObject({ mChannel: 3, accountId: "synthetic-admin", entrytype: 4, msg_id: 1 });
    expect(json.payload.streamtype).toBe(2);
    expect(String(json.transaction)).toMatch(/^\d{13}$/);
    consumer.stop();
    router.close();
    const stop = sent(agent, agent.write.mock.calls.length - 1);
    expect(stop).toMatchObject({ cmd: 1350, channel: 3, flag: 0 });
    expect(JSON.parse(stop.body.toString())).toMatchObject({ cmd: 1004, mChannel: 3, payload: { channel: 3 } });
  });

  it("starts a standalone T8170 with its 1700 inner 1000, the event-stream flag in byte 14, and stops with 1004", async () => {
    const { router, agent } = layers();
    const sn = "T8170P0000000000";
    const route = { ...ROUTE, stationSn: sn, cameraSn: sn, attached: false, channel: 0, version: 1000 };
    const consumer = await router.mediaProviderFor({ ...route, live: SOLO_LIVE }).live();
    const start = sent(agent, 0);
    expect(start).toMatchObject({ cmd: 1700, channel: 0, flag: 10 });
    expect(JSON.parse(start.body.toString())).toMatchObject({
      commandType: 1000,
      data: { cmd: 1000, mChannel: 0, account_id: "synthetic-admin", streamtype: 2, extValue: 1000 },
    });
    consumer.stop();
    router.close();
    const stop = sent(agent, agent.write.mock.calls.length - 1);
    expect(stop).toMatchObject({ cmd: 1004, channel: 0, flag: 0 });
    expect(stop.body).toEqual(Buffer.alloc(4));
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
