import { describe, expect, it } from "vitest";
import { BIZ_CHANNEL, BIZ_PROTOCOL, bizChannelName, parseBizMapFrame } from "../biz-stream.js";
import { parseAiotDpReport, parseDpMessage } from "../dp-codec.js";

/**
 * The map-stream envelope, checked against the rules the app itself applies.
 *
 * Every acceptance and refusal below traces to `BaseRobovacServiceImpl.dispatchMessage` (the
 * `protocol` switch and the object-or-string payload) or to `AiotMapManager`'s map-data listener (the
 * six required fields, and channel 0 routed to scenes) in the disassembled V6 app. Serials here are
 * synthetic.
 */

/** A real frame: varint(2) then two bytes, hex-encoded as the wire sends it. */
const HEX = "02aabb";
const B64 = Buffer.from([0x02, 0xaa, 0xbb]).toString("base64");

const data = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  channel_id: BIZ_CHANNEL.MAP_DATA,
  clear_type: 0,
  data_type: 1,
  offset: 0,
  len: 3,
  data: HEX,
  ...over,
});

const envelope = (d: Record<string, unknown> = data(), protocol: number = BIZ_PROTOCOL.MAP_DATA): unknown => ({
  payload: { protocol, t: 1_700_000_000, device_sn: "T8000P0000000000", data: d },
});

describe("parseBizMapFrame", () => {
  it("unwraps a frame to its bytes and the numbers around it", () => {
    expect(parseBizMapFrame(envelope())).toEqual({
      channelId: BIZ_CHANNEL.MAP_DATA,
      clearType: 0,
      dataType: 1,
      offset: 0,
      len: 3,
      payload: B64,
    });
  });

  it("accepts the payload as a JSON string, as the broker sometimes sends it", () => {
    const asString = { payload: JSON.stringify({ protocol: 41, data: data() }) };
    expect(parseBizMapFrame(asString)?.payload).toBe(B64);
  });

  it("keeps a zero channel, which is the scene channel and not an absent one", () => {
    // The app switches on `channel_id == 0` and routes it to a scene event instead of a map one, so
    // zero here is a real address. A parser that treated a falsy id as missing would drop scenes.
    expect(parseBizMapFrame(envelope(data({ channel_id: 0 })))?.channelId).toBe(0);
  });

  it("reads numbers the envelope spelled as strings", () => {
    const stringly = data({ channel_id: "4", clear_type: "1", data_type: "0", offset: "16", len: "3" });
    expect(parseBizMapFrame(envelope(stringly))).toMatchObject({ channelId: 4, clearType: 1, offset: 16 });
  });

  it("declines a live-photo message, which shares the leg and nothing else", () => {
    expect(parseBizMapFrame(envelope(data(), BIZ_PROTOCOL.LIVE_PHOTO))).toBeUndefined();
  });

  it("declines every unrelated message on the connection without complaint", () => {
    // This runs against DP reports, ACKs and anything else the broker delivers.
    expect(parseBizMapFrame(undefined)).toBeUndefined();
    expect(parseBizMapFrame("not json")).toBeUndefined();
    expect(parseBizMapFrame({})).toBeUndefined();
    expect(parseBizMapFrame({ payload: "[]" })).toBeUndefined();
    expect(parseBizMapFrame({ payload: { protocol: 41 } })).toBeUndefined();
    expect(parseBizMapFrame({ payload: { protocol: 41, data: [] } })).toBeUndefined();
    expect(parseBizMapFrame({ payload: { data: data() } })).toBeUndefined();
  });

  it("refuses a frame missing any one of the six fields the app requires", () => {
    // The app checks for all six by name and returns early without them. A frame short a field is one
    // this code does not understand, and half of it is worth nothing.
    for (const key of ["channel_id", "clear_type", "data_type", "offset", "len", "data"]) {
      const short = data();
      delete short[key];
      expect(parseBizMapFrame(envelope(short)), key).toBeUndefined();
    }
  });

  it("refuses a payload that is not clean hex", () => {
    // Deferred to `hexToRawDp`, and it matters here: hex truncates from the end, so garbage after a
    // valid prefix would otherwise yield a shorter frame whose own length check still passes.
    expect(parseBizMapFrame(envelope(data({ data: `${HEX}zz9988` })))).toBeUndefined();
    expect(parseBizMapFrame(envelope(data({ data: "" })))).toBeUndefined();
    expect(parseBizMapFrame(envelope(data({ data: 3 })))).toBeUndefined();
  });

  it("refuses a negative or fractional count rather than rounding it", () => {
    expect(parseBizMapFrame(envelope(data({ offset: -1 })))).toBeUndefined();
    expect(parseBizMapFrame(envelope(data({ len: 1.5 })))).toBeUndefined();
    expect(parseBizMapFrame(envelope(data({ channel_id: "nine" })))).toBeUndefined();
  });
});

describe("the channel table", () => {
  it("names the channels a robot's frames identify", () => {
    expect(bizChannelName(0)).toBe("SCENES");
    expect(bizChannelName(2)).toBe("MAP_DATA");
    expect(bizChannelName(4)).toBe("ROOM_OUTLINE");
    expect(bizChannelName(68)).toBe("MAP_BACKUP");
  });

  it("has no name for an id outside the table", () => {
    // Not a guess and not a throw: a device that renumbered its channels, or added one, produces an
    // id this table cannot name, and saying so is the honest answer.
    expect(bizChannelName(9)).toBeUndefined();
    expect(bizChannelName(-1)).toBeUndefined();
  });

  it("maps every id to exactly one name", () => {
    const ids = Object.values(BIZ_CHANNEL);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/**
 * Why the client can route a map frame and stop.
 *
 * The message handler tries the parsers in order and returns on the first that answers. That is only
 * safe if the others would have declined anyway — otherwise the new branch would be stealing messages
 * from a working path. It is also the other half of the claim that these frames were being DROPPED
 * rather than half-read: both DP parsers refuse them, which is why nothing has ever come of them.
 */
describe("a map frame against the other parsers on the same connection", () => {
  const msg = envelope();

  it("is refused by both DP parsers", () => {
    expect(parseAiotDpReport(msg)).toBeUndefined();
    expect(parseDpMessage(msg)).toBeUndefined();
  });

  it("and a DP report is refused by this one", () => {
    const dpReport = { payload: { protocol: 4, t: 1, device_sn: "T8000P0000000000", data: { "163": "85" } } };

    expect(parseAiotDpReport(dpReport)).toEqual({ 163: "85" });
    expect(parseBizMapFrame(dpReport)).toBeUndefined();
  });
});
