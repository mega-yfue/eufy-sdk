/**
 * Station topology and per-station channel addressing, from the device records alone.
 *
 * Both sides of the P2P wire key on a device's channel within its station: a media start and every
 * per-channel command address it, and an inbound frame is attributed to the device on its channel. Resolving
 * it once, here, keeps the two sides from ever disagreeing about which device a channel means.
 *
 * @module transport/p2p/station-channels
 * @internal
 */
import type { EufyDevice } from "../../core/types.js";

/**
 * The station a device's traffic belongs to, from its cloud record and its own serial.
 *
 * `parent_sn` carries the parent on a HomeBase-attached device. `station_sn` is frequently absent there —
 * empty on every attached sensor of a T8010 — and serves only as a fallback. An empty string states no
 * station.
 *
 * A device naming no parent answers its own serial, so every device has a station.
 */
export function resolvedStationSn(raw: Record<string, unknown>, sn: string): string {
  const parent = typeof raw.parent_sn === "string" && raw.parent_sn ? raw.parent_sn : undefined;
  if (parent && parent !== sn) return parent;
  const station = typeof raw.station_sn === "string" && raw.station_sn ? raw.station_sn : undefined;
  return station ?? sn;
}

/**
 * The parent station a device's traffic belongs to — the session key the router opens and the station the
 * frame resolver attributes by.
 *
 * `parent_sn` on the cloud record is the field that is actually populated for a HomeBase-attached device, so
 * it wins; `stationSn` is frequently absent (observed empty on every attached sensor of a T8010), so keying on
 * it alone silently resolves an attached device to ITSELF and no frame ever matches. Answering the device's
 * OWN serial is what "stands alone" means.
 */
export function stationOf(dev: EufyDevice): string {
  const raw = (dev.raw ?? {}) as Record<string, unknown>;
  const parent =
    typeof raw.parent_sn === "string" && raw.parent_sn && raw.parent_sn !== dev.sn ? raw.parent_sn : undefined;
  return parent ?? dev.stationSn ?? resolvedStationSn(raw, dev.sn);
}

/**
 * A device's channel within its station, or why it has none. `shared` keeps the channel it `claimed`, so a
 * frame arriving on it is known to belong to one of the claimants rather than to the station.
 */
export type StationChannel = { channel: number } | { issue: "missing" } | { issue: "shared"; claimed: number };

/** The `device_channel` a record states, or `undefined` when it states none. */
function statedChannel(dev: EufyDevice): number | undefined {
  const v = (dev.raw as Record<string, unknown> | undefined)?.device_channel;
  return typeof v === "number" ? v : undefined;
}

/**
 * The channel each device is addressed by within its station.
 *
 * A standalone device is its own station, addressed by the channel its record states, or 0. An attached
 * device has a channel only when its record states one that no other device attached to the same station
 * also states. A missing channel names no device, and a channel two attached devices both state cannot say
 * which of them it means, so either resolves to an issue rather than to a channel: guessing would address
 * another device, streaming its video or attributing its frames under this serial. Every attached device
 * counts towards a clash, whatever its kind, and the answer does not depend on list order.
 */
export function stationChannels(devices: readonly EufyDevice[]): Map<string, StationChannel> {
  const out = new Map<string, StationChannel>();
  const claimants = new Map<string, Map<number, number>>();
  for (const d of devices) {
    const station = stationOf(d);
    const stated = statedChannel(d);
    if (d.sn === station || stated === undefined) continue;
    const counts = claimants.get(station) ?? new Map<number, number>();
    counts.set(stated, (counts.get(stated) ?? 0) + 1);
    claimants.set(station, counts);
  }
  for (const d of devices) {
    const station = stationOf(d);
    const stated = statedChannel(d);
    if (d.sn === station) out.set(d.sn, { channel: stated ?? 0 });
    else if (stated === undefined) out.set(d.sn, { issue: "missing" });
    else if ((claimants.get(station)?.get(stated) ?? 0) > 1) out.set(d.sn, { issue: "shared", claimed: stated });
    else out.set(d.sn, { channel: stated });
  }
  return out;
}
