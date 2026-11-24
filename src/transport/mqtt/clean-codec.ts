/**
 * Build the AIoT MQTT envelope for a DP write to a clean-line device (vacuum/mower), as the app's AIoT stack
 * builds it.
 *
 * `{head, payload}`: `head` is an object — `sign_code` 0, `timestamp` (ms), `version` `1.0.0.1`, `client_id`, a
 * `sess_id` equal to it, `msg_seq` 1, `cmd` 65537 (0x10001), `cmd_status` 2, `seed` `""` — and `payload` a JSON
 * **string** `{protocol: 2, t, account_id, device_sn, data}` whose `t` is the same millisecond timestamp.
 *
 * `clientId` is the app's AIoT client id, `android-{app_name}-{uid}-eufy_android_{phone model}_{uid}`, not the
 * connection's. The DP value is sent as-is: booleans, numbers, and base64 strings all appear directly in the
 * `data` map (the device interprets the type from its own schema).
 */
export function buildCleanDpEnvelope(
  accountId: string,
  deviceSn: string,
  dp: number,
  value: boolean | number | string,
  opts: { clientId: string; timestamp?: number },
): string {
  const t = opts.timestamp ?? Date.now();
  const payload = JSON.stringify({
    protocol: 2,
    t,
    account_id: accountId,
    device_sn: deviceSn,
    data: { [String(dp)]: value },
  });
  return JSON.stringify({
    head: {
      sign_code: 0,
      timestamp: t,
      version: "1.0.0.1",
      client_id: opts.clientId,
      sess_id: opts.clientId,
      msg_seq: 1,
      cmd: 65537,
      cmd_status: 2,
      seed: "",
    },
    payload,
  });
}
