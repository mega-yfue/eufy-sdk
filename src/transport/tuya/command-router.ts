/**
 * `TuyaCommandRouter` — the transport-side command router for eufy Home/Clean Tuya vacuums (X8,
 * G-series and other `eufy_home_tuya` category devices).
 *
 * Usage: call {@link bind} after a successful mega login, then {@link registerDevice} for each
 * `eufy_home_tuya` device (the facade does both). On the first {@link dispatchCommand} the router
 * logs into the Tuya cloud lazily (once, shared across all subsequent sends). The dp.publish write
 * is sent via `TuyaClient.publishDps`, verified on T2276.
 *
 * Layering: imports `../../core` only — no `model/` import, consistent with the capability↔transport
 * decorrelation invariant. Sibling tuya/* imports are same-layer (transport).
 */
import type { Command } from "../../core/contracts.js";
import { resolveCountryCode } from "./account.js";
import { HmacSigner } from "./sign.js";
import { TuyaClient } from "./client.js";
import type { TuyaHttpPost } from "./request.js";
import { parseTuyaDpEvent } from "./dp-codec.js";

export interface TuyaCommandRouterConfig {
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
   * Route an `aiot-dp` {@link Command} to the Tuya REST API.
   *
   * Logs in lazily on first call. The eufy SN must have been registered via {@link registerDevice}
   * before dispatch — the facade does this when the device list is loaded.
   *
   * Rejected API replies throw; acceptance alone does not confirm physical execution.
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
    const reply = await this.client!.publishDps(ids.devId, ids.gwId, { [cmd.dp]: cmd.value });
    if (!reply.success) {
      throw new Error(`Tuya DP publish rejected: ${reply.errorCode ?? "unknown"}`);
    }
  }
}
