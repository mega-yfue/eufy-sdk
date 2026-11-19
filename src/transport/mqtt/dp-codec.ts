/**
 * `eufy_life` secure-MQTT "DP" TLV frame codec — the wire framing shared by the T8L0x smart-light
 * family (other eufy_life appliances plausibly reuse the shape, unconfirmed). CONFIRMED live
 * (2026-07): magic bytes, header, XOR checksum, and the universal `a1`=timestamp / `a2`=account-id
 * opener are byte-for-byte verified against real captures + real device writes.
 *
 * This module owns the DP framing for both write frames on this family:
 *  - `0x0201` device-info (on/off + brightness) — generic tag/value fields the capability supplies.
 *  - `0x0206` custom colour — command-specific fields come from the MQTT colour-field serializer.
 *  - `0x020D` light-effect — the command-specific fields are built by `transport/dp-preset.ts`
 *    and passed in; this module only frames and wraps them.
 *
 * The capability layer names the feature ids (`0x0201`/`0x0206`/`0x020D`, the tag numbers, the
 * `mqttCmdCode`) and forwards them opaquely; this module names none of them.
 */
import { randomUUID } from "node:crypto";
import type { DpInboundFrame } from "../../core/contracts.js";
import { jsonObject } from "../../core/util.js";

const DP_MAGIC = [0xff, 0x09] as const;

/** Bytes before the TLV run: magic (2) + u16LE size (2) + `03 00 02` (3) + u16BE cmdCode (2). */
const DP_HEADER_LEN = 9;

/** One TLV field in a DP frame (tag `0xa1`-`0xff`, arbitrary-length value). */
export interface DpField {
  tag: number;
  value: Buffer;
}

/** XOR of every byte — the frame's trailing checksum. */
function xorChecksum(buf: Buffer): number {
  let x = 0;
  for (const b of buf) x ^= b;
  return x;
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag, value.length]), value]);
}

/**
 * Build one `eufy_life` DP TLV frame: `[ff 09][total len][03 00 02][u16BE cmdCode][tag/len/value…][xor]`,
 * the opcode the app writes from the descriptor's `cmdCode`. Every frame opens with `a1`=timestamp (u32LE) + `a2`=account
 * id (ASCII), prepended here so callers supply only the command-specific fields (`0xa3` onward).
 *
 * The total-size field at offset 2 is a **u16LE**, not a single byte: `0x020D` effect frames routinely
 * exceed 255 bytes, and a truncated high byte yields a frame the light rejects outright.
 */
export function buildDpFrame(cmdCode: number, accountId: string, fields: readonly DpField[]): Buffer {
  const timestamp = Buffer.alloc(4);
  timestamp.writeUInt32LE(Math.floor(Date.now() / 1000), 0);
  const all: DpField[] = [
    { tag: 0xa1, value: timestamp },
    { tag: 0xa2, value: Buffer.from(accountId, "utf8") },
    ...fields,
  ];
  const tlvBytes = Buffer.concat(all.map((f) => tlv(f.tag, f.value)));
  const totalLen = DP_HEADER_LEN + tlvBytes.length + 1;
  const size = Buffer.alloc(2);
  size.writeUInt16LE(totalLen, 0);
  const header = Buffer.concat([
    Buffer.from([...DP_MAGIC]),
    size,
    Buffer.from([0x03, 0x00, 0x02, (cmdCode >> 8) & 0xff, cmdCode & 0xff]),
  ]);
  const body = Buffer.concat([header, tlvBytes]);
  return Buffer.concat([body, Buffer.from([xorChecksum(body)])]);
}

/**
 * Wrap a DP frame in the `eufy_life` MQTT `/req` envelope the SDK publishes:
 * `{head:{…,cmd:mqttCmdCode}, payload: JSON({account_id, device_sn, data:<b64 frame>, trans:""})}`.
 * The stringified result is the MQTT message body. `client_id` follows the app's
 * `ios-eufy_mega-{userId}-{uuid}` shape; its exact value is CONFIRMED not to affect a write.
 */
export function buildDpEnvelope(opts: {
  accountId: string;
  deviceSn: string;
  mqttCmdCode: number;
  frame: Buffer;
}): string {
  const inner = {
    account_id: opts.accountId,
    device_sn: opts.deviceSn,
    data: opts.frame.toString("base64"),
    trans: "",
  };
  const head = {
    version: "1.0.0.1",
    client_id: `ios-eufy_mega-${opts.accountId}-${randomUUID()}`,
    sess_id: "0000",
    msg_seq: 1,
    seed: "",
    timestamp: Math.floor(Date.now() / 1000),
    cmd_status: 1,
    cmd: opts.mqttCmdCode,
    sign_code: 0,
  };
  return JSON.stringify({ head, payload: JSON.stringify(inner) });
}

/**
 * Response frame commands carry a status byte between the header and the TLV run.
 *
 * The high byte of the frame command distinguishes the two inbound shapes: `0x0A__` frames answer a
 * request (`0x0A00` answers `0x0200`, `0x0A01` answers `0x0201`) and are prefixed with a status byte;
 * `0x02__` frames are unsolicited reports and start their TLVs immediately. CONFIRMED live (2026-07-28).
 */
const RESPONSE_CMD_HI = 0x0a;

/**
 * Decode an inbound `eufy_life` MQTT message into its DP frame, or `undefined` on any shape mismatch —
 * another appliance's traffic on the same connection must fall through, never throw.
 *
 * The inbound wrapping is **asymmetric with {@link buildDpEnvelope}** and double-nested: `payload` is a
 * JSON string `{data, sn, pn}` whose `data` is base64 of *another* JSON string, whose own `data` is the
 * frame as **hex** (outbound carries base64 at that inner position). The frame is then validated —
 * magic, the u16LE self-declared length — before any field is read, and the TLV walk is bounded by the
 * trailing checksum byte so a truncated or lying length yields nothing rather than a misread.
 *
 * Tag MEANING is not decided here: the fields come back in wire order for the capability to interpret.
 */
export function parseDpMessage(raw: unknown): DpInboundFrame | undefined {
  const envelope = raw as { head?: { cmd?: unknown }; payload?: unknown } | undefined;
  const envelopeCmd = envelope?.head?.cmd;
  if (typeof envelopeCmd !== "number") return undefined;

  const outer = jsonObject(envelope?.payload);
  if (typeof outer?.data !== "string") return undefined;
  const hex = jsonObject(Buffer.from(outer.data, "base64").toString("utf8"))?.data;
  if (typeof hex !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(hex)) return undefined;

  const buf = Buffer.from(hex, "hex");
  if (buf.length < DP_HEADER_LEN + 1 || !buf.subarray(0, 2).equals(Buffer.from([...DP_MAGIC]))) return undefined;
  if (buf.readUInt16LE(2) !== buf.length) return undefined;

  const cmd = buf.readUInt16BE(7);
  const hasStatus = cmd >> 8 === RESPONSE_CMD_HI;
  const start = DP_HEADER_LEN + (hasStatus ? 1 : 0);
  if (start > buf.length - 1) return undefined;

  const fields: Array<{ tag: number; value: Buffer }> = [];
  for (let i = start; i + 1 < buf.length - 1;) {
    const len = buf[i + 1];
    if (i + 2 + len > buf.length - 1) break;
    fields.push({ tag: buf[i], value: buf.subarray(i + 2, i + 2 + len) });
    i += 2 + len;
  }
  return { envelopeCmd, cmd, status: hasStatus ? buf[DP_HEADER_LEN] : undefined, fields };
}

/**
 * Keys the AIoT report envelope carries alongside the data-point map. `data` is normally its own
 * object, but a flattened report puts the points at the top level next to these, so they are skipped
 * by name rather than assumed absent.
 */
const AIOT_META_KEYS = new Set(["protocol", "t", "account_id", "device_sn"]);

/**
 * Parse an AIoT realtime report into its data-point map — the Clean/appliance line's device→app leg,
 * and the counterpart to {@link parseDpMessage}'s TLV frames. The two lines share a broker and a
 * `{head, payload}` envelope but nothing below it: this payload is plain JSON, not a binary frame.
 *
 * `payload` is `{t, protocol, account_id, device_sn, data}` — sometimes as a JSON string, sometimes
 * already an object, so both are accepted. The points live under `data`; a report that flattens them
 * to the top level is read that way instead, with the envelope's own keys skipped.
 *
 * Point ids come back as numbers and every value as a string, matching the cloud record's param shape
 * so a report merges into device state on the same path a polled record does. Values are NOT
 * interpreted: a scalar arrives as its own text and a structured point as the base64 its device sent,
 * for the capability that owns the id to decode.
 *
 * Defensive throughout — this runs against every message on a shared connection, so an unrelated one
 * yields `undefined` rather than throwing.
 */
export function parseAiotDpReport(raw: unknown): Record<number, string> | undefined {
  const envelope = raw as { payload?: unknown } | undefined;
  const payload =
    jsonObject(envelope?.payload) ??
    (envelope?.payload && typeof envelope.payload === "object" && !Array.isArray(envelope.payload)
      ? (envelope.payload as Record<string, unknown>)
      : undefined);
  if (!payload) return undefined;

  const data = payload.data;
  const points = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : payload;

  const out: Record<number, string> = {};
  for (const [key, value] of Object.entries(points)) {
    if (AIOT_META_KEYS.has(key)) continue;
    const id = Number(key);
    if (!Number.isInteger(id) || key.trim() === "") continue;
    if (value === null || value === undefined || typeof value === "object") continue;
    out[id] = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  }
  return Object.keys(out).length ? out : undefined;
}
