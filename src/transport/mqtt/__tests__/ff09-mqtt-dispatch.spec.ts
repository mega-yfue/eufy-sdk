import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { MqttCommandRouter } from "../command-router.js";
import type { EufyDevice } from "../../../core/types.js";

/**
 * `MqttCommandRouter.dispatchCommand` on the `ff09-actuate` intent — no live broker: the `secureTransport` dep
 * hands back a fake, device resolution comes from the injected `listDevices`, and the "MQTT connection" is a
 * bare EventEmitter standing in for `SecureMqtt` (publish is a no-op; `message`
 * events are emitted manually to simulate a device `/res` reply). Fake timers drive the ack-wait
 * deterministically instead of a real multi-second sleep. `commandAck` is asserted via the injected
 * `onCommandAck` callback (the facade re-emits it as the `commandAck` event).
 */
function makeRouter(
  sn = "T85D0K0000000000",
  raw: Record<string, unknown> = { device_new_pn: "T85D0" },
  getPnBySn = vi.fn().mockRejectedValue(new Error("offline")),
) {
  const dev = {
    sn,
    category: "eufy_security",
    model: "T85D0C",
    raw,
  } as unknown as EufyDevice;
  const acks: any[] = [];
  const fakeMqtt = Object.assign(new EventEmitter(), {
    id: "client-1",
    publish: vi.fn<(topic: string, body: string, opts?: unknown) => Promise<void>>().mockResolvedValue(undefined),
  });
  const router = new MqttCommandRouter({
    mega: { getPnBySn } as any,
    listDevices: () => [dev],
    ensureDevices: async () => {},
    onCommandAck: (info) => acks.push(info),
    onError: () => {},
    secureTransport: async () => fakeMqtt as any,
  });

  const cmd = {
    kind: "ff09-actuate" as const,
    engage: true,
    adminUserId: "0000000000000000000000000000000000000000",
    username: "someone+tag",
    shortUserId: "0003",
    deviceSn: sn,
  };
  return { router, fakeMqtt, cmd, acks, getPnBySn };
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

  it("resolves as soon as the /res message arrives, without waiting the full timeout", async () => {
    const { router, fakeMqtt, cmd, acks } = makeRouter();

    const p = router.dispatchCommand("T85D0K0000000000", cmd);
    await vi.advanceTimersByTimeAsync(0); // let the publish microtasks settle
    fakeMqtt.emit("message", { topic: "cmd/eufy_security/T85D0/T85D0K0000000000/res", raw: { head: { cmd: 8 } } });
    await p;

    expect(vi.mocked(fakeMqtt.publish).mock.calls[0]![0]).toBe("cmd/eufy_security/T85D0/T85D0K0000000000/req");
    expect(acks).toEqual([{ sn: "T85D0K0000000000", kind: "ff09-actuate", acked: true }]);
  });

  it("names the topic after the serial when the record has no device_new_pn, never device_model", async () => {
    for (const [sn, pn, calls] of [
      ["T85D0K0000000000", "T85D0", 1], // get_pn_by_sn fails → first five characters
      ["T852009000000000", "T8520P", 0], // the T8520 table answers without the cloud
    ] as const) {
      const { router, fakeMqtt, cmd, getPnBySn } = makeRouter(sn, {});
      const p = router.dispatchCommand(sn, cmd);
      await vi.advanceTimersByTimeAsync(10_000);
      await p;
      expect(vi.mocked(fakeMqtt.publish).mock.calls[0]![0]).toBe(`cmd/eufy_security/${pn}/${sn}/req`);
      expect(getPnBySn).toHaveBeenCalledTimes(calls);
    }
  });

  it("takes get_pn_by_sn's answer over the serial, one call for commands racing on a serial", async () => {
    const getPnBySn = vi.fn().mockResolvedValue("T85D2");
    const { router, fakeMqtt, cmd } = makeRouter("T85D0K0000000000", {}, getPnBySn);
    const both = Promise.all([0, 1].map(() => router.dispatchCommand("T85D0K0000000000", cmd)));
    await vi.advanceTimersByTimeAsync(10_000);
    await both;
    expect(vi.mocked(fakeMqtt.publish).mock.calls[1]![0]).toBe("cmd/eufy_security/T85D2/T85D0K0000000000/req");
    expect(getPnBySn).toHaveBeenCalledOnce();
    expect(getPnBySn).toHaveBeenCalledWith("T85D0K0000000000");
  });

  it("resolves (does not throw) on timeout with no reply, reporting acked:false", async () => {
    const { router, cmd, acks } = makeRouter();

    const p = router.dispatchCommand("T85D0K0000000000", cmd);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).resolves.toBe(false); // no ack is not an error, and not done

    expect(acks).toEqual([{ sn: "T85D0K0000000000", kind: "ff09-actuate", acked: false }]);
  });

  it("ignores a message on an unrelated topic (not a /res suffix)", async () => {
    const { router, fakeMqtt, cmd, acks } = makeRouter();

    const p = router.dispatchCommand("T85D0K0000000000", cmd);
    await vi.advanceTimersByTimeAsync(0);
    fakeMqtt.emit("message", { topic: "cmd/eufy_security/T85D0/T85D0K0000000000/req" }); // not /res
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(acks).toEqual([{ sn: "T85D0K0000000000", kind: "ff09-actuate", acked: false }]);
  });

  it("does not take a /res whose head.cmd is not 8 as the ack", async () => {
    const { router, fakeMqtt, cmd, acks } = makeRouter();

    const p = router.dispatchCommand("T85D0K0000000000", cmd);
    await vi.advanceTimersByTimeAsync(0);
    fakeMqtt.emit("message", { topic: "cmd/eufy_security/T85D0/T85D0K0000000000/res", raw: { head: { cmd: 9 } } });
    await vi.advanceTimersByTimeAsync(10_000);
    await p;

    expect(acks).toEqual([{ sn: "T85D0K0000000000", kind: "ff09-actuate", acked: false }]);
  });
});
