/**
 * Secure MQTT ("smqtt") — Anker AIoT broker, mutual-TLS.
 *
 * Broker: mqtts://aiot-mqtt-{region}.anker.com:8883. Credentials come from the
 * mega API `get_user_mqtt_info` call: a per-user client certificate + RSA key,
 * and a server CA (the `aws_root_ca1_pem` field, despite the name, is a GoDaddy
 * root). The default clientId is the cert CN = `{user_id}-{app_name}`.
 *
 * Topic vocabulary and the per-line credential scope live in `./topics.ts` — publish to `/req`
 * (cloud→device commands), subscribe to whichever inbound legs that line uses. Granted for eufy_mega +
 * eufy_home devices; eufy_security (cameras) are DENIED here (they use P2P) — see src/types.ts
 * classifyDevice.
 */
import { EventEmitter } from "node:events";
import type { MqttClient } from "mqtt";
import { loadMqtt } from "./engine.js";
import type { EufyDevice, RealtimeMessage, RealtimeTransport } from "../../core/types.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import { bareIpTlsOptions } from "./bare-ip-tls.js";
import { parseSecureTopic, subscribeTopics } from "./topics.js";

/**
 * The bit a SUBACK return code carries when the broker refused the filter (`0x80` in MQTT 3.1.1, any
 * code at or above it in MQTT 5). AWS IoT answers a policy-denied topic filter with such a grant
 * instead of failing the SUBSCRIBE, so a wrong-scope credential is refused per topic, not per request.
 */
const SUBACK_FAILURE = 0x80;

/**
 * Whether a rejected `subscribeAsync` is the broker refusing the filter. The MQTT engine rejects the
 * WHOLE request when any one grant has the {@link SUBACK_FAILURE} bit (`Subscribe error: Unspecified
 * error`) and attaches the SUBACK it received as `packet`. A rejection that carries no SUBACK — a
 * dropped connection, a client that is not connected — is a transport failure and answers false.
 */
function isRefusal(err: unknown): boolean {
  const granted = (err as { packet?: { granted?: unknown } } | null)?.packet?.granted;
  return Array.isArray(granted) && granted.some((g) => typeof g === "number" && (g & SUBACK_FAILURE) !== 0);
}

/**
 * Whether a connect failed because the broker REFUSED the client — a CONNACK return code the client
 * cannot retry its way out of, as `mqtt.js` words it (`Connection refused: not authorized`). A socket
 * that dies without an answer is not this: it is the same request, unanswered, and retrying it is the
 * only way to learn which of the two happened.
 *
 * A refusal that arrives as a dropped connection instead of a CONNACK reads here as the transport
 * failure it is indistinguishable from.
 */
export function isNotAuthorized(err: unknown): boolean {
  return err instanceof Error && /connection refused/i.test(err.message) && /not authori[sz]ed/i.test(err.message);
}

/**
 * Per-user mTLS credentials as returned by get_user_mqtt_info.
 *
 * Broker credentials as the cloud returns them — internal transport detail.
 * @internal
 */
export interface SecureMqttCredentials {
  /** Broker host, e.g. aiot-mqtt-eu.anker.com (port assumed 8883). */
  endpoint_addr: string;
  endpoint_port?: number;
  /** PEM client certificate (CN = {user_id}-{app_name}). */
  certificate_pem: string;
  /** PEM client private key. */
  private_key: string;
  /** PEM server CA (field is misleadingly named aws_root_ca1_pem — it's a GoDaddy root). */
  aws_root_ca1_pem: string;
  /** Default clientId (cert CN = thing_name). */
  thing_name?: string;
  /** App scope the cert is granted for (the `{app_name}` topic segment) — e.g. `eufy_mega`. */
  app_name?: string;
  /** The account/user id the cert is bound to. */
  user_id?: string;
}

/**
 * Construction options for the internal broker client.
 * @internal
 */
export interface SecureMqttOptions {
  credentials: SecureMqttCredentials;
  clientId?: string;
  /** Dial this IP directly instead of resolving `credentials.endpoint_addr` via DNS — the broker
   * hostname fronts multiple independent backend instances that do NOT share subscribe/publish
   * routing (see `transport/mqtt/broker-discovery.ts`); pin to the instance a device's session was
   * confirmed to be on, found via {@link discoverReachableInstance}. */
  instanceIp?: string;
  /**
   * mqtt.js's own `reconnectPeriod` (ms) — auto-reconnect on an unexpected drop. Default `5000`,
   * right for the one long-lived connection (the facade's auto-started `this.transport`). A **one-shot**
   * connection (opened for a single command, torn down right after — see `MqttCommandRouter.ensureSecurityMqttFor`)
   * must pass `0` here: with a nonzero period, a connect that never establishes (or drops right after)
   * leaves the underlying mqtt.js client retrying against that instance forever, orphaned in the
   * background — {@link SecureMqtt.connect} rejecting/resolving doesn't stop it, only `end()` does, and
   * a one-shot caller has no reason to ever call `end()` again after its one command is done.
   */
  reconnectPeriod?: number;
  /** Diagnostics sink. Omit for silence. */
  logger?: Logger;
}

/**
 * The broker client. Internal transport; a host reaches appliances through the capability surface.
 * @internal
 */
export class SecureMqtt extends EventEmitter implements RealtimeTransport {
  readonly kind = "smqtt" as const;
  private client?: MqttClient;
  /**
   * The in-flight or established connect. A client ID is exclusive at the broker, so a second mqtt.js
   * client under the same ID evicts the first, which reconnects and evicts it back, forever; `connect()`
   * therefore hands a later caller this same attempt instead of opening a rival. Cleared when the
   * attempt fails and on `disconnect()`, so a caller can still retry or deliberately reconnect.
   */
  private connecting?: Promise<void>;
  private readonly o: SecureMqttOptions;
  private readonly logger: Logger;

  constructor(opts: SecureMqttOptions) {
    super();
    this.o = opts;
    this.logger = opts.logger ?? noopLogger;
  }

  get id(): string {
    return this.o.clientId ?? this.o.credentials.thing_name ?? "";
  }

  /** Connect, joining the attempt in `connecting` when one is already opening or open. */
  async connect(): Promise<void> {
    this.connecting ??= this.open().catch((error: unknown) => {
      this.connecting = undefined;
      throw error;
    });
    return await this.connecting;
  }

  /**
   * Open the broker connection, resolving once it is established. Pinned to a broker instance's IP, or
   * to the plain hostname; only the former needs its own TLS shape, see `./bare-ip-tls.ts`.
   */
  private async open(): Promise<void> {
    // The engine, not at import: see ./engine.ts. This method already returned a promise, so awaiting
    // a module load in front of a TLS connect changes nothing a caller can observe.
    const mqtt = await loadMqtt();
    const c = this.o.credentials;
    const port = c.endpoint_port ?? 8883;
    const pinned = this.o.instanceIp;
    const reconnectPeriod = this.o.reconnectPeriod ?? 5000;
    return await new Promise((resolve, reject) => {
      const client = pinned
        ? mqtt.connect({
            host: pinned,
            port,
            protocol: "mqtts",
            clientId: this.id,
            ...bareIpTlsOptions({
              hostname: c.endpoint_addr,
              cert: c.certificate_pem,
              key: c.private_key,
              ca: c.aws_root_ca1_pem,
            }),
            protocolVersion: 4,
            keepalive: 60,
            clean: true,
            reconnectPeriod,
          })
        : mqtt.connect(`mqtts://${c.endpoint_addr}:${port}`, {
            clientId: this.id,
            cert: c.certificate_pem,
            key: c.private_key,
            ca: c.aws_root_ca1_pem,
            protocolVersion: 4,
            keepalive: 60,
            clean: true,
            reconnectPeriod,
            rejectUnauthorized: true,
          });
      this.client = client;
      let settled = false;
      client.on("connect", () => {
        if (!settled) {
          settled = true;
          resolve();
        }
        this.emit("connect");
      });
      client.on("connect", () => this.logger.info(`[smqtt] connected (${c.app_name ?? "default"})`));
      client.on("reconnect", () => this.logger.warn("[smqtt] reconnecting"));
      client.on("close", () => this.emit("disconnect", "close"));
      client.on("error", (err) => {
        this.emit("error", err);
        if (!settled) {
          settled = true;
          // A connect that never established would otherwise leave this mqtt.js client alive,
          // retrying every `reconnectPeriod` forever with nothing left owning it (the caller only
          // has the rejected promise, no handle to end() with) — end it here so an errored connect
          // never orphans a background client.
          client.end(true);
          reject(err);
        }
      });
      client.on("message", (topic, payload) => {
        const sn = parseSecureTopic(topic)?.sn;
        let raw: unknown = payload;
        try {
          raw = JSON.parse(payload.toString("utf-8"));
        } catch {
          /* keep buffer */
        }
        const msg: RealtimeMessage = { deviceSn: sn, topic, raw };
        this.emit("message", msg);
      });
    });
  }

  /**
   * Subscribe every inbound leg this device's line uses (see `topics.ts` — one `/res` for most lines,
   * four topics for `eufy_life` and the clean line).
   *
   * The grants are INSPECTED, not assumed: AWS IoT refuses a policy-denied filter with a
   * {@link SUBACK_FAILURE} grant rather than failing the connection. A denied topic is reported via
   * `error` naming the credential scope; only an all-denied device throws, so a line that grants its
   * state channel but refuses (say) a business leg still works.
   */
  async subscribeDevice(device: EufyDevice): Promise<void> {
    const topics = [...subscribeTopics(device)];
    const { denied } = await this.subscribeEach(topics);
    const scope = this.o.credentials.app_name ?? "default";
    if (denied.length === topics.length) {
      throw new Error(
        `subscribe ${device.sn}: every topic denied on credential scope "${scope}" — ` +
          `this line's topics are granted to a different scope (${denied.join(", ")})`,
      );
    }
    for (const topic of denied) {
      this.emit("error", new Error(`subscribe ${device.sn}: "${topic}" denied on credential scope "${scope}"`));
    }
  }

  /**
   * Subscribe to explicit topic filters, returning the topics that were granted. A scope-denied filter
   * is dropped from the result instead of throwing — callers that need every leg check the returned
   * list. Used by lines whose topic vocabulary isn't the eufy `subscribeTopics` shape (e.g. Anker Solix
   * `dt/{app}/{pn}/{sn}`).
   */
  async subscribe(topics: string[]): Promise<string[]> {
    return (await this.subscribeEach(topics)).granted;
  }

  /**
   * Subscribe each filter in a SUBSCRIBE of its own and split the outcome into granted vs refused.
   *
   * One request per filter because the MQTT engine treats a SUBACK as all-or-nothing: one refused grant
   * rejects the whole request, and it forgets EVERY filter of that request for resubscription after a
   * reconnect — so a batch holding one denied leg would lose the granted legs on the next drop. Alone,
   * a refused filter costs only itself. A rejection that carries no SUBACK is a transport failure and
   * is thrown.
   *
   * The cost is one SUBSCRIBE and one SUBACK per filter instead of one per device — four for a
   * four-leg line. They are sent concurrently, so the wall-clock cost is one round trip. Folding them
   * back into one request brings back the lost resubscription.
   */
  private async subscribeEach(topics: readonly string[]): Promise<{ granted: string[]; denied: string[] }> {
    const client = this.client;
    if (!client) throw new Error("SecureMqtt not connected");
    const outcomes = await Promise.allSettled(topics.map((topic) => client.subscribeAsync(topic, { qos: 1 })));
    const granted: string[] = [];
    const denied: string[] = [];
    outcomes.forEach((outcome, i) => {
      const topic = topics[i]!;
      if (outcome.status === "fulfilled") {
        granted.push(topic);
        return;
      }
      if (!isRefusal(outcome.reason)) throw outcome.reason;
      denied.push(topic);
    });
    return { granted, denied };
  }

  /**
   * Publish a raw payload to an MQTT topic (the command leg — `cmd/{app}/{pn}/{sn}/req`). The `body`
   * is a pre-built envelope the caller supplies (the command router builds it). QoS 1 by default (the
   * broker acks). This is the outbound leg — commands, alongside the receive-only `/res` subscriptions.
   *
   * NOTE: which cert scope is used does NOT gate publishing to a security device's topic — confirmed
   * live, an `eufy_mega`-scoped cert and an `eufy_security`-scoped cert get the identical grant/deny
   * pattern. What actually matters is landing on the broker instance that currently holds the device's
   * session (`ensureSecurityMqttFor`/`broker-discovery.ts` — the NLB fronts several instances that
   * don't share subscribe/publish routing).
   */
  async publish(topic: string, body: string | Buffer, opts: { qos?: 0 | 1 | 2 } = {}): Promise<void> {
    if (!this.client) throw new Error("SecureMqtt not connected");
    await this.client.publishAsync(topic, body, { qos: opts.qos ?? 1 });
  }

  async disconnect(): Promise<void> {
    this.connecting = undefined;
    await this.client?.endAsync(true);
    this.client = undefined;
  }
}
