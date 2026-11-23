/**
 * `ff09` frame encoder — the AES-128-CBC framed control protocol shared by every eufy device that
 * takes a lock-style on/off actuation command (currently: the T8531 video smart lock and the T85D0
 * garage door; likely other actuators later — see below).
 *
 * The command bytes are a self-contained `ff09…` frame, NOT a plain param write, and BOTH transports
 * carry the exact same frame:
 *  - **P2P** (`transport/p2p/command-router.ts`, T8531): wrapped in a `SET_PAYLOAD` (1350) envelope
 *    whose inner `cmd` is `TRANSFER_PAYLOAD` (1940) and `payload` = `{apiCommand:6018,
 *    lock_payload:"ff09…", seq_num, time}`.
 *  - **MQTT** (`transport/mqtt/command-router.ts`, standalone/garage families): base64 of the identical
 *    frame under the `trans` field.
 *
 * So cracking the frame solves both — this module builds ONLY the frame, nothing about either
 * envelope, and sits at the transport root (like `ffmpeg.ts`) specifically so neither transport
 * imports the other for it. Named after the wire frame, not the capability: the two current callers
 * both happen to be locks, but nothing here is lock-specific beyond the {@link LOCK_COMMAND_CODE}
 * opcode value itself — a future actuator (e.g. a curtain) reusing this wire would just be a new
 * opcode constant, not a new encoder.
 *
 * ## Wire
 *
 * **Outer frame** (`lockPayload`, hex):
 * ```
 *   ff 09 | size(u16 LE) | 03(versionCode) 00(reserved) 02(dataType) | cmdEnc(u16 BE) | ct… | xorHash(1)
 * ```
 * `size` = total frame length incl. header + xor. `cmdEnc` = `0x4000 | commandCode` (bit 0x4000 =
 * "encrypted payload"). `xorHash` = XOR of every preceding byte.
 *
 * **Inner plaintext** — an incrementing-separator TLV (`0xA1, 0xA2, …`, each `sep | len | bytes`),
 * then **zero-padded to a 16-byte boundary** before AES (the app pads the buffer, so the real PKCS#7
 * block AES adds is a full 0x10 block):
 * ```
 *   A1 04 <time u32 LE>            — freshness stamp
 *   A2 <len> <admin_user_id ASCII> — the lock owner's id (40 hex chars)
 *   A3 01 <lockByte>               — 0 = lock, 1 = unlock
 *   A4 <len> <username ASCII>      — the acting user's display name (the account name)
 *   A5 <len> <short_user_id bytes> — the acting member's short id (hex→bytes, e.g. "0003")
 * ```
 *
 * **Cipher**: AES-128-CBC + PKCS#7.
 *  - key = `ASCII(admin_user_id[-12:])` (12 B) ‖ `uint32 BE(time)` (4 B) = 16 B.
 *  - iv  = `ASCII(deviceSn)` zero-padded to 16 B (a 16-char SN is used verbatim).
 *  - `time` is the nonce that makes each command's key differ; it is emitted CLEARTEXT in the
 *    envelope `time` field so the lock can re-derive the key. The app computes it as
 *    `floor(unixSec) | floor(random*100)` — the low bits are randomized. We reproduce that:
 *    `keyTime = unixSec | nonce`, and the TLV `A1` stamp carries the un-noised `unixSec`.
 *
 * ## Settings GET/SET (garage/lock auto-lock — same cipher/frame family)
 *
 * Two more `apiCommand`/`commandCode` pairs on the SAME outer frame + cipher as above:
 *  - **GET** (`LOCK_API_COMMAND.GET_SETTINGS` 6016 / `LOCK_COMMAND_CODE.GET_SETTINGS` 53/0x35,
 *    {@link buildFf09QueryFrame}): plaintext is JUST `[A1 time][A2 adminUserId]` — no user-attribution
 *    fields at all (narrower than even `omitUserFields`, which still keeps A3).
 *  - **SET** (`LOCK_API_COMMAND.SET_SETTINGS` 6015 / `LOCK_COMMAND_CODE.SET_SETTINGS` 52/0x34,
 *    {@link buildFf09SettingsFrame}): `[A1 time][A2 adminUserId][A3 1B][A4 1B enable][A5 2B LE delay-
 *    seconds][A6 1B][A7 2B][A8 2B][A9 1B]`. `A3` is the same **setting-type selector** the Rain Mode
 *    compact write uses (see below) — `0x00` selects auto-lock. `A4`-`A8` are named by the app's own
 *    `smartLockSetParamsDataParse` `case 0`: `A4`=`isAutoLock`, `A5`=`autoLockTime`
 *    (seconds, LE u16), `A6`=`isSchedule` (bool), `A7`=`scheduleStartTime`, `A8`=`scheduleEndTime`.
 *    `A7`/`A8` are each `[hourByte, minuteByte]` (the app encodes them as `hour.toString(16)‖
 *    minute.toString(16)`, NOT a packed LE u16) — we still treat them as an opaque 2-byte passthrough
 *    (read from a prior GET, written back unchanged), which stays correct either way since we never
 *    interpret their contents, only preserve them. **`A9` is UNRESOLVED, not "confirmed reserved"**:
 *    the app's `case 0` builder writes exactly 5 fields (`A4`-`A8`), while the app's wire frame carries
 *    a 6th tagged byte (`0xA9`, value `0x00`) after `A8`. The encoder sends `A9=0x00`, as the wire
 *    does, and the device accepts it.
 *  - **The device's `/res` reply to a GET** is NOT a normal command ack: no `mChannel`/`mValue3`/
 *    `apiCommand`/`seq_num`, just `{cmd:1940, payload:{dev_sn, lock_payload, time}}` where `time` is a
 *    **hex string** (not decimal) that equals the keyTime of the GET that triggered it — matched back
 *    to the query to survive interleaved traffic. Its `cmdEnc` has an extra flag bit set vs. a request
 *    (`0x48xx` not `0x40xx`) but decodes with the exact same key/iv derivation. Decrypted plaintext:
 *    a leading `0x00` status byte, then TLV fields using the same `sep|len|bytes` encoding but the
 *    response's OWN independent tag numbering (does not line up positionally with the GET/SET request
 *    TLVs), and it is NOT the auto-lock write's own reply scoped to auto-lock: **a single `GET_SETTINGS`
 *    reply is a FLAT DUMP of the device's ENTIRE settings state**, one field per tag, covering every
 *    setting in the `A3`/setting-type enum below (not just the one being written) — per the app's own
 *    `smartLockGetParamsDataParse`, which explicit-tag-reads (not sequentially, `getByteParam(<tag>)`/`getSecondParam(<tag>)`/
 *    `getTimeParam(<tag>)`) THIRTY-FOUR fields, tags `0xa1` through `0xc2`:
 *
 *    | tag  | field                              | tag  | field                              |
 *    |------|-------------------------------------|------|-------------------------------------|
 *    | 0xa1 | `isAutoLock` **(current enable state — use THIS, not `A4`, to read it back)** | 0xb3 | *(read, unused in this build)* |
 *    | 0xa2 | `autoLockTime` (= our `A5`/delay readback) | 0xb4 | *(read, unused in this build)* |
 *    | 0xa3 | `isSchedule` (= our `A6`)           | 0xb5 | `isPowerSavingMode`                  |
 *    | 0xa4 | `scheduleStartTime` (= our `A7` readback) | 0xb6 | `powerSavingModeStartTime`     |
 *    | 0xa5 | `scheduleEndTime` (= our `A8` readback) | 0xb7 | `powerSavingModeEndTime`         |
 *    | 0xa6 | `isOneTouchLock` (setting-type 1)   | 0xb8 | `keepAliveTime`                      |
 *    | 0xa7 | `isScramblePasscode` (setting-type 3) | 0xb9 | `isOneTouchRearLock` (setting-type 11) |
 *    | 0xa8 | `isWrongTryProtect` (setting-type 2) | 0xba | `multiFunctionBtnSinglePressMode` (12) |
 *    | 0xa9 | `wrongTryTime`                      | 0xbb | `multiFunctionBtnDoublePressMode`    |
 *    | 0xaa | `lockDownTime`                      | 0xbc | `multiFunctionBtnLongPressMode`      |
 *    | 0xab | `lockVolume` (setting-type 4)        | 0xbd | `isSoundNotDisturbSchedule`          |
 *    | 0xac | `wifiStatus` (setting-type 5)        | 0xbe | `soundNotDisturbScheduleStart`       |
 *    | 0xad | `isEnableLog` (setting-type 6)        | 0xbf | `soundNotDisturbScheduleEnd`         |
 *    | 0xae | `isRainMode` (setting-type 7)         | 0xc0 | `faceEnabled` (setting-type 13, default 1) |
 *    | 0xaf | `isPassageMode` (setting-type 8)      | 0xc1 | `faceWakeType` (default 0)           |
 *    | 0xb0 | `passageModeStartTime`               | 0xc2 | `fingerprintEnabled` (default 1)     |
 *    | 0xb1 | `passageModeEndTime`                 |      |                                       |
 *    | 0xb2 | `isPrivacyMode` (setting-type 9)      |      |                                       |
 *
 *    `a6` is `isOneTouchLock`, an entirely different setting, which is why it never moves with
 *    auto-lock's own on/off state — the REAL current-enable-state field is `a1` (our own
 *    `parseFf09SettingsResponse` already parses it correctly; it is simply not READ by
 *    `sendFf09Autolock`/`dispatchFf09Autolock`, which only pull `a2`/`a4`/`a5`). Not yet
 *    wired into any code path — flagged here as a documented opportunity, not a shipped read.
 *    See {@link decryptFf09Frame} + {@link parseFf09SettingsResponse}.
 *  - **The T8531 speaks the same GET/SET frame over P2P** (same key derivation, same TLV layout). See
 *    `transport/p2p/command-router.ts`'s `sendFf09Autolock`.
 *
 * ## Rain Mode (T8531 — a SECOND, shorter `SET_SETTINGS` shape)
 *
 * Same `apiCommand`/`commandCode` pair as the auto-lock SET above (6015/52), but a genuinely different,
 * SHORTER plaintext: `[A1 time]
 * [A2 adminUserId][A3 1B settingId][A4 1B value]`, nothing past `A4` (no `A5`-`A9` at all). `A3` here
 * is NOT the unconfirmed constant from the full-blob write above — it's a setting-id SELECTOR (`0x07`
 * for Rain Mode), making this a compact single-setting write rather than a read-modify-write of a fixed
 * blob. Because it doesn't touch any field besides the one being set, it's a pure blind write — no GET
 * pass needed first. See {@link FF09_SETTING_ID} + {@link buildFf09SettingToggleFrame}. The `A3`
 * selector addresses at least 14 T8531 settings — the app's own `smartLockSetParamsDataParse` gives the
 * id→setting map; `RAIN_MODE` is the only one whose frame comes from the app's wire, and 6 more
 * (one-touch lock/scramble/wifi/enable-log/privacy/one-touch-rear) are wired but THROW "wire unverified"
 * until each clears that bar — see {@link FF09_SETTING_ID} for the full id list. See
 * `transport/p2p/command-router.ts`'s `sendFf09SettingToggle`.
 */

import { createCipheriv, createDecipheriv } from "node:crypto";
import { u16be, u16le, u32be, u32le } from "../core/util.js";
import type { AutoLockSnapshot } from "../core/contracts.js";

/**
 * `apiCommand` values for the `TRANSFER_PAYLOAD` (1940) envelope `payload`. `ON_OFF_LOCK` (6018)
 * is THE lock/unlock command for both the video lock (T8531) and the garage door (T85D0), open and
 * close alike. Direction is the ff09 frame's `A3` byte, not the
 * apiCommand: both lock and unlock issue `apiCommand 6018`.
 */
export const LOCK_API_COMMAND = {
  /** Lock / unlock the deadbolt — video lock AND garage door, both directions (see above). */
  ON_OFF_LOCK: 6018,
  /**
   * NOT used by this encoder — kept only as a real wire constant. The app's traffic carries
   * `apiCommand 6012`, and the app's own `ESLCommand` enum names it `QUERY_STATUS_IN_LOCK` — a read-only
   * status POLL, not an actuator, so sending it opens or closes nothing. The name `OPEN_DOOR` is a misnomer,
   * kept as-is to avoid API churn on a constant that is not usable — do not use it for open, close, or
   * a status read (this encoder has no query-status support; `GET_SETTINGS`/6016 is the only supported
   * read path).
   */
  OPEN_DOOR: 6012,
  /** Read the current auto-lock/settings TLV — {@link buildFf09QueryFrame}. */
  GET_SETTINGS: 6016,
  /** Write the auto-lock/settings TLV — {@link buildFf09SettingsFrame}. */
  SET_SETTINGS: 6015,
} as const;

/**
 * `commandCode` values encoded into the `ff09` frame's `cmdEnc` field (`0x4000 | commandCode`).
 * `ON_OFF_LOCK` (35 = 0x23 → cmdEnc 0x4023) is lock/unlock — video lock AND garage door, both
 * directions. Distinct from {@link LOCK_API_COMMAND}: this is the inner frame opcode, that is the
 * outer envelope's `apiCommand`.
 */
export const LOCK_COMMAND_CODE = {
  /** Lock / unlock the deadbolt (inner frame opcode) — video lock + garage door, both directions. */
  ON_OFF_LOCK: 35,
  /** NOT used by this encoder — see {@link LOCK_API_COMMAND.OPEN_DOOR}; kept as an observed constant only. */
  OPEN_DOOR: 34,
  /** Settings GET inner opcode (53 = 0x35 → cmdEnc 0x4035) — see {@link buildFf09QueryFrame}. */
  GET_SETTINGS: 53,
  /** Settings SET inner opcode (52 = 0x34 → cmdEnc 0x4034) — see {@link buildFf09SettingsFrame}. */
  SET_SETTINGS: 52,
} as const;

/** The `TRANSFER_PAYLOAD` inner-command id both envelopes carry (P2P `SET_PAYLOAD.cmd` / MQTT `trans.cmd`). */
export const CMD_TRANSFER_PAYLOAD = 1940;

export interface Ff09FrameInput {
  /** Actuation direction — the `A3` byte: `true` = engage (byte 0, lock/close), `false` = release (byte 1, unlock/open). */
  engage: boolean;
  /** The lock owner's account id (`member.admin_user_id`, 40 hex chars) — drives the key + `A2`. */
  adminUserId: string;
  /** The acting user's display name (`MegaHttpClient.accountName`) — the `A4` field. Omitted when {@link omitUserFields}. */
  username?: string;
  /** The acting member's short id (`member.short_user_id`, hex, e.g. `"0003"`) — the `A5` field. Omitted when {@link omitUserFields}. */
  shortUserId?: string;
  /**
   * Skip the user-attribution TLV fields (A4 username, A5 shortUserId). The garage-door OPEN command
   * (`apiCommand 6012` / opcode 34) omits them — its plaintext is just `[A1 time, A2 adminUserId, A3 byte]`.
   * Lock/unlock + garage CLOSE keep them (default false).
   */
  omitUserFields?: boolean;
  /** The lock's serial number — the AES IV (zero-padded to 16). */
  deviceSn: string;
  /** Override the unix-seconds stamp (testing / byte-exact reproduction). Default = now. */
  unixTime?: number;
  /** Override the key-time nonce OR'd into `unixTime` (testing). Default = a random 0..99. */
  nonce?: number;
  /** Override the envelope `seq_num` (testing). Default = `unixTime`. */
  seqNum?: number;
}

export interface Ff09Frame {
  /** The `ff09…` frame, hex — goes verbatim into the envelope `lock_payload` (P2P) or `trans` (MQTT). */
  lockPayload: string;
  /** The cleartext `time` the envelope must carry so the device re-derives the key. */
  time: number;
  /** The envelope `seq_num`. */
  seqNum: number;
  /**
   * The `apiCommand` the envelope must carry for THIS frame (the `TRANSFER_PAYLOAD` `payload.apiCommand`
   * — see {@link LOCK_API_COMMAND}). Returned by the builder so neither transport has to know the
   * frame↔apiCommand pairing: the P2P/MQTT envelope just carries it through. Distinct from the inner
   * frame `commandCode` the builder also picks internally.
   */
  apiCommand: number;
}

/**
 * The `TRANSFER_PAYLOAD` (1940) `payload` object both transports carry for an ff09 frame. The index
 * signature keeps it assignable to the routers' generic `Record<string, unknown>` envelope-body param
 * (every field is already `number | string`).
 */
export interface Ff09TransferPayload {
  apiCommand: number;
  lock_payload: string;
  seq_num: number;
  time: number;
  [field: string]: number | string;
}

/**
 * Project a built {@link Ff09Frame} into the `TRANSFER_PAYLOAD` (1940) `payload` — the ONE place the
 * frame→envelope field mapping (`lockPayload`→`lock_payload`, `seqNum`→`seq_num`) lives, so neither the
 * P2P router (`set-payload` body) nor the MQTT router (`trans.payload`) re-spells it.
 */
export function ff09TransferPayload(frame: Ff09Frame): Ff09TransferPayload {
  return { apiCommand: frame.apiCommand, lock_payload: frame.lockPayload, seq_num: frame.seqNum, time: frame.time };
}

/**
 * Serialize TLV fields with an incrementing separator starting at 0xA1 (`sep | len | bytes`). The
 * length byte is a single octet — throws rather than silently wrapping (`f.length & 0xff`) on a field
 * over 255 bytes, since a wrapped length would emit a frame that just decodes wrong on the device with
 * no error surfacing anywhere (see {@link buildFf09Frame}'s doc on why this whole path fails loud).
 */
function writeTlv(fields: Buffer[]): Buffer {
  let sep = 0xa1;
  const out: Buffer[] = [];
  for (const f of fields) {
    if (f.length > 0xff) throw new Error(`ff09: TLV field too long for a 1-byte length (${f.length} > 255)`);
    out.push(Buffer.from([sep++, f.length]), f);
  }
  return Buffer.concat(out);
}

/** Zero-pad to a multiple of `blocksize` (eufy pads the pre-AES plaintext with 0x00, NOT PKCS7). */
function zeroPadToBlock(data: Buffer, blocksize = 16): Buffer {
  const size = data.byteLength < blocksize ? blocksize : Math.ceil(data.byteLength / blocksize) * blocksize;
  const out = Buffer.alloc(size);
  data.copy(out);
  return out;
}

/**
 * Build an `ff09` command frame. Deterministic given `unixTime`/`nonce`/`seqNum`, so a test can
 * reproduce a captured frame byte-for-byte; otherwise it stamps a fresh `time` per call.
 *
 * Throws on missing identity (empty `adminUserId`/`shortUserId`/`deviceSn`) — an all-empty field would
 * silently produce a frame the device rejects, and both transports send this fire-and-forget (no
 * error comes back), so we fail loud here instead.
 */
export function buildFf09Frame(input: Ff09FrameInput): Ff09Frame {
  const { engage, adminUserId, username, shortUserId, deviceSn, omitUserFields } = input;
  if (!deviceSn) throw new Error("ff09: deviceSn is required (AES IV)");
  // The IV is `deviceSn` zero-padded into a fixed 16-byte buffer via Buffer.copy(), which silently
  // truncates a longer source rather than erroring — every real serial observed is exactly 16 chars,
  // but a longer one would produce a frame with the wrong IV that the lock just rejects, with nothing
  // surfacing on this fire-and-forget path. Fail loud instead.
  if (deviceSn.length > 16) throw new Error(`ff09: deviceSn too long for the 16-byte IV (${deviceSn.length} > 16)`);
  if (!omitUserFields && (!username || !shortUserId))
    throw new Error("ff09: username + shortUserId are required unless omitUserFields is set");
  // shortUserId is parsed as hex (Buffer.from(str, "hex")) below — Node silently drops trailing
  // characters on an odd length and returns an EMPTY buffer on non-hex input, rather than throwing.
  // Every other required field here fails loud; this one would otherwise fail silent on this
  // fire-and-forget wire. Shape-check it explicitly instead.
  if (!omitUserFields && !/^([0-9a-fA-F]{2})+$/.test(shortUserId as string))
    throw new Error(`ff09: shortUserId must be an even-length hex string, got ${JSON.stringify(shortUserId)}`);

  const unixTime = (input.unixTime ?? Math.floor(Date.now() / 1000)) >>> 0;
  const nonce = input.nonce ?? Math.floor(Math.random() * 100);
  const keyTime = (unixTime | nonce) >>> 0;
  const seqNum = (input.seqNum ?? unixTime) >>> 0;

  // Inner TLV plaintext, then zero-pad to a 16-byte boundary (the app 0x00-pads the buffer pre-AES;
  // AES then adds a full PKCS#7 block on top).
  const tlvFields = [u32le(unixTime), Buffer.from(adminUserId, "ascii"), Buffer.from([engage ? 0 : 1])];
  if (!omitUserFields) {
    tlvFields.push(Buffer.from(username as string, "ascii"), Buffer.from(shortUserId as string, "hex"));
  }
  const plain = zeroPadToBlock(writeTlv(tlvFields));
  return assembleFf09Frame(
    LOCK_COMMAND_CODE.ON_OFF_LOCK,
    LOCK_API_COMMAND.ON_OFF_LOCK,
    plain,
    adminUserId,
    deviceSn,
    keyTime,
    seqNum,
  );
}

/**
 * Shared tail of every `ff09` frame builder — the part with nothing capability-specific in it: derive
 * the AES-128-CBC key/iv, encrypt the (already-built) TLV plaintext, and wrap it in the outer
 * `ff09|size|03 00 02|cmdEnc|ct|xorHash` frame. Extracted so {@link buildFf09Frame},
 * {@link buildFf09QueryFrame}, and {@link buildFf09SettingsFrame} can't drift on the framing/cipher
 * while each owns its own TLV shape + validation.
 */
function assembleFf09Frame(
  commandCode: number,
  apiCommand: number,
  plain: Buffer,
  adminUserId: string,
  deviceSn: string,
  keyTime: number,
  seqNum: number,
  header: { subVersion: number; functionType: number; encrypt: boolean } = {
    subVersion: 3,
    functionType: 2,
    encrypt: true,
  },
): Ff09Frame {
  // key = admin_user_id[-12:] ‖ uint32_BE(keyTime); iv = deviceSn zero-padded to 16. The app derives the key for
  // every frame but uses it only to seal: no admin id fails a sealed frame alone, a short one fails any frame.
  if (!adminUserId && header.encrypt) throw new Error("ff09: adminUserId (member.admin_user_id) is required");
  if (adminUserId && adminUserId.length < 12)
    throw new Error(`ff09: adminUserId too short (${adminUserId.length} < 12)`);
  const key = Buffer.concat([Buffer.from(adminUserId.slice(-12), "ascii"), u32be(keyTime)]);
  const iv = Buffer.alloc(16);
  Buffer.from(deviceSn, "ascii").copy(iv);
  const cipher = header.encrypt ? createCipheriv("aes-128-cbc", key, iv) : undefined;
  const ct = cipher ? Buffer.concat([cipher.update(plain), cipher.final()]) : plain;

  // Outer ff09 frame: header ‖ ct, then a trailing XOR-of-all-preceding checksum byte.
  const opcode = (header.encrypt ? 0x4000 : 0) | commandCode;
  const body = Buffer.concat([Buffer.from([header.subVersion, 0x00, header.functionType]), u16be(opcode), ct]);
  const size = 2 /*ff09*/ + 2 /*size*/ + body.length + 1; /*xor*/
  const preXor = Buffer.concat([Buffer.from([0xff, 0x09]), u16le(size), body]);
  let xor = 0;
  for (const b of preXor) xor ^= b;
  const frame = Buffer.concat([preXor, Buffer.from([xor])]);

  return { lockPayload: frame.toString("hex"), time: keyTime, seqNum, apiCommand };
}

/**
 * An `ff09` frame from tagged TLV fields a settings bundle builds, for a lock reached over MQTT: `A1` the
 * time and `A2` the user id first, then `fields`, sealed when `encrypt` (the descriptor's
 * `needEncrypt`) with the frame header's `subVersion` and `functionType`. `apiCommand` is the MQTT
 * channel's `TRANSFER_PAYLOAD`.
 */
export function buildFf09TlvFrame(input: {
  cmdCode: number;
  fields: readonly { tag: number; value: Buffer }[];
  /** The frame's `A2`. */
  userId: string;
  /** The key's owner: the record's `member.admin_user_id`, `""` without one. */
  adminUserId: string;
  deviceSn: string;
  encrypt: boolean;
  subVersion: number;
  functionType: number;
  unixTime?: number;
  nonce?: number;
}): Ff09Frame {
  const { unixTime, keyTime, seqNum } = resolveFf09Identity(input.deviceSn, input.unixTime, input.nonce);
  const fields = [
    { tag: 0xa1, value: u32le(unixTime) },
    { tag: 0xa2, value: Buffer.from(input.userId, "ascii") },
    ...input.fields,
  ];
  for (const f of fields)
    if (f.value.length > 0xff) throw new Error(`ff09: TLV field too long for a 1-byte length (${f.value.length})`);
  const tlv = Buffer.concat(fields.map((f) => Buffer.concat([Buffer.from([f.tag, f.value.length]), f.value])));
  return assembleFf09Frame(
    input.cmdCode,
    CMD_TRANSFER_PAYLOAD,
    input.encrypt ? zeroPadToBlock(tlv) : tlv,
    input.adminUserId,
    input.deviceSn,
    keyTime,
    seqNum,
    { subVersion: input.subVersion, functionType: input.functionType, encrypt: input.encrypt },
  );
}

/**
 * Shared identity validation + `time`/`nonce`/`seqNum` resolution for the settings GET/SET builders
 * below — the same checks {@link buildFf09Frame} does, minus the lock/unlock-specific username/
 * shortUserId fields (the settings frames don't carry them at all).
 */
function resolveFf09Identity(
  deviceSn: string,
  unixTimeIn?: number,
  nonceIn?: number,
  seqNumIn?: number,
): { unixTime: number; keyTime: number; seqNum: number } {
  if (!deviceSn) throw new Error("ff09: deviceSn is required (AES IV)");
  // See buildFf09Frame's doc for why this fails loud instead of silently truncating.
  if (deviceSn.length > 16) throw new Error(`ff09: deviceSn too long for the 16-byte IV (${deviceSn.length} > 16)`);

  const unixTime = (unixTimeIn ?? Math.floor(Date.now() / 1000)) >>> 0;
  const nonce = nonceIn ?? Math.floor(Math.random() * 100);
  const keyTime = (unixTime | nonce) >>> 0;
  const seqNum = (seqNumIn ?? unixTime) >>> 0;
  return { unixTime, keyTime, seqNum };
}

export interface Ff09QueryFrameInput {
  /** The lock owner's account id (`member.admin_user_id`, 40 hex chars) — drives the key + `A2`. */
  adminUserId: string;
  /** The lock's serial number — the AES IV (zero-padded to 16). */
  deviceSn: string;
  /** Override the unix-seconds stamp (testing / byte-exact reproduction). Default = now. */
  unixTime?: number;
  /** Override the key-time nonce OR'd into `unixTime` (testing). Default = a random 0..99. */
  nonce?: number;
  /** Override the envelope `seq_num` (testing). Default = `unixTime`. */
  seqNum?: number;
}

/**
 * Build the settings **GET** query frame (`LOCK_COMMAND_CODE.GET_SETTINGS`) — plaintext is just
 * `[A1 time][A2 adminUserId]`, no user-attribution fields (narrower than `omitUserFields` on
 * {@link buildFf09Frame}, which still keeps A3). See the module doc's "Settings GET/SET" section.
 */
export function buildFf09QueryFrame(input: Ff09QueryFrameInput): Ff09Frame {
  const { adminUserId, deviceSn } = input;
  const { unixTime, keyTime, seqNum } = resolveFf09Identity(deviceSn, input.unixTime, input.nonce, input.seqNum);
  const plain = zeroPadToBlock(writeTlv([u32le(unixTime), Buffer.from(adminUserId, "ascii")]));
  return assembleFf09Frame(
    LOCK_COMMAND_CODE.GET_SETTINGS,
    LOCK_API_COMMAND.GET_SETTINGS,
    plain,
    adminUserId,
    deviceSn,
    keyTime,
    seqNum,
  );
}

export interface Ff09SettingsFrameInput {
  /** The lock owner's account id (`member.admin_user_id`, 40 hex chars) — drives the key + `A2`. */
  adminUserId: string;
  /** The lock's serial number — the AES IV (zero-padded to 16). */
  deviceSn: string;
  /** `A4` — auto-lock enable (confirmed semantics). */
  autoLockEnabled: boolean;
  /** `A5` (u16 LE) — auto-lock delay in seconds (confirmed semantics). */
  autoLockDelaySeconds: number;
  /**
   * `A7` (u16 LE) — semantics UNCONFIRMED, but the value IS readable back from a GET response
   * (response field `a4`), so callers should pass through a just-read current value rather than a
   * guess. See the module doc's "Settings GET/SET" section.
   */
  a7: number;
  /** `A8` (u16 LE) — same caveat as {@link a7} (readable back as GET response field `a5`). */
  a8: number;
  /** Override the unix-seconds stamp (testing / byte-exact reproduction). Default = now. */
  unixTime?: number;
  /** Override the key-time nonce OR'd into `unixTime` (testing). Default = a random 0..99. */
  nonce?: number;
  /** Override the envelope `seq_num` (testing). Default = `unixTime`. */
  seqNum?: number;
}

/**
 * Build the settings **SET** frame (`LOCK_COMMAND_CODE.SET_SETTINGS`) — plaintext is `[A1 time]
 * [A2 adminUserId][A3 1B][A4 1B enable][A5 2B LE delay][A6 1B][A7 2B LE][A8 2B LE][A9 1B]`. `A3`/`A6`/
 * `A9` are sent as the literal `0x00` the app's frame carries (semantics unconfirmed —
 * see the module doc). `A7`/`A8` are NOT hardcoded here — the caller (the read-modify-write orchestration
 * in the client) is expected to pass through values just read from a GET response.
 */
export function buildFf09SettingsFrame(input: Ff09SettingsFrameInput): Ff09Frame {
  const { adminUserId, deviceSn, autoLockEnabled, autoLockDelaySeconds, a7, a8 } = input;
  const { unixTime, keyTime, seqNum } = resolveFf09Identity(deviceSn, input.unixTime, input.nonce, input.seqNum);
  const tlvFields = [
    u32le(unixTime),
    Buffer.from(adminUserId, "ascii"),
    Buffer.from([0x00]), // A3 — observed constant, semantics unconfirmed
    Buffer.from([autoLockEnabled ? 1 : 0]), // A4 — autolock enable (confirmed)
    u16le(autoLockDelaySeconds), // A5 — autolock delay seconds (confirmed)
    Buffer.from([0x00]), // A6 — observed constant, semantics unconfirmed
    u16le(a7), // A7 — passthrough, semantics unconfirmed
    u16le(a8), // A8 — passthrough, semantics unconfirmed
    Buffer.from([0x00]), // A9 — observed constant, semantics unconfirmed
  ];
  const plain = zeroPadToBlock(writeTlv(tlvFields));
  return assembleFf09Frame(
    LOCK_COMMAND_CODE.SET_SETTINGS,
    LOCK_API_COMMAND.SET_SETTINGS,
    plain,
    adminUserId,
    deviceSn,
    keyTime,
    seqNum,
  );
}

/**
 * Setting-id selectors for the COMPACT single-setting `SET_SETTINGS` write ({@link
 * buildFf09SettingToggleFrame}) — a SHORTER TLV than the full-blob write ({@link buildFf09SettingsFrame},
 * which always sends `A3=0x00` plus all of `A4`-`A9` together for auto-lock). On the T8531 a Rain Mode
 * toggle is just `[A1 time][A2 adminUserId][A3=0x07][A4 0/1]` — nothing past `A4`, and `A3` here is a
 * setting-id SELECTOR rather than an unconfirmed constant. The app's own JS maps the full selector enum
 * (≥14 settings); `RAIN_MODE` is the only one whose frame comes from the app's wire, the other 6 ids
 * below ship throwing "wire unverified" until theirs does. See the module doc's "Rain Mode" section.
 *
 * NOT consulted by {@link buildFf09SettingToggleFrame} or anything else on the production path — the
 * wire byte actually comes from the `Command`'s opaque `settingId` field, sourced from `model/`'s OWN
 * copy (`lock.ts`'s `LOCK_SETTING_ID.RAIN_MODE`, per the capability↔transport decorrelation rule this
 * module's doc already covers). This constant is layer-local wire vocab for THIS file's own callers/
 * spec only — it documents the value but carries no production reference, so it can't structurally
 * catch the two copies drifting apart; see `lock.ts`'s doc for that caveat.
 */
export const FF09_SETTING_ID = {
  /** One-touch lock toggle. Named by the app's own JS; its frame is not from the app's wire. */
  ONE_TOUCH_LOCK: 1,
  /** Scramble-passcode toggle. Named by the app's own JS; its frame is not from the app's wire. */
  SCRAMBLE_PASSCODE: 3,
  /** Wifi-status toggle. Named by the app's own JS; its frame is not from the app's wire. */
  WIFI_STATUS: 5,
  /** Event-log-enable toggle. Named by the app's own JS; its frame is not from the app's wire. */
  ENABLE_LOG: 6,
  /** Rain Mode toggle on the T8531 video lock. `A4` = 0 off / 1 on. */
  RAIN_MODE: 7,
  /** Privacy-mode toggle. Named by the app's own JS; its frame is not from the app's wire. */
  PRIVACY_MODE: 9,
  /** One-touch rear-lock toggle. Named by the app's own JS; its frame is not from the app's wire. */
  ONE_TOUCH_REAR_LOCK: 11,
} as const;

export interface Ff09SettingToggleFrameInput {
  /** The lock owner's account id (`member.admin_user_id`, 40 hex chars) — drives the key + `A2`. */
  adminUserId: string;
  /** The lock's serial number — the AES IV (zero-padded to 16). */
  deviceSn: string;
  /** Which setting this write targets — the `A3` field. See {@link FF09_SETTING_ID}. */
  settingId: number;
  /** The new value — the `A4` field (0/1). */
  value: boolean;
  /** Override the unix-seconds stamp (testing / byte-exact reproduction). Default = now. */
  unixTime?: number;
  /** Override the key-time nonce OR'd into `unixTime` (testing). Default = a random 0..99. */
  nonce?: number;
  /** Override the envelope `seq_num` (testing). Default = `unixTime`. */
  seqNum?: number;
}

/**
 * Build the settings **SET** frame using the COMPACT single-setting shape (`LOCK_COMMAND_CODE.SET_SETTINGS`,
 * same opcode as {@link buildFf09SettingsFrame}) — plaintext is just `[A1 time][A2 adminUserId]
 * [A3 1B settingId][A4 1B value]`, no `A5`-`A9` at all. Unlike the full-blob write, this is a pure blind
 * write — no GET-then-preserve is needed since it doesn't touch any field the device isn't being told to
 * change. See the module doc's "Rain Mode" section + {@link FF09_SETTING_ID}.
 */
export function buildFf09SettingToggleFrame(input: Ff09SettingToggleFrameInput): Ff09Frame {
  const { adminUserId, deviceSn, settingId, value } = input;
  const { unixTime, keyTime, seqNum } = resolveFf09Identity(deviceSn, input.unixTime, input.nonce, input.seqNum);
  const plain = zeroPadToBlock(
    writeTlv([
      u32le(unixTime),
      Buffer.from(adminUserId, "ascii"),
      Buffer.from([settingId & 0xff]),
      Buffer.from([value ? 1 : 0]),
    ]),
  );
  return assembleFf09Frame(
    LOCK_COMMAND_CODE.SET_SETTINGS,
    LOCK_API_COMMAND.SET_SETTINGS,
    plain,
    adminUserId,
    deviceSn,
    keyTime,
    seqNum,
  );
}

/**
 * Decrypt any `ff09` response frame (e.g. the GET-settings reply) back to its plaintext TLV bytes.
 * Same key/iv derivation as the encoder (`adminUserId.slice(-12) ‖ u32be(keyTime)` / `deviceSn` padded
 * 16), but normal PKCS#7 unpadding (`createDecipheriv` with auto-padding ON) — unlike the encoder,
 * which zero-pads its OWN plaintext before letting AES add a genuine PKCS#7 block on top, a device
 * response is a plain PKCS#7-padded ciphertext with no extra zero-padding layer.
 *
 * Validates the `ff09` magic and the trailing XOR checksum (the frame's own self-check). Of `cmdEnc` it reads only the
 * 0x4000 bit: without it the body is returned as sent.
 *
 * `keyTime` is the response envelope's `time` field parsed as the hex string it actually is (NOT
 * decimal, unlike the `seq_num`/other envelope fields) — see the module doc.
 */
export function decryptFf09Frame(input: {
  lockPayload: string;
  keyTime: number;
  adminUserId: string;
  deviceSn: string;
}): Buffer {
  const { lockPayload, keyTime, adminUserId, deviceSn } = input;
  if (!adminUserId) throw new Error("ff09: adminUserId (member.admin_user_id) is required");
  if (!deviceSn) throw new Error("ff09: deviceSn is required (AES IV)");
  if (adminUserId.length < 12) throw new Error(`ff09: adminUserId too short (${adminUserId.length} < 12)`);

  const buf = Buffer.from(lockPayload, "hex");
  if (buf.length < 10 || buf[0] !== 0xff || buf[1] !== 0x09) throw new Error("ff09: response frame missing ff09 magic");
  const size = buf.readUInt16LE(2);
  if (size !== buf.length)
    throw new Error(`ff09: response frame size mismatch (header says ${size}, got ${buf.length})`);
  let xor = 0;
  for (const b of buf.subarray(0, buf.length - 1)) xor ^= b;
  if (xor !== buf[buf.length - 1]) throw new Error("ff09: response frame failed its XOR checksum");

  // Header is 9 bytes (ff09|size2|03 00 02|cmdEnc2); the body is everything up to the trailing xor byte, and is
  // ciphertext only when cmdEnc carries 0x4000, as the app's `parseEslBleV12Data` decrypts it.
  const ct = buf.subarray(9, buf.length - 1);
  if (!(buf.readUInt16BE(7) & 0x4000)) return Buffer.from(ct);
  const key = Buffer.concat([Buffer.from(adminUserId.slice(-12), "ascii"), u32be(keyTime >>> 0)]);
  const iv = Buffer.alloc(16);
  Buffer.from(deviceSn, "ascii").copy(iv);
  const decipher = createDecipheriv("aes-128-cbc", key, iv);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

/** A decoded settings-response TLV: the leading status byte + the `a1..ad` fields, keyed by separator byte. */
export interface Ff09SettingsResponse {
  /** The leading status byte (byte 0 of the decrypted plaintext, before the TLV fields). */
  status: number;
  /** `sep` (e.g. `0xa2`) → field bytes. The response's own tag numbering — does NOT line up positionally
   * with the GET/SET request TLVs (see the module doc). */
  fields: Map<number, Buffer>;
}

/**
 * Parse a decrypted settings-response plaintext ({@link decryptFf09Frame}'s output) into its leading
 * status byte + `sep|len|bytes` TLV fields. Stops at a `0x00` separator (real tags start at `0xa1`;
 * a `0x00` sep only ever shows up as trailing zero-padding, never a real field) so it doesn't choke on
 * padding past the last real field.
 */
export function parseFf09SettingsResponse(plain: Buffer): Ff09SettingsResponse {
  if (plain.length < 1) throw new Error("ff09: settings response too short (missing status byte)");
  const status = plain[0]!;
  const fields = walkFf09Tlv(plain, 1, plain.length);
  return { status, fields };
}

/**
 * Walk a bounded `tag|len|value` TLV region into a `tag → bytes` map. Stops at a `0x00` tag (only ever
 * trailing zero-padding, never a real field — real tags start at `0xa1`) and refuses a field whose
 * declared length would overrun `end`, so a corrupt length can't read past the region (e.g. into a
 * trailing checksum). Shared by {@link parseFf09SettingsResponse} and the Solix param decoder.
 */
export function walkFf09Tlv(buf: Buffer, start: number, end: number): Map<number, Buffer> {
  const fields = new Map<number, Buffer>();
  let i = start;
  while (i + 2 <= end) {
    const tag = buf[i]!;
    if (tag === 0) break;
    const len = buf[i + 1]!;
    if (i + 2 + len > end) break;
    fields.set(tag, buf.subarray(i + 2, i + 2 + len));
    i += 2 + len;
  }
  return fields;
}

/** Read a little-endian u16 out of a TLV field buffer (throws on a missing/short field — a caller-side bug, not a wire ambiguity). */
export function readFf09U16LE(field: Buffer | undefined, name: string): number {
  if (!field || field.length < 2) throw new Error(`ff09: settings response missing/short field ${name}`);
  return field.readUInt16LE(0);
}

/** Read a single byte out of a TLV field buffer (throws on a missing field — same convention as {@link readFf09U16LE}). */
export function readFf09U8(field: Buffer | undefined, name: string): number {
  if (!field || field.length < 1) throw new Error(`ff09: settings response missing field ${name}`);
  return field[0]!;
}

/**
 * Read a 2-byte `[hour, minute]` time pair out of a TLV field buffer — the app encodes schedule times
 * as `hour.toString(16)‖minute.toString(16)` (two raw byte VALUES, not a packed LE u16 — see the
 * module doc's "Settings GET/SET" section). Throws on a missing/short field, same convention as
 * {@link readFf09U16LE}.
 */
export function readFf09HourMinute(field: Buffer | undefined, name: string): [number, number] {
  if (!field || field.length < 2) throw new Error(`ff09: settings response missing/short field ${name}`);
  return [field[0]!, field[1]!];
}

/**
 * Decode a parsed `GET_SETTINGS` response into the auto-lock snapshot both transports return from
 * `getAutoLockState` — the response tag map's `a1`=enabled, `a2`=delaySeconds, `a3`=isSchedule,
 * `a4`/`a5`=schedule start/end (`[hour,minute]`). Shared here (rather than copied into each router's
 * `getAutoLockState`) so the P2P and MQTT read paths can't drift on the field mapping.
 */
export function decodeFf09AutoLockSnapshot(parsed: Ff09SettingsResponse): AutoLockSnapshot {
  return {
    enabled: readFf09U8(parsed.fields.get(0xa1), "a1 (enabled)") !== 0,
    delaySeconds: readFf09U16LE(parsed.fields.get(0xa2), "a2 (delaySeconds)"),
    isSchedule: readFf09U8(parsed.fields.get(0xa3), "a3 (isSchedule)") !== 0,
    scheduleStartTime: readFf09HourMinute(parsed.fields.get(0xa4), "a4 (scheduleStartTime)"),
    scheduleEndTime: readFf09HourMinute(parsed.fields.get(0xa5), "a5 (scheduleEndTime)"),
  };
}

/**
 * Coerce a settings-response `time` field back to the numeric keyTime, for matching the reply against
 * the GET's own keyTime. Shared by both transports' autolock GET-reply matchers. A string is parsed
 * base-16 (the reply `time` is a hex string on the working, test-backed path — `ff09-mqtt-settings-
 * dispatch.spec` drives the full GET→decrypt→SET flow with a `time.toString(16)` reply); a JSON number
 * is taken as the value directly (unambiguous). A *decimal string* is deliberately NOT handled — it's
 * indistinguishable from hex and never observed on the wire, so parsing an all-digit decimal as hex
 * would silently mis-match. Returns the keyTime, or `undefined` if it doesn't parse to a finite number.
 */
export function ff09ReplyKeyTime(rawTime: string | number): number | undefined {
  const keyTime = typeof rawTime === "number" ? rawTime >>> 0 : parseInt(rawTime, 16);
  return Number.isFinite(keyTime) ? keyTime : undefined;
}

/**
 * The read-modify-write core of an auto-lock settings write, shared by both transports' autolock
 * dispatchers ({@link buildFf09QueryFrame} GET → this → send): decrypt the GET-settings reply, pull the
 * current delay + `A7`/`A8` passthrough values off it, and build the SET frame that changes only
 * enable/delay while preserving everything else. The transport owns getting the reply (its own GET wire
 * + reply match) and wrapping/sending the returned frame; the decrypt→read→rebuild sequence lives here
 * once so the two routers can't drift (e.g. the pending `a2`/`a4`/`a5`→`a1` enable-readback fix the
 * module doc flags is then a one-place change).
 */
export function buildFf09AutolockSetFrame(input: {
  lockPayload: string;
  keyTime: number;
  adminUserId: string;
  deviceSn: string;
  enabled: boolean;
  delaySeconds?: number;
}): Ff09Frame {
  const plain = decryptFf09Frame({
    lockPayload: input.lockPayload,
    keyTime: input.keyTime,
    adminUserId: input.adminUserId,
    deviceSn: input.deviceSn,
  });
  const parsed = parseFf09SettingsResponse(plain);
  const currentDelay = readFf09U16LE(parsed.fields.get(0xa2), "a2 (delay)");
  const currentA7 = readFf09U16LE(parsed.fields.get(0xa4), "a4 (A7 readback)");
  const currentA8 = readFf09U16LE(parsed.fields.get(0xa5), "a5 (A8 readback)");
  return buildFf09SettingsFrame({
    adminUserId: input.adminUserId,
    deviceSn: input.deviceSn,
    autoLockEnabled: input.enabled,
    autoLockDelaySeconds: input.delaySeconds ?? currentDelay,
    a7: currentA7,
    a8: currentA8,
  });
}
