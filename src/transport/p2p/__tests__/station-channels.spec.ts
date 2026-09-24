import { describe, expect, it } from "vitest";
import { stationChannels } from "../station-channels.js";

const HUB = "T8000P0000000000";
const A = "T8000P0000000001";
const B = "T8000P0000000002";
const OTHER_HUB = "T8000P0000000005";
const C = "T8000P0000000006";
const STANDALONE = "T8000P0000000009";

const hub = (sn: string) => ({ sn, raw: {} }) as never;
const on = (station: string, sn: string, channel?: number) =>
  ({ sn, raw: { parent_sn: station, ...(channel === undefined ? {} : { device_channel: channel }) } }) as never;

describe("stationChannels", () => {
  it("keeps distinct stated channels as they are", () => {
    const map = stationChannels([hub(HUB), on(HUB, A, 0), on(HUB, B, 1)]);
    expect(map.get(A)).toEqual({ channel: 0 });
    expect(map.get(B)).toEqual({ channel: 1 });
  });

  it("gives neither device a channel both state", () => {
    const map = stationChannels([hub(HUB), on(HUB, A, 0), on(HUB, B, 0)]);
    expect(map.get(A)).toEqual({ issue: "shared", claimed: 0 });
    expect(map.get(B)).toEqual({ issue: "shared", claimed: 0 });
  });

  it("gives an attached device that states no channel none, instead of 0", () => {
    expect(stationChannels([hub(HUB), on(HUB, A)]).get(A)).toEqual({ issue: "missing" });
  });

  it("only compares devices attached to the same station", () => {
    const map = stationChannels([hub(HUB), hub(OTHER_HUB), on(HUB, A, 1), on(OTHER_HUB, C, 1)]);
    expect(map.get(A)).toEqual({ channel: 1 });
    expect(map.get(C)).toEqual({ channel: 1 });
  });

  it("addresses a standalone device by the channel it states, else 0", () => {
    const map = stationChannels([hub(STANDALONE), { sn: HUB, raw: { device_channel: 2 } } as never]);
    expect(map.get(STANDALONE)).toEqual({ channel: 0 });
    expect(map.get(HUB)).toEqual({ channel: 2 });
  });
});
