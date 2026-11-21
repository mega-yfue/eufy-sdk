import { describe, it, expect, vi, beforeEach } from "vitest";
import type { EufyDevice } from "../../core/types.js";
import type { PersistedSession, SessionStore } from "../../core/store.js";

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

/** A store that already holds an identity, as one does on every run after the first. */
function storeHolding(session: Partial<PersistedSession>): SessionStore {
  let held = session as PersistedSession;
  return {
    load: () => held,
    save: (s) => {
      held = s;
    },
    clear: () => {},
  };
}

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
const uuidOf = (clientId: string): string | undefined => clientId?.split("-")[3];

describe("secure-MQTT client id", () => {
  beforeEach(() => {
    constructedWith.length = 0;
    connect.mockReset().mockResolvedValue(undefined);
  });

  it("identifies the client, not the certificate", async () => {
    await bringUp(makeClient({ openudid: "a".repeat(16) }));

    expect(constructedWith).toHaveLength(1);
    expect(clientIds()[0]).toMatch(new RegExp(`^android-eufy_mega-${UID}-[0-9a-f]{16}-\\d+$`));
    expect(clientIds()[0]).not.toContain(CREDS.thing_name);
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

  it("survives a restart, because the identity it is built from is the persisted one", async () => {
    const store = storeHolding({ openudid: "b".repeat(16) } as Partial<PersistedSession>);
    await bringUp(makeClient({ store }));
    await bringUp(makeClient({ store }));

    expect(uuidOf(clientIds()[0]!)).toBe(uuidOf(clientIds()[1]!));
  });

  it("separates two clients only as far as their openudid does", async () => {
    await bringUp(makeClient({ openudid: "a".repeat(16) }));
    await bringUp(makeClient({ openudid: "c".repeat(16) }));
    expect(uuidOf(clientIds()[0]!)).not.toBe(uuidOf(clientIds()[1]!));

    // And the limit of that, stated rather than implied: a caller configuring no `openudid` is given
    // one derived from the ACCOUNT, so two such clients are one client to the broker and go on
    // evicting each other. `MegaClientConfig.openudid` is what a host sets to be told apart — the
    // same setting that already keeps their logins from displacing each other.
    await bringUp(makeClient());
    await bringUp(makeClient());
    expect(uuidOf(clientIds()[2]!)).toBe(uuidOf(clientIds()[3]!));
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
