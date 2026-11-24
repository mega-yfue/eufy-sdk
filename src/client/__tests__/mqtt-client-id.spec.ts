import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EufyDevice } from "../../core/types.js";

/**
 * The client id the long-lived secure-MQTT transports connect under.
 *
 * The certificate's own name (`thing_name` = `{user_id}-{app_name}`) identifies the ACCOUNT and the
 * line, not the client, and the broker resolves a duplicate client id by evicting the incumbent — so
 * two clients under one name flap indefinitely, neither holding a channel. These specs pin what the id
 * is built from and how far it actually separates two clients.
 *
 * `SecureMqtt` is mocked (no sockets, no cloud); `buildAppShapedClientId` and `mqttUuidFrom` stay real
 * — they are pure, and what they produce is exactly what is under test.
 */
const connect = vi.fn().mockResolvedValue(undefined);
const constructedWith: any[] = [];
vi.mock("../../transport/mqtt/secure-mqtt.js", async () => {
  const actual = await vi.importActual<typeof import("../../transport/mqtt/secure-mqtt.js")>(
    "../../transport/mqtt/secure-mqtt.js",
  );
  const { EventEmitter } = await import("node:events");
  class FakeSecureMqtt extends EventEmitter {
    constructor(opts: any) {
      super();
      constructedWith.push(opts);
    }
    connect = connect;
    subscribeDevice = vi.fn(async () => {});
    disconnect = vi.fn(async () => {});
  }
  return { ...actual, SecureMqtt: FakeSecureMqtt };
});

const { EufyMega } = await import("../eufy-mega.js");

/** A synthetic account id of the right shape — 40 hex, as the cloud issues them. */
const UID = "0".repeat(40);

const CREDS = {
  endpoint_addr: "aiot-mqtt-eu.anker.com",
  endpoint_port: 8883,
  certificate_pem: "CERT",
  private_key: "KEY",
  aws_root_ca1_pem: "CA",
  thing_name: `${UID}-eufy_mega`,
  user_id: UID,
};

/** A client signed in far enough to bring one MQTT scope up, with no network behind it. */
function makeClient(options: Record<string, unknown> = {}, creds: Record<string, unknown> = CREDS) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", ...options });
  Object.defineProperty((eufy as any).mega, "auth", {
    configurable: true,
    get: () => ({ userId: UID, authToken: "t" }),
  });
  const dev = { sn: "T8000P0000000000", category: "eufy_mega" } as unknown as EufyDevice;
  vi.spyOn((eufy as any).registry, "list").mockReturnValue([dev]);
  vi.spyOn(eufy, "getMqttDevices").mockReturnValue([]);
  vi.spyOn(eufy, "getUserMqttInfo").mockResolvedValue(creds as never);
  return eufy;
}

/** The whole bring-up, which is what owns the memo a second call would find. */
const bringUp = (eufy: any, scope = "default"): Promise<void> => eufy.ensureMqttStarted(scope);

const clientIds = (): string[] => constructedWith.map((o) => o.clientId);

describe("secure-MQTT client id", () => {
  beforeEach(() => {
    constructedWith.length = 0;
    connect.mockReset().mockResolvedValue(undefined);
  });

  it("identifies the clean stack's client as MqttConnectionNew: its uuid then the endpoint without dashes", async () => {
    await bringUp(makeClient({ openudid: "a".repeat(16) }));

    expect(constructedWith).toHaveLength(1);
    const endpoint = CREDS.endpoint_addr.replace(/-/g, "");
    expect(clientIds()[0]).toMatch(
      new RegExp(`^android-eufy_mega-${UID}-[0-9a-f]{32}${endpoint.replace(/\./g, "\\.")}$`),
    );
    expect(clientIds()[0]).not.toContain(CREDS.thing_name);
    expect(constructedWith[0]).toMatchObject({ backoff: { attempts: 3 } });
  });

  it("takes the credential's own app name, and the scope's when it reports none", async () => {
    await bringUp(makeClient({ openudid: "a".repeat(16) }, { ...CREDS, app_name: "eufy_home" }));
    await bringUp(makeClient({ openudid: "a".repeat(16) }), "eufy_life");

    expect(clientIds()[0]).toContain("-eufy_home-");
    expect(clientIds()[1]).toContain("-eufy_life-");
  });

  it("connects the security and light stacks as the app does, under the raw openudid", async () => {
    const openudid = "a".repeat(16);
    await bringUp(makeClient({ openudid }, { ...CREDS, app_name: "eufy_security" }), "eufy_security");
    await bringUp(makeClient({ openudid }), "eufy_life");

    expect(constructedWith[0]).toMatchObject({ clientId: `android-eufy_security-${UID}-${openudid}`, keepaliveS: 300 });
    expect(constructedWith[1]).toMatchObject({ clientId: `android-eufy_life-${UID}-${openudid}`, keepaliveS: 300 });
  });

  it("takes a fresh random uuid for each clean-line client, as the app's EncryptUtil.generateUUID", async () => {
    await bringUp(makeClient({ openudid: "a".repeat(16) }));
    await bringUp(makeClient({ openudid: "a".repeat(16) }));
    expect(clientIds()[0]).not.toBe(clientIds()[1]);
  });

  it("asks the security certificate again when the cached one is refused, as the app's force refresh", async () => {
    const eufy = makeClient({ openudid: "a".repeat(16) });
    const fresh = vi.spyOn((eufy as any).mega, "getUserMqttInfo").mockResolvedValue({ ...CREDS, private_key: "NEW" });
    connect.mockRejectedValueOnce(new Error("certificate refused")).mockResolvedValue(undefined);

    await bringUp(eufy, "eufy_security");
    expect(fresh).toHaveBeenCalledWith("eufy_security", true);
    expect(constructedWith.at(-1).credentials.private_key).toBe("NEW");
  });

  it("rejects a failed connect without announcing it, and asks again under its own id", async () => {
    const eufy = makeClient({ openudid: "a".repeat(16) });
    const connected = vi.fn();
    eufy.on("connect", connected);
    connect.mockRejectedValueOnce(new Error("ECONNRESET")).mockResolvedValue(undefined);

    await expect(bringUp(eufy)).rejects.toThrow("ECONNRESET");
    expect(connected).not.toHaveBeenCalled();

    await bringUp(eufy);
    expect(clientIds()[1]).toMatch(/^android-/);
    expect(connected).toHaveBeenCalledTimes(1);
  });
});
