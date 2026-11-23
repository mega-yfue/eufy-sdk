import { createCipheriv, randomBytes } from "node:crypto";
import type { Ff09Identity } from "../../core/contracts.js";
import { eciesWrap } from "./codec.js";
import { CommandType } from "./commands.js";

/**
 * Keyed-payload envelope — the `SET_PAYLOAD` (1350) shape the classic Wi-Fi smart lock takes for its
 * actuation. There is no session key: every command carries its OWN fresh AES-128 key, sealed for the
 * device's long-lived P-256 public key (published by the cloud, one per device), and the inner JSON is
 * AES-128-CBC/PKCS#7 under that key. This module builds the two sealed fields; `P2PSession.sendSetPayload`
 * wraps them in the ordinary envelope and carries a keyed one in the clear, as the vendor app sends it.
 *
 * ## Wire
 *
 * ```
 *   { key: <keyBlobHex>, account_id: <adminUserId>, cmd: <opcode>, mChannel: <ch>, mValue3: 0,
 *     payload: <base64(AES-128-CBC(aesKey, iv, innerJson))> }
 * ```
 * `iv` = ASCII(deviceSn) zero-padded/truncated to 16 bytes. `aesKey` = 16 random bytes, spelled as 32
 * UPPERCASE hex characters — the hex SPELLING is what the key blob seals, not the raw bytes.
 *
 * `key` (hex) is the ECIES envelope {@link eciesWrap} produces for the device's public key over that
 * spelling: `compressedEphemeralPub(33) ‖ nonce(16) ‖ sealedKey(48) ‖ hmac(32)`.
 *
 * Inner JSON for the actuation opcode, `P2P_ON_OFF_LOCK` (1961): `{shortUserId, slOperation: 1|0, userId,
 * userName, seq_num}`.
 *
 * ## Answer
 *
 * The device answers every command at once with an int32 result on the `SET_PAYLOAD` echo — `0`
 * accepted, -151 when `seq_num` is not above the mark it holds — and, when the command changed its state,
 * about two seconds later with a `NOTIFY_PAYLOAD` whose JSON carries `P2P_QUERY_STATUS_IN_LOCK` (1955) as
 * `cmd`, the result again under `payload.code` and the state reached under `payload.slState`
 * ({@link keyedPayloadReportCode} reads the code of the report stating the state a command drives to). A
 * command it was already in the state of draws the echo alone. A `CMD_DOORLOCK_P2P_SEQ` (1916) notify states
 * the mark it holds ({@link keyedPayloadSeqMark}).
 *
 * The command ids are {@link CommandType}'s; the inner field names follow a third-party reverse-engineering
 * project, a name source only.
 */

/** Knobs a spec injects to make the otherwise random envelope deterministic, plus the sequence it carries. */
export interface KeyedPayloadRandomness {
  /** The per-command AES key (16 bytes). */
  aesKey?: Buffer;
  /** The CBC nonce sealing that key inside the blob (16 bytes). */
  nonce?: Buffer;
  /** The ephemeral P-256 private key for the ECDH exchange (32 bytes). */
  ephemeralPrivateKey?: Buffer;
  /** The `seq_num` the inner JSON carries, issued by the sender. */
  seqNum: number;
}

/**
 * The cipher IV the device derives from its own serial: ASCII bytes, zero-padded to 16. It is the same for
 * every command to a device, which is sound only because {@link buildKeyedActuatePayload} seals each command
 * under a key minted for it alone — no two messages ever share a key with this IV.
 */
export function serialIv(deviceSn: string): Buffer {
  const iv = Buffer.alloc(16);
  Buffer.from(deviceSn, "utf8").copy(iv, 0, 0, 16);
  return iv;
}

/** Spell 16 key bytes as the 32 uppercase hex characters the wire seals. */
export function spellAesKey(key: Buffer): string {
  return key.toString("hex").toUpperCase();
}

/**
 * Seal a per-command AES key for the device's P-256 public key: the {@link eciesWrap} envelope over the
 * key's hex spelling, as hex.
 * @param aesKeyHex the 32-hex-char key spelling (what gets sealed — as ASCII).
 * @param devicePublicKeyHex the device's uncompressed public key WITHOUT the `04` prefix (64 bytes hex).
 */
export function buildKeyBlob(
  aesKeyHex: string,
  devicePublicKeyHex: string,
  rnd: Pick<KeyedPayloadRandomness, "nonce" | "ephemeralPrivateKey"> = {},
): string {
  const devicePublicKey = Buffer.concat([Buffer.from([0x04]), Buffer.from(devicePublicKeyHex, "hex")]);
  return eciesWrap(Buffer.from(aesKeyHex, "utf8"), devicePublicKey, {
    ephemeralPrivateKey: rnd.ephemeralPrivateKey,
    iv: rnd.nonce,
  }).toString("hex");
}

/** AES-128-CBC/PKCS#7 the inner JSON under the per-command key, IV from the serial; base64 out. */
export function sealInnerPayload(innerJson: string, aesKeyHex: string, deviceSn: string): string {
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(aesKeyHex, "hex"), serialIv(deviceSn));
  return Buffer.concat([cipher.update(Buffer.from(innerJson, "utf8")), cipher.final()]).toString("base64");
}

/** The two sealed fields of a keyed envelope; the sender supplies the rest of the `SET_PAYLOAD` value. */
export interface KeyedActuatePayload {
  /** The sealed per-command key — the value's `key` field, hex. */
  key: string;
  /** The inner JSON sealed under that key — the value's `payload` field, base64. */
  payload: string;
}

/**
 * Build the sealed fields of the classic Wi-Fi lock's actuation.
 * @param id the acting identity + direction.
 * @param devicePublicKeyHex the device's public key from the cloud (no `04` prefix).
 * @param userName the acting member's display name as the device shows it in its log.
 */
export function buildKeyedActuatePayload(
  id: Omit<Ff09Identity, "adminUserId"> & { adminUserId?: string },
  devicePublicKeyHex: string,
  userName: string,
  rnd: KeyedPayloadRandomness,
): KeyedActuatePayload {
  const aesKeyHex = spellAesKey(rnd.aesKey ?? randomBytes(16));
  const inner = JSON.stringify({
    shortUserId: id.shortUserId,
    slOperation: id.engage ? 1 : 0,
    userId: id.adminUserId,
    userName,
    seq_num: rnd.seqNum,
  });
  return {
    key: buildKeyBlob(aesKeyHex, devicePublicKeyHex, rnd),
    payload: sealInnerPayload(inner, aesKeyHex, id.deviceSn),
  };
}

/**
 * The result a `NOTIFY_PAYLOAD` document reports for a keyed command driving to a state. The device sends
 * one once a keyed command has changed its state, `{cmd, payload: {code, slState, …}}` with `cmd`
 * `P2P_QUERY_STATUS_IN_LOCK` (1955) in {@link CommandType}, `payload.code` being the command's result and
 * `payload.slState` the state reached. Answers `payload.code` when it is a number and `payload.slState` is
 * the state the command drives to: `"4"` engaged (locked) when `engage`, `"3"` released (unlocked) when
 * not, the values of the lock's state param 6000 as the device spells them. Answers `undefined` for any
 * other document, a report of the other state included: that one answers some other command.
 */
export function keyedPayloadReportCode(
  json: { cmd?: number; payload?: unknown } | undefined,
  engage: boolean,
): number | undefined {
  if (json?.cmd !== CommandType.P2P_QUERY_STATUS_IN_LOCK) return undefined;
  const payload = json.payload as { code?: unknown; slState?: unknown } | null | undefined;
  const slState = engage ? "4" : "3";
  if (payload?.slState !== slState) return undefined;
  return typeof payload?.code === "number" ? payload.code : undefined;
}

/**
 * The sequence mark a `NOTIFY_PAYLOAD` document publishes, `{cmd, payload: {lock_cmd, seq_num}}` with `cmd` `CMD_DOORLOCK_P2P_SEQ` (1916) in {@link CommandType},
 * `payload.seq_num` being the mark the device holds on this connection. Answers that number, or
 * `undefined` for any other document.
 */
export function keyedPayloadSeqMark(json: { cmd?: number; payload?: unknown } | undefined): number | undefined {
  if (json?.cmd !== CommandType.CMD_DOORLOCK_P2P_SEQ) return undefined;
  const seq = (json.payload as { seq_num?: unknown } | null | undefined)?.seq_num;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : undefined;
}
