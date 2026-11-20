import { randomUUID } from "node:crypto";

/**
 * Build the AIoT MQTT envelope for a Tuya DP write to a clean-line device (vacuum/mower).
 *
 * The outer JSON carries `{head, payload}` where `payload` is itself a JSON **string** containing the
 * DP map. `head.cmd` 65537 (0x10001), `cmd_status` 2, `sign_code` 0.
 *
 * The DP value is sent as-is: booleans, numbers, and base64 strings all appear directly in the
 * `data` map (the device interprets the type from its own schema).
 */
export function buildCleanDpEnvelope(
  accountId: string,
  deviceSn: string,
  dp: number,
  value: boolean | number | string,
  opts?: { timestamp?: number; uuid?: string },
): string {
  const payload = JSON.stringify({
    t: opts?.uuid ?? randomUUID(),
    protocol: 2,
    account_id: accountId,
    device_sn: deviceSn,
    data: { [String(dp)]: value },
  });
  return JSON.stringify({
    head: { cmd: 65537, cmd_status: 2, sign_code: 0, timestamp: opts?.timestamp ?? Date.now() },
    payload,
  });
}
