/**
 * Raw-DP codec — the structural reader for the base64 protobuf values a Tuya-style data point carries
 * when it holds a whole message instead of a scalar. Implements the `core/contracts` {@link RawDpCodec}
 * boundary, so the capability layer can read those DPs without importing `protobufjs`, which the
 * decorrelation guard bars from `model/`.
 *
 * Schema-less by construction. It walks fields by number and wire type and hands back what it finds; it
 * never learns which DP a payload came from, what a field means, or whether a length-delimited run is a
 * UTF-8 string, an opaque blob or a nested message. That is the reader's call, and the reader is the
 * capability — the same split `DpInboundFrame` already draws for inbound TLV frames.
 *
 * ## Wire (AIoT MQTT)
 *
 * A Raw DP's value is `base64( varint(len) ++ protobufMessage )` — the length prefix is the exact byte
 * length of the message that follows, so it doubles as a validity check: a value whose prefix disagrees
 * with the remaining body is not this shape and is rejected rather than half-read. Standard protobuf
 * wire types are handled (`0` varint, `1` fixed64, `2` length-delimited, `5` fixed32); a group marker
 * (`3`/`4`) or a reserved `6`/`7` rejects the whole payload — none appears in any captured DP, and
 * guessing past one would silently misalign every field after it.
 *
 * `Buffer.from(_, "base64")` never throws (it drops invalid characters silently), so a non-base64 string
 * decodes to bytes whose length prefix will not match and is rejected by that same check.
 *
 * Varints are read UNSIGNED, because the wire does not say otherwise: a negative `int32`/`int64` is
 * encoded as a 10-byte varint and surfaces here as a very large `bigint`, and `sint32`/`sint64` values
 * arrive still zig-zag encoded. Recovering either needs the field's declared type, which only the
 * capability naming that field has. No DP read today has a signed field; one that does converts on its
 * own side.
 *
 * Pure and stateless — no socket, no session — so it sits at the transport root beside `ff09.ts` and is
 * imported by direct path rather than re-exported from the barrel.
 */
import { protobufjs } from "./protobuf.js";
import type { RawDpCodec, RawDpField } from "../core/contracts.js";

/**
 * Walk a protobuf message body to its top-level fields. Returns `undefined` on an unhandled wire type,
 * a truncated field, or trailing bytes that do not start a further field — every one of which means the
 * remaining fields cannot be trusted to be at the offsets they appear to be.
 */
function readFields(body: Buffer): RawDpField[] | undefined {
  const r = protobufjs().Reader.create(body);
  const out: RawDpField[] = [];
  try {
    while (r.pos < r.len) {
      const tag = r.uint32();
      const field = tag >>> 3;
      switch (tag & 7) {
        case 0:
          out.push({ field, kind: "int", value: BigInt(r.uint64().toString()) });
          break;
        case 1:
          out.push({ field, kind: "int", value: BigInt(r.fixed64().toString()) });
          break;
        case 2:
          out.push({ field, kind: "bytes", value: Buffer.from(r.bytes()) });
          break;
        case 5:
          out.push({ field, kind: "int", value: BigInt(r.fixed32()) });
          break;
        default:
          return undefined;
      }
    }
  } catch {
    return undefined;
  }
  return r.pos === r.len ? out : undefined;
}

/**
 * The codec every Raw-DP reader shares. Stateless, so one frozen instance serves every device — there
 * is nothing per-device or per-DP to configure.
 */
export const rawDpCodec: RawDpCodec = Object.freeze({
  decode(value: string): readonly RawDpField[] | undefined {
    if (!value) return undefined;
    const buf = Buffer.from(value, "base64");
    if (!buf.length) return undefined;
    let len: number;
    let bodyStart: number;
    try {
      const r = protobufjs().Reader.create(buf);
      len = r.uint32();
      bodyStart = r.pos;
    } catch {
      return undefined;
    }
    const body = buf.subarray(bodyStart);
    if (len !== body.length) return undefined;
    return readFields(body);
  },

  nested(value: Buffer): readonly RawDpField[] | undefined {
    return readFields(value);
  },
});
