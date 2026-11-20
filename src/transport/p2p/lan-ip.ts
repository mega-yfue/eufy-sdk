/**
 * LAN-address resolution for a P2P station from its cloud device record.
 *
 * Pure helpers (no session state) — used when opening a P2P session to prefer a direct on-LAN
 * lookup over the cloud relay (works when broadcast is blocked by AP isolation / macOS, even if
 * the record's pairing `ip_addr` went stale).
 */

/** True for an RFC-1918 private IPv4 (a routable LAN address, not a WAN/public one). */
export function isPrivateIpv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some((o) => Number(o) > 255)) return false;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Resolve the freshest LAN IP for a station from its cloud record.
 *
 * The record carries the device IP in several places of differing trust:
 *  - **params** (`{param_type, param_value, update_time}`) — self-reported by the device on each
 *    heartbeat, so a private-IP param value is timestamped and updates when the device roams.
 *  - **`ip_addr`** (top-level) — frozen at pairing, no timestamp; goes stale if the device moved
 *    to another subnet since.
 *  - **`local_ip`** — often empty, or the public WAN address.
 *
 * Strategy: collect every param whose value is a private IPv4, take the one with the newest
 * `update_time`, and only fall back to `ip_addr` / `local_ip` when no param IP exists. This
 * prefers the most recent evidence over a fixed field-priority order.
 */
export function freshestLanIp(raw: unknown): string | undefined {
  const rec = raw as
    | { params?: Array<{ param_value?: unknown; update_time?: unknown }>; ip_addr?: unknown; local_ip?: unknown }
    | undefined;
  let best: { ip: string; ts: number } | undefined;
  for (const p of rec?.params ?? []) {
    const v = typeof p?.param_value === "string" ? p.param_value : undefined;
    if (!v || !isPrivateIpv4(v)) continue;
    const ts = typeof p.update_time === "number" ? p.update_time : 0;
    if (!best || ts > best.ts) best = { ip: v, ts };
  }
  if (best) return best.ip;
  for (const cand of [rec?.local_ip, rec?.ip_addr]) {
    if (typeof cand === "string" && isPrivateIpv4(cand)) return cand;
  }
  return undefined;
}
