/**
 * Direct-binary write helpers.
 *
 * The capability-driven command recipes live in the capability modules
 * (`src/model/capabilities/*`): each module owns its own `buildCommand`, and the barrel's
 * `buildCommand()` resolves across them. This file keeps ONLY the **direct-binary** body builder
 * — a packed struct, not a JSON recipe — used by `EufyMega.sendDirectBinary` for camera on/off +
 * spotlight brightness/color-temp/enable. No dependency on the capability barrel (avoids a cycle).
 */

/**
 * Build the packed binary body for a "direct" control command — TWO shapes, one layout. The tail is
 * always `[uint32 LE value][account_id ASCII pad→128]`; they differ only by an optional leading
 * channel word:
 *  - **device form** (pass `channel`): `[uint32 LE channel][uint32 LE value][account_id @8]` = **136B**
 *    — camera on/off `1035`, spotlight brightness `1401` / color-temp `1410` / enable `1403`, etc.
 *  - **station form** (omit `channel`): `[uint32 LE value][account_id @4]` = **132B** — a HomeBase
 *    station-scoped scalar (alarm/speaker volume `1235`); the hub is addressed by the outer frame
 *    channel 255, so there is no leading channel word.
 *
 * `account_id` is
 * **sliced to 128** (`Buffer.write` would otherwise silently truncate) and must be **non-empty** —
 * an all-zero account field is rejected by the HomeBase and the caller's fallback chain can resolve
 * to `""`, so we fail loud instead.
 */
/**
 * Write the account_id into the trailing 128-byte ASCII field every level-2 control body ends with.
 * Shared by all body builders so the encoding (non-empty guard, 128-byte truncation, ASCII) can't drift.
 */
function writeAccountIdField(body: Buffer, offset: number, accountId: string): void {
  if (!accountId) throw new Error("control command requires a non-empty account_id");
  body.write(accountId.slice(0, 128), offset, "ascii");
}

/**
 * Build a level-2 direct-binary control body: `[u32 channel?][u32 value][account_id ASCII pad→128]`.
 * Omit `channel` for the channel-less station form (e.g. HomeBase alarm volume). See the struct note above.
 */
export function buildDirectBinaryBody(value: number, accountId: string, channel?: number): Buffer {
  const withChannel = channel !== undefined;
  const body = Buffer.alloc((withChannel ? 8 : 4) + 128);
  let offset = 0;
  if (withChannel) {
    body.writeUInt32LE(channel, 0);
    offset = 4;
  }
  body.writeUInt32LE(value, offset);
  writeAccountIdField(body, offset + 4, accountId);
  return body;
}

/**
 * UTF-8 encode `name`, truncated to at most `maxBytes` *bytes* on a code-point boundary. The app
 * encodes device names as UTF-8, so we match it (rather than the lossy `"ascii"` write, which masked
 * every non-ASCII char to a single wrong byte — e.g. "Café" → mojibake). Truncation drops whole JS
 * chars until the UTF-8 length fits, so a multi-byte char is never split into a partial sequence.
 */
function encodeNameField(name: string, maxBytes: number): Buffer {
  let s = name;
  while (Buffer.byteLength(s, "utf8") > maxBytes) s = s.slice(0, -1);
  return Buffer.from(s, "utf8");
}

/**
 * The app's native string body (its sender's layout 0x2d9cb4, used by `SET_TIME_ZONE` 1215, `SET_HUB_NAME`
 * 1216 and `SET_DEVICE_NAME` 1217): a 261-byte `[u32 = 0][u8 device_channel][string → 128B, null-padded]
 * [account_id → 128B, null-padded]`, sent on the station channel (255). The string is UTF-8 (matching the
 * app), truncated to fit 127 bytes so the field stays null-terminated.
 */
export function buildStringBody(channel: number, name: string, accountId: string): Buffer {
  const body = Buffer.alloc(5 + 128 + 128);
  body.writeUInt32LE(0, 0); // reserved / value = 0
  body.writeUInt8(channel & 0xff, 4); // device channel
  encodeNameField(name, 127).copy(body, 5); // name field (128B, keep null-terminated)
  writeAccountIdField(body, 5 + 128, accountId); // account_id field (128B)
  return body;
}

/**
 * The `SET_PAYLOAD` (1350) JSON the app sends: `{key?, account_id, cmd, mChannel, mValue3, payload}`, mValue3 0 unless
 * given, `payload` omitted with `omitPayload` or spread at the top level with `unzip`. A `"$userId"` in the params
 * (`encrypt_key`) is written as the account id.
 */
export function setPayloadJson(
  cmd: number,
  payload: unknown,
  opts: {
    accountId?: string;
    channel?: number;
    mValue3?: number;
    key?: string;
    omitPayload?: boolean;
    unzip?: boolean;
  },
): string {
  const inner = {
    ...(opts.key !== undefined ? { key: opts.key } : {}),
    account_id: opts.accountId ?? "",
    cmd,
    mChannel: opts.channel ?? 0,
    mValue3: opts.mValue3 ?? 0,
    ...(opts.omitPayload ? {} : opts.unzip ? (payload as object) : { payload }),
  };
  return JSON.stringify(inner, (_, v) => (v === "$userId" ? (opts.accountId ?? "") : v));
}
