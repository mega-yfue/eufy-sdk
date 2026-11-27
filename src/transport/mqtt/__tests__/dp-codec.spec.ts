import { buildDpFrame, buildDpEnvelope, parseDpMessage } from "../dp-codec.js";
import {
  rgbcwBlock,
  dpPresetFields,
  dpLevelFields,
  specIsSerializable,
  type DpPresetSpec,
  type DpPresetLayer,
} from "../../dp-preset.js";

// Fixture values only — never real serials/account ids (CLAUDE.md redaction rules).
const ACCOUNT_ID = "0".repeat(40);
const DEVICE_SN = "T8000P0000000000";

function xorChecksum(buf: Buffer): number {
  let x = 0;
  for (const b of buf) x ^= b;
  return x;
}

/** Walk the TLV run (past the 9-byte header, before the 1-byte checksum). */
function decodeFields(buf: Buffer): Array<{ tag: number; value: Buffer }> {
  const out: Array<{ tag: number; value: Buffer }> = [];
  let i = 9;
  while (i < buf.length - 1) {
    const tag = buf[i]!;
    const len = buf[i + 1]!;
    out.push({ tag, value: buf.subarray(i + 2, i + 2 + len) });
    i += 2 + len;
  }
  return out;
}

describe("dp-codec — eufy_life MQTT DP TLV frame", () => {
  it("builds the frame shape: magic, u16LE size, header, u16BE cmdCode, checksum", () => {
    const buf = buildDpFrame(0x0201, ACCOUNT_ID, [{ tag: 0xa3, value: Buffer.from([1]) }]);
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0x09);
    expect(buf.readUInt16LE(2)).toBe(buf.length); // u16LE total-length self-check at offset 2
    expect(buf.subarray(4, 9)).toEqual(Buffer.from([0x03, 0x00, 0x02, 0x02, 0x01]));
    expect(buf[buf.length - 1]).toBe(xorChecksum(buf.subarray(0, buf.length - 1)));
  });

  it("writes a cmdCode outside 0x02xx whole, as the app does", () => {
    expect(buildDpFrame(0x0033, ACCOUNT_ID, []).subarray(7, 9)).toEqual(Buffer.from([0x00, 0x33]));
    expect(buildDpFrame(0x0041, ACCOUNT_ID, []).subarray(7, 9)).toEqual(Buffer.from([0x00, 0x41]));
  });

  it("writes the size as a real u16LE for frames over 255 bytes (effect frames) — not a truncated byte", () => {
    // A single big field pushes the frame well past 255 bytes; the old byte-plus-zero size silently
    // truncated the high byte, so the light rejected large effect frames.
    const buf = buildDpFrame(0x020d, ACCOUNT_ID, [{ tag: 0xa3, value: Buffer.alloc(300, 0x7) }]);
    expect(buf.length).toBeGreaterThan(255);
    expect(buf.readUInt16LE(2)).toBe(buf.length); // high byte carried, not zeroed
    expect(buf[2]).toBe(buf.length & 0xff);
    expect(buf[3]).toBe((buf.length >> 8) & 0xff);
  });

  it("prepends a1=timestamp (u32LE) and a2=accountId automatically before the caller's fields", () => {
    const before = Math.floor(Date.now() / 1000);
    const buf = buildDpFrame(0x0201, ACCOUNT_ID, [{ tag: 0xa3, value: Buffer.from([1]) }]);
    const fields = decodeFields(buf);
    expect(fields[0]!.tag).toBe(0xa1);
    expect(fields[0]!.value.length).toBe(4);
    const ts = fields[0]!.value.readUInt32LE(0);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(before + 2);
    expect(fields[1]).toEqual({ tag: 0xa2, value: Buffer.from(ACCOUNT_ID, "utf8") });
    expect(fields[2]).toEqual({ tag: 0xa3, value: Buffer.from([1]) });
  });

  it("subtype tracks cmdCode's low byte for a second command family (0x020D → 0x0d)", () => {
    expect(buildDpFrame(0x020d, ACCOUNT_ID, [])[8]).toBe(0x0d);
  });

  it("round-trips an arbitrary multi-field payload with correct tag/len/value framing", () => {
    const supplied = [
      { tag: 0xa3, value: Buffer.from([0x01, 0x02, 0x03, 0x04]) },
      { tag: 0xa4, value: Buffer.from("hi", "utf8") },
    ];
    const fields = decodeFields(buildDpFrame(0x020d, ACCOUNT_ID, supplied));
    expect(fields[2]).toEqual(supplied[0]);
    expect(fields[3]).toEqual(supplied[1]);
  });
});

describe("dp-codec — MQTT /req envelope", () => {
  it("wraps a frame into the confirmed {head,payload} string with mqttCmdCode as head.cmd", () => {
    const frame = buildDpFrame(0x0201, ACCOUNT_ID, [{ tag: 0xa3, value: Buffer.from([1]) }]);
    const body = buildDpEnvelope({
      clientId: "client-1",
      accountId: ACCOUNT_ID,
      deviceSn: DEVICE_SN,
      mqttCmdCode: 17,
      frame,
    });
    const outer = JSON.parse(body) as { head: Record<string, unknown>; payload: string };
    expect(outer.head).toMatchObject({ cmd: 17, sign_code: 0, cmd_status: 1, client_id: "client-1" });
    expect(outer.head.sess_id).toMatch(/^[0-9a-f]{4}$/);
    expect(outer.head.seed).toMatch(/^[0-9a-f]{32}$/);
    const inner = JSON.parse(outer.payload) as { account_id: string; device_sn: string; data: string; trans: string };
    expect(inner.account_id).toBe(ACCOUNT_ID);
    expect(inner.device_sn).toBe(DEVICE_SN);
    expect(inner.trans).toBe("");
    expect(Buffer.from(inner.data, "base64")).toEqual(frame);
  });
});

describe("dp-codec — RGBCW colour approximation", () => {
  it("maps pure primaries exactly onto the R/G/B channels (white channels zero)", () => {
    expect([...rgbcwBlock("ff0000")!]).toEqual([255, 0, 0, 0, 0]);
    expect([...rgbcwBlock("00ff00")!]).toEqual([0, 255, 0, 0, 0]);
    expect([...rgbcwBlock("0000ff")!]).toEqual([0, 0, 255, 0, 0]);
    expect([...rgbcwBlock("000000")!]).toEqual([0, 0, 0, 0, 0]);
  });

  it("returns a 5-byte block for any valid hex and null for invalid input", () => {
    expect(rgbcwBlock("abcdef")).toHaveLength(5);
    expect(rgbcwBlock("xyz")).toBeNull();
    expect(rgbcwBlock("fff")).toBeNull();
    expect(rgbcwBlock("")).toBeNull();
  });
});

describe("dp-codec — light-effect fields", () => {
  const specWith = (layers: DpPresetSpec["layers"]): DpPresetSpec => ({
    lightId: 10474,
    speed: 5,
    layerExecutionMode: 1,
    layers,
  });

  it("serialises the a3-a9 header + one a9+idx layer blob per layer", () => {
    const fields = dpPresetFields(
      specWith([
        { current_layer_type: 1, colors: "ff0000", brightness_value: 10 },
        { current_layer_type: 0, colors: "00ff00|0000ff" },
      ]),
    );
    const byTag = new Map(fields.map((f) => [f.tag, f.value]));
    expect(byTag.get(0xa3)!.readUInt32LE(0)).toBe(10474); // lightId, u32LE
    expect([...byTag.get(0xa4)!]).toEqual([5]); // speed
    expect([...byTag.get(0xa5)!]).toEqual([2]); // layer count
    expect([...byTag.get(0xa6)!]).toEqual([1]); // execution mode
    expect([...byTag.get(0xa8)!]).toEqual([0]);
    expect(byTag.has(0xa9)).toBe(true); // layer 0
    expect(byTag.has(0xaa)).toBe(true); // layer 1
    expect(fields.some((f) => f.tag === 0xa7)).toBe(false); // a7 deliberately absent
  });

  it("shapes a layer blob as header(8) + [00,type,count] + 5 bytes/colour + trailer", () => {
    const [layer] = dpPresetFields(specWith([{ current_layer_type: 1, colors: "ff0000|00ff00" }])).filter(
      (f) => f.tag === 0xa9,
    );
    const blob = layer!.value;
    // header(8) + [00,type,count](3) + 2 colours * 5 + type-1 trailer(10) = 31
    expect(blob[8]).toBe(0x00);
    expect(blob[9]).toBe(0x01); // current_layer_type
    expect(blob[10]).toBe(0x02); // colour count
    expect(blob.subarray(11, 16)).toEqual(Buffer.from([255, 0, 0, 0, 0])); // first colour (pure red)
    expect(blob.subarray(16, 21)).toEqual(Buffer.from([0, 255, 0, 0, 0])); // second colour (pure green)
  });

  it("throws on an unknown layer type rather than emitting a guessed shape", () => {
    expect(() => dpPresetFields(specWith([{ current_layer_type: 7, colors: "ff0000" }]))).toThrow(
      /no known frame shape/i,
    );
  });

  it("throws on unparseable / missing colours", () => {
    expect(() => dpPresetFields(specWith([{ current_layer_type: 1, colors: "nothex" }]))).toThrow(/RGB hex/i);
    expect(() => dpPresetFields(specWith([{ current_layer_type: 1, colors: "" }]))).toThrow(/RGB hex/i);
  });

  it("refuses a [min,max] pair in a single-byte field rather than silently mis-packing", () => {
    // nature/moods effects can carry interval_value: [1,1]; the header packs it as one byte, and how the
    // app widens for that shape isn't reversed — building it would ship a frame the light silently drops.
    const layer = { current_layer_type: 2, colors: "ff0000", interval_value: [1, 1] } as unknown as DpPresetLayer;
    expect(() => dpPresetFields(specWith([layer]))).toThrow(/min,max|mis-packed|not reverse-engineered/i);
  });
});

describe("light-effect — serializability predicate", () => {
  const layer = (over: Partial<DpPresetLayer> = {}): DpPresetLayer => ({
    current_layer_type: 1,
    colors: "ff0000",
    ...over,
  });

  it("ignores a field the layer type never serializes", () => {
    // execution_parameter / is_lights_move_with_people only ship on trailer types 0 and 2, so an
    // unencodable value there must not disqualify a type-1 layer that never emits the byte.
    expect(specIsSerializable({ layers: [layer({ is_lights_move_with_people: [0, 1] as never })] })).toBe(true);
    expect(
      specIsSerializable({ layers: [layer({ current_layer_type: 0, execution_parameter: [0, 1] as never })] }),
    ).toBe(false);
  });

  it("refuses layerless, unknown-type, bad-colour and non-scalar-header effects", () => {
    expect(specIsSerializable({ layers: [] })).toBe(false);
    expect(specIsSerializable({ layers: [layer({ current_layer_type: 9 })] })).toBe(false);
    expect(specIsSerializable({ layers: [layer({ colors: "nothex" })] })).toBe(false);
    expect(specIsSerializable({ layers: [layer({ interval_value: [1, 1] as never })] })).toBe(false);
    expect(specIsSerializable({ speed: [1, 5], layers: [layer()] })).toBe(false);
  });

  it("accepts a numeric string where the cloud stringifies a scalar", () => {
    expect(specIsSerializable({ speed: "5", layerExecutionMode: "0", layers: [layer()] })).toBe(true);
  });
});

describe("dp-codec — brightness fields", () => {
  it("emits tag 0xa4 clamped to 0-100", () => {
    expect(dpLevelFields(50)).toEqual([{ tag: 0xa4, value: Buffer.from([50]) }]);
    expect(dpLevelFields(150)).toEqual([{ tag: 0xa4, value: Buffer.from([100]) }]);
    expect(dpLevelFields(-5)).toEqual([{ tag: 0xa4, value: Buffer.from([0]) }]);
  });
});

describe("dp-preset — range fields never pack silently", () => {
  const layer = (extra: Record<string, unknown>) => ({
    current_layer_type: 1,
    colors: "ff0000",
    ...extra,
  });
  const spec = (extra: Record<string, unknown>) => ({ speed: 1, layerExecutionMode: 0, layers: [layer(extra)] });

  it("accepts a stringified range component the cloud sent as text", () => {
    expect(specIsSerializable(spec({ layer_range: "5" }))).toBe(true);
  });

  it("refuses a range whose component shape isn't reverse-engineered, rather than zeroing it", () => {
    // A nested pair in a range slot has no known packing. Collapsing it to [0,0] would advertise the
    // effect as buildable and then publish a frame the light ignores, on a wire with no delivery ack.
    expect(specIsSerializable(spec({ layer_range: [[1, 2], 3] }))).toBe(false);
    expect(specIsSerializable(spec({ layer_range: {} }))).toBe(false);
  });
});

describe("parseDpMessage — inbound framing", () => {
  const wrap = (frameHex: string, cmd = 16): unknown => ({
    head: { cmd },
    payload: JSON.stringify({
      data: Buffer.from(JSON.stringify({ data: frameHex })).toString("base64"),
      sn: "T8000P0000000000",
      pn: "T8L02",
    }),
  });

  /** A real 0x0204 report: TLVs start straight after the 9-byte header, no status byte. */
  const REPORT = "ff092500030102020" + "4a10101a20128a3010aa404ea280000a50100a604ea280000a70102".slice(0) + "55";

  it("unwraps the double-nested hex payload and returns the frame's tags in wire order", () => {
    const f = parseDpMessage(wrap(REPORT));
    expect(f?.envelopeCmd).toBe(16);
    expect(f?.cmd).toBe(0x0204);
    expect(f?.status).toBeUndefined();
    expect(f?.fields.map((x) => x.tag)).toEqual([0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7]);
  });

  it("strips the status byte a response frame carries, so its TLVs align", () => {
    // 0x0A00 answers get_device_info; the byte at offset 9 is status, not a tag.
    const reply =
      "ff093a000300020a0000a10100a20155a3020a00a402ea28a50100a60400000000" +
      "a71000000000000000000000000000000000a80100a90100ee";
    const f = parseDpMessage(wrap(reply));
    expect(f?.cmd).toBe(0x0a00);
    expect(f?.status).toBe(0);
    expect(f?.fields[0]).toMatchObject({ tag: 0xa1 });
  });

  it("returns undefined on every malformed shape instead of throwing", () => {
    const bad: unknown[] = [
      undefined,
      {},
      { head: {}, payload: "x" },
      { head: { cmd: 16 }, payload: "not json" },
      { head: { cmd: 16 }, payload: JSON.stringify({ data: null }) },
      { head: { cmd: 16 }, payload: JSON.stringify({ data: "!!!" }) },
      wrap("00010203"), // right wrapping, not a DP frame
      wrap("ff0904000300020204"), // length field disagrees with the buffer
      wrap("ff09"), // shorter than a header
    ];
    for (const raw of bad) {
      expect(() => parseDpMessage(raw)).not.toThrow();
      expect(parseDpMessage(raw)).toBeUndefined();
    }
  });

  it("forwards the envelope id verbatim rather than judging it", () => {
    // Which dispatch ids mean what is capability vocabulary; the parser must not filter on it.
    expect(parseDpMessage(wrap(REPORT, 65537))?.envelopeCmd).toBe(65537);
  });
});
