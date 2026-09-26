/**
 * The command framing a HomeBase S1 Pro (T9000) speaks over its WebRTC data channel — the wire the
 * security.eufy.com web client builds, reproduced byte-exact.
 *
 * A packet is a 16-byte header behind the ASCII magic `XZYH`, then a body. The body is the JSON the
 * classic P2P path would have sealed into a 1350 SET_PAYLOAD envelope, sent in the clear (the DTLS
 * channel is the encryption), except for a short list of two-integer commands the portal encodes as a
 * fixed 136-byte struct instead. Replies come back with `isResponse = 1`, the same `segment` the request
 * carried, and a body whose first four bytes are a little-endian result code.
 *
 * Evidence: the portal bundle's header builder/parser (`Gr()` / `Qr()`) and `worker_sctp_send`, and
 * genomez/eufy-security-client's port of them (MIT), which round-trips guard mode on US and FR T9000s.
 * No field here is inferred from a name — every offset is what those two agree on.
 */

const MAGIC = Buffer.from("XZYH", "ascii");
export const PORTAL_HEADER_LENGTH = 16;

/** Portal link types — which logical channel a frame belongs to (`worker_sctp_send`). */
export const PortalLinkType = {
  /** Command channel: requests out, acknowledgements back. */
  COMMAND: 1,
  FILE: 2,
  /** Station-originated frames: pushes, notify payloads, camera info. */
  NOTIFY: 3,
  PLAYBACK: 4,
  LIVE: 5,
  INNER: 99,
} as const;

export interface PortalHeader {
  commandId: number;
  paramLength: number;
  segment: number;
  channel: number;
  isResponse: number;
  devType: number;
}

export interface PortalRequest {
  commandId: number;
  channel: number;
  /** 1..255, wraps; echoed by the reply so it can be matched. */
  segment: number;
  payload: Record<string, unknown>;
  isResponse?: number;
  devType?: number;
}

export interface PortalResponse {
  commandId: number;
  segment: number;
  isResponse: number;
  linkType: number;
  /** Command-channel replies only: the int32 result code (0 = ok). */
  errCode?: number;
  /** Notify frames: the nested `cmd` the JSON body carries. */
  cmd?: number;
  data?: unknown;
}

/** Little-endian fixed-width unsigned integer, as the portal's `Ur()` writes it. */
function encodeLe(value: number, width: number): Buffer {
  const buf = Buffer.alloc(width);
  let v = value >>> 0;
  for (let i = 0; i < width; i++) {
    buf[i] = v & 0xff;
    v >>>= 8;
  }
  return buf;
}

/** The 16-byte header (portal `Gr()`). */
export function buildPortalHeader(
  commandId: number,
  paramLength: number,
  channel: number,
  segment: number,
  isResponse = 0,
  devType = 2,
): Buffer {
  const header = Buffer.alloc(PORTAL_HEADER_LENGTH);
  MAGIC.copy(header, 0);
  encodeLe(commandId, 2).copy(header, 4);
  encodeLe(paramLength, 4).copy(header, 6);
  header[10] = 0;
  header[11] = segment & 0xff;
  header[12] = channel & 0xff;
  header[13] = 0;
  header[14] = isResponse & 0xff;
  header[15] = devType & 0xff;
  return header;
}

/** Parse the header (portal `Qr()`); `undefined` when the magic is missing or the buffer is short. */
export function parsePortalHeader(buf: Buffer): PortalHeader | undefined {
  if (buf.length < PORTAL_HEADER_LENGTH || buf.subarray(0, 4).compare(MAGIC) !== 0) return undefined;
  return {
    commandId: buf.readUInt16LE(4),
    paramLength: buf.readUInt32LE(6),
    segment: buf[11]!,
    channel: buf[12]!,
    isResponse: buf[14]!,
    devType: buf[15]!,
  };
}

/** Whether a buffer starts a portal packet. */
export function isPortalPacket(buf: Buffer): boolean {
  return buf.length >= PORTAL_HEADER_LENGTH && buf.subarray(0, 4).compare(MAGIC) === 0;
}

/**
 * Commands whose body the portal encodes as `[u32 value][u32 value1][account, 128 bytes]` rather than
 * JSON — the same 136-byte shape the classic P2P "direct binary" body has. The list is the portal's own.
 */
export const TWO_INT_BODY_COMMANDS: ReadonlySet<number> = new Set([
  1103, 1252, 1214, 1207, 1230, 1056, 1200, 1240, 1241, 1400, 1401, 9257, 1403, 1015, 1035,
]);

function encodeTwoIntBody(payload: Record<string, unknown>): Buffer {
  const body = Buffer.alloc(136);
  body.writeUInt32LE(Number(payload.value ?? 0) >>> 0, 0);
  body.writeUInt32LE(Number(payload.value1 ?? 0) >>> 0, 4);
  const account = String(payload.account_id ?? payload.account ?? "");
  body.write(account, 8, Math.min(128, Buffer.byteLength(account, "utf8")), "utf8");
  return body;
}

function encodeBody(commandId: number, payload: Record<string, unknown>): Buffer {
  if (TWO_INT_BODY_COMMANDS.has(commandId)) return encodeTwoIntBody(payload);
  return Buffer.from(JSON.stringify(payload), "utf8");
}

/** A complete request packet: header + body. */
export function buildPortalPacket(req: PortalRequest): Buffer {
  const body = encodeBody(req.commandId, req.payload);
  const header = buildPortalHeader(
    req.commandId,
    body.length,
    req.channel,
    req.segment,
    req.isResponse ?? 0,
    req.devType ?? 2,
  );
  return Buffer.concat([header, body]);
}

function parseJsonBody(buf: Buffer): unknown {
  let text = buf.toString("utf8");
  while (text.endsWith("\0")) text = text.slice(0, -1);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Parse an inbound packet. On the command channel the body opens with the int32 result code and may
 * carry JSON after it; on the notify channel the whole body is JSON with a nested `cmd`.
 */
export function parsePortalPacket(buf: Buffer, linkType: number = PortalLinkType.COMMAND): PortalResponse | undefined {
  const header = parsePortalHeader(buf);
  if (!header) return undefined;
  const body = buf.subarray(PORTAL_HEADER_LENGTH, PORTAL_HEADER_LENGTH + header.paramLength);
  if (linkType === PortalLinkType.NOTIFY) {
    const data = parseJsonBody(body);
    const cmd =
      typeof data === "object" && data !== null && "cmd" in data ? Number((data as { cmd?: unknown }).cmd) : undefined;
    return { commandId: header.commandId, segment: header.segment, isResponse: header.isResponse, linkType, cmd, data };
  }
  return {
    commandId: header.commandId,
    segment: header.segment,
    isResponse: header.isResponse,
    linkType,
    errCode: body.length >= 4 ? body.readInt32LE(0) : -1,
    data: body.length > 4 ? parseJsonBody(body.subarray(4)) : undefined,
  };
}

/** A 1..255 segment counter that never yields 0 (the portal reserves it). */
export class SegmentCounter {
  private current = 0;

  next(): number {
    this.current = (this.current + 1) & 0xff;
    if (this.current === 0) this.current = 1;
    return this.current;
  }
}
