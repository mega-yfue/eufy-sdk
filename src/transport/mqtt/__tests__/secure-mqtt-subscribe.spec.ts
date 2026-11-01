import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import { nextClient } from "./lazy-engine.js";
import type { EufyDevice } from "../../../core/types.js";

/**
 * `SecureMqtt`'s subscribe paths against the MQTT engine's SUBACK behaviour: one refused grant rejects
 * the whole `subscribeAsync` with `Subscribe error: Unspecified error` and the SUBACK attached as
 * `packet`. The fake client reproduces exactly that, per request.
 */
type FakeClient = EventEmitter & {
  end: ReturnType<typeof vi.fn>;
  subscribeAsync: ReturnType<typeof vi.fn>;
};
const fakeClients: FakeClient[] = [];
let refused = new Set<string>();
let broken: Error | undefined;

function suback(topics: readonly string[]): Promise<unknown> {
  if (broken) return Promise.reject(broken);
  const granted = topics.map((t) => (refused.has(t) ? 128 : 1));
  if (granted.some((g) => g & 0x80)) {
    return Promise.reject(Object.assign(new Error("Subscribe error: Unspecified error"), { packet: { granted } }));
  }
  return Promise.resolve(topics.map((topic, i) => ({ topic, qos: granted[i] })));
}

vi.mock("mqtt", () => ({
  default: {
    connect: vi.fn(() => {
      const client = new EventEmitter() as FakeClient;
      client.end = vi.fn();
      client.subscribeAsync = vi.fn((topic: string | string[]) => suback(Array.isArray(topic) ? topic : [topic]));
      fakeClients.push(client);
      return client;
    }),
  },
}));

const { SecureMqtt } = await import("../secure-mqtt.js");

const CREDS = {
  endpoint_addr: "aiot-mqtt-eu.anker.com",
  certificate_pem: "cert",
  private_key: "key",
  aws_root_ca1_pem: "ca",
  thing_name: "u000-eufy_mega",
  app_name: "eufy_mega",
};

const VACUUM = {
  sn: "T2000P0000000000",
  model: "T2000",
  category: "eufy_home",
  deviceClass: "vacuum",
} as unknown as EufyDevice;

async function connected() {
  const m = new SecureMqtt({ credentials: CREDS });
  const errors: Error[] = [];
  m.on("error", (e: Error) => errors.push(e));
  const p = m.connect();
  (await nextClient(fakeClients)).emit("connect");
  await p;
  return { m, errors, client: fakeClients[0]! };
}

describe("SecureMqtt.subscribeDevice — a partly refused line", () => {
  beforeEach(() => {
    fakeClients.length = 0;
    refused = new Set();
    broken = undefined;
  });

  it("resolves when only some legs are refused, reporting each refused one", async () => {
    const { m, errors, client } = await connected();
    refused = new Set([`biz/eufy_home/T2000/${VACUUM.sn}/req`, `dt/eufy_home/T2000/${VACUUM.sn}/param_info`]);

    await expect(m.subscribeDevice(VACUUM)).resolves.toBeUndefined();

    expect(client.subscribeAsync).toHaveBeenCalledTimes(4);
    expect(errors.map((e) => e.message)).toEqual([
      `subscribe ${VACUUM.sn}: "biz/eufy_home/T2000/${VACUUM.sn}/req" denied on credential scope "eufy_mega"`,
      `subscribe ${VACUUM.sn}: "dt/eufy_home/T2000/${VACUUM.sn}/param_info" denied on credential scope "eufy_mega"`,
    ]);
  });

  it("throws when every leg is refused", async () => {
    const { m } = await connected();
    refused = new Set([
      `cmd/eufy_home/T2000/${VACUUM.sn}/res`,
      `biz/eufy_home/T2000/${VACUUM.sn}/res`,
      `biz/eufy_home/T2000/${VACUUM.sn}/req`,
      `dt/eufy_home/T2000/${VACUUM.sn}/param_info`,
    ]);

    await expect(m.subscribeDevice(VACUUM)).rejects.toThrow(/every topic denied on credential scope "eufy_mega"/);
  });

  it("rethrows a failure that carries no SUBACK", async () => {
    const { m } = await connected();
    broken = new Error("client disconnecting");

    await expect(m.subscribeDevice(VACUUM)).rejects.toThrow("client disconnecting");
  });
});

describe("SecureMqtt.subscribe — explicit filters", () => {
  beforeEach(() => {
    fakeClients.length = 0;
    refused = new Set();
    broken = undefined;
  });

  it("answers the granted filters and drops the refused ones", async () => {
    const { m } = await connected();
    refused = new Set(["dt/app/pn/sn/state_info"]);

    await expect(m.subscribe(["dt/app/pn/sn/param_info", "dt/app/pn/sn/state_info"])).resolves.toEqual([
      "dt/app/pn/sn/param_info",
    ]);
  });
});
