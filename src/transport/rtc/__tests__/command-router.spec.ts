import { EventEmitter } from "node:events";
import { createDecipheriv, createECDH } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RtcCallSdp } from "../call.js";
import { buildStringBody } from "../../p2p/write-commands.js";
import { RtcCommandRouter, type RtcLiveRoute } from "../command-router.js";
import type { RtcCommandCounter, RtcDataChannel } from "../data-channel.js";
import type { IceAgent } from "../ice.js";
import type { RtcSignalClient, RtcSignalOptions } from "../signal-client.js";

/** The shapes of the bundle's `rtcLive` frames: a T9000 camera's 1350 start and stop, a standalone T8170's. */
const NVR_LIVE: RtcLiveRoute["live"] = {
  start: {
    cmd: 1350,
    body: "json",
    payload: {
      cmd: 1003,
      mChannel: "$channel",
      account_id: "$userId",
      mValue3: 1003,
      payload: {
        accountId: "$userId",
        streamtype: 2,
        camera_type: "$cameraType",
        entrytype: "$entryType",
        chn_list: "$chnList",
        audio_chn: "$channel",
        msg_id: "$msgId",
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
    rtcSendRoute: 1,
  },
};
const SOLO_LIVE: RtcLiveRoute["live"] = {
  start: {
    cmd: 1700,
    body: "json1700",
    payload: { cmd: 1000, mChannel: "$channel", account_id: "$userId", streamtype: 2, extValue: 1000 },
    subCmd: 1000,
    counter: "bump",
    rtcSendRoute: 1,
  },
  stop: { cmd: 1004, body: "native", payload: {}, layout: "u32-ch", rtcSendRoute: 1 },
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

const u32 = (...v: number[]) => Buffer.from(new Uint32Array(v).buffer);

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

  it("sends a rename as the 389-byte RTC string body: the P2P body, then a fresh P-256 public key in hex", async () => {
    const { router, data } = layers();
    const rename = { kind: "p2p-string", cmd: 1217, value: "Garden", channel: 3 } as const;
    await router.dispatchCommand(ROUTE, rename);
    await router.dispatchCommand(ROUTE, rename);
    const [[id, body, channel], [, again]] = data.command.mock.calls as unknown as [number, Buffer, number][];
    expect([id, channel, body.length]).toEqual([1217, 255, 389]);
    expect(body.subarray(0, 261)).toEqual(buildStringBody(3, "Garden", "synthetic-admin"));
    const key = body.subarray(261).toString();
    expect(key).toMatch(/^[0-9A-F]{128}$/);
    const peer = createECDH("prime256v1");
    peer.generateKeys();
    expect(() => peer.computeSecret(Buffer.from(`04${key}`, "hex"))).not.toThrow();
    expect(again.subarray(261)).not.toEqual(body.subarray(261));
    router.close();
  });

  it("refuses what the app's RTC sender does not frame, before connecting", async () => {
    const { router, priv1 } = layers();
    for (const cmd of [
      { kind: "set-param", param: 1044, value: 1, channel: 3 },
      { kind: "set-param", param: 1035, value: 1, channel: 3, form: "int-pair" },
      { kind: "set-json-raw", cmd: 1035, data: {}, channel: 3 },
      { kind: "p2p-int-string", cmd: 1035, value: 1, valueSub: 3, channel: 3 },
      { kind: "p2p-string", cmd: 1035, value: "name", channel: 3 },
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

  it("starts a T9000 camera's view with its rtcLive 1350, the single-camera page filled, as a sealed ANKE command", async () => {
    const { router, agent } = layers();
    const consumer = await router.mediaProviderFor(ROUTE).live({ entryType: 4 });
    const start = sent(agent, 0);
    const json = JSON.parse(start.body.toString()) as { payload: Record<string, unknown> } & Record<string, unknown>;
    expect(start).toMatchObject({ cmd: 1350, channel: 3, flag: 0 });
    expect(json).toMatchObject({ cmd: 1003, mChannel: 3, account_id: "synthetic-admin", mValue3: 1003, msg_id: 1 });
    expect(json.payload).toMatchObject({ accountId: "synthetic-admin", entrytype: 4, msg_id: 1, audio_chn: 3 });
    // The single-camera page: one channel order, camera id 0.
    expect(json.payload).toMatchObject({ camera_type: 0, chn_list: [{ cameraType: 0, chn: 3, index: 0, sensor: 0 }] });
    expect(json.payload.streamtype).toBe(2);
    expect(String(json.transaction)).toMatch(/^\d{13}$/);
    consumer.stop();
    router.close();
    const stop = sent(agent, agent.write.mock.calls.length - 1);
    expect(stop).toMatchObject({ cmd: 1350, channel: 3, flag: 0 });
    expect(JSON.parse(stop.body.toString())).toMatchObject({ cmd: 1004, mChannel: 3, payload: { channel: 3 } });
  });

  /** `RtcLivePlayerBridge` starts with the camera's stated admin, else `""`; the stop's envelope keeps `p2pRequest`'s. */
  it("starts a camera stating no admin with an empty account and stops it as the signed-in user", async () => {
    const { router, agent } = layers();
    const consumer = await router.mediaProviderFor({ ...ROUTE, adminUserId: undefined }).live();
    const json = JSON.parse(sent(agent, 0).body.toString()) as { payload: Record<string, unknown> };
    expect(json).toMatchObject({ account_id: "", payload: { accountId: "" } });
    consumer.stop();
    router.close();
    const stop = sent(agent, agent.write.mock.calls.length - 1);
    expect(JSON.parse(stop.body.toString())).toMatchObject({ account_id: "synthetic-user", cmd: 1004 });
  });

  it("lists a camera's lenses in the lens page's chn_list", async () => {
    const { router, agent } = layers();
    const consumer = await router.mediaProviderFor({ ...ROUTE, sensors: [0, 1] }).live();
    const json = JSON.parse(sent(agent, 0).body.toString()) as { payload: Record<string, unknown> };
    expect(json.payload.chn_list).toEqual([
      { cameraType: 0, chn: 3, index: 0, sensor: 0 },
      { cameraType: 0, chn: 3, index: 1, sensor: 1 },
    ]);
    consumer.stop();
    router.close();
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

  it("sends an old T8223's 1700 start and 1004 stop over the data channel, from 3.3.7.6 over ANKE", async () => {
    const sn = "T8223P0000000000";
    // The bundle's routes: the start always 0, the stop 1 from 3.3.7.6 on.
    const live = (stop: number) => ({
      start: { ...SOLO_LIVE!.start, rtcSendRoute: 0 },
      stop: { ...SOLO_LIVE!.stop, rtcSendRoute: stop },
    });
    const route = { ...ROUTE, stationSn: sn, cameraSn: sn, attached: false, channel: 0 };
    const old = layers();
    const consumer = await old.router.mediaProviderFor({ ...route, version: 3375, live: live(0) }).live();
    await vi.waitFor(() => expect(old.data.command).toHaveBeenCalledWith(1700, expect.any(Buffer), 0, 10));
    consumer.stop();
    old.router.close();
    expect(old.data.command).toHaveBeenLastCalledWith(1004, Buffer.alloc(4), 0, 0);
    expect(old.agent.write).not.toHaveBeenCalled();
    const fresh = layers();
    const view = await fresh.router.mediaProviderFor({ ...route, version: 3376, live: live(1) }).live();
    expect(sent(fresh.agent, 0)).toMatchObject({ cmd: 1700, flag: 10 });
    expect(fresh.data.command).not.toHaveBeenCalled();
    view.stop();
    fresh.router.close();
  });

  it("routes a T8030 child's live frames on the station's context: 1700 over ANKE above 3742, its route-0 stop on the data channel", async () => {
    const hub = "T8030P0000000000";
    const live = { start: { ...SOLO_LIVE!.start, rtcSendRoute: 0 }, stop: { ...SOLO_LIVE!.stop, rtcSendRoute: 0 } };
    const route = { ...ROUTE, stationSn: hub, cameraSn: "T8223P0000000001", channel: 2, live };
    const old = layers();
    const consumer = await old.router.mediaProviderFor({ ...route, version: 3742 }).live();
    await vi.waitFor(() => expect(old.data.command).toHaveBeenCalledWith(1700, expect.any(Buffer), 2, 10));
    consumer.stop();
    old.router.close();
    expect(old.data.command).toHaveBeenLastCalledWith(1004, u32(2), 2, 0);
    const fresh = layers();
    const view = await fresh.router.mediaProviderFor({ ...route, version: 3743 }).live();
    expect(sent(fresh.agent, 0)).toMatchObject({ cmd: 1700, flag: 10 });
    view.stop();
    fresh.router.close();
    expect(fresh.agent.write).toHaveBeenCalledOnce();
  });

  it("talks inside a T9000 camera's view: 1005/1006 over the data channel, Opus as plain RTP on the PM call", async () => {
    const { router, agent, data } = layers();
    const talkStart = { cmd: 1005, body: "native", payload: {}, layout: "u32-ch" } as const;
    const talkStop = { cmd: 1006, body: "native", payload: {}, layout: "u32-ch" } as const;
    const route = { ...ROUTE, version: 4000, live: { ...NVR_LIVE!, talkStart, talkStop } };
    const opening = router.mediaProviderFor(route).talkback!();
    await vi.waitFor(() => expect(agent.write).toHaveBeenCalled());
    const idr = Buffer.alloc(22);
    idr.writeUInt32BE(0x80e30001);
    idr.writeUInt32BE(9000, 4);
    idr[12] = 0x65;
    idr.writeBigUInt64LE(BigInt(Date.now()), 13);
    idr[21] = 3;
    agent.emit("data", idr);
    const talk = await opening;
    expect(talk.codec).toBe("opus");
    await vi.waitFor(() => expect(data.command).toHaveBeenLastCalledWith(1005, u32(3), 3, 0));
    const opus = Buffer.from("one opus packet");
    talk.write(opus);
    await vi.waitFor(() => expect((agent.write.mock.calls.at(-1)![0] as Buffer)[1]).toBe(0x80 | 111));
    const rtp = agent.write.mock.calls.at(-1)![0] as Buffer;
    expect([rtp[0], rtp.readUInt32BE(8), rtp.subarray(12)]).toEqual([0x80, CALL.audio, opus]);
    await talk.stop();
    expect(data.command).toHaveBeenLastCalledWith(1006, u32(3), 3, 0);
    router.close();
  });

  it("sends talkback audio only once start_intercom is written, as the app enables its mic on its success", async () => {
    const { router, agent, data } = layers();
    data.connected = false;
    const talkStart = { cmd: 1005, body: "native", payload: {}, layout: "u32-ch" } as const;
    const talkStop = { cmd: 1006, body: "native", payload: {}, layout: "u32-ch" } as const;
    const route = { ...ROUTE, version: 4000, live: { ...NVR_LIVE!, talkStart, talkStop } };
    const opening = router.mediaProviderFor(route).talkback!();
    await vi.waitFor(() => expect(agent.write).toHaveBeenCalled());
    const idr = Buffer.alloc(22);
    idr.writeUInt32BE(0x80e30001);
    idr.writeUInt32BE(9000, 4);
    idr[12] = 0x65;
    idr.writeBigUInt64LE(BigInt(Date.now()), 13);
    idr[21] = 3;
    agent.emit("data", idr);
    const talk = await opening;
    const audio = () => agent.write.mock.calls.filter(([p]) => ((p as Buffer)[1]! & 0x7f) === 111);
    talk.write(Buffer.from("before the start"));
    await new Promise((r) => setTimeout(r, 100));
    expect([data.command.mock.calls.length, audio().length]).toEqual([0, 0]);
    data.connected = true;
    await vi.waitFor(() => expect(data.command).toHaveBeenCalledWith(1005, u32(3), 3, 0));
    talk.write(Buffer.from("after the start"));
    await vi.waitFor(() => expect(audio()).toHaveLength(1));
    expect((audio()[0]![0] as Buffer).subarray(12)).toEqual(Buffer.from("after the start"));
    await talk.stop();
    router.close();
  });

  it("a failed start_intercom sends no stop_intercom until the talkback is stopped, as the app's player sits in Failed", async () => {
    const { router, agent, data, priv1 } = layers();
    priv1.mockImplementationOnce(() => {
      throw new Error("no data channel");
    });
    const talkStart = { cmd: 1005, body: "native", payload: {}, layout: "u32-ch" } as const;
    const talkStop = { cmd: 1006, body: "native", payload: {}, layout: "u32-ch" } as const;
    const route = { ...ROUTE, version: 4000, live: { ...NVR_LIVE!, talkStart, talkStop } };
    const opening = router.mediaProviderFor(route).talkback!();
    await vi.waitFor(() => expect(agent.write).toHaveBeenCalled());
    const idr = Buffer.alloc(22);
    idr.writeUInt32BE(0x80e30001);
    idr.writeUInt32BE(9000, 4);
    idr[12] = 0x65;
    idr.writeBigUInt64LE(BigInt(Date.now()), 13);
    idr[21] = 3;
    agent.emit("data", idr);
    const talk = await opening;
    const failed = new Promise<Error>((r) => talk.on("error", r));
    expect((await failed).message).toContain("did not take start_intercom");
    await new Promise((r) => setTimeout(r, 50));
    expect(data.command).not.toHaveBeenCalled();
    await talk.stop();
    await vi.waitFor(() => expect(data.command).toHaveBeenCalledWith(1006, u32(3), 3, 0));
    router.close();
  });

  it("refuses a live view without the start JSON", async () => {
    const { router } = layers();
    await expect(router.mediaProviderFor({ ...ROUTE, live: undefined }).live()).rejects.toThrow("no RTC start frame");
    router.close();
  });

  it("quick-logs a station in with its cached token and caches the token a new login hands out", async () => {
    const { signal, data, priv1, pmIce } = layers();
    const options: RtcSignalOptions[] = [];
    const token = { aes: "A".repeat(16), contactId: "synthetic-contact", addr: "192.0.2.2", authTimestamp: 1 };
    const tokens = { get: vi.fn(() => token), set: vi.fn() };
    const router = new RtcCommandRouter({
      userId: () => "synthetic-user",
      appId: "0123456789abcdef",
      tokens,
      layers: { signal: (o) => (options.push(o), signal as unknown as RtcSignalClient), priv1, pmIce },
    });
    await router.dispatchCommand(ROUTE, { kind: "set-json", param: 1400, data: {}, channel: 3 });
    expect([tokens.get.mock.calls[0], options[0]!.token]).toEqual([[ROUTE.stationSn], token]);
    const fresh = { ...token, aes: "B".repeat(16) };
    signal.emit("token", fresh);
    expect(tokens.set).toHaveBeenCalledExactlyOnceWith(ROUTE.stationSn, fresh);
    expect(data.command).toHaveBeenCalled();
    router.close();
  });

  it("ships without node-datachannel", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).not.toHaveProperty("node-datachannel");
  });
});
