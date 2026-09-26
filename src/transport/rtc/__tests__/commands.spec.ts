import { describe, expect, it } from "vitest";
import { buildStartLive, buildStopLive, PORTAL_STATION_CHANNEL } from "../commands.js";
import { parsePortalHeader } from "../portal-packet.js";

/** The bytes the portal put on the wire, with its account id replaced by forty ASCII zeros. */
const ACCOUNT = "0".repeat(40);
const CAPTURED_START =
  '{"account_id":"' + ACCOUNT + '","cmd":1103,"payload":{"channel_info":{"array_size":3,"channel_array":[1,0,2]}}}';
const CAPTURED_STOP = '{"account_id":"' + ACCOUNT + '","cmd":1004,"payload":{}}';

describe("portal live commands", () => {
  it("rebuilds the start the portal sends, header and body", () => {
    const pkt = buildStartLive({ accountId: ACCOUNT, channels: [1, 0, 2], segment: 151 });
    const header = parsePortalHeader(pkt)!;
    expect(header).toMatchObject({
      commandId: 1350,
      channel: PORTAL_STATION_CHANNEL, // 255: the station, not a camera
      segment: 151,
      isResponse: 0,
      devType: 2,
    });
    // The capture's frame was 152 bytes: the 16-byte header plus a 136-byte body.
    expect(header.paramLength).toBe(136);
    expect(pkt.length).toBe(152);
    expect(pkt.subarray(16).toString("utf8")).toBe(CAPTURED_START);
  });

  it("stops one camera on its own channel", () => {
    const pkt = buildStopLive({ accountId: ACCOUNT, channel: 1, segment: 152 });
    expect(parsePortalHeader(pkt)).toMatchObject({ commandId: 1350, channel: 1, segment: 152 });
    expect(pkt.subarray(16).toString("utf8")).toBe(CAPTURED_STOP);
    expect(pkt.length).toBe(16 + 81); // the capture's paramLen
  });

  it("refuses a start that names no camera", () => {
    expect(() => buildStartLive({ accountId: ACCOUNT, channels: [], segment: 1 })).toThrow(RangeError);
  });
});
