import { describe, it, expect } from "vitest";
import { decodeTuyaMapRooms } from "../tuya-map.js";

function fixture(names = ["Room A", "Room A"], prefix = 64): Buffer {
  const records = names.map((name, id) => {
    const text = Buffer.from(name);
    return Buffer.concat([Buffer.from([id, text.length + 2]), text]);
  });
  const raw = Buffer.concat([Buffer.from([0]), Buffer.alloc(6), Buffer.from([6, names.length]), ...records]);
  const compressed = Buffer.concat([Buffer.from([0xf0, raw.length - 15]), raw]);
  const header = Buffer.alloc(24);
  header.write("0pam");
  header.writeUInt16BE(42, 4);
  header.writeUInt16BE(1, 8);
  header.writeUInt16BE(1, 10);
  header.writeUInt32BE(compressed.length, 16);
  header.writeUInt32BE(raw.length, 20);
  return Buffer.concat([Buffer.alloc(prefix), header, compressed]);
}

describe("stored Tuya room tables", () => {
  it.each([0, 64])("decodes map-scoped room zero and duplicate names with prefix %s", (prefix) => {
    expect(decodeTuyaMapRooms(fixture(undefined, prefix), "Floor A")).toEqual({
      mapId: 42,
      name: "Floor A",
      rooms: [
        { id: 0, name: "Room A" },
        { id: 1, name: "Room A" },
      ],
    });
  });
  it("preserves UTF-8 names", () => {
    expect(decodeTuyaMapRooms(fixture(["Pièce", "寝室"])).rooms[1]?.name).toBe("寝室");
  });
  it("rejects truncated data and excessive expansion", () => {
    const blob = fixture();
    expect(() => decodeTuyaMapRooms(blob.subarray(0, -1))).toThrow();
    blob.writeUInt32BE(0xffffffff, 84);
    expect(() => decodeTuyaMapRooms(blob)).toThrow();
  });
  it("rejects malformed room record lengths", () => {
    const blob = fixture();
    blob[100] = 255;
    expect(() => decodeTuyaMapRooms(blob)).toThrow();
  });
});
