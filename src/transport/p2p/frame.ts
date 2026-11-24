/**
 * The model-facing reading of one inbound station frame, shared by every transport that carries `XZYH` frames (P2P,
 * and the RTC data channel's notifies): its JSON document and the params it volunteers.
 */
import type { P2PDataFrameHeader } from "./codec.js";
import { readNullTerminatedString } from "./codec.js";
import { commandName } from "./commands.js";
import { STATION_CHANNEL, type P2PFrame } from "./p2p-session.js";

/** CMD_NOTIFY_PAYLOAD (1351) — the station's unsolicited JSON notification. */
const CMD_NOTIFY_PAYLOAD = 1351;
/**
 * CMD_CAMERA_INFO — params as a root-level array. On a camera's channel it is that camera's OWN report; on
 * {@link STATION_CHANNEL} a HomeBase answers with its whole table, every entry's `dev_type` naming the
 * channel it belongs to.
 */
const CMD_CAMERA_INFO = 1103;

/** Read a frame: `data` opened, `raw` as received. A NUL-terminated JSON document is parsed and its params lifted. */
export function decodeFrame(
  stationSn: string,
  header: P2PDataFrameHeader,
  data: Buffer,
  raw: Buffer,
  dataType: number,
): P2PFrame {
  const frame: P2PFrame = { ...header, stationSn, commandName: commandName(header.commandId), dataType, data, raw };
  const text = readNullTerminatedString(data);
  if (!text.startsWith("{")) return frame;
  try {
    frame.json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  const stationTable = header.commandId === CMD_CAMERA_INFO && header.channel === STATION_CHANNEL;
  const byChannel = stationTable ? channelReport(frame.json) : undefined;
  const reported =
    header.commandId === CMD_NOTIFY_PAYLOAD
      ? paramReport(frame.json?.payload)
      : header.commandId === CMD_CAMERA_INFO && !stationTable
        ? paramReport(frame.json)
        : undefined;
  if (byChannel) frame.channelParams = byChannel;
  if (reported) frame.params = reported;
  return frame;
}

/**
 * Lift a notify payload's `params` array into a `param_type → param_value` map, or `undefined` when
 * the payload isn't one.
 *
 * A station volunteers an attached device's state as `[{dev_type, param_type, param_value}, …]`, and
 * those `param_type` ids are the cloud record's own — so this is a format unwrap, not an
 * interpretation. Entries missing an id or a value are skipped rather than stored as `"undefined"`.
 *
 * Two frames are read this way, each in ONE shape, because the caller lands these as the reporting device's
 * params — which widens the evidence its typed reads are gated on, so a reply that merely happens to carry an
 * array must not be mistaken for a device reporting its own state. A station's notify nests an attached
 * device's array under `payload`; a camera's own `CMD_CAMERA_INFO` puts it at the root. Reading each only in
 * its measured shape is what keeps the distinction. A `CMD_CAMERA_INFO` answered on {@link STATION_CHANNEL}
 * is the station's per-channel table and is read by {@link channelReport} instead.
 */
function paramReport(payload: unknown): Record<number, string> | undefined {
  const list = (payload as { params?: unknown } | undefined)?.params;
  if (!Array.isArray(list)) return undefined;
  const out: Record<number, string> = {};
  for (const entry of list) {
    const p = entry as { param_type?: unknown; param_value?: unknown };
    if (typeof p?.param_type !== "number" || p.param_value == null) continue;
    out[p.param_type] = String(p.param_value);
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Split a station's `CMD_CAMERA_INFO` table into one `param_type → param_value` map per channel, or
 * `undefined` when the payload carries no entry naming one.
 *
 * A HomeBase answers on {@link STATION_CHANNEL} with every attached camera's params in one root array, each
 * entry's `dev_type` naming the channel it belongs to and 255 naming the station. Flattened, each id keeps
 * whichever channel came last, so no camera reads its own state from it.
 */
function channelReport(payload: unknown): Record<number, Record<number, string>> | undefined {
  const list = (payload as { params?: unknown } | undefined)?.params;
  if (!Array.isArray(list)) return undefined;
  const out: Record<number, Record<number, string>> = {};
  for (const entry of list) {
    const p = entry as { dev_type?: unknown; param_type?: unknown; param_value?: unknown };
    if (typeof p?.dev_type !== "number" || typeof p.param_type !== "number" || p.param_value == null) continue;
    (out[p.dev_type] ??= {})[p.param_type] = String(p.param_value);
  }
  return Object.keys(out).length ? out : undefined;
}
