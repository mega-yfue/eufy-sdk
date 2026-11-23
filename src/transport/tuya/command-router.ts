/**
 * `TuyaCommandRouter` — the transport-side command router for eufy Home/Clean Tuya vacuums (X8,
 * G-series and other `eufy_home_tuya` category devices).
 *
 * Usage: call {@link bind} after a successful mega login, then {@link registerDevice} for each
 * `eufy_home_tuya` device (the facade does both). On the first {@link dispatchCommand} the router
 * logs into the Tuya cloud lazily (once, shared across all subsequent sends). The dp.publish write
 * is sent via `TuyaClient.publishDps` — note the `dp.publish` param shape is not yet confirmed from
 * a live eufy Home/Clean capture (gated by {@link TuyaCommandRouterConfig.allowUnverified}, default `false`).
 *
 * Layering: imports `../../core` only — no `model/` import, consistent with the capability↔transport
 * decorrelation invariant. Sibling tuya/* imports are same-layer (transport).
 */
import type { Command } from "../../core/contracts.js";
import { resolveCountryCode, tuyaUsername } from "./account.js";
import { HmacSigner } from "./sign.js";
import { TuyaClient } from "./client.js";
import type { TuyaHttpPost } from "./request.js";
import { parseTuyaDpEvent } from "./dp-codec.js";

export interface TuyaCommandRouterConfig {
  /**
   * Opt-in to unverified Tuya DP writes. Defaults to `false` — {@link dispatchCommand} will throw
   * until a live `publishDps` capture confirms the dp.publish round-trip. Set `true` only after that
   * confirmation and remove the gate when the write is shipped as verified.
   */
  allowUnverified?: boolean;
  /** Inject a POST transport (test stub); default = native fetch. Forwarded to the internal TuyaClient. */
  http?: TuyaHttpPost;
}

/** eufy SN → Tuya device identity needed for DP reads and writes. */
interface TuyaDeviceIds {
  /** Primary device id (the `devId` Tuya field). */
  devId: string;
  /**
   * Gateway device id — for standalone devices equals `devId`; for hub-attached sub-devices is the
   * hub's devId.
   */
  gwId: string;
}

export class TuyaCommandRouter {
  private readonly allowUnverified: boolean;
  private readonly http: TuyaHttpPost | undefined;
  private userId: string | undefined;
  private dialCode: string | undefined;
  private client: TuyaClient | null = null;
  /** Promise that resolves once Tuya login has completed. Reset by {@link bind}. */
  private loginOnce: Promise<void> | null = null;

  /**
   * eufy SN → Tuya device ids, populated via {@link registerDevice} once the device list loads.
   * The Tuya id is the record's first non-empty `tuya_uuid` / `tuya_virtual_id` / `tuya_device_id` /
   * `virtualId`, or the device's serial when the record carries none of them.
   */
  private readonly snMap = new Map<string, TuyaDeviceIds>();

  constructor(config: TuyaCommandRouterConfig = {}) {
    this.allowUnverified = config.allowUnverified ?? false;
    this.http = config.http;
  }

  /**
   * Supply credentials for lazy Tuya login. Called by the facade after a successful mega login.
   * The router logs into Tuya on the first {@link dispatchCommand}, not immediately.
   *
   * `regionShard` is the mega shard string (`"eu-pr"`, `"us-pr"`, …) used as a coarse fallback;
   * `isoCode` is the ISO 3166-1 alpha-2 country code from {@link MegaClientConfig} (e.g. `"DE"`)
   * and takes precedence — a German user on the EU shard gets dial code `"49"`, not `"44"`.
   */
  bind(userId: string, regionShard?: string, isoCode?: string): void {
    this.userId = userId;
    this.dialCode = resolveCountryCode(undefined, regionShard, isoCode);
    // Reset so next dispatch re-logs with the new credentials (handles re-login after logout).
    this.client = null;
    this.loginOnce = null;
  }

  /**
   * Register a eufy SN → Tuya devId mapping for an `eufy_home_tuya` device. `devId` is the record's
   * first non-empty `tuya_uuid` / `tuya_virtual_id` / `tuya_device_id` / `virtualId`, or the device's
   * serial when the record carries none of them. `gwId` defaults to `devId` — standalone devices
   * share the two.
   */
  registerDevice(sn: string, devId: string, gwId = devId): void {
    this.snMap.set(sn, { devId, gwId });
  }

  private ensureLoggedIn(): Promise<void> {
    if (!this.loginOnce) {
      const p = (async () => {
        if (!this.userId) {
          throw new Error(
            "TuyaCommandRouter: bind(userId) was not called before dispatch — " +
              "the facade must call bind() after a successful mega login",
          );
        }
        const client = new TuyaClient({ signer: new HmacSigner(), http: this.http });
        await client.login(this.userId, this.dialCode);
        this.client = client;
      })();
      p.catch(() => {
        if (this.loginOnce === p) this.loginOnce = null;
      });
      this.loginOnce = p;
    }
    return this.loginOnce;
  }

  /**
   * Read a device's current DPs from the Tuya cloud (`smartlife.m.device.dp.get`) and answer the DP
   * map: the reply's flat `result`, kept to integer DP keys with scalar values. Answers `null` for an
   * unregistered device, a failed reply, or a reply with no DPs.
   */
  async fetchDps(sn: string): Promise<Record<string, unknown> | null> {
    const ids = this.snMap.get(sn);
    if (!ids) return null;
    await this.ensureLoggedIn();
    const res = await this.client!.getDeviceDps<Record<string, unknown>>(ids.devId);
    if (!res.success || !res.result) return null;
    const dps = parseTuyaDpEvent(res.result);
    return dps ? (dps as unknown as Record<string, unknown>) : null;
  }

  /**
   * One Tuya sharing call as the app's ThingHomeSdk device-share API makes it (`thing.m.sharing.*`, sent as
   * `smartlife.m.sharing.*`), logged in first. A failed reply throws its error code, except `handled`, which
   * the app counts as done.
   */
  private async sharing<T>(a: string, v: string, data: object, handled?: string): Promise<T | undefined> {
    await this.ensureLoggedIn();
    const res = await this.client!.call<T>({ a: `smartlife.m.sharing.${a}`, v, postData: JSON.stringify(data) });
    const code = res.errorCode ?? res.errorMsg;
    if (!res.success && code !== handled) throw new Error(`tuya sharing.${a} failed: ${code ?? "unknown"}`);
    return res.result;
  }

  /**
   * The owner's Tuya-side share of an `eufy_home_tuya` device (`sharing.invite {resId, resType: 1, userAccount,
   * countryCode}`): `userAccount` is the invitee's Tuya username, `countryCode` this account's own `phoneCode`.
   * Answers the share id the app puts in the invite's `extension`.
   */
  async inviteShare(devId: string, inviteeUserId: string): Promise<string> {
    await this.ensureLoggedIn();
    const { phoneCode } = this.client!.getSession();
    const id = await this.sharing<number>("invite", "1.0", {
      resId: devId,
      resType: 1,
      userAccount: tuyaUsername(inviteeUserId),
      countryCode: phoneCode ?? this.dialCode,
    });
    return String(id);
  }

  /**
   * The invitee's Tuya-side accept (`sharing.accept {id}`), `id` the invite's `extension` read as an integer;
   * one that is not refuses before sending, as the app does. An already handled invite counts as accepted.
   */
  async acceptShare(extension = ""): Promise<void> {
    const id = /^[+-]?\d+$/.test(extension) ? Number(extension) : -1;
    if (id < 0) throw new Error("tuya shareId not found");
    await this.sharing("accept", "1.0", { id }, "SHARING_INVITE_HANDLED");
  }

  /**
   * The owner's Tuya-side removal: the device's members (`sharing.device.member.list {devId}`), and when one's
   * `username` is the receiver's Tuya username, `sharing.device.remove {relationId, devId}` on its `id`. No such
   * member is nothing to remove.
   */
  async removeShare(devId: string, receiverUserId: string): Promise<void> {
    const members = await this.sharing<Array<{ id: number; username?: string }>>("device.member.list", "1.0", {
      devId,
    });
    const member = members?.find((m) => m.username === tuyaUsername(receiverUserId));
    if (member) await this.sharing("device.remove", "3.0", { relationId: member.id, devId });
  }

  /** The receiver's Tuya-side leave (`sharing.sharer.remove.res {resId, resType: "device"}`). */
  async leaveShare(devId: string): Promise<void> {
    await this.sharing("sharer.remove.res", "3.0", { resId: devId, resType: "device" });
  }

  /**
   * Route an `aiot-dp` {@link Command} to the Tuya REST API.
   *
   * Logs in lazily on first call. The eufy SN must have been registered via {@link registerDevice}
   * before dispatch — the facade does this when the device list is loaded.
   *
   * ⚠️ `dp.publish` is unverified — see {@link TuyaCommandRouterConfig.allowUnverified}. By default
   * this throws. Pass `allowUnverified: true` in the router config only after a live capture
   * confirms the full round-trip, then remove the gate.
   */
  async dispatchCommand(sn: string, cmd: Command): Promise<void> {
    if (cmd.kind !== "aiot-dp") {
      throw new Error(`TuyaCommandRouter received an unroutable command (${cmd.kind}) — only aiot-dp belongs here`);
    }
    await this.ensureLoggedIn();
    const ids = this.snMap.get(sn);
    if (!ids) {
      throw new Error(
        `TuyaCommandRouter: no Tuya device id registered for ${sn}. ` +
          "Ensure getDevices() was called; it registers every eufy_home_tuya device under its Tuya id or its serial.",
      );
    }
    await this.client!.publishDps(
      ids.devId,
      ids.gwId,
      { [cmd.dp]: cmd.value },
      { allowUnverified: this.allowUnverified },
    );
  }
}
