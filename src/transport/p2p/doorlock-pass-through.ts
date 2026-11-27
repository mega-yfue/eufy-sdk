/**
 * The sealed blob a station relays to the Bluetooth lock paired to it, carried as `payload.payload` of a
 * `CMD_DOORLOCK_DATA_PASS_THROUGH` set-payload.
 *
 * The blob is base64 of AES-128-CBC (PKCS#7 over a zero-padded plaintext) under a key derived from the
 * station owner's 40-character admin id and the 16-character station serial, with the station serial as the
 * IV. The plaintext is JSON `{channel, lock_cmd, lock_payload, seq_num}` with `channel` always 0: the lock's
 * channel on its station rides only the P2P envelope (`mChannel` and the frame header). For lock/unlock
 * `lock_cmd` is 8 and `lock_payload` is base64 of the on/off TLV {@link encodeLockOnOff}.
 */
import { createCipheriv } from "node:crypto";
import { paddingP2PData } from "./codec.js";
import { serialIv } from "./keyed-payload.js";

/** `lock_cmd` for lock/unlock. */
const LOCK_CMD_ON_OFF = 8;

/** The on/off TLV's tags, in frame order: short user id, direction, timestamp, nickname. */
const TAG = { USER: 0xa1, DIRECTION: 0xa2, TIME: 0xa3, NAME: 0xa4 } as const;

/** The seed the lock key is derived from. */
const KEY_SEED = [104, -83, -72, 38, -107, 99, -110, 17, -95, -121, 54, 57, -46, -98, -111, 89] as const;

/**
 * The lock/unlock TLV: the short user id (uint16 BE), the direction (1 = lock, 0 = unlock), the time in seconds
 * (uint32 LE) and the UTF-8 nickname. The nickname is cut at 255 bytes because its length field is one byte, and
 * a longer name would mislabel every byte after it.
 */
export function encodeLockOnOff(
  shortUserId: number,
  nickname: string,
  engage: boolean,
  nowSec = Date.now() / 1000,
): Buffer {
  const user = Buffer.alloc(2);
  user.writeUInt16BE(shortUserId & 0xffff, 0);
  const time = Buffer.alloc(4);
  time.writeUInt32LE(Math.trunc(nowSec) >>> 0, 0);
  const name = Buffer.from(nickname, "utf-8").subarray(0, 0xff);
  return Buffer.concat([
    Buffer.from([TAG.USER, 2]),
    user,
    Buffer.from([TAG.DIRECTION, 1, engage ? 1 : 0, TAG.TIME, 4]),
    time,
    Buffer.from([TAG.NAME, name.length]),
    name,
  ]);
}

/**
 * The AES-128 lock key from the station owner's admin id (40 characters) and the station serial (16). Any other
 * length throws: a shorter input indexes past its end and still yields a key, just one the lock silently ignores.
 */
export function lockKey(adminUserId: string, stationSn: string): Buffer {
  const owner = Buffer.from(adminUserId, "utf-8");
  const station = Buffer.from(stationSn, "utf-8");
  if (owner.length !== 40 || station.length !== 16) {
    throw new Error(
      `door-lock pass-through: expected a 40-character admin id and 16-character station serial, got ${owner.length} and ${station.length}`,
    );
  }
  const out = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    out[i] = (KEY_SEED[i]! + station[(station[i]! * 3 + 5) % 16]! + owner[(owner[i]! * 3 + 5) % 40]!) & 0xff;
  }
  return out;
}

export interface DoorlockPassThroughInput {
  engage: boolean;
  /** The station owner's admin user id. */
  adminUserId: string;
  /** The station owner's short user id. */
  shortUserId: number;
  /** The station owner's nickname. */
  nickname: string;
  /** The serial of the station the lock is paired to. */
  stationSn: string;
  /** The blob's sequence number. */
  seqNum: number;
  /** The TLV's timestamp in seconds; the current time when omitted. */
  nowSec?: number;
}

/** The base64 blob for `payload.payload` of a lock/unlock pass-through. */
export function buildDoorlockPassThrough(input: DoorlockPassThroughInput): string {
  const inner = Buffer.from(
    JSON.stringify({
      channel: 0,
      lock_cmd: LOCK_CMD_ON_OFF,
      lock_payload: encodeLockOnOff(input.shortUserId, input.nickname, input.engage, input.nowSec).toString("base64"),
      seq_num: input.seqNum,
    }),
    "utf-8",
  );
  const cipher = createCipheriv("aes-128-cbc", lockKey(input.adminUserId, input.stationSn), serialIv(input.stationSn));
  return Buffer.concat([cipher.update(paddingP2PData(inner)), cipher.final()]).toString("base64");
}
