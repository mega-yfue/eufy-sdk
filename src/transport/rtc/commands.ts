/**
 * The portal commands that start and stop a live stream, as the portal itself sends them.
 *
 * Captured from a live `security.eufy.com` session against a HomeBase S1 Pro, on the command data
 * channel: pressing play produced ONE packet for the whole station, not one per camera. That is the
 * detail every guess had missed — the command is addressed to {@link PORTAL_STATION_CHANNEL} and names
 * the cameras in its payload, so asking a per-camera session to start itself (the shape `1003`/`1000`
 * suggests) is answered with silence rather than an error.
 */

import { buildPortalPacket } from "./portal-packet.js";

/** The `1350` envelope every one of these rides in — the portal's SET_PAYLOAD wrapper. */
export const PORTAL_CMD_SET_PAYLOAD = 1350;

/**
 * The channel a station-wide command is addressed to. A per-camera command carries that camera's own
 * channel instead, the way the stop below does.
 */
export const PORTAL_STATION_CHANNEL = 255;

/** The inner `cmd` values, observed on the wire. */
export const PortalLiveCommand = {
  /** Start live on the listed channels. Station-wide, one packet for all of them. */
  START: 1103,
  /** Stop live on the channel the packet is addressed to. Empty payload. */
  STOP: 1004,
} as const;

/**
 * Start live video for one or more cameras.
 *
 * `channels` is sent verbatim, in order, alongside its own length — the portal sent `[1, 0, 2]` for
 * three cameras, so neither sorting nor de-duplication is implied, and a caller asking for one camera
 * sends a one-element array.
 */
export function buildStartLive(opts: { accountId: string; channels: readonly number[]; segment: number }): Buffer {
  if (opts.channels.length === 0) throw new RangeError("start-live needs at least one channel");
  return buildPortalPacket({
    commandId: PORTAL_CMD_SET_PAYLOAD,
    channel: PORTAL_STATION_CHANNEL,
    segment: opts.segment,
    payload: {
      account_id: opts.accountId,
      cmd: PortalLiveCommand.START,
      payload: { channel_info: { array_size: opts.channels.length, channel_array: [...opts.channels] } },
    },
  });
}

/** Stop live video for one camera, addressed to that camera's channel. */
export function buildStopLive(opts: { accountId: string; channel: number; segment: number }): Buffer {
  return buildPortalPacket({
    commandId: PORTAL_CMD_SET_PAYLOAD,
    channel: opts.channel,
    segment: opts.segment,
    payload: { account_id: opts.accountId, cmd: PortalLiveCommand.STOP, payload: {} },
  });
}
