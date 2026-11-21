import { lz4BlockDecompress } from "../core/lz4-block.js";

/** Named rooms from one saved map. Names need not be unique; ids belong to this map. */
export interface TuyaMapRooms {
  mapId: number;
  name: string;
  rooms: { id: number; name: string }[];
}

/** Decode the named-room table from a stored map. Unnamed grid segments are excluded. @internal */
export function decodeTuyaMapRooms(data: Buffer, name = ""): TuyaMapRooms {
  const offset = data.indexOf("0pam");
  if ((offset !== 0 && offset !== 64) || data.length < offset + 24) throw new Error("Invalid Tuya map header");
  const b = data.subarray(offset);
  const width = b.readUInt16BE(8),
    height = b.readUInt16BE(10);
  const compressed = b.readUInt32BE(16),
    expanded = b.readUInt32BE(20);
  const cells = width * height;
  if (
    !width ||
    !height ||
    width > 4000 ||
    height > 4000 ||
    expanded < cells + 6 ||
    expanded > cells + 131072 ||
    compressed > b.length - 24
  )
    throw new Error("Invalid Tuya map dimensions or length");
  const raw = lz4BlockDecompress(b.subarray(24, 24 + compressed), expanded);
  if (!raw) throw new Error("Invalid Tuya map compression");
  const rooms: TuyaMapRooms["rooms"] = [];
  let pos = cells + 6;
  while (pos < raw.length) {
    if (pos + 2 > raw.length) throw new Error("Truncated Tuya map section");
    const tag = raw[pos++]!,
      count = raw[pos++]!;
    if (tag === 6) {
      for (let i = 0; i < count; i++) {
        if (pos + 2 > raw.length) throw new Error("Truncated Tuya room record");
        const id = raw[pos]!,
          size = raw[pos + 1]!;
        if (size < 2 || pos + size > raw.length) throw new Error("Invalid Tuya room record length");
        rooms.push({ id, name: new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(pos + 2, pos + size)) });
        pos += size;
      }
    } else {
      const size = count * (tag === 2 ? 8 : tag === 3 || tag === 8 ? 16 : 1);
      if (pos + size > raw.length) throw new Error("Truncated Tuya map section");
      pos += size;
    }
  }
  return { mapId: b.readUInt16BE(4), name, rooms };
}
