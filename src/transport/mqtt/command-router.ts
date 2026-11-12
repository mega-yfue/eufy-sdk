/**
 * MQTT command router — the transport-side owner of the secure-MQTT command path: maps a
 * transport-neutral {@link Command} to its MQTT wire + envelope over a one-shot connection per command.
 * The MQTT sibling of `transport/p2p/command-router.ts`'s `P2PCommandRouter`.
 *
 * The MQTT-bound kinds are `ff09-*` (`ff09-actuate` — a single fire-and-forget frame; `ff09-autolock`
 * — a GET-then-SET read-modify-write) and `mqtt-dp`/`mqtt-dp-color`/`mqtt-dp-preset` (the `eufy_life` DP TLV writes
 * behind the T8L0x smart lights), routed here when a device's stack is MQTT (see {@link claimsDevice}).
 * A future command family (another frame, another protocol) is one more {@link dispatchCommand} branch
 * — nothing here is ff09-only by design.
 *
 * Layering: this module knows MQTT bytes; it does NOT know capabilities. Capability modules emit a
 * transport-neutral {@link Command}; the facade fans it out by `kind` + topology to this router or the
 * P2P one. This keeps transport free of any `model/` import — the capability↔transport decorrelation
 * invariant.
 *
 * Two connection strategies live here, matched to what each wire was verified over:
 *  - **ff09** opens its OWN one-shot, explicitly non-reconnecting `SecureMqtt` pinned to a broker
 *    instance that grants the device's topic (see {@link ensureSecurityMqttFor}) and tears it down
 *    right after — the lock/garage path needs the SUBSCRIBE-and-wait ack machinery.
 *  - **eufy_life DP** (lights) publishes fire-and-forget over the facade's persistent account-wide
 *    `this.transport` via the injected {@link MqttRouterDeps.publishSecure} — that persistent connection
 *    is the CONFIRMED light-write path (`connectMQTT()` then publish to `.../req`), owned by the facade.
 */
import { randomBytes } from "node:crypto";
import type { EufyDevice } from "../../core/types.js";
import type { Command, AutoLockSnapshot } from "../../core/contracts.js";
import { noopLogger, type Logger } from "../../core/logger.js";
import type { MegaHttpClient } from "../http/mega-client.js";
import {
  buildFf09Frame,
  buildFf09QueryFrame,
  buildFf09AutolockSetFrame,
  decryptFf09Frame,
  parseFf09SettingsResponse,
  decodeFf09AutoLockSnapshot,
  ff09ReplyKeyTime,
  ff09TransferPayload,
  CMD_TRANSFER_PAYLOAD,
  type Ff09Frame,
  type Ff09FrameInput,
  type Ff09TransferPayload,
} from "../ff09.js";
import { SecureMqtt, isSubackFailure, type SecureMqttCredentials } from "./secure-mqtt.js";
import { secureTopic } from "./topics.js";
import { buildAppShapedClientId, mqttUuidFrom } from "./app-client-id.js";
import { discoverReachableInstance } from "./broker-discovery.js";
import { buildDpFrame, buildDpEnvelope } from "./dp-codec.js";
import { dpPresetFields, dpLevelFields, type DpPresetSpec } from "../dp-preset.js";
import { dpColorFields } from "./dp-color.js";
import { buildCleanDpEnvelope } from "./clean-codec.js";

/**
 * The ff09 command topic — always the `eufy_security` scope, regardless of the device's own category
 * (garage/standalone lock records aren't necessarily `eufy_security`-categorized, but this is the one
 * topic that's live-verified to accept `head.cmd:9` commands).
 */
export function ff09MqttTopic(pn: string, sn: string): string {
  return `cmd/eufy_security/${pn}/${sn}/req`;
}

/**
 * The MQTT `ff09-actuate` builder input — the same fields as {@link Ff09FrameInput} minus `omitUserFields`
 * (the actuate path always carries full user attribution), with `username`/`shortUserId` made **required**
 * (the frame builder allows omitting them only under `omitUserFields`, which this path never sets).
 * Derived from `Ff09FrameInput` so the shared fields (`engage`/`adminUserId`/`deviceSn`/`unixTime`/
 * `nonce`/`seqNum`) can't drift.
 */
export type Ff09TransInput = Omit<Ff09FrameInput, "omitUserFields" | "username" | "shortUserId"> & {
  username: string;
  shortUserId: string;
};

/** The inner `trans` object (before base64) — `{cmd:1940,…,payload:{apiCommand,lock_payload,…}}`. */
export interface Ff09Trans {
  cmd: number;
  mChannel: number;
  mValue3: number;
  payload: Ff09TransferPayload;
}

/** Wrap a built ff09 frame in the `{cmd:1940, mChannel:0, mValue3:0, payload}` MQTT `trans` envelope. */
function toFf09Trans(frame: Ff09Frame): Ff09Trans {
  return { cmd: CMD_TRANSFER_PAYLOAD, mChannel: 0, mValue3: 0, payload: ff09TransferPayload(frame) };
}

/**
 * Build the ff09 actuate command as the inner `trans` object. `engage` only flips the ff09 frame's
 * internal `A3` byte; the `apiCommand` comes from the frame builder (see `transport/ff09.ts`).
 */
export function buildFf09Trans(input: Ff09TransInput): Ff09Trans {
  return toFf09Trans(
    buildFf09Frame({
      engage: input.engage,
      adminUserId: input.adminUserId,
      deviceSn: input.deviceSn,
      username: input.username,
      shortUserId: input.shortUserId,
      unixTime: input.unixTime,
      nonce: input.nonce,
      seqNum: input.seqNum,
    }),
  );
}

/**
 * Build the settings **GET** command as the inner `trans` object. Same `{cmd:1940,…}` envelope shape as
 * {@link buildFf09Trans}, a narrower ff09 frame (no user-attribution fields — see `transport/ff09.ts`).
 */
function buildFf09QueryTrans(input: {
  adminUserId: string;
  deviceSn: string;
  unixTime?: number;
  nonce?: number;
  seqNum?: number;
}): Ff09Trans {
  return toFf09Trans(buildFf09QueryFrame(input));
}

/**
 * The shape of a GET-settings `/res` reply — NOT the normal command-ack envelope
 * ({@link buildFf09Trans}'s `{cmd,mChannel,mValue3,payload:{apiCommand,lock_payload,seq_num,time}}}`).
 * The device replies with just `{cmd:1940, payload:{dev_sn, lock_payload, time}}`, where `time` is a
 * **hex string** (not decimal) equal to the keyTime of the GET that triggered it — matched back to the
 * query's `time` to survive interleaved traffic. See `transport/ff09.ts`'s module doc. `time`'s
 * type is `string | number`: confirmed a hex string live, but a decimal is also accepted in case a
 * future firmware / a different lock family sends it that way (the P2P sibling `sendFf09Autolock` is
 * defensive the same way), rather than silently discarding a numeric reply as "not a match".
 */
interface Ff09SettingsResponseTrans {
  cmd: number;
  payload: { dev_sn: string; lock_payload: string; time: string | number };
}

/**
 * Parse a `SecureMqtt` `"message"` event's `raw` field as a {@link Ff09SettingsResponseTrans}, or
 * `undefined` if it doesn't match (e.g. some other message on the same subscription).
 *
 * `raw` is only ONE unwrap deep — `SecureMqtt` JSON-parses the outer MQTT payload bytes into
 * `{head, payload}`, where `payload` is itself a JSON **string** (`'{"trans":"<base64>"}'`, per a live
 * capture of a real GET-settings reply). Reaching the actual `{cmd, payload:{dev_sn,...}}` object needs
 * TWO more steps this function does internally: `JSON.parse(raw.payload)` to reach `{trans}`, then
 * base64-decode + `JSON.parse` that `trans` string. Deliberately defensive throughout — `raw` is
 * unstructured by construction, and a malformed/unrelated message must resolve to `undefined`, never
 * throw, so the caller's message-listener loop keeps waiting instead of crashing.
 */
function parseFf09SettingsResponseTrans(raw: unknown): Ff09SettingsResponseTrans | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const outerPayload = (raw as Record<string, unknown>).payload;
  if (typeof outerPayload !== "string") return undefined;

  let transB64: unknown;
  try {
    transB64 = (JSON.parse(outerPayload) as Record<string, unknown>).trans;
  } catch {
    return undefined;
  }
  if (typeof transB64 !== "string") return undefined;

  let inner: unknown;
  try {
    inner = JSON.parse(Buffer.from(transB64, "base64").toString("utf-8"));
  } catch {
    return undefined;
  }
  if (!inner || typeof inner !== "object") return undefined;
  const obj = inner as Record<string, unknown>;
  if (typeof obj.cmd !== "number") return undefined;
  const payload = obj.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.dev_sn !== "string" ||
    typeof p.lock_payload !== "string" ||
    (typeof p.time !== "string" && typeof p.time !== "number")
  )
    return undefined;
  return { cmd: obj.cmd, payload: { dev_sn: p.dev_sn, lock_payload: p.lock_payload, time: p.time } };
}

/**
 * Build the `{head, payload}` envelope a ff09 command publishes to {@link ff09MqttTopic} — `head.cmd:9`,
 * `payload` = `{account_id, device_sn, trans: base64(trans)}`. `timestamp`/`sessId`/`seed` are
 * injectable for deterministic tests; default to fresh/random.
 */
export function buildFf09MqttEnvelope(input: {
  trans: Ff09Trans;
  clientId: string;
  accountId: string;
  deviceSn: string;
  timestamp?: number;
  sessId?: string;
  seed?: string;
}): string {
  const transB64 = Buffer.from(JSON.stringify(input.trans), "utf-8").toString("base64");
  const payload = JSON.stringify({ account_id: input.accountId, device_sn: input.deviceSn, trans: transB64 });
  const head = {
    version: "1.0.0.1",
    client_id: input.clientId,
    sess_id: input.sessId ?? randomBytes(2).toString("hex"),
    msg_seq: 1,
    seed: input.seed ?? randomBytes(16).toString("hex"),
    timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
    cmd_status: 2,
    cmd: 9,
    sign_code: 0,
  };
  return JSON.stringify({ head, payload });
}

/**
 * The security broker cluster for the region an `aiot-mqtt-{region}.anker.com` endpoint names —
 * `security-mqtt-{region}.anker.com`, where `eufy_security` lock sessions live (see
 * `MqttCommandRouter.ensureSecurityMqttFor`). Throws on an endpoint of any other shape rather than
 * dialling a host derived from a guess.
 */
function securityBrokerHost(aiotEndpoint: string): string {
  const region = /^aiot-mqtt-([a-z]+)\.anker\.com$/.exec(aiotEndpoint)?.[1];
  if (!region) throw new Error(`no security broker known for MQTT endpoint "${aiotEndpoint}"`);
  return `security-mqtt-${region}.anker.com`;
}

/**
 * The facade-side dependencies the router needs. It owns the one-shot MQTT connection lifecycle + all
 * command wire logic, but defers device-list access + lifecycle event fan-out to the client (which owns
 * the typed EventEmitter).
 */
export interface MqttRouterDeps {
  mega: MegaHttpClient;
  /** Diagnostics sink. Omit for silence. */
  logger?: Logger;
  /** Current (already-loaded) device list. */
  listDevices: () => EufyDevice[];
  /** Load the device list if it isn't loaded yet (delegates to the client's getDevices). */
  ensureDevices: () => Promise<void>;
  /** A command delivery/actuation ack — the client re-emits it as the `commandAck` event. */
  onCommandAck: (info: Record<string, unknown>) => void;
  onError: (err: Error) => void;
  /**
   * The `a2` account id an `eufy_life` DP frame embeds for `dev` — the owning member's `admin_user_id`
   * (or the session user id). Injected because it needs session state the transport doesn't hold; the
   * router treats it opaquely. Required once any `mqtt-dp` command family can be routed.
   */
  resolveAccountId?: (dev: EufyDevice) => string;
  /**
   * Resolve a gallery `lightId` to its serializable effect definition — a thin wrapper over the HTTP
   * effect catalog the client owns (so the transport never imports HTTP). Injected; required to route
   * `mqtt-dp-preset`.
   */
  resolvePreset?: (lightId: number) => Promise<DpPresetSpec>;
  /**
   * Publish an already-built MQTT message `body` to `topic` over the facade's persistent account-wide
   * secure-MQTT transport — the CONFIRMED `eufy_life` light-write path (the facade's `connectMQTT()` +
   * `transport.publish`). Injected because that persistent connection is owned by the facade, not this
   * router (which otherwise opens per-command one-shot connections for ff09). Required to route
   * `mqtt-dp`/`mqtt-dp-color`/`mqtt-dp-preset`.
   */
  publishSecure?: (dev: EufyDevice, topic: string, body: string) => Promise<void>;
}

export class MqttCommandRouter {
  private readonly deps: MqttRouterDeps;
  private readonly logger: Logger;
  constructor(deps: MqttRouterDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }

  /**
   * Whether this transport stack drives `dev`'s `ff09-*` commands — a **eufy-cloud device**
   * (`api === "mega"`) with NO usable P2P endpoint (empty `p2p_did`): a standalone lock/garage (T85D0),
   * an appliance, and so on. Named positively by the plane it drives rather than "anything without a
   * P2P id", so a device on another cloud (a printer, `api === "ankermake"`) is claimed by NEITHER this
   * stack nor {@link P2PCommandRouter.claimsDevice} instead of falling onto the eufy MQTT plane. (See
   * P2P's `claimsDevice` for why the endpoint, not the `realtime` tag, is the routing fact.)
   */
  static claimsDevice(dev: EufyDevice): boolean {
    return dev.api === "mega" && !(typeof dev.p2pDid === "string" && dev.p2pDid.length > 0);
  }

  /**
   * Route a transport-neutral {@link Command} to the secure-MQTT wire — the MQTT half of the command
   * sink. The `ff09-actuate`/`ff09-autolock` (locks/garage) and `mqtt-dp`/`mqtt-dp-color`/`mqtt-dp-preset`
   * (`eufy_life` lights) kinds reach here (the facade fans everything else to the P2P router); any
   * other kind is a routing bug, so fail loud rather than resolve as a silent success.
   */
  async dispatchCommand(sn: string, cmd: Command): Promise<void> {
    switch (cmd.kind) {
      case "ff09-actuate":
        await this.dispatchFf09Actuate(sn, cmd);
        return;
      case "ff09-autolock":
        await this.dispatchFf09Autolock(sn, cmd);
        return;
      case "mqtt-dp":
        await this.dispatchMqttDp(sn, cmd);
        return;
      case "mqtt-dp-preset":
        await this.dispatchDpPreset(sn, cmd);
        return;
      case "mqtt-dp-color":
        await this.dispatchDpColor(sn, cmd);
        return;
      case "aiot-dp":
        await this.dispatchAiotDp(sn, cmd);
        return;
      default:
        // The facade sink routes an ff09-* command here only for an MQTT device (no P2P endpoint).
        // `ff09-setting-toggle` (Rain Mode) has no MQTT form, so one reaching here is a routing bug; fail
        // loud rather than guess a shape that is not known to exist. Same for any non-ff09 or non-aiot-dp
        // kind (the facade routes those to P2P).
        throw new Error(
          `MqttCommandRouter received an unroutable command (${cmd.kind}) for ${sn} — the facade sink should ` +
            `only route ff09-actuate/ff09-autolock/aiot-dp here`,
        );
    }
  }

  /** Resolve a serial to its loaded device record (loading the device list if needed). */
  private async deviceFor(sn: string): Promise<EufyDevice> {
    if (!this.deps.listDevices().length) await this.deps.ensureDevices();
    const dev = this.deps.listDevices().find((d) => d.sn === sn);
    if (!dev) throw new Error(`device ${sn} not found`);
    return dev;
  }

  /**
   * Fallback broker-instance IPs, tried alongside a fresh DNS resolution — the `aiot-mqtt-{region}
   * .anker.com` NLB has been observed (2026-07-16) to answer a single DNS query with only 2 of its
   * targets, and NOT necessarily including the one currently holding a given device's session (e.g.
   * `3.139.229.186` held a live T85D0 session all evening but never once appeared in `dig`/`resolve4`
   * output during that window). These are just previously-observed AWS infra IPs, not secrets — kept as
   * a small seed list so discovery doesn't depend on DNS happening to expose the right target.
   *
   * NOTE: this is a hardcoded FALLBACK, not a source of truth — a fresh `dig`/`resolve4` of
   * `aiot-mqtt-{region}.anker.com` runs alongside it every discovery, and AWS can rotate these NLB
   * targets at any time. If discovery starts failing, the seed list is the first thing to re-resolve
   * from DNS and refresh; it's not meant to be maintained by hand long-term.
   */
  private static readonly KNOWN_AIOT_BROKER_IPS = [
    "3.139.229.186",
    "18.224.90.2",
    "3.138.226.206",
    "3.138.64.16",
    "3.139.229.1",
    "3.147.137.189",
    "52.39.57.62",
    "52.42.98.25",
  ];

  /**
   * Connect a fresh **security-scoped** (`eufy_security`) MQTT client to the broker cluster `dev`'s
   * session lives on, pinned to one of its instances that grants the device's `/res` SUBSCRIBE (probed
   * SUBSCRIBE-only, never publishing — see `transport/mqtt/broker-discovery.ts`), for the caller to
   * publish on.
   *
   * That cluster is `security-mqtt-{region}.anker.com` ({@link securityBrokerHost}) for a lock whose
   * session lives there, not the `aiot-mqtt-{region}.anker.com` endpoint `get_user_mqtt_info` names: the
   * two are separate clusters that share no routing, and the `aiot` one grants such a lock's topics too.
   * Verified on US-region Smart Lock C33, C30 and FamiLock S3 units: the vendor app's commands and the
   * lock's replies cross the security cluster; a frame published on any of its instances is answered,
   * and the same frame published on any `aiot` instance is not. Both serve the same `*.anker.com`
   * certificate, so the account's credentials and TLS checks carry over unchanged.
   *
   * The security cluster refuses the topic of a device whose session is not there (every instance
   * answers a C220's with a SUBACK deny). Such a device is probed on the `aiot` endpoint instead, with
   * {@link KNOWN_AIOT_BROKER_IPS}, where an unlock of a T85D0 has been answered, as is any device when the
   * security host resolves to no instance.
   *
   * Which cert is used does NOT change the outcome — the account's own `get_user_mqtt_info` cert and a
   * cert extracted from a real phone's keystore produce the identical grant/deny pattern across every
   * candidate IP. One exception is known: a single garage unit whose own-cert SUBSCRIBE was denied on
   * every candidate while a phone-extracted cert granted on the same one, with a sibling of the same
   * model on the same account granting fine. That is a per-device authorization gap on the vendor's
   * backend, not something this SDK works around — the throw below names each candidate's outcome (its
   * SUBACK deny code, a timeout or a connection error).
   *
   * One fresh, explicitly non-reconnecting (`reconnectPeriod: 0`) connection per call — it repays the
   * full mTLS handshake every command and tears the socket down right after (see
   * {@link SecureMqttOptions.reconnectPeriod} for why a one-shot connection MUST disable reconnect).
   * That cost is accepted because garage/lock commands are rare. ⚠️ A reused connection off a persistent
   * security-MQTT transport would amortize the handshake and stay mounted long enough for a slow actuator
   * (a garage door travels ~20-30s) to push an async state update on the same socket, subscribing once
   * with a scope-bounded wildcard (`cmd/{app}/+/+/res`) instead of per-call subscribe/unsubscribe.
   */
  private async ensureSecurityMqttFor(dev: EufyDevice): Promise<{ mqtt: SecureMqtt; instanceIp: string }> {
    const account: SecureMqttCredentials = await this.deps.mega.getUserMqttInfo("eufy_security");
    let creds: SecureMqttCredentials = { ...account, endpoint_addr: securityBrokerHost(account.endpoint_addr) };
    const mqttUuid = mqttUuidFrom(this.deps.mega.openudid);
    const clientIdFor = () => buildAppShapedClientId({ appName: "eufy_security", uid: creds.user_id ?? "", mqttUuid });
    const probe = (on: SecureMqttCredentials, candidateIps?: string[]) =>
      discoverReachableInstance(
        {
          hostname: on.endpoint_addr,
          port: on.endpoint_port,
          certificate_pem: on.certificate_pem,
          private_key: on.private_key,
          aws_root_ca1_pem: on.aws_root_ca1_pem,
        },
        {
          clientIdFor,
          topic: secureTopic(dev, "res"),
          candidateIps,
          stopOnFirstGrant: true,
          perAttemptTimeoutMs: 8000,
        },
      );
    let results = await probe(creds);
    const refused = results.length > 0 && results.every((r) => isSubackFailure(r.grantedQos));
    if (refused || results.length === 0) {
      creds = account;
      results = await probe(account, MqttCommandRouter.KNOWN_AIOT_BROKER_IPS);
    }
    const winner = results.find((res) => res.granted);
    if (!winner) {
      throw new Error(
        `ensureSecurityMqttFor(${dev.sn}): no broker instance grants this device's topic ` +
          `(probed ${results.length} candidate IPs: ` +
          results
            .map(
              (r) =>
                `${r.ip} ${r.grantedQos === undefined ? "" : `SUBACK 0x${r.grantedQos.toString(16)} `}${r.error ?? "denied"}`,
            )
            .join("; ") +
          `).`,
      );
    }
    const m = new SecureMqtt({
      credentials: creds,
      clientId: clientIdFor(),
      instanceIp: winner.ip,
      reconnectPeriod: 0, // one-shot: never leave an orphaned client retrying in the background
      logger: this.deps.logger,
    });
    m.on("error", (e) => this.deps.onError(e));
    await m.connect();
    return { mqtt: m, instanceIp: winner.ip };
  }

  /**
   * How long {@link dispatchFf09Actuate} waits for the device's `/res` **delivery ack** before giving up.
   * This is NOT a physical-actuation budget, so the SAME number covers a deadbolt and a garage door
   * despite their very different travel times — see that method's doc for why.
   */
  private static readonly FF09_ACK_TIMEOUT_MS = 5000;

  /**
   * Shared "arm a listener, resolve on the first matching message, else time out" scaffold —
   * {@link dispatchFf09Actuate}'s ack wait and {@link dispatchFf09Autolock}'s GET-reply/SET-ack waits
   * are all one instance of this pattern (differing only in `match`), so it's factored here instead of
   * three near-identical inline `new Promise(...)` blocks. `match` returns the extracted value once a
   * message satisfies it, or `undefined` to keep waiting; the returned promise resolves `undefined` on
   * timeout with no unhandled listener left behind either way.
   */
  private waitForMqttMessage<T>(
    mqtt: SecureMqtt,
    match: (m: { topic?: string; raw?: unknown }) => T | undefined,
    timeoutMs: number,
  ): Promise<T | undefined> {
    return new Promise<T | undefined>((resolve) => {
      const onMessage = (m: { topic?: string; raw?: unknown }): void => {
        const result = match(m);
        if (result === undefined) return;
        cleanup();
        resolve(result);
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        mqtt.off("message", onMessage);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      mqtt.on("message", onMessage);
    });
  }

  /**
   * The `ff09-actuate` intent handler over MQTT — a standalone lock/garage door (T85D0) with no P2P endpoint.
   * Builds the same `ff09` frame the P2P lock uses (`transport/ff09.ts`), wraps it in the MQTT `trans`
   * envelope (`buildFf09Trans`/`buildFf09MqttEnvelope`, this module), discovers which broker instance holds the device's
   * live session (see {@link ensureSecurityMqttFor}), and publishes to `cmd/eufy_security/{pn}/{sn}/req`.
   * `cmd.engage` maps straight to the frame's direction byte (`true`=lock/close, `false`=unlock/open) — no inversion.
   *
   * **Verification status differs by direction — don't conflate them.** ✅ Unlock is LIVE-VERIFIED on a
   * T85D0 (2026-07-16): 3/3 closed→open transitions, direct cause→observed-effect, driven fully
   * end-to-end through this exact codepath. Lock is byte-exact against two independently-captured
   * real-app close frames — the same evidentiary bar the P2P video lock's wire ships under — but has
   * NOT itself been driven through this codepath and physically observed closing the real door; that's
   * still open.
   *
   * **What the `/res` reply actually means — a delivery ack, NOT "motion complete".** A live garage-open
   * test (2026-07-15) got its `/res` in ~2.5s, far faster than the ~20-30s a garage door physically takes
   * to travel — so this is the device saying "I received the command", not "I finished moving". That's
   * why {@link FF09_ACK_TIMEOUT_MS} is one fixed, short window shared by every ff09 device regardless of
   * its actuator's physical speed: it's timing a network round-trip, not a door. (There is currently no
   * signal at all for actuation completion — that would need a different source, e.g. the device's own
   * state push — so this method stays fire-and-forget: it resolves either way, never throws on a missing
   * ack, and reports what it knows via the `commandAck` event rather than the return value, so a future
   * richer per-device state model doesn't have to fight this method's `Promise<void>` contract.)
   *
   * Subscribes to the reply topic BEFORE publishing and waits for the actual message event (or the
   * timeout) rather than a blind sleep, so a reply arriving anywhere in that window is never missed —
   * unlike a fixed-sleep-then-teardown, where a late reply arrives after the subscription is already gone.
   */
  private async dispatchFf09Actuate(sn: string, cmd: Extract<Command, { kind: "ff09-actuate" }>): Promise<void> {
    const dev = await this.deviceFor(sn);
    if (!dev.model) throw new Error(`dispatchFf09Actuate(${sn}): no product model (pn) — required for the topic`);
    const trans = buildFf09Trans({
      engage: cmd.engage,
      adminUserId: cmd.adminUserId,
      deviceSn: cmd.deviceSn,
      username: cmd.username,
      shortUserId: cmd.shortUserId,
    });

    const { mqtt, instanceIp } = await this.ensureSecurityMqttFor(dev);
    try {
      await mqtt.subscribeDevice(dev);
      // Arm the ack wait BEFORE publishing (no race between "publish already answered" and
      // "listener not attached yet"), but don't AWAIT it until after the publish call below.
      const ackPromise = this.waitForMqttMessage(
        mqtt,
        // Scope to THIS device's own reply topic (`.../{sn}/res`), not any `/res`, so another device's
        // reply on the connection can't be mistaken for this actuate's ack. It still can't pin the ack to
        // this specific publish (the actuate `/res` shape isn't captured, so there's no keyTime to
        // correlate) — telemetry-only, so a same-device redelivery latching early is acceptable.
        (m) => (m.topic?.endsWith(`/${sn}/res`) ? true : undefined),
        MqttCommandRouter.FF09_ACK_TIMEOUT_MS,
      );
      const envelope = buildFf09MqttEnvelope({
        trans,
        clientId: mqtt.id,
        accountId: cmd.adminUserId,
        deviceSn: sn,
      });
      const topic = ff09MqttTopic(dev.model, sn);
      await mqtt.publish(topic, envelope, { qos: 1 });
      // Event-driven, not a blind sleep: resolves the instant the device's own `/res` arrives (a live
      // T85D0 garage-open answered in ~2.5s), or after FF09_ACK_TIMEOUT_MS with no reply. The
      // subscription stays open for the whole wait, so a reply
      // that lands right at the edge of the window is never missed the way a fixed-sleep-then-teardown
      // would miss it.
      const acked = (await ackPromise) ?? false;
      this.deps.onCommandAck({ sn, kind: "ff09-actuate", acked, instanceIp });
      if (!acked) {
        this.logger.debug(
          `dispatchFf09Actuate(${sn}): no /res within ${MqttCommandRouter.FF09_ACK_TIMEOUT_MS}ms on ${instanceIp} — ` +
            `the broker accepted the publish (QoS 1 PUBACK), but that's delivery-to-broker, not ` +
            `delivery-to-device; unclear whether the device ever saw it`,
        );
      }
    } finally {
      await mqtt.disconnect();
    }
  }

  /**
   * The `ff09-autolock` intent handler over MQTT — read-modify-write the T85D0's auto-lock setting.
   * ✅ LIVE-VERIFIED end-to-end (2026-07-17): both enable and disable
   * driven through this exact codepath against a real T85D0, confirmed via the app UI showing the new
   * state afterward, not just byte-exact against a capture. Unlike {@link dispatchFf09Actuate} (one
   * fire-and-forget frame), this is a GET then a SET over the SAME one-shot MQTT connection:
   *
   *  1. Publish a settings GET query ({@link buildFf09QueryTrans}), then wait for the device's `/res`
   *     reply — NOT the generic "any /res" ack {@link dispatchFf09Actuate} accepts, but specifically a
   *     message matching {@link parseFf09SettingsResponseTrans}'s shape whose `time` (hex string,
   *     parsed as the keyTime) equals the GET's own `time`, so unrelated traffic on the same
   *     subscription can't be mistaken for the reply. **No reply within the timeout throws** — unlike
   *     lock/unlock, this is a genuine precondition (we need the device's live `A7`/`A8`/delay values
   *     to preserve them), not a fire-and-forget actuation, so silently guess-writing would be worse
   *     than failing loud.
   *  2+3. Decrypt the reply, preserve the current delay (`a2`) + `A7`/`A8` passthrough values (`a4`/
   *     `a5`), and build the SET frame that changes only `A4`=`cmd.enabled` / `A5`=`cmd.delaySeconds`
   *     (or the just-read delay if omitted) — the decrypt→read→rebuild is shared with the P2P sibling in
   *     `transport/ff09.ts`'s {@link buildFf09AutolockSetFrame}; here it's wrapped in the MQTT `trans`
   *     envelope and published. Its ack follows the same fire-and-forget device-scoped `/res` convention
   *     as {@link dispatchFf09Actuate} —
   *     there's no captured evidence of a distinct SET-ack shape to match more strictly against. This
   *     listener is armed fresh (topic-only match, no keyTime correlation like step 1's), so in theory a
   *     REDELIVERED copy of the already-consumed GET reply (QoS-1 retransmit) could latch it early —
   *     telemetry-only (the call resolves either way; `setAcked` only affects a debug log line), so left
   *     as-is rather than adding keyTime correlation this ack doesn't otherwise need.
   */
  private async dispatchFf09Autolock(sn: string, cmd: Extract<Command, { kind: "ff09-autolock" }>): Promise<void> {
    const dev = await this.deviceFor(sn);
    if (!dev.model) throw new Error(`dispatchFf09Autolock(${sn}): no product model (pn) — required for the topic`);

    const { mqtt, instanceIp } = await this.ensureSecurityMqttFor(dev);
    try {
      await mqtt.subscribeDevice(dev);
      const topic = ff09MqttTopic(dev.model, sn);

      // ── 1. GET current settings, matched back by keyTime (shared with getAutoLockState — see helper). ──
      const getReply = await this.fetchFf09SettingsGetReply(mqtt, topic, sn, cmd, instanceIp);

      // ── 2+3. Decrypt the reply, preserve A7/A8 + delay, build the SET frame (shared with the P2P
      //         sibling — see buildFf09AutolockSetFrame), then wrap it in the MQTT trans envelope. ──
      const setTrans = toFf09Trans(
        buildFf09AutolockSetFrame({
          lockPayload: getReply.lockPayload,
          keyTime: getReply.keyTime,
          adminUserId: cmd.adminUserId,
          deviceSn: cmd.deviceSn,
          enabled: cmd.enabled,
          delaySeconds: cmd.delaySeconds,
        }),
      );
      const setAckPromise = this.waitForMqttMessage(
        mqtt,
        // Same device-scoped `/res` match as the actuate ack above (topic-only, no keyTime — telemetry).
        (m) => (m.topic?.endsWith(`/${sn}/res`) ? true : undefined),
        MqttCommandRouter.FF09_ACK_TIMEOUT_MS,
      );
      await mqtt.publish(
        topic,
        buildFf09MqttEnvelope({ trans: setTrans, clientId: mqtt.id, accountId: cmd.adminUserId, deviceSn: sn }),
        { qos: 1 },
      );
      const setAcked = (await setAckPromise) ?? false;
      this.deps.onCommandAck({ sn, kind: "ff09-autolock", getAcked: true, acked: setAcked, instanceIp });
      if (!setAcked) {
        this.logger.debug(
          `dispatchFf09Autolock(${sn}): settings GET succeeded but no SET /res within ` +
            `${MqttCommandRouter.FF09_ACK_TIMEOUT_MS}ms on ${instanceIp} — broker accepted the publish, device receipt unclear`,
        );
      }
    } finally {
      await mqtt.disconnect();
    }
  }

  /**
   * Shared GET-and-wait step behind both {@link dispatchFf09Autolock} (which reads to preserve A7/A8
   * across a write) and {@link getAutoLockState} (which reads for its own sake) — extracted so the two
   * don't drift on the query/keyTime-matching machinery. Takes an already-connected+subscribed
   * `mqtt`/`topic`; connection lifecycle stays the caller's concern (the write path keeps the
   * connection open for a following SET, the read path closes right after). Throws if no matching
   * reply arrives within {@link FF09_ACK_TIMEOUT_MS}.
   */
  private async fetchFf09SettingsGetReply(
    mqtt: SecureMqtt,
    topic: string,
    sn: string,
    cmd: { adminUserId: string; deviceSn: string },
    instanceIp: string,
  ): Promise<{ lockPayload: string; keyTime: number }> {
    const queryTrans = buildFf09QueryTrans({ adminUserId: cmd.adminUserId, deviceSn: cmd.deviceSn });
    const getReplyPromise = this.waitForMqttMessage(
      mqtt,
      (m) => {
        const reply = parseFf09SettingsResponseTrans(m.raw);
        if (!reply || reply.cmd !== CMD_TRANSFER_PAYLOAD) return undefined;
        const keyTime = ff09ReplyKeyTime(reply.payload.time);
        if (keyTime === undefined || keyTime !== queryTrans.payload.time) return undefined; // other traffic — keep waiting
        return { lockPayload: reply.payload.lock_payload, keyTime };
      },
      MqttCommandRouter.FF09_ACK_TIMEOUT_MS,
    );
    await mqtt.publish(
      topic,
      buildFf09MqttEnvelope({ trans: queryTrans, clientId: mqtt.id, accountId: cmd.adminUserId, deviceSn: sn }),
      { qos: 1 },
    );
    const getReply = await getReplyPromise;
    if (!getReply) {
      throw new Error(
        `fetchFf09SettingsGetReply(${sn}): no settings GET reply within ${MqttCommandRouter.FF09_ACK_TIMEOUT_MS}ms on ` +
          `${instanceIp}.`,
      );
    }
    return getReply;
  }

  /**
   * **Read the T85D0's current auto-lock settings over MQTT** — the `Ff09SettingsReader` implementation.
   * A pure GET, no SET: opens its own one-shot MQTT connection (same
   * lifecycle as {@link dispatchFf09Autolock}), reuses {@link fetchFf09SettingsGetReply}, then decrypts
   * + decodes fields `a1`-`a5` per `transport/ff09.ts`'s response tag map. Live-verified only insofar
   * as the underlying GET step already is (`setAutoLock`'s own read) — the standalone read path itself
   * has not been independently exercised against a real device yet.
   */
  async getAutoLockState(sn: string, cmd: { adminUserId: string; deviceSn: string }): Promise<AutoLockSnapshot> {
    const dev = await this.deviceFor(sn);
    if (!dev.model) throw new Error(`getAutoLockState(${sn}): no product model (pn) — required for the topic`);
    const { mqtt, instanceIp } = await this.ensureSecurityMqttFor(dev);
    try {
      await mqtt.subscribeDevice(dev);
      const topic = ff09MqttTopic(dev.model, sn);
      const getReply = await this.fetchFf09SettingsGetReply(mqtt, topic, sn, cmd, instanceIp);
      return decodeFf09AutoLockSnapshot(
        parseFf09SettingsResponse(
          decryptFf09Frame({
            lockPayload: getReply.lockPayload,
            keyTime: getReply.keyTime,
            adminUserId: cmd.adminUserId,
            deviceSn: cmd.deviceSn,
          }),
        ),
      );
    } finally {
      await mqtt.disconnect();
    }
  }

  /**
   * The `a2` account id an `eufy_life` DP frame embeds — the owning member's `admin_user_id` (or the
   * session user id), resolved by the injected {@link MqttRouterDeps.resolveAccountId}. Throws if the
   * resolver isn't wired or yields an empty id: the frame's `a2` opener is a required field, and a
   * fire-and-forget write with an empty account id would look like success while doing nothing.
   */
  private requireAccountId(dev: EufyDevice): string {
    if (!this.deps.resolveAccountId) {
      throw new Error(`eufy_life DP for ${dev.sn}: resolveAccountId dependency not wired`);
    }
    const id = this.deps.resolveAccountId(dev);
    if (!id) throw new Error(`eufy_life DP for ${dev.sn}: no account id resolved (the frame's a2 field is required)`);
    return id;
  }

  /**
   * Wrap a built DP frame in its `eufy_life` MQTT envelope and publish it to the device's `.../req`
   * topic over the facade's persistent account-wide transport ({@link MqttRouterDeps.publishSecure}) —
   * the CONFIRMED light-write path. Fire-and-forget: the DP wire carries no delivery ack the SDK
   * has captured, so there's nothing to wait on here (unlike the ff09 paths above).
   */
  private async publishDpFrame(
    dev: EufyDevice,
    sn: string,
    accountId: string,
    mqttCmdCode: number,
    frame: Buffer,
  ): Promise<void> {
    if (!this.deps.publishSecure) {
      throw new Error(`eufy_life DP for ${sn}: publishSecure dependency not wired`);
    }
    const envelope = buildDpEnvelope({ accountId, deviceSn: sn, mqttCmdCode, frame });
    await this.deps.publishSecure(dev, secureTopic(dev, "req"), envelope);
  }

  /**
   * The `mqtt-dp` handler — a single `eufy_life` DP TLV write (on/off, brightness). The capability
   * supplies the opaque `mqttCmdCode`/`cmdCode` + already-tagged scalar `fields`; this builds the frame
   * ({@link buildDpFrame} prepends the `a1` timestamp + `a2` account id) and publishes it.
   */
  private async dispatchMqttDp(sn: string, cmd: Extract<Command, { kind: "mqtt-dp" }>): Promise<void> {
    const dev = await this.deviceFor(sn);
    const accountId = this.requireAccountId(dev);
    const frame = buildDpFrame(cmd.cmdCode, accountId, cmd.fields);
    await this.publishDpFrame(dev, sn, accountId, cmd.mqttCmdCode, frame);
    this.deps.onCommandAck({ sn, kind: "mqtt-dp", cmdCode: cmd.cmdCode, acked: true });
  }

  /** Serialize and publish one semantic RGB DP action without changing configured brightness. */
  private async dispatchDpColor(sn: string, cmd: Extract<Command, { kind: "mqtt-dp-color" }>): Promise<void> {
    const dev = await this.deviceFor(sn);
    const accountId = this.requireAccountId(dev);
    const fields = dpColorFields(cmd);
    const frame = buildDpFrame(cmd.cmdCode, accountId, fields);
    await this.publishDpFrame(dev, sn, accountId, cmd.mqttCmdCode, frame);
    this.deps.onCommandAck({ sn, kind: "mqtt-dp-color", cmdCode: cmd.cmdCode, acked: true });
  }

  /**
   * The `aiot-dp` handler — a single DP write to a clean-line device (vacuum/mower). Builds the
   * AIoT MQTT envelope ({@link buildCleanDpEnvelope}) and publishes fire-and-forget to the device's
   * `cmd/eufy_home/{pn}/{sn}/req` topic over the facade's persistent transport. The clean line uses
   * the DEFAULT credential (same as `eufy_mega` devices) — no separate MQTT connection needed; only
   * `eufy_life` (smart lights) gets its own certificate. Confirmed live on T2351 (2026-07-30).
   */
  private async dispatchAiotDp(sn: string, cmd: Extract<Command, { kind: "aiot-dp" }>): Promise<void> {
    const dev = await this.deviceFor(sn);
    if (!this.deps.resolveAccountId) {
      throw new Error(`aiot-dp for ${sn}: resolveAccountId dependency not wired`);
    }
    const accountId = this.deps.resolveAccountId(dev);
    if (!accountId) throw new Error(`aiot-dp for ${sn}: no account id resolved`);
    if (!this.deps.publishSecure) {
      throw new Error(`aiot-dp for ${sn}: publishSecure dependency not wired`);
    }
    const envelope = buildCleanDpEnvelope(accountId, sn, cmd.dp, cmd.value);
    await this.deps.publishSecure(dev, secureTopic(dev, "req"), envelope);
    this.deps.onCommandAck({ sn, kind: "aiot-dp", dp: cmd.dp, acked: true });
  }

  /**
   * The `mqtt-dp-preset` handler — select a gallery effect by catalog id. Resolves the effect's
   * layer definition via the injected {@link MqttRouterDeps.resolvePreset} (HTTP catalog, client-
   * owned), serializes it to the `0x020D` effect frame ({@link dpPresetFields}), and publishes it;
   * if the catalog entry carries an overall brightness, sends the companion `0x0201` brightness frame
   * ({@link dpLevelFields}) right after, matching the app's two-frame effect apply.
   */
  private async dispatchDpPreset(sn: string, cmd: Extract<Command, { kind: "mqtt-dp-preset" }>): Promise<void> {
    if (!this.deps.resolvePreset) {
      throw new Error(`mqtt-dp-preset for ${sn}: resolvePreset dependency not wired`);
    }
    const dev = await this.deviceFor(sn);
    const accountId = this.requireAccountId(dev);
    const spec = await this.deps.resolvePreset(cmd.presetId);
    const effectFrame = buildDpFrame(cmd.cmdCode, accountId, dpPresetFields(spec));
    await this.publishDpFrame(dev, sn, accountId, cmd.mqttCmdCode, effectFrame);
    if (typeof spec.brightness === "number") {
      const brightFrame = buildDpFrame(cmd.companionCmdCode, accountId, dpLevelFields(spec.brightness));
      await this.publishDpFrame(dev, sn, accountId, cmd.mqttCmdCode, brightFrame);
    }
    this.deps.onCommandAck({ sn, kind: "mqtt-dp-preset", presetId: cmd.presetId, acked: true });
  }
}
