/**
 * The call of the vendor app's native RTC client: the call body every in-call packet carries, the 86-byte
 * `sdp_info` of a PRIV1 (call type 5) or PrivMedia (6) call, the session uuid, and the CALL repeat schedule.
 *
 * Call body (body kind 7): 0 u32 channel, 4 u16 attach length N, 6 uuid[36], 42 contact_id[32], 74 u8 1 when N is
 * 0, 75 u8 reserved, 76 the attach, AES-128-ECB under the session key and the header ts when header byte 18 is 1.
 *
 * `sdp_info`: 0 u16 0, 2 data-channel flag, 3 crypto type 1, 4 channel flag 1, 5 the client byte 6, 6 ICE ufrag (4
 * chars of the base64 alphabet, NUL-padded to 8), 14 ICE pwd (22, padded to 24), 38 media key (16 `[0-9a-zA-Z]`,
 * padded to 20), 58 media iv (12, padded to 20), 78 and 82 u32 LE random audio and video values.
 */
import { createHash, randomInt } from "node:crypto";
import { readNullTerminatedString } from "../p2p/codec.js";
import { rawDpCodec } from "../raw-dp.js";

export const RtcCallType = { PRIV1: 5, PM: 6 } as const;
export const RTC_CALL_BODY_LENGTH = 76;
const ALNUM = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function randomChars(n: number, alphabet = ALNUM): string {
  return Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join("");
}

/** What the app sends in `sdp_info` and later uses itself: its ICE credentials, media key and iv, the two values. */
export interface RtcCallSdp {
  ufrag: string;
  pwd: string;
  key: string;
  iv: string;
  audio: number;
  video: number;
}

export function sdpInfo(flag: number): { info: Buffer } & RtcCallSdp {
  const s = {
    ufrag: randomChars(4, B64),
    pwd: randomChars(22, B64),
    key: randomChars(16),
    iv: randomChars(12),
    audio: randomInt(2 ** 32),
    video: randomInt(2 ** 32),
  };
  const info = Buffer.alloc(86);
  info.set([flag, 1, 1, 6], 2);
  info.write(s.ufrag, 6, "latin1");
  info.write(s.pwd, 14, "latin1");
  info.write(s.key, 38, "latin1");
  info.write(s.iv, 58, "latin1");
  info.writeUInt32LE(s.audio, 78);
  info.writeUInt32LE(s.video, 82);
  return { info, ...s };
}

/** `FF00` ‖ call type ‖ the first 31 hex chars of md5(sn, app id, did, lic, µs time, call type). */
export function callUuid(type: number, sn: string, appId: string, did: string, lic: string): string {
  const md5 = createHash("md5")
    .update(`${sn}${appId}${did}${lic}${Date.now() * 1000}${type}`)
    .digest("hex");
  return `FF00${type}${md5.slice(0, 31)}`;
}

/** A call body on channel 0 with byte 75 at 0. */
export function callBody(uuid: string, contact: string, attach: Buffer = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(RTC_CALL_BODY_LENGTH + attach.length);
  b.writeUInt16LE(attach.length, 4);
  b.write(uuid, 6, 36, "latin1");
  b.write(contact, 42, 32, "latin1");
  b[74] = attach.length ? 0 : 1;
  attach.copy(b, RTC_CALL_BODY_LENGTH);
  return b;
}

export function callUuidOf(body: Buffer): string {
  return readNullTerminatedString(body.subarray(6, 42), "latin1");
}

/** The first 76 bytes of a received call body with N forced to 0: the body of every ack and 200 echo. */
export function callBodyHead(body: Buffer): Buffer {
  const b = Buffer.from(body.subarray(0, RTC_CALL_BODY_LENGTH));
  b.writeUInt16LE(0, 4);
  return b;
}

/** `pbsdp` (base64 `PbMessageSdpUnit`): field 3, a `PbSdpInfo`, field 16 = transport caps. */
export function pbTransportCaps(pbsdp: string): number | undefined {
  const info = rawDpCodec.nested(Buffer.from(pbsdp, "base64"))?.find((f) => f.field === 3 && f.kind === "bytes");
  const caps = info && rawDpCodec.nested(info.value as Buffer)?.find((f) => f.field === 16 && f.kind === "int");
  return caps ? Number(caps.value) : undefined;
}

/**
 * When the saved CALL goes out again, in ms since the epoch, or `undefined` once the call is over 14 s old: 500 ms
 * after the last send while the call is at most 1 s old (whole seconds), 1000 ms after it from then on. `start` is the
 * call's unix second. The app keeps repeating on a non-Wi-Fi model whatever the station answers; ICE connecting ends it.
 */
export function nextCallRepeat(start: number, last: number): number | undefined {
  let at = last + 500;
  if (Math.floor(at / 1000) - start > 1) at = last + 1000;
  return Math.floor(at / 1000) - start > 14 ? undefined : at;
}
