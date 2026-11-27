import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { MqttCommandRouter } from "../command-router.js";
import type { EufyDevice } from "../../../core/types.js";

/**
 * `MqttCommandRouter.dispatchCommand` on the `ff09-actuate` intent — no live broker: `ensureSecurityMqttFor`
 * is stubbed, device resolution comes from the injected `listDevices`, and the "MQTT connection" is a
 * bare EventEmitter standing in for `SecureMqtt` (subscribe/publish/disconnect are no-ops; `message`
 * events are emitted manually to simulate a device `/res` reply). Fake timers drive the ack-wait
 * deterministically instead of a real multi-second sleep. `commandAck` is asserted via the injected
 * `onCommandAck` callback (the facade re-emits it as the `commandAck` event).
 */
function makeRouter(sn = "T85D0K0000000000", raw: Record<string, unknown> = { device_new_pn: "T85D0" }) {
  const dev = {
    sn,
    category: "eufy_security",
    model: "T85D0C",
    raw,
  } as unknown as EufyDevice;
  const acks: any[] = [];
  const router = new MqttCommandRouter({
    mega: {} as any,
    listDevices: () => [dev],
    ensureDevices: async () => {},
    onCommandAck: (info) => acks.push(info),
    onError: () => {},
  });

  const fakeMqtt = new EventEmitter() as EventEmitter & {
    id: string;
    subscribeDevice: (d: EufyDevice) => Promise<void>;
    publish: (topic: string, body: string, opts?: unknown) => Promise<void>;
    disconnect: () => Promise<void>;
  };
  fakeMqtt.id = "client-1";
  fakeMqtt.subscribeDevice = vi.fn().mockResolvedValue(undefined);
  fakeMqtt.publish = vi.fn().mockResolvedValue(undefined);
  fakeMqtt.disconnect = vi.fn().mockResolvedValue(undefined);

  vi.spyOn(router as any, "ensureSecurityMqttFor").mockResolvedValue({ mqtt: fakeMqtt, instanceIp: "198.51.100.7" });

  const cmd = {
    kind: "ff09-actuate" as const,
    engage: true,
    adminUserId: "0000000000000000000000000000000000000000",
    username: "someone+tag",
    shortUserId: "0003",
    deviceSn: sn,
  };
  return { router, fakeMqtt, cmd, acks };
}

describe("MqttCommandRouter.claimsDevice", () => {
  it("claims a eufy-cloud device with no p2p_did endpoint (MQTT-only lock/garage), declines a P2P one", () => {
    expect(MqttCommandRouter.claimsDevice({ api: "mega", p2pDid: "" } as EufyDevice)).toBe(true);
    expect(MqttCommandRouter.claimsDevice({ api: "mega" } as EufyDevice)).toBe(true);
    expect(MqttCommandRouter.claimsDevice({ api: "mega", p2pDid: "DID-XYZ" } as EufyDevice)).toBe(false);
  });

  it("does NOT claim a device on another cloud — a printer isn't swept onto the eufy MQTT plane", () => {
    // api "ankermake" (a printer): no P2P endpoint, but not this stack's plane → neither router claims it.
    expect(MqttCommandRouter.claimsDevice({ api: "ankermake", p2pDid: "" } as EufyDevice)).toBe(false);
  });
});

describe("MqttCommandRouter.dispatchCommand (ff09-actuate)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("subscribes BEFORE publishing (no race between listener attach and an instant reply)", async () => {
    const { router, fakeMqtt, cmd } = makeRouter();
    const order: string[] = [];
    (fakeMqtt.subscribeDevice as any).mockImplementation(async () => order.push("subscribe"));
    (fakeMqtt.publish as any).mockImplementation(async () => order.push("publish"));

    const p = router.dispatchCommand("T85D0K0000000000", cmd);
    await vi.advanceTimersByTimeAsync(5000);
    await p;

    expect(order).toEqual(["subscribe", "publish"]);
  });

  it("resolves as soon as the /res message arrives, without waiting the full timeout", async () => {
    const { router, fakeMqtt, cmd, acks } = makeRouter();

    const p = router.dispatchCommand("T85D0K0000000000", cmd);
    await vi.advanceTimersByTimeAsync(0); // let subscribe+publish microtasks settle
    fakeMqtt.emit("message", { topic: "cmd/eufy_security/T85D0/T85D0K0000000000/res" });
    await p;

    expect(vi.mocked(fakeMqtt.publish).mock.calls[0]![0]).toBe("cmd/eufy_security/T85D0/T85D0K0000000000/req");
    expect(acks).toEqual([{ sn: "T85D0K0000000000", kind: "ff09-actuate", acked: true, instanceIp: "198.51.100.7" }]);
    expect(fakeMqtt.disconnect).toHaveBeenCalledOnce();
  });

  it("names the topic after the serial when the record has no device_new_pn, never device_model", async () => {
    for (const [sn, pn] of [
      ["T85D0K0000000000", "T85D0"],
      ["T852009000000000", "T8520P"],
    ]) {
      const { router, fakeMqtt, cmd } = makeRouter(sn, {});
      const p = router.dispatchCommand(sn, cmd);
      await vi.advanceTimersByTimeAsync(5000);
      await p;
      expect(vi.mocked(fakeMqtt.publish).mock.calls[0]![0]).toBe(`cmd/eufy_security/${pn}/${sn}/req`);
    }
  });

  it("resolves (does not throw) on timeout with no reply, reporting acked:false", async () => {
    const { router, fakeMqtt, cmd, acks } = makeRouter();

    const p = router.dispatchCommand("T85D0K0000000000", cmd);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(p).resolves.toBeUndefined(); // fire-and-forget: no ack is not an error

    expect(acks).toEqual([{ sn: "T85D0K0000000000", kind: "ff09-actuate", acked: false, instanceIp: "198.51.100.7" }]);
    expect(fakeMqtt.disconnect).toHaveBeenCalledOnce();
  });

  it("ignores a message on an unrelated topic (not a /res suffix)", async () => {
    const { router, fakeMqtt, cmd, acks } = makeRouter();

    const p = router.dispatchCommand("T85D0K0000000000", cmd);
    await vi.advanceTimersByTimeAsync(0);
    fakeMqtt.emit("message", { topic: "cmd/eufy_security/T85D0/T85D0K0000000000/req" }); // not /res
    await vi.advanceTimersByTimeAsync(5000);
    await p;

    expect(acks).toEqual([{ sn: "T85D0K0000000000", kind: "ff09-actuate", acked: false, instanceIp: "198.51.100.7" }]);
  });

  it("always disconnects, even when the publish throws", async () => {
    const { router, fakeMqtt, cmd } = makeRouter();
    (fakeMqtt.publish as any).mockRejectedValue(new Error("broker down"));

    await expect(router.dispatchCommand("T85D0K0000000000", cmd)).rejects.toThrow("broker down");
    expect(fakeMqtt.disconnect).toHaveBeenCalledOnce();
  });
});
