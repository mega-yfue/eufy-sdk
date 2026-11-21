/**
 * MQTT command router — the transport-side owner of the secure-MQTT command path: maps a
 * transport-neutral {@link Command} to its MQTT wire + envelope.
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
 * Every security-device command (ff09) rides the facade's long-lived `eufy_security` stack
 * ({@link MqttRouterDeps.securityTransport}), as the app's one session; `eufy_life` DP writes publish over the
 * light stack via {@link MqttRouterDeps.publishSecure}.
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
  buildFf09TlvFrame,
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
import type { SecureMqtt } from "./secure-mqtt.js";
import { secureTopic } from "./topics.js";
import { buildDpFrame, buildDpEnvelope, nextMsgSeq } from "./dp-codec.js";
import { dpPresetFields, dpLevelFields, type DpPresetSpec } from "../dp-preset.js";
import { dpColorFields } from "./dp-color.js";
import { buildCleanDpEnvelope } from "./clean-codec.js";

/**
 * The ff09 command topic — always the `eufy_security` scope, regardless of the device's own category
 * (garage/standalone lock records aren't necessarily `eufy_security`-categorized, but this is the one
 * topic that accepts `head.cmd:9` commands).
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

/** The inner `trans` object (before base64) — `{cmd:1940, account_id:"", payload:{apiCommand:1940,…}, …}`. */
export interface Ff09Trans {
  cmd: number;
  account_id: string;
  mChannel: number;
  mValue3: number;
  payload: Ff09TransferPayload;
}

/**
 * Wrap a built ff09 frame in the MQTT `trans` envelope as the app's MQTT channel builds it: `cmd` and the
 * payload's `apiCommand` both `TRANSFER_PAYLOAD` (1940), `account_id` empty, `mValue3`/`mChannel` 0.
 */
function toFf09Trans(frame: Ff09Frame): Ff09Trans {
  const payload = { ...ff09TransferPayload(frame), apiCommand: CMD_TRANSFER_PAYLOAD };
  return { cmd: CMD_TRANSFER_PAYLOAD, account_id: "", payload, mValue3: 0, mChannel: 0 };
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
 * type is `string | number`: a hex string on the wire, but a decimal is also accepted in case a
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
 * `payload` = `{account_id, device_sn, trans: base64(trans), data:"", update_data:"", method:""}`. `timestamp`/`sessId`/`seed` are
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
  /** `head.cmd`, the descriptor's `mqttCmdCode`; 9 by default. */
  cmd?: number;
}): string {
  const transB64 = Buffer.from(JSON.stringify(input.trans), "utf-8").toString("base64");
  const payload = JSON.stringify({
    account_id: input.accountId,
    device_sn: input.deviceSn,
    trans: transB64,
    data: "",
    update_data: "",
    method: "",
  });
  const head = {
    version: "1.0.0.1",
    client_id: input.clientId,
    sess_id: input.sessId ?? randomBytes(2).toString("hex"),
    msg_seq: nextMsgSeq(),
    seed: input.seed ?? randomBytes(16).toString("hex"),
    timestamp: input.timestamp ?? Math.floor(Date.now() / 1000),
    // `needAck ? 1 : 2`, and a lock descriptor states no `needAck`: the app's default, 1 (`MqttRequest`).
    cmd_status: 1,
    cmd: input.cmd ?? 9,
    sign_code: 0,
  };
  return JSON.stringify({ head, payload });
}

/**
 * The facade-side dependencies the router needs. It owns the command wire logic, but defers device-list access + lifecycle event fan-out to the client (which owns
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
   * router. Required to route
   * `mqtt-dp`/`mqtt-dp-color`/`mqtt-dp-preset`.
   */
  publishSecure?: (dev: EufyDevice, topic: string, body: string | ((clientId: string) => string)) => Promise<void>;
  /** The facade's long-lived `eufy_security` stack, which every ff09 command rides, as the app's one session. */
  securityTransport?: () => Promise<SecureMqtt>;
}

export class MqttCommandRouter {
  private readonly deps: MqttRouterDeps;
  private readonly logger: Logger;
  /** The last `seq_num` sent per serial, counted per device as the app's `SecuritySeqNumManager` does. */
  private readonly seqNums = new Map<string, number>();
  constructor(deps: MqttRouterDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? noopLogger;
  }

  /** `trans` carrying this device's next `seq_num`. */
  private sequenced(sn: string, trans: Ff09Trans): Ff09Trans {
    const seq = (this.seqNums.get(sn) ?? 0) + 1;
    this.seqNums.set(sn, seq);
    return { ...trans, payload: { ...trans.payload, seq_num: seq } };
  }

  /**
   * Whether this transport stack drives `dev`'s `ff09-*` commands — a **eufy-cloud device**
   * (`api === "mega"`) with NO usable P2P endpoint (empty `p2p_did`): a standalone lock/garage (T85D0),
   * an appliance, and so on. A standalone video lock also takes its `ff09` frames on this stack, although its
   * P2P endpoint keeps it unclaimed here. Named positively by the plane it drives rather than "anything without a
   * P2P id", so a device on another cloud (a printer, `api === "ankermake"`) is claimed by NEITHER this
   * stack nor {@link P2PCommandRouter.claimsDevice} instead of falling onto the eufy MQTT plane. (See
   * P2P's `claimsDevice` for why the endpoint, not the `realtime` tag, is the routing fact.)
   */
  static claimsDevice(dev: EufyDevice): boolean {
    return dev.api === "mega" && !(typeof dev.p2pDid === "string" && dev.p2pDid.length > 0);
  }

  /**
   * Route a transport-neutral {@link Command} to the secure-MQTT wire — the MQTT half of the command
   * sink. The `ff09-actuate`/`ff09-autolock` (a lock/garage without a P2P endpoint, or a standalone video lock)
   * and `mqtt-dp`/`mqtt-dp-color`/`mqtt-dp-preset` (`eufy_life` lights) kinds reach here (the facade fans everything else to the P2P router); any
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
        // An ff09-* command reaches here for a device with no P2P endpoint or a standalone video lock.
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
   * The record with `model` set to the product number its topics name, as the app's `snToPn`: `device_new_pn`,
   * else the serial ({@link pnFromSerial}), never `device_model` (a C30 reports `T85D0C` and answers only on `T85D0`).
   */
  private async pnDeviceFor(sn: string): Promise<EufyDevice> {
    return await this.withPn(await this.deviceFor(sn));
  }

  /** `dev` with `model` set to the product number its topics name ({@link pnDeviceFor}). */
  async withPn(dev: EufyDevice): Promise<EufyDevice> {
    const sn = dev.sn;
    const pn = (dev.raw as { device_new_pn?: unknown } | undefined)?.device_new_pn;
    return { ...dev, model: typeof pn === "string" && pn ? pn : await this.pnFromSerial(sn) };
  }

  /**
   * `get_pn_by_sn` answers per serial, kept like the app's `DevicePnCache`: a failed call keeps `""`. The
   * promise is kept, so commands racing on a serial share one call.
   */
  private readonly cloudPn = new Map<string, Promise<string>>();

  /**
   * The app's `snToPn` past `device_new_pn` (`CoreSnKtxKt.snToPn`): a serial of 6 characters or fewer is its own
   * product number; else the app's prefix rules, a product number already given as is, then the cloud's
   * `get_pn_by_sn`, and an empty answer takes the serial's first five characters.
   */
  private async pnFromSerial(sn: string): Promise<string> {
    if (sn.length <= 6) return sn;
    const ruled = serialPn(sn);
    if (ruled !== undefined) return ruled;
    let pn = this.cloudPn.get(sn);
    if (!pn) {
      pn = this.deps.mega.getPnBySn(sn).catch(() => "");
      this.cloudPn.set(sn, pn);
    }
    return (await pn) || sn.slice(0, 5);
  }

  /** The `eufy_security` stack every ff09 command rides. */
  private async securityMqtt(): Promise<SecureMqtt> {
    if (!this.deps.securityTransport) throw new Error("ff09 over MQTT: securityTransport dependency not wired");
    return await this.deps.securityTransport();
  }

  /**
   * How long {@link dispatchFf09Actuate} waits for the device's `/res` **delivery ack** before giving up.
   * This is NOT a physical-actuation budget, so the SAME number covers a deadbolt and a garage door
   * despite their very different travel times — see that method's doc for why.
   */
  private static readonly FF09_ACK_TIMEOUT_MS = 5000;

  /**
   * Publish `envelope()` to `topic` and wait `timeoutMs` for the answer `match` picks, sending again up to `retries`
   * times while none comes, as the app's `MqttDelegate.sendForRawResponse` does (`MqttConfig.maxRetryCount` 1 unless
   * the descriptor states `retryCount`). The wait is armed before each publish.
   */
  private async request<T>(
    mqtt: SecureMqtt,
    topic: string,
    envelope: () => string,
    match: (m: { topic?: string; raw?: unknown }) => T | undefined,
    timeoutMs: number,
    retries = 1,
  ): Promise<T | undefined> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const answer = this.waitForMqttMessage(mqtt, match, timeoutMs);
      await mqtt.publish(topic, envelope(), { qos: 1 });
      const got = await answer;
      if (got !== undefined) return got;
    }
    return undefined;
  }

  /** Whether `m` is `sn`'s answer to a `head.cmd` of `mqttCmdCode`: on its `/res`, `head.cmd` one below, as the app matches. */
  private static isReply(m: { topic?: string; raw?: unknown }, sn: string, mqttCmdCode: number): boolean {
    return !!m.topic?.endsWith(`/${sn}/res`) && (m.raw as { head?: { cmd?: unknown } })?.head?.cmd === mqttCmdCode - 1;
  }

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
   * The `ff09-actuate` intent handler over MQTT: sends one lock or unlock frame to the device.
   * Builds the same `ff09` frame the P2P lock uses (`transport/ff09.ts`), wraps it in the MQTT `trans`
   * envelope (`buildFf09Trans`/`buildFf09MqttEnvelope`, this module), and publishes to `cmd/eufy_security/{pn}/{sn}/req`
   * on the security stack.
   * `cmd.engage` maps straight to the frame's direction byte (`true`=lock/close, `false`=unlock/open) — no inversion.
   *
   * **What the `/res` reply actually means — a delivery ack, NOT "motion complete".** It answers within
   * seconds, well before a garage door finishes its travel — so this is the device saying "I received the command", not "I finished moving". That's
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
    const dev = await this.pnDeviceFor(sn);
    const trans = this.sequenced(
      sn,
      buildFf09Trans({
        engage: cmd.engage,
        adminUserId: cmd.adminUserId,
        deviceSn: cmd.deviceSn,
        username: cmd.username,
        shortUserId: cmd.shortUserId,
      }),
    );

    const mqtt = await this.securityMqtt();
    const acked =
      (await this.request(
        mqtt,
        ff09MqttTopic(dev.model, sn),
        () => buildFf09MqttEnvelope({ trans, clientId: mqtt.id, accountId: cmd.adminUserId, deviceSn: sn }),
        (m) => (MqttCommandRouter.isReply(m, sn, 9) ? true : undefined),
        MqttCommandRouter.FF09_ACK_TIMEOUT_MS,
      )) ?? false;
    this.deps.onCommandAck({ sn, kind: "ff09-actuate", acked });
    if (!acked) {
      this.logger.debug(
        `dispatchFf09Actuate(${sn}): no /res within ${MqttCommandRouter.FF09_ACK_TIMEOUT_MS}ms — ` +
          `the broker accepted the publish (QoS 1 PUBACK), but that's delivery-to-broker, not ` +
          `delivery-to-device; unclear whether the device ever saw it`,
      );
    }
  }

  /**
   * The `ff09-autolock` intent handler over MQTT — read-modify-write the T85D0's auto-lock setting.
   * Unlike {@link dispatchFf09Actuate} (one
   * fire-and-forget frame), this is a GET then a SET:
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
    const dev = await this.pnDeviceFor(sn);

    const mqtt = await this.securityMqtt();
    const topic = ff09MqttTopic(dev.model, sn);

    // ── 1. GET current settings, matched back by keyTime (shared with getAutoLockState — see helper). ──
    const getReply = await this.fetchFf09SettingsGetReply(mqtt, topic, sn, cmd);

    // ── 2+3. Decrypt the reply, preserve A7/A8 + delay, build the SET frame (shared with the P2P
    //         sibling — see buildFf09AutolockSetFrame), then wrap it in the MQTT trans envelope. ──
    const setTrans = this.sequenced(
      sn,
      toFf09Trans(
        buildFf09AutolockSetFrame({
          lockPayload: getReply.lockPayload,
          keyTime: getReply.keyTime,
          adminUserId: cmd.adminUserId,
          deviceSn: cmd.deviceSn,
          enabled: cmd.enabled,
          delaySeconds: cmd.delaySeconds,
        }),
      ),
    );
    const setAcked =
      (await this.request(
        mqtt,
        topic,
        () => buildFf09MqttEnvelope({ trans: setTrans, clientId: mqtt.id, accountId: cmd.adminUserId, deviceSn: sn }),
        (m) => (MqttCommandRouter.isReply(m, sn, 9) ? true : undefined),
        MqttCommandRouter.FF09_ACK_TIMEOUT_MS,
      )) ?? false;
    this.deps.onCommandAck({ sn, kind: "ff09-autolock", getAcked: true, acked: setAcked });
    if (!setAcked) {
      this.logger.debug(
        `dispatchFf09Autolock(${sn}): settings GET succeeded but no SET /res within ` +
          `${MqttCommandRouter.FF09_ACK_TIMEOUT_MS}ms — broker accepted the publish, device receipt unclear`,
      );
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
  ): Promise<{ lockPayload: string; keyTime: number }> {
    const queryTrans = this.sequenced(
      sn,
      buildFf09QueryTrans({ adminUserId: cmd.adminUserId, deviceSn: cmd.deviceSn }),
    );
    const getReply = await this.request(
      mqtt,
      topic,
      () => buildFf09MqttEnvelope({ trans: queryTrans, clientId: mqtt.id, accountId: cmd.adminUserId, deviceSn: sn }),
      (m) => {
        if (!MqttCommandRouter.isReply(m, sn, 9)) return undefined;
        const reply = parseFf09SettingsResponseTrans(m.raw);
        if (!reply || reply.cmd !== CMD_TRANSFER_PAYLOAD) return undefined;
        const keyTime = ff09ReplyKeyTime(reply.payload.time);
        if (keyTime === undefined || keyTime !== queryTrans.payload.time) return undefined; // other traffic — keep waiting
        return { lockPayload: reply.payload.lock_payload, keyTime };
      },
      MqttCommandRouter.FF09_ACK_TIMEOUT_MS,
    );
    if (!getReply) {
      throw new Error(
        `fetchFf09SettingsGetReply(${sn}): no settings GET reply within ${MqttCommandRouter.FF09_ACK_TIMEOUT_MS}ms on ` +
          `the eufy_security stack.`,
      );
    }
    return getReply;
  }

  /**
   * **Read the T85D0's current auto-lock settings over MQTT** — the `Ff09SettingsReader` implementation.
   * A pure GET, no SET: reuses {@link fetchFf09SettingsGetReply}, then decrypts
   * + decodes fields `a1`-`a5` per `transport/ff09.ts`'s response tag map.
   */
  async getAutoLockState(sn: string, cmd: { adminUserId: string; deviceSn: string }): Promise<AutoLockSnapshot> {
    const dev = await this.pnDeviceFor(sn);
    const mqtt = await this.securityMqtt();
    const topic = ff09MqttTopic(dev.model, sn);
    const getReply = await this.fetchFf09SettingsGetReply(mqtt, topic, sn, cmd);
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
    await this.deps.publishSecure(dev, secureTopic(await this.withPn(dev), "req"), (clientId) =>
      buildDpEnvelope({ clientId, accountId, deviceSn: sn, mqttCmdCode, frame }),
    );
  }

  /**
   * The `mqtt-dp` handler — a single `eufy_life` DP TLV write (on/off, brightness). The capability
   * supplies the opaque `mqttCmdCode`/`cmdCode` + already-tagged scalar `fields`; this builds the frame
   * ({@link buildDpFrame} prepends the `a1` timestamp + `a2` account id) and publishes it.
   */
  private async dispatchMqttDp(sn: string, cmd: Extract<Command, { kind: "mqtt-dp" }>): Promise<void> {
    const dev = await this.pnDeviceFor(sn);
    if (dev.category !== "eufy_life") return this.dispatchLockDp(sn, cmd);
    const accountId = this.requireAccountId(dev);
    const frame = buildDpFrame(cmd.cmdCode, accountId, cmd.fields);
    await this.publishDpFrame(dev, sn, accountId, cmd.mqttCmdCode, frame);
    this.deps.onCommandAck({ sn, kind: "mqtt-dp", cmdCode: cmd.cmdCode, acked: true });
  }

  /**
   * An `mqtt-dp` write to a security device (a lock), as the app's MQTT channel sends it: the bundle's TLV
   * in an `ff09` frame sealed with the lock key (unless the descriptor says otherwise), in the lock `trans`
   * envelope under `head.cmd = mqttCmdCode`, on the device's `eufy_security` topic.
   */
  private async dispatchLockDp(sn: string, cmd: Extract<Command, { kind: "mqtt-dp" }>): Promise<void> {
    const dev = await this.pnDeviceFor(sn);
    const adminUserId = this.requireAccountId(dev);
    const frame = buildFf09TlvFrame({
      cmdCode: cmd.cmdCode,
      fields: cmd.fields,
      adminUserId,
      deviceSn: sn,
      encrypt: cmd.encrypt ?? true,
      subVersion: cmd.subVersion ?? 3,
      functionType: cmd.functionType ?? 2,
    });
    const trans = this.sequenced(sn, toFf09Trans(frame));
    const mqtt = await this.securityMqtt();
    const reply = await this.request(
      mqtt,
      ff09MqttTopic(dev.model, sn),
      () =>
        buildFf09MqttEnvelope({ trans, clientId: mqtt.id, accountId: adminUserId, deviceSn: sn, cmd: cmd.mqttCmdCode }),
      (m) => (MqttCommandRouter.isReply(m, sn, cmd.mqttCmdCode) ? true : undefined),
      (cmd.timeoutS ?? 5) * 1000,
      cmd.retryCount,
    );
    this.deps.onCommandAck({ sn, kind: "mqtt-dp", cmdCode: cmd.cmdCode, acked: reply ?? false });
  }

  /** Serialize and publish one semantic RGB DP action without changing configured brightness. */
  private async dispatchDpColor(sn: string, cmd: Extract<Command, { kind: "mqtt-dp-color" }>): Promise<void> {
    const dev = await this.pnDeviceFor(sn);
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
   * `eufy_life` (smart lights) gets its own certificate.
   */
  private async dispatchAiotDp(sn: string, cmd: Extract<Command, { kind: "aiot-dp" }>): Promise<void> {
    const dev = await this.pnDeviceFor(sn);
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
    const dev = await this.pnDeviceFor(sn);
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

/** The product numbers `snToPn` returns as given. */
const PN_AS_IS = new Set([
  "T2276T",
  "T2080A",
  "T2261EV",
  "T2261A",
  "T2261B",
  "T2262A",
  "T2262EV",
  "T2262_77",
  "T2262B",
  "T2255D",
  "T2256D",
  "T2272D",
  "T2273D",
  "T2270D",
  "T2270",
  "T2254D",
  "T2272DS",
  "T2273DS",
  "T2253DS",
  "T2253D",
  "T2250DS",
  "T2250D",
  "T2292B",
  "T2880B",
  "T2801B",
]);

/** `snToPn`'s serial rules for a serial over 6 characters, `undefined` where it asks the cloud. */
export function serialPn(sn: string): string | undefined {
  const c7 = sn.charAt(6);
  if (sn.startsWith("T8W11P")) return "T8W11C";
  if (sn.startsWith("T8420")) return c7 === "6" ? "T8420X" : "T8420";
  if (sn.startsWith("T8520")) return c7 === "8" ? "T8510P" : c7 === "9" ? "T8520P" : "T8520";
  if (sn.startsWith("T2276T")) return "T2276T";
  if (sn.startsWith("T2080A")) return "T2080A";
  if (sn.startsWith("T8210")) return c7 === "8" ? "T8210C" : "T8210";
  if (sn.startsWith("T8410")) return c7 === "5" ? "T8410C" : "T8410";
  return PN_AS_IS.has(sn) ? sn : undefined;
}
