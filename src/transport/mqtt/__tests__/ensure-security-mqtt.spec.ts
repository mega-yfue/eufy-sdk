import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EufyDevice } from "../../../core/types.js";

/**
 * `MqttCommandRouter.ensureSecurityMqttFor` — the broker-instance probe. A lock's session lives on the
 * region's `security-mqtt-*` cluster, not the `aiot-mqtt-*` endpoint the credential names, so the router
 * probes that cluster's instances with a SUBSCRIBE-only connection and pins the real connection to the
 * first that grants. A device the security cluster refuses outright is not on it, and is probed on the
 * `aiot` endpoint instead. A device no instance grants is reported rather than connected to a broker that
 * will never route to it.
 *
 * The account's own credentials are the ONLY credentials used — there is no cert override, so the
 * router does no filesystem access at all. `discoverReachableInstance` and `SecureMqtt` are mocked (no
 * real network); `secureTopic`/`buildAppShapedClientId`/`mqttUuidFrom` stay real (pure).
 */
const discoverReachableInstance = vi.fn();
vi.mock("../broker-discovery.js", () => ({ discoverReachableInstance }));

const connectMock = vi.fn().mockResolvedValue(undefined);
let lastConstructedWith: any;
vi.mock("../secure-mqtt.js", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeSecureMqtt extends EventEmitter {
    constructor(opts: any) {
      super();
      lastConstructedWith = opts;
    }
    connect = connectMock;
  }
  const actual = await vi.importActual<typeof import("../secure-mqtt.js")>("../secure-mqtt.js");
  return {
    SecureMqtt: FakeSecureMqtt,
    isSubackFailure: actual.isSubackFailure,
    secureTopic: (d: EufyDevice, leg: string = "res") => `cmd/${d.category}/${d.model}/${d.sn}/${leg}`,
  };
});

const { MqttCommandRouter } = await import("../command-router.js");
const { mqttUuidFrom } = await import("../app-client-id.js");

const DEV = { sn: "T85D0K0000000000", category: "eufy_security", model: "T85D0" } as unknown as EufyDevice;

const OWN_CREDS = {
  endpoint_addr: "aiot-mqtt-us.anker.com",
  endpoint_port: 8883,
  certificate_pem: "OWN_CERT",
  private_key: "OWN_KEY",
  aws_root_ca1_pem: "CA",
  user_id: "u1",
};

/** The install identity the one-shot client id is built from, as `MegaHttpClient` resolves it. */
const OPENUDID = "a".repeat(16);

function makeRouter() {
  return new MqttCommandRouter({
    mega: { getUserMqttInfo: vi.fn().mockResolvedValue(OWN_CREDS), openudid: OPENUDID } as any,
    listDevices: () => [DEV],
    ensureDevices: async () => {},
    onCommandAck: () => {},
    onError: () => {},
  });
}

function granted(ip: string) {
  return [{ ip, granted: true, grantedQos: 1, ms: 10 }];
}
/** Every instance answering the SUBSCRIBE with a SUBACK deny — the cluster refusing the topic outright. */
function suback80() {
  return [
    { ip: "192.0.2.10", granted: false, grantedQos: 0x80, error: "Subscribe error: Unspecified error", ms: 10 },
    { ip: "198.51.100.20", granted: false, grantedQos: 0x80, error: "Subscribe error: Unspecified error", ms: 10 },
  ];
}
function allDenied() {
  return [
    { ip: "1.1.1.1", granted: false, error: "denied", ms: 10 },
    { ip: "2.2.2.2", granted: false, error: "denied", ms: 10 },
  ];
}

describe("MqttCommandRouter.ensureSecurityMqttFor — broker-instance probe", () => {
  beforeEach(() => {
    discoverReachableInstance.mockReset();
    lastConstructedWith = undefined;
  });

  it("pins the connection to a granting instance of the region's security cluster, with the account's credentials", async () => {
    discoverReachableInstance.mockResolvedValueOnce(granted("192.0.2.30"));
    const router = makeRouter();

    const { instanceIp } = await (router as any).ensureSecurityMqttFor(DEV);

    expect(instanceIp).toBe("192.0.2.30");
    expect(discoverReachableInstance).toHaveBeenCalledTimes(1);
    const [probed, opts] = discoverReachableInstance.mock.calls[0]!;
    expect(probed.hostname).toBe("security-mqtt-us.anker.com");
    expect(opts.candidateIps).toBeUndefined();
    expect(lastConstructedWith.credentials).toMatchObject({
      certificate_pem: "OWN_CERT",
      private_key: "OWN_KEY",
      endpoint_addr: "security-mqtt-us.anker.com",
      aws_root_ca1_pem: "CA",
    });
  });

  it("refuses an endpoint whose region it cannot read, without probing", async () => {
    const router = new MqttCommandRouter({
      mega: {
        getUserMqttInfo: vi.fn().mockResolvedValue({ ...OWN_CREDS, endpoint_addr: "mqtt.example.com" }),
        openudid: OPENUDID,
      } as any,
      listDevices: () => [DEV],
      ensureDevices: async () => {},
      onCommandAck: () => {},
      onError: () => {},
    });

    await expect((router as any).ensureSecurityMqttFor(DEV)).rejects.toThrow(/no security broker known/);
    expect(discoverReachableInstance).not.toHaveBeenCalled();
  });

  it("identifies itself the same way on every run, being built from the install's own identity", async () => {
    discoverReachableInstance.mockResolvedValue(granted("192.0.2.30"));

    await (makeRouter() as any).ensureSecurityMqttFor(DEV);
    const first = lastConstructedWith.clientId;
    await (makeRouter() as any).ensureSecurityMqttFor(DEV);

    expect(first.split("-")[3]).toBe(mqttUuidFrom(OPENUDID));
    expect(lastConstructedWith.clientId.split("-")[3]).toBe(first.split("-")[3]);
  });

  it("throws after one probe round when every candidate denies", async () => {
    discoverReachableInstance.mockResolvedValueOnce(allDenied());
    const router = makeRouter();

    await expect((router as any).ensureSecurityMqttFor(DEV)).rejects.toThrow(
      /no broker instance grants this device's topic/,
    );
    expect(discoverReachableInstance).toHaveBeenCalledTimes(1);
  });

  it("probes the aiot endpoint when the security host resolves to no instance", async () => {
    discoverReachableInstance.mockResolvedValueOnce([]).mockResolvedValueOnce(granted("192.0.2.40"));

    const { instanceIp } = await (makeRouter() as any).ensureSecurityMqttFor(DEV);

    expect(instanceIp).toBe("192.0.2.40");
    expect(discoverReachableInstance.mock.calls[1]![0].hostname).toBe("aiot-mqtt-us.anker.com");
  });

  it("probes the aiot endpoint, with its seed instances, for a device the security cluster refuses outright", async () => {
    discoverReachableInstance.mockResolvedValueOnce(suback80()).mockResolvedValueOnce(granted("192.0.2.40"));

    const { instanceIp } = await (makeRouter() as any).ensureSecurityMqttFor(DEV);

    expect(instanceIp).toBe("192.0.2.40");
    expect(discoverReachableInstance).toHaveBeenCalledTimes(2);
    const [probed, opts] = discoverReachableInstance.mock.calls[1]!;
    expect(probed.hostname).toBe("aiot-mqtt-us.anker.com");
    expect(opts.candidateIps).toContain("3.139.229.186");
    expect(lastConstructedWith.credentials.endpoint_addr).toBe("aiot-mqtt-us.anker.com");
  });

  it("names each candidate's reason when none grants, a SUBACK deny code included", async () => {
    discoverReachableInstance.mockResolvedValueOnce([
      { ip: "192.0.2.10", granted: false, grantedQos: 0x80, error: "Subscribe error: Unspecified error", ms: 10 },
      { ip: "198.51.100.20", granted: false, error: "timeout", ms: 8000 },
    ]);

    const err = await (makeRouter() as any).ensureSecurityMqttFor(DEV).catch((e: Error) => e);

    expect(err.message).toContain("192.0.2.10 SUBACK 0x80 Subscribe error: Unspecified error");
    expect(err.message).toContain("198.51.100.20 timeout");
    expect(err.message).not.toMatch(/may be offline/);
  });
});
