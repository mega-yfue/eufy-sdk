/**
 * `TuyaCommandRouter` — the transport-side command router for eufy Home/Clean Tuya vacuums (X8,
 * G-series and other `eufy_home_tuya` category devices).
 *
 * Usage: call {@link bind} after a successful mega login, then {@link registerDevice} for each
 * `eufy_home_tuya` device (the facade does both). On the first {@link dispatchCommand} the router
 * logs into the Tuya cloud lazily (once, shared across all subsequent sends). The dp.publish write
 * is sent via `TuyaClient.publishDps` — note the `dp.publish` param shape is not yet confirmed from
 * a live eufy Home/Clean capture (guarded by `allowUnverified: true` until a capture confirms it).
 *
 * Layering: imports `../../core` only — no `model/` import, consistent with the capability↔transport
 * decorrelation invariant. Sibling tuya/* imports are same-layer (transport).
 */
import type { Command } from "../../core/contracts.js";
import { HmacSigner } from "./sign.js";
import { TuyaClient } from "./client.js";

/** eufy SN → Tuya device identity needed for DP reads and writes. */
interface TuyaDeviceIds {
  /** Primary device id (the `devId` Tuya field). */
  devId: string;
  /**
   * Gateway device id — for standalone devices equals `devId`; for hub-attached sub-devices is the
   * hub's devId. Confirmed from `DPBusiness.java`: `gwId = devId` for direct devices.
   */
  gwId: string;
}

/**
 * Map a mega region shard string (`"eu-pr"`, `"us-pr"`, `"cn-pr"`) to the Tuya `countryCode`
 * numeric dial code. Used as the Tuya login countryCode when the caller does not supply one
 * directly.
 */
function dialCodeFromRegion(regionShard: string): string {
  const r = regionShard.toLowerCase();
  if (r.startsWith("eu")) return "44";
  if (r.startsWith("cn")) return "86";
  return "1";
}

export class TuyaCommandRouter {
  private userId: string | undefined;
  private dialCode: string | undefined;
  private client: TuyaClient | null = null;
  /** Promise that resolves once Tuya login has completed. Reset by {@link bind}. */
  private loginOnce: Promise<void> | null = null;

  /**
   * eufy SN → Tuya device ids, populated by the facade via {@link registerDevice}.
   * The facade extracts the Tuya id from the `raw` device record fields (`tuya_uuid`,
   * `tuya_virtual_id`, `tuya_device_id`, `virtualId`) and registers it once the device list loads.
   */
  private readonly snMap = new Map<string, TuyaDeviceIds>();

  /**
   * Supply credentials for lazy Tuya login. Called by the facade after a successful mega login.
   * The router logs into Tuya on the first {@link dispatchCommand}, not immediately.
   * `regionShard` is the mega shard string (`"eu-pr"`, `"us-pr"`, …) used to derive the Tuya
   * `countryCode` dial code when the account's phone code is not explicitly configured.
   */
  bind(userId: string, regionShard?: string): void {
    this.userId = userId;
    this.dialCode = regionShard ? dialCodeFromRegion(regionShard) : undefined;
    // Reset so next dispatch re-logs with the new credentials (handles re-login after logout).
    this.client = null;
    this.loginOnce = null;
  }

  /**
   * Register a eufy SN → Tuya devId mapping. Called by the facade for each `eufy_home_tuya`
   * device after the cloud device list loads. The facade extracts the Tuya id from the device's
   * raw record (`tuya_uuid` / `tuya_virtual_id` / `tuya_device_id` / `virtualId` fields).
   * `gwId` defaults to `devId` — standalone devices share the two (confirmed from `DPBusiness.java`).
   */
  registerDevice(sn: string, devId: string, gwId = devId): void {
    this.snMap.set(sn, { devId, gwId });
  }

  private ensureLoggedIn(): Promise<void> {
    this.loginOnce ??= (async () => {
      if (!this.userId) {
        throw new Error(
          "TuyaCommandRouter: bind(userId) was not called before dispatch — " +
            "the facade must call bind() after a successful mega login",
        );
      }
      const client = new TuyaClient({ signer: new HmacSigner(), chKey: "7cbfe6d8" });
      await client.login(this.userId, this.dialCode);
      this.client = client;
    })();
    return this.loginOnce;
  }

  /**
   * Route an `aiot-dp` {@link Command} to the Tuya REST API.
   *
   * Logs in lazily on first call. The eufy SN must have been registered via {@link registerDevice}
   * before dispatch — the facade does this when the device list is loaded.
   *
   * ⚠️ `dp.publish` param shape is sent with `{ allowUnverified: true }` — the wire shape is
   * implemented from the documented protocol but not yet confirmed from a live eufy Home/Clean
   * capture. Remove the guard once a capture confirms the full round-trip.
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
          "Ensure getDevices() was called and the cloud record includes a tuya_uuid / tuya_virtual_id field.",
      );
    }
    await this.client!.publishDps(ids.devId, ids.gwId, { [cmd.dp]: cmd.value }, { allowUnverified: true });
  }
}
