import type { RawDpCodec, RawDpField } from "../../../core/contracts.js";
import type { CommandContext } from "../types.js";
import {
  VACUUM_CLEAN,
  VACUUM_DP,
  TUYA_VACUUM_DP,
  decodeVacuumActivity,
  decodeCleanType,
  decodeUnisetting,
  decodeCleanParamValue,
  decodeConsumableHours,
  decodeDoNotDisturb,
  decodeDoNotDisturbActive,
  decodeCleanStat,
  decodeVacuumFault,
  decodeLanguageField,
  decodeUnisettingNumber,
  decodeUnistateFlag,
  decodeUnistateNumber,
  LIVE_MAP_BITS,
  decodeUnisettingTopLevel,
  decodeDoNotDisturbTime,
  decodeChargeState,
  decodeTriggerSource,
  encodeConsumableReset,
  CONSUMABLE_PARTS,
  CONSUMABLE_RESET_TYPE,
  VOICE_PACK_STATES,
  encodeModeCtrl,
  encodeSelectRoomsClean,
  encodeSelectZonesClean,
  encodeSceneClean,
  encodeAutoClean,
  encodeCleanParam,
  ModeCtrlParamMethod,
  VACUUM_DP_MESSAGE,
  ModeCtrlMethod,
  type VacuumCleanActions,
  type VacuumActivity,
  type VacuumCleanType,
  type TuyaCleanType,
  type VoicePackState,
  type ConsumablePart,
} from "../vacuum-clean.js";
import { bind } from "./bind.js";
import { byteCodec, frame, int, str, sub, varint } from "./proto-bytes.js";

/**
 * The capability is exercised against a FAKE codec, never the real `transport/raw-dp.ts` — importing
 * that here would break the decorrelation guard, which greps `src/model` with no `__tests__` exemption.
 * That constraint is the point: if this spec can decode a payload without transport in scope, so can
 * any other consumer of the contract.
 */
function fakeCodec(fields: readonly RawDpField[] | undefined): RawDpCodec {
  return { decode: () => fields, nested: () => fields };
}
/** A codec reporting only `WorkStatus.state` (field #2), as the real one would for a state-carrying frame. */
function workStatus(state: number): RawDpCodec {
  return fakeCodec([{ field: 2, kind: "int", value: BigInt(state) }]);
}

/**
 * `encodeModeCtrl` — hand-rolled proto3 varint encoder for `ModeCtrlRequest` (DP 152).
 * Tests are byte-exact: we decode the base64 output and compare the raw wire bytes, so a
 * regression silently producing a wrong frame (no-ops on the device) is caught here.
 *
 * Wire format: `varint(bodyLen) ++ body` where `body = {field#1:method, field#2:seq}`.
 */
describe("encodeModeCtrl", () => {
  it("START_GOHOME (method 6, seq 112)", () => {
    // body: [0x08, 0x06, 0x10, 0x70]
    // wire: [0x04, 0x08, 0x06, 0x10, 0x70]
    expect(Buffer.from(encodeModeCtrl(ModeCtrlMethod.START_GOHOME, 112), "base64")).toEqual(
      Buffer.from([0x04, 0x08, 0x06, 0x10, 0x70]),
    );
  });

  it("PAUSE_TASK (method 13, seq 112)", () => {
    // body: [0x08, 0x0d, 0x10, 0x70]
    // wire: [0x04, 0x08, 0x0d, 0x10, 0x70]
    expect(Buffer.from(encodeModeCtrl(ModeCtrlMethod.PAUSE_TASK, 112), "base64")).toEqual(
      Buffer.from([0x04, 0x08, 0x0d, 0x10, 0x70]),
    );
  });

  it("encodes a multi-byte varint seq (seq 200 > 127)", () => {
    // seq 200: varint = [0xc8, 0x01]  (200 = 0b11001000 → [0xC8 with msb set, 0x01])
    // body: [0x08, 0x0d, 0x10, 0xc8, 0x01]
    // wire: [0x05, 0x08, 0x0d, 0x10, 0xc8, 0x01]
    expect(Buffer.from(encodeModeCtrl(ModeCtrlMethod.PAUSE_TASK, 200), "base64")).toEqual(
      Buffer.from([0x05, 0x08, 0x0d, 0x10, 0xc8, 0x01]),
    );
  });
});

/** Minimal `CommandContext` for a given model/category and optional DP id set. */
function fakeCtx(model?: string, category?: string, paramIds: Set<number> = new Set()): CommandContext {
  return { channel: 0, codec: "vacuum", model, category, paramIds };
}

describe("vacuum_clean capability module", () => {
  it("declares the capability + schema", () => {
    expect(VACUUM_CLEAN.capability).toBe("vacuum_clean");
    expect(VACUUM_CLEAN.properties.map((p) => p.name)).toEqual([
      "power",
      "activity",
      "volume",
      "battery",
      "voicePack",
      "cleanType",
      "errorCode",
      "workStatus",
      "workMode",
      "cleaningStrength",
      "mopWater",
      "clearTime",
      "clearArea",
      "loudness",
      "lifetimeCleanTime",
      "lifetimeCleanArea",
      "waterTank",
      "mopPad",
      "childLock",
      "sideBrushHours",
      "doNotDisturb",
      "scheduleCount",
      "sceneCount",
      "rssi",
      "resumeClean",
    ]);
  });

  it("is a vacuum-codec baseline", () => {
    expect(VACUUM_CLEAN.detection?.codecs).toEqual(["vacuum"]);
  });

  /**
   * `coerce` runs at ingest and would have no codec in scope; `decode` runs inside the getter, which is
   * the only place the injected `RawDpCodec` exists. The schema must therefore carry NO ingest decode.
   */
  it("decodes activity at read time, not at ingest — the codec only exists once bound", () => {
    expect(VACUUM_CLEAN.properties.find((p) => p.name === "activity")?.decode).toBeUndefined();
    const activity = VACUUM_CLEAN.members!.activity as { decode?: unknown; decodedValues?: readonly unknown[] };
    expect(activity.decode).toBeTypeOf("function");
    expect(activity.decodedValues).toContain("docked");
  });
});

describe("decodeVacuumActivity (WorkStatus.state → activity)", () => {
  it("maps the confirmed state enum", () => {
    expect(decodeVacuumActivity("payload", workStatus(0))).toBe("idle");
    expect(decodeVacuumActivity("payload", workStatus(1))).toBe("idle");
    expect(decodeVacuumActivity("payload", workStatus(2))).toBe("error");
    expect(decodeVacuumActivity("payload", workStatus(3))).toBe("docked");
    expect(decodeVacuumActivity("payload", workStatus(5))).toBe("cleaning");
    expect(decodeVacuumActivity("payload", workStatus(7))).toBe("returning");
  });

  it("has no state above the vendor enum's last member — 15 is not a state a device can report", () => {
    expect(decodeVacuumActivity("payload", workStatus(9))).toBe("unknown");
    expect(decodeVacuumActivity("payload", workStatus(15))).toBe("unknown");
  });

  it("picks field #2 out of a full frame, ignoring the fields around it", () => {
    const frame = fakeCodec([
      { field: 1, kind: "int", value: 12n },
      { field: 2, kind: "int", value: 3n },
      { field: 3, kind: "bytes", value: Buffer.from([0x1a, 0x00]) },
      { field: 14, kind: "bytes", value: Buffer.alloc(0) },
    ]);
    expect(decodeVacuumActivity("payload", frame)).toBe("docked");
  });

  it("returns 'unknown' for an unmapped state", () => {
    expect(decodeVacuumActivity("payload", workStatus(99))).toBe("unknown");
  });

  it("returns 'unknown' when the payload is undecodable or carries no state field", () => {
    expect(decodeVacuumActivity("payload", fakeCodec(undefined))).toBe("unknown");
    expect(decodeVacuumActivity("payload", fakeCodec([]))).toBe("unknown");
    expect(decodeVacuumActivity("payload", fakeCodec([{ field: 2, kind: "bytes", value: Buffer.alloc(1) }]))).toBe(
      "unknown",
    );
  });

  it("returns 'unknown' without a codec — an unbound device never guesses", () => {
    expect(decodeVacuumActivity("payload", undefined)).toBe("unknown");
  });

  it("returns 'unknown' for a non-string value", () => {
    expect(decodeVacuumActivity(undefined, workStatus(3))).toBe("unknown");
    expect(decodeVacuumActivity(7, workStatus(3))).toBe("unknown");
  });
});

/** `WorkStatus.state` = CLEANING(5), plus whichever sub-messages the fixture states. */
function cleaningFrame(...subs: number[][]): string {
  return frame([...int(2, 5), ...subs.flat()]);
}

/**
 * State 5 is the vendor's catch-all for "off the dock or servicing mops", and separating its members is
 * the whole point of reading the sub-messages. Each case here is a physical situation a T2351 reaches.
 */
describe("decodeVacuumActivity — WorkStatus state 5 sub-states", () => {
  it("is cleaning when no sub-message narrows it", () => {
    expect(decodeVacuumActivity(cleaningFrame(), byteCodec)).toBe("cleaning");
  });

  it("is paused when the cleaning job reports PAUSED", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(6, int(1, 1))), byteCodec)).toBe("paused");
  });

  it("is cleaning when the cleaning job is present but running — an empty sub-message means DOING", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(6, [])), byteCodec)).toBe("cleaning");
  });

  it("is docked while the dock washes or dries the mops", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(7, int(2, 1))), byteCodec)).toBe("docked");
    expect(decodeVacuumActivity(cleaningFrame(sub(7, int(2, 2))), byteCodec)).toBe("docked");
  });

  it("is still cleaning while DRIVING to the dock to wash — navigation is not arrival", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(7, [])), byteCodec)).toBe("cleaning");
  });

  it("is docked when the station reports a washing/drying cycle", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(14, sub(3, []))), byteCodec)).toBe("docked");
  });

  it("is cleaning when the station is reported but idle", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(14, [])), byteCodec)).toBe("cleaning");
  });

  it("prefers the dock over the pause — a robot that paused itself to go wash reports both", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(6, int(1, 1)), sub(7, int(2, 1))), byteCodec)).toBe("docked");
  });

  it("refines only state 5 — every other state answers from the state field alone", () => {
    expect(decodeVacuumActivity(frame([...int(2, 3), ...sub(6, int(1, 1))]), byteCodec)).toBe("docked");
    expect(decodeVacuumActivity(frame([...int(2, 7), ...sub(7, int(2, 2))]), byteCodec)).toBe("returning");
  });

  it("falls back to cleaning on a frame whose sub-messages it cannot read", () => {
    expect(decodeVacuumActivity(cleaningFrame(sub(6, [0xff])), byteCodec)).toBe("cleaning");
  });
});

/**
 * `CleanParam` (DP 154) → cleaning type. Fixtures are synthesized to the SHAPES a live T2351 emits: it
 * sends all four `CleanParamResponse` containers on every report, present-but-empty when unset, so the
 * decode has to lean on the presence of the fields inside rather than on the container.
 */
function cleanParam(fields: readonly RawDpField[]): RawDpCodec {
  return {
    decode: () => fields,
    nested: (v: Buffer) => (v.length ? [{ field: 1, kind: "int", value: BigInt(v[0]) }] : []),
  };
}
/** The configured container holding an explicit `clean_type.value`. */
function configuredType(value: number): RawDpCodec {
  return {
    decode: () => [{ field: 1, kind: "bytes", value: Buffer.from([0xff]) }],
    nested: (v: Buffer) =>
      v[0] === 0xff
        ? [{ field: 1, kind: "bytes", value: Buffer.from([value]) }]
        : [{ field: 1, kind: "int", value: BigInt(v[0]) }],
  };
}

describe("decodeCleanType (CleanParam.clean_type → cleanType)", () => {
  it("maps the types observed live", () => {
    expect(decodeCleanType("payload", configuredType(1))).toBe("mop");
    expect(decodeCleanType("payload", configuredType(2))).toBe("sweepAndMop");
  });

  it("reads an explicit zero as sweep", () => {
    expect(decodeCleanType("payload", configuredType(0))).toBe("sweep");
  });

  it("returns undefined when the configured container is present but empty", () => {
    expect(
      decodeCleanType("payload", cleanParam([{ field: 1, kind: "bytes", value: Buffer.alloc(0) }])),
    ).toBeUndefined();
  });

  it("returns undefined when the configured container is absent — no fabricated sweep", () => {
    expect(
      decodeCleanType("payload", cleanParam([{ field: 4, kind: "bytes", value: Buffer.from([1]) }])),
    ).toBeUndefined();
    expect(decodeCleanType("payload", cleanParam([]))).toBeUndefined();
  });

  it("returns undefined for an unmapped type, a bad payload, or no codec", () => {
    expect(decodeCleanType("payload", configuredType(9))).toBeUndefined();
    expect(decodeCleanType("payload", fakeCodec(undefined))).toBeUndefined();
    expect(decodeCleanType("payload", undefined)).toBeUndefined();
    expect(decodeCleanType(7, configuredType(1))).toBeUndefined();
  });
});

/**
 * The derived surface, pinned at COMPILE time. The decoded reads are the interesting half: a `decode`'s
 * declared return type wins over the stored `type`, so `activity` surfaces the named union rather than
 * the `string` the DP is stored as. Widening either decode would fail the build here.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
declare const vac: VacuumCleanActions;

const _power: Exact<typeof vac.power, boolean | undefined> = true;
const _battery: Exact<typeof vac.battery, number | undefined> = true;
const _activity: Exact<typeof vac.activity, VacuumActivity | undefined> = true;
const _cleanType: Exact<typeof vac.cleanType, VacuumCleanType | TuyaCleanType | undefined> = true;

// setPower is gated by paramIds.has(151) — optional on the surface (absent until DP 151 is reported).
const _setPowerOptional: Exact<undefined extends typeof vac.setPower ? true : false, true> = true;
const _setPowerArg: Exact<Parameters<NonNullable<typeof vac.setPower>>[0], boolean> = true;

// Read-only members get no setter — nothing writes the activity or the battery back.
const _noSetActivity: Exact<"setActivity" extends keyof VacuumCleanActions ? true : false, false> = true;
const _noSetBattery: Exact<"setBattery" extends keyof VacuumCleanActions ? true : false, false> = true;

// startCleaning is a MethodMember gated by isAiotVacuum or DP 2 in paramIds — absent only on Tuya-category devices that haven't reported DP 2.
const _startCleaning: Exact<typeof vac.startCleaning, (() => Promise<void>) | undefined> = true;

// errorCode is an evidence-gated read for the legacy Tuya clean line.
const _errorCode: Exact<typeof vac.errorCode, number | undefined> = true;

// doNotDisturb and rssi are DP-gated reads — absent until DPs 107 / 134 are reported.
const _doNotDisturb: Exact<typeof vac.doNotDisturb, boolean | undefined> = true;
// A `readsFrom` member derives its surface type from its own `decode`, exactly as an owning one does.
const _doNotDisturbActive: Exact<typeof vac.doNotDisturbActive, boolean | undefined> = true;
const _rssi: Exact<typeof vac.rssi, number | undefined> = true;

// The voice pack and the volume are AIoT-only READS. Neither ships a setter. For the volume the write
// direction rests on the product schema's `writable: true` alone, with no live publishDps capture, and
// an AIoT dp write dispatches for real rather than being refused by a router guard. For the voice pack
// the write is not a setter's shape at all — it carries a CDN url and an md5 the device verifies.
const _voicePack: Exact<typeof vac.voicePack, number | undefined> = true;
const _voicePackState: Exact<typeof vac.voicePackState, VoicePackState | undefined> = true;
const _volume: Exact<typeof vac.volume, number | undefined> = true;

export const _surfaceAssertions = [
  _power,
  _battery,
  _activity,
  _cleanType,
  _setPowerOptional,
  _setPowerArg,
  _noSetActivity,
  _noSetBattery,
  _startCleaning,
  _errorCode,
  _doNotDisturb,
  _doNotDisturbActive,
  _rssi,
  _voicePack,
  _voicePackState,
  _volume,
];

/**
 * `ErrorCode` (DP 177). Both code lists are `repeated uint32`, which proto3 encodes PACKED by
 * default — one length-delimited run of varints, not one field per value. A sender may still emit the
 * unpacked form, so both are exercised against real bytes.
 */
/** A packed `repeated uint32` field: one length-delimited run of concatenated varints. */
function packed(field: number, values: readonly number[]): number[] {
  return sub(
    field,
    values.flatMap((v) => varint(v)),
  );
}

describe("decodeVacuumFault (ErrorCode → fault code)", () => {
  it("reads the first packed error code", () => {
    expect(decodeVacuumFault(frame(packed(2, [77])), byteCodec)).toBe(77);
    expect(decodeVacuumFault(frame(packed(2, [77, 3, 21])), byteCodec)).toBe(77);
  });

  it("reads a multi-byte code — the station and situational ranges are all above 127", () => {
    expect(decodeVacuumFault(frame(packed(2, [6113])), byteCodec)).toBe(6113);
    expect(decodeVacuumFault(frame(packed(3, [7055])), byteCodec)).toBe(7055);
  });

  it("reads the unpacked encoding too — a sender may emit either", () => {
    expect(decodeVacuumFault(frame(int(2, 40)), byteCodec)).toBe(40);
  });

  it("falls back to the first warning when no error is listed", () => {
    expect(decodeVacuumFault(frame(packed(3, [50, 51])), byteCodec)).toBe(50);
  });

  it("prefers an error over a warning — a fault that stops the robot is the more urgent answer", () => {
    expect(decodeVacuumFault(frame([...packed(2, [77]), ...packed(3, [50])]), byteCodec)).toBe(77);
  });

  it("is 0 when the device states no fault, including an empty list", () => {
    expect(decodeVacuumFault(frame([]), byteCodec)).toBe(0);
    expect(decodeVacuumFault(frame(packed(2, [])), byteCodec)).toBe(0);
    expect(decodeVacuumFault(frame([...packed(2, []), ...packed(3, [])]), byteCodec)).toBe(0);
  });

  it("ignores the fields around the code lists", () => {
    expect(decodeVacuumFault(frame([...int(1, 999), ...packed(2, [21]), ...sub(4, [])]), byteCodec)).toBe(21);
  });

  it("reads the legacy Tuya line's plain integer on the same property", () => {
    expect(decodeVacuumFault(0, byteCodec)).toBe(0);
    expect(decodeVacuumFault(106, byteCodec)).toBe(106);
    expect(decodeVacuumFault("77", byteCodec)).toBe(77);
    expect(decodeVacuumFault(3, undefined)).toBe(3);
  });

  it("is undefined when the device has not stated a fault at all", () => {
    expect(decodeVacuumFault(undefined, byteCodec)).toBeUndefined();
    expect(decodeVacuumFault(frame(packed(2, [77])), undefined)).toBeUndefined();
    expect(decodeVacuumFault("!!not-base64!!", byteCodec)).toBeUndefined();
  });
});

/**
 * `UndisturbedResponse` (DP 157) and `CleanStatistics` (DP 167). Both wrap their payload one or two
 * containers deep, and both rely on proto3 omitting zero values — so an empty container is a real
 * answer (off / no elapsed time), while an absent one is the device not answering.
 */
describe("decodeUnisetting (UnisettingResponse toggles)", () => {
  const CHILD_LOCK = 1;
  const MULTI_MAP = 3;
  const SMART_FOLLOW = 13;

  it("reads a switch through its wrapper", () => {
    expect(decodeUnisetting(frame(sub(CHILD_LOCK, int(1, 1))), byteCodec, CHILD_LOCK)).toBe(true);
  });

  it("reads an omitted zero as off", () => {
    expect(decodeUnisetting(frame(sub(CHILD_LOCK, [])), byteCodec, CHILD_LOCK)).toBe(false);
  });

  it("reads each toggle out of one message without disturbing the others", () => {
    // The whole point of one message carrying fifteen settings: every member reads its own field of
    // the same payload, and a field it does not name must not leak into its answer.
    const payload = frame([...sub(CHILD_LOCK, int(1, 1)), ...sub(MULTI_MAP, []), ...sub(SMART_FOLLOW, int(1, 1))]);
    expect(decodeUnisetting(payload, byteCodec, CHILD_LOCK)).toBe(true);
    expect(decodeUnisetting(payload, byteCodec, MULTI_MAP)).toBe(false);
    expect(decodeUnisetting(payload, byteCodec, SMART_FOLLOW)).toBe(true);
    // Field 9 is absent from this payload — not reported, which is not the same as off.
    expect(decodeUnisetting(payload, byteCodec, 9)).toBeUndefined();
  });

  it("is undefined when the setting is not reported at all", () => {
    expect(decodeUnisetting(frame(sub(MULTI_MAP, int(1, 1))), byteCodec, CHILD_LOCK)).toBeUndefined();
    expect(decodeUnisetting(frame(sub(CHILD_LOCK, int(1, 1))), undefined, CHILD_LOCK)).toBeUndefined();
    expect(decodeUnisetting(undefined, byteCodec, CHILD_LOCK)).toBeUndefined();
  });
});

describe("decodeLanguageField (LanguageResponse → voice pack)", () => {
  // What the property this replaced actually held. DP 162 is Raw in both directions, so the old
  // `language` read published this base64 typed as a locale code — a value no caller could use and
  // none would recognise as wrong at a glance, since a string property answering a string looks fine.
  const response = frame([...int(1, 1), ...int(2, 7), ...int(3, 22), ...int(5, 2)]);

  it("reads each field of the response", () => {
    expect(decodeLanguageField(response, byteCodec, 1)).toBe(1);
    expect(decodeLanguageField(response, byteCodec, 2)).toBe(7);
    expect(decodeLanguageField(response, byteCodec, 3)).toBe(22);
    expect(decodeLanguageField(response, byteCodec, 5)).toBe(2);
  });

  it("reads an absent field as the proto3 zero, not as missing", () => {
    // A robot on its shipped voice pack sends no `current_id` at all: the id is 0 and proto3 omits it.
    // Reading that as `undefined` would report "this device does not tell us" about the commonest case
    // there is.
    expect(decodeLanguageField(frame([...int(1, 3)]), byteCodec, 2)).toBe(0);
  });

  it("refuses a payload it cannot parse, and one with no codec", () => {
    expect(decodeLanguageField("en", byteCodec, 2)).toBeUndefined();
    expect(decodeLanguageField(response, undefined, 2)).toBeUndefined();
    expect(decodeLanguageField(undefined, byteCodec, 2)).toBeUndefined();
  });

  it("names the download states in the vendor's order", () => {
    expect(VOICE_PACK_STATES).toEqual(["idle", "updating", "success", "failure"]);
  });
});

describe("decodeConsumableHours (ConsumableRuntime parts)", () => {
  const SIDE_BRUSH = 1;
  const MOP = 6;
  const DIRTY_WATERTANK = 10;
  /**
   * The report WRAPS the runtime block at field 1 — the parts sit one level down, not at the top.
   *
   * Every fixture here reached through the top level until a live T2351 report showed otherwise, and
   * the decode agreed with them, so these tests passed while the feature answered `undefined` on real
   * hardware. That is the mistake a synthetic fixture cannot catch alone: it can only ever confirm the
   * assumption it was written from.
   */
  const report = (parts: number[]): string => frame(sub(1, parts));

  it("reads a part's hours through the runtime wrapper and its Duration", () => {
    expect(decodeConsumableHours(report(sub(SIDE_BRUSH, int(1, 42))), byteCodec, SIDE_BRUSH)).toBe(42);
  });

  it("reads a fitted-but-unused part as 0, not as missing", () => {
    expect(decodeConsumableHours(report(sub(MOP, [])), byteCodec, MOP)).toBe(0);
  });

  it("reads each part out of one message, and respects the gap at 8 and 9", () => {
    // The vendor leaves 8 and 9 unused; a live report carries 1-7 and then jumps past them.
    const payload = report([
      ...sub(SIDE_BRUSH, int(1, 10)),
      ...sub(MOP, int(1, 20)),
      ...sub(DIRTY_WATERTANK, int(1, 30)),
    ]);
    expect(decodeConsumableHours(payload, byteCodec, SIDE_BRUSH)).toBe(10);
    expect(decodeConsumableHours(payload, byteCodec, MOP)).toBe(20);
    expect(decodeConsumableHours(payload, byteCodec, DIRTY_WATERTANK)).toBe(30);
    expect(decodeConsumableHours(payload, byteCodec, 8)).toBeUndefined();
    expect(decodeConsumableHours(payload, byteCodec, 9)).toBeUndefined();
  });

  it("reads the real shape a T2351 sends", () => {
    // Trimmed from a live report: runtime(1) wrapping side_brush(1)=77h, rolling_brush(2)=19h and a
    // present-but-zero mop(6). Read at the top level this finds the wrapper where a part should be
    // and answers undefined for every counter — which is what shipped before this capture.
    const live = report([...sub(1, int(1, 77)), ...sub(2, int(1, 19)), ...sub(6, [])]);
    expect(decodeConsumableHours(live, byteCodec, 1)).toBe(77);
    expect(decodeConsumableHours(live, byteCodec, 2)).toBe(19);
    expect(decodeConsumableHours(live, byteCodec, 6)).toBe(0);
  });

  it("is undefined for a part this robot does not track", () => {
    expect(decodeConsumableHours(report(sub(SIDE_BRUSH, int(1, 5))), byteCodec, MOP)).toBeUndefined();
    expect(decodeConsumableHours(report(sub(SIDE_BRUSH, int(1, 5))), undefined, SIDE_BRUSH)).toBeUndefined();
    expect(decodeConsumableHours(undefined, byteCodec, SIDE_BRUSH)).toBeUndefined();
  });

  it("is undefined when the runtime wrapper is missing altogether", () => {
    expect(decodeConsumableHours(frame(sub(SIDE_BRUSH, int(1, 5))), byteCodec, SIDE_BRUSH)).toBeUndefined();
  });
});

describe("decodeDoNotDisturb (Undisturbed.sw → doNotDisturb)", () => {
  /** `UndisturbedResponse.undisturbed.sw.value` = on, with the live `active` flag beside it. */
  const dnd = (on: boolean): string => frame([...sub(1, int(1, 1)), ...sub(2, sub(1, on ? int(1, 1) : []))]);

  it("reads the switch through both wrapper messages", () => {
    expect(decodeDoNotDisturb(dnd(true), byteCodec)).toBe(true);
  });

  it("reads an omitted zero as off, at either level", () => {
    expect(decodeDoNotDisturb(dnd(false), byteCodec)).toBe(false);
    expect(decodeDoNotDisturb(frame(sub(2, [])), byteCodec)).toBe(false);
  });

  it("reads the switch, not the live in-window flag", () => {
    // active(1) = true while the window is open, but the feature itself is off. The property means
    // "is it enabled", so this has to answer false.
    expect(decodeDoNotDisturb(frame([...sub(1, int(1, 1)), ...sub(2, sub(1, []))]), byteCodec)).toBe(false);
  });

  it("reads the Tuya line's plain bool on the same property", () => {
    expect(decodeDoNotDisturb(true, byteCodec)).toBe(true);
    expect(decodeDoNotDisturb(false, byteCodec)).toBe(false);
    expect(decodeDoNotDisturb("true", undefined)).toBe(true);
    expect(decodeDoNotDisturb(1, undefined)).toBe(true);
    expect(decodeDoNotDisturb("0", undefined)).toBe(false);
  });

  it("is undefined when the device has not stated a window at all", () => {
    expect(decodeDoNotDisturb(frame([]), byteCodec)).toBeUndefined();
    expect(decodeDoNotDisturb(dnd(true), undefined)).toBeUndefined();
    expect(decodeDoNotDisturb(undefined, byteCodec)).toBeUndefined();
  });
});

describe("decodeDoNotDisturbActive (Undisturbed.active → doNotDisturbActive)", () => {
  /** The same payload shape the switch decode is exercised with: `active`(1) beside `undisturbed`(2). */
  const window = (active: number[]): string => frame([...sub(1, active), ...sub(2, sub(1, int(1, 1)))]);

  it("reads the live flag through a Switch wrapper", () => {
    expect(decodeDoNotDisturbActive(window(int(1, 1)), byteCodec)).toBe(true);
  });

  it("reads a bare varint too, since which shape the vendor sends is not confirmed", () => {
    // Both readings mean the same flag, so accepting either is what removes the guess rather than
    // adding one — a wrapper whose value is omitted, and a bare zero, are both "not open".
    expect(decodeDoNotDisturbActive(frame([...int(1, 1), ...sub(2, [])]), byteCodec)).toBe(true);
    expect(decodeDoNotDisturbActive(window([]), byteCodec)).toBe(false);
  });

  it("reads an omitted flag beside a stated window as closed, not as missing", () => {
    expect(decodeDoNotDisturbActive(frame(sub(2, sub(1, int(1, 1)))), byteCodec)).toBe(false);
  });

  it("answers the window, not the switch — the two disagree for most of the day", () => {
    // The feature is ON (sw.value = 1) but the quiet hours have not started. Reading the switch here
    // would tell a caller the robot is being quiet when it is not.
    expect(decodeDoNotDisturb(window([]), byteCodec)).toBe(true);
    expect(decodeDoNotDisturbActive(window([]), byteCodec)).toBe(false);
  });

  it("is undefined on anything that is not an UndisturbedResponse", () => {
    // The Tuya line's DP 107 is a plain bool carrying the SWITCH; borrowing it would answer a
    // different question than the one asked.
    expect(decodeDoNotDisturbActive(true, byteCodec)).toBeUndefined();
    expect(decodeDoNotDisturbActive("1", byteCodec)).toBeUndefined();
    expect(decodeDoNotDisturbActive(frame([]), byteCodec)).toBeUndefined();
    expect(decodeDoNotDisturbActive(window(int(1, 1)), undefined)).toBeUndefined();
    expect(decodeDoNotDisturbActive(undefined, byteCodec)).toBeUndefined();
  });
});

describe("decodeCleanParamValue (CleanParam settings beside clean_type)", () => {
  const CARPET = 2;
  const EXTENT = 3;
  const TIMES = 7;
  /** `clean_param`(1) wrapping the settings, as the device reports them. */
  const param = (body: number[]): string => frame(sub(1, body));

  it("reads a setting through its single-field wrapper", () => {
    expect(decodeCleanParamValue(param(sub(CARPET, int(1, 1))), byteCodec, CARPET)).toBe(1);
  });

  it("reads the wrapper's scalar wherever the vendor numbered it", () => {
    // The point of taking the first varint rather than asserting an inner field number: the wrapper's
    // field is named differently per setting (`value`, `strategy`, …) and this must not depend on that.
    expect(decodeCleanParamValue(param(sub(EXTENT, int(3, 2))), byteCodec, EXTENT)).toBe(2);
  });

  it("reads a present-but-empty wrapper as the zero member, not as missing", () => {
    expect(decodeCleanParamValue(param(sub(CARPET, [])), byteCodec, CARPET)).toBe(0);
    expect(decodeCleanParamValue(param(sub(CARPET, sub(9, []))), byteCodec, CARPET)).toBe(0);
  });

  it("reads a bare scalar too, for a setting the vendor did not wrap", () => {
    expect(decodeCleanParamValue(param(int(TIMES, 2)), byteCodec, TIMES)).toBe(2);
  });

  it("gives each setting its own answer out of the one payload", () => {
    const payload = param([...sub(1, int(1, 1)), ...sub(CARPET, int(1, 2)), ...sub(EXTENT, [])]);
    expect(decodeCleanParamValue(payload, byteCodec, CARPET)).toBe(2);
    expect(decodeCleanParamValue(payload, byteCodec, EXTENT)).toBe(0);
    // Not stated in this report — absent is not the same as the zero member.
    expect(decodeCleanParamValue(payload, byteCodec, TIMES)).toBeUndefined();
  });

  it("reads the CONFIGURED container, never the running one", () => {
    // running_clean_param(4) disagrees with the setting mid-change; reading it would report what the
    // job in progress is doing as though the user had chosen it.
    const payload = frame([...sub(1, sub(CARPET, int(1, 1))), ...sub(4, sub(CARPET, int(1, 2)))]);
    expect(decodeCleanParamValue(payload, byteCodec, CARPET)).toBe(1);
  });

  it("is undefined on anything that is not a CleanParam", () => {
    expect(decodeCleanParamValue(frame([]), byteCodec, CARPET)).toBeUndefined();
    expect(decodeCleanParamValue(param(sub(CARPET, int(1, 1))), undefined, CARPET)).toBeUndefined();
    expect(decodeCleanParamValue(true, byteCodec, CARPET)).toBeUndefined();
    expect(decodeCleanParamValue(undefined, byteCodec, CARPET)).toBeUndefined();
  });
});

/**
 * `encodeCleanParam` — the write side of DP 154, stated against the same byte fixtures the reads use.
 *
 * Expectations are BUILT from those helpers rather than hand-rolled buffers, which is what makes them
 * an independent statement of the wire: `int` omits a zero and `sub` always emits, and those are the
 * two proto3 rules the encoder is written to.
 */
describe("encodeCleanParam (CleanParamRequest.clean_param, DP 154)", () => {
  const CONFIGURED = 1;
  const TYPE = 1;
  const EXTENT = 3;
  const MOP = 4;
  const VALUE = 1;

  it("states all three settings inside one clean_param", () => {
    expect(encodeCleanParam("mop", "narrow", "high")).toBe(
      frame(sub(CONFIGURED, [...sub(TYPE, int(VALUE, 1)), ...sub(EXTENT, int(VALUE, 1)), ...sub(MOP, int(VALUE, 2))])),
    );
  });

  it("writes a zero member as a present-but-empty wrapper, per proto3", () => {
    expect(encodeCleanParam("sweep", "normal", "low")).toBe(
      frame(sub(CONFIGURED, [...sub(TYPE, []), ...sub(EXTENT, []), ...sub(MOP, [])])),
    );
  });

  it("states every setting on every write — a CleanParam carries all three", () => {
    const sent = encodeCleanParam("sweepThenMop", "normal", "high");
    expect(decodeCleanParamValue(sent, byteCodec, TYPE)).toBe(3);
    expect(decodeCleanParamValue(sent, byteCodec, EXTENT)).toBe(0);
    expect(decodeCleanParamValue(sent, byteCodec, MOP)).toBe(2);
  });

  it("never writes clean_times, so the robot keeps its configured pass count", () => {
    const CLEAN_TIMES = 7;
    expect(decodeCleanParamValue(encodeCleanParam("mop", "quick", "high"), byteCodec, CLEAN_TIMES)).toBeUndefined();
  });

  it("round-trips through the reads that observe it", () => {
    const sent = encodeCleanParam("sweepAndMop", "quick", "middle");
    expect(decodeCleanType(sent, byteCodec)).toBe("sweepAndMop");
    expect(decodeCleanParamValue(sent, byteCodec, EXTENT)).toBe(2);
  });
});

describe("CleanParam settings on the bound surface", () => {
  const dps = new Set([VACUUM_DP.CLEAN_PARAM]);
  const payload = frame(
    sub(1, [...sub(1, int(1, 1)), ...sub(2, int(1, 1)), ...sub(3, []), ...sub(5, int(1, 1)), ...sub(7, int(1, 2))]),
  );

  const bound = () =>
    bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, dps), {
      rawDp: byteCodec,
      read: (name) => (name === "cleanType" ? { value: payload } : undefined),
    });

  it("answers every setting off the one DP 154 report", () => {
    const acts = bound().acts;
    expect(acts.cleanType).toBe("mop");
    expect(acts.carpetStrategy).toBe("avoid");
    expect(acts.cleanExtent).toBe("normal");
    expect(acts.smartMode).toBe(true);
    expect(acts.cleanTimes).toBe(2);
  });

  it("publishes one property for DP 154, however many members read it", () => {
    const named = VACUUM_CLEAN.properties.filter((p) => p.paramType === VACUUM_DP.CLEAN_PARAM).map((p) => p.name);
    expect(named).toEqual(["cleanType"]);
  });

  it("grows no setters — the whole message would have to be re-encoded to write one field", () => {
    const acts = bound().acts as Record<string, unknown>;
    for (const name of ["setCarpetStrategy", "setCleanExtent", "setSmartMode", "setCleanTimes"]) {
      expect(acts[name]).toBeUndefined();
    }
  });
});

describe("one payload, many reads — DP 176 settings and DP 168 consumables", () => {
  const settings = frame([...sub(1, int(1, 1)), ...sub(3, []), ...sub(13, int(1, 1))]);
  // runtime(1) wraps the parts — the shape a live T2351 actually sends.
  const consumables = frame(sub(1, [...sub(1, int(1, 120)), ...sub(6, []), ...sub(10, int(1, 30))]));
  const dps = new Set([VACUUM_DP.SETTINGS, VACUUM_DP.CONSUMABLES]);

  const bound = () =>
    bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, dps), {
      rawDp: byteCodec,
      read: (name) =>
        name === "childLock" ? { value: settings } : name === "sideBrushHours" ? { value: consumables } : undefined,
    });

  it("gives every settings toggle its own answer off the one DP 176 report", () => {
    const acts = bound().acts;
    expect(acts.childLock).toBe(true);
    expect(acts.multiMap).toBe(false);
    expect(acts.smartFollow).toBe(true);
    // Reported by neither the fixture nor the device — absent, which is not "off".
    expect(acts.livePhoto).toBeUndefined();
  });

  it("gives every consumable counter its own answer off the one DP 168 report", () => {
    const acts = bound().acts;
    expect(acts.sideBrushHours).toBe(120);
    expect(acts.mopHours).toBe(0);
    expect(acts.dirtyWaterTankHours).toBe(30);
    expect(acts.dustBagHours).toBeUndefined();
  });

  it("publishes exactly one property per DP, however many members read it", () => {
    // Eighteen getters over two data points. The schema still describes two reports, because that is
    // what the device sends — the extra readings are derived, not extra wire claims.
    const named = (dp: number) => VACUUM_CLEAN.properties.filter((p) => p.paramType === dp).map((p) => p.name);
    expect(named(VACUUM_DP.SETTINGS)).toEqual(["childLock"]);
    expect(named(VACUUM_DP.CONSUMABLES)).toEqual(["sideBrushHours"]);
  });

  it("installs none of them on a device that never reported the DP", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, new Set()), {
      rawDp: byteCodec,
    });
    expect(acts.childLock).toBeUndefined();
    expect(acts.smartFollow).toBeUndefined();
    expect(acts.sideBrushHours).toBeUndefined();
    expect(acts.mopHours).toBeUndefined();
  });

  it("grows no setters — every one of these is a read", () => {
    const acts = bound().acts as Record<string, unknown>;
    for (const name of ["setChildLock", "setMultiMap", "setSmartFollow", "setSideBrushHours", "setMopHours"]) {
      expect(acts[name]).toBeUndefined();
    }
  });
});

describe("doNotDisturbActive — a second reading of one DP (`readsFrom`)", () => {
  const payload = frame([...sub(1, int(1, 1)), ...sub(2, sub(1, int(1, 1)))]);
  const aiotDnd = new Set([VACUUM_DP.DO_NOT_DISTURB]);

  it("decodes the OWNER's stored property, not one named after itself", () => {
    // The whole point of the mechanism: `Device` stores DP 157 under `doNotDisturb`, so a getter
    // reading `doNotDisturbActive` would find nothing and answer undefined forever.
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, aiotDnd), {
      rawDp: byteCodec,
      read: (name) => (name === "doNotDisturb" ? { value: payload } : undefined),
    });
    expect(acts.doNotDisturb).toBe(true);
    expect(acts.doNotDisturbActive).toBe(true);
  });

  it("publishes no property of its own — DP 157 stays owned by one spec", () => {
    // A second spec for the same id is what `Device.specByParam` drops on the floor, and what the
    // one-owner guard exists to catch. The reading is derived; the param is not claimed twice.
    const forDp157 = VACUUM_CLEAN.properties.filter((p) => p.paramType === VACUUM_DP.DO_NOT_DISTURB);
    expect(forDp157.map((p) => p.name)).toEqual(["doNotDisturb"]);
  });

  it("is absent on a device that reports only the Tuya switch", () => {
    // DP 107 carries the switch and says nothing about the window, so the owner's read alias must not
    // drag this getter onto a device that cannot answer it.
    const tuyaOnly = new Set([TUYA_VACUUM_DP.FORBID_MODE]);
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home_tuya", tuyaOnly), {
      rawDp: byteCodec,
      read: (name) => (name === "doNotDisturb" ? { value: true } : undefined),
    });
    expect(acts.doNotDisturb).toBe(true);
    expect(acts.doNotDisturbActive).toBeUndefined();
  });

  it("grows no setter — a field inside a shared payload cannot be written on its own", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, aiotDnd), {
      rawDp: byteCodec,
    });
    expect((acts as Record<string, unknown>).setDoNotDisturbActive).toBeUndefined();
  });
});

describe("decodeCleanStat (CleanStatistics — the run beside the lifetime totals)", () => {
  it("reads the current run's duration", () => {
    expect(decodeCleanStat(frame(sub(1, int(1, 4200))), byteCodec, 1, 1)).toBe(4200);
  });

  it("reads a started-but-zero run as 0, not as missing", () => {
    expect(decodeCleanStat(frame(sub(1, [])), byteCodec, 1, 1)).toBe(0);
  });

  it("ignores the lifetime accumulators beside it", () => {
    // total(2) and user_total(3) carry a clean_duration at the same inner field number; reading the
    // wrong container would report a lifetime figure as the current run.
    const payload = frame([...sub(1, int(1, 60)), ...sub(2, int(1, 999999)), ...sub(3, int(1, 888888))]);
    expect(decodeCleanStat(payload, byteCodec, 1, 1)).toBe(60);
  });

  it("reads the Tuya line's plain integer on the same property", () => {
    expect(decodeCleanStat(4200, byteCodec, 1, 1)).toBe(4200);
    expect(decodeCleanStat("4200", undefined, 1, 1)).toBe(4200);
    expect(decodeCleanStat(0, undefined, 1, 1)).toBe(0);
  });

  it("is undefined when the device has not stated a run", () => {
    expect(decodeCleanStat(frame([]), byteCodec, 1, 1)).toBeUndefined();
    expect(decodeCleanStat(frame(sub(1, int(1, 60))), undefined, 1, 1)).toBeUndefined();
    expect(decodeCleanStat(undefined, byteCodec, 1, 1)).toBeUndefined();
  });
});

describe("one figure, two clean lines — CleanStatistics as a second source", () => {
  /** `single{duration,area}` + `user_total{duration,area,count}`, as an AIoT robot reports them. */
  const stats = frame([
    ...sub(1, [...int(1, 600), ...int(2, 12)]),
    ...sub(3, [...int(1, 360000), ...int(2, 4200), ...int(3, 210)]),
  ]);

  it("reads every figure out of the one DP 167 report on the AIoT line", () => {
    const { acts } = bind<VacuumCleanActions>(
      "vacuum_clean",
      fakeCtx(undefined, undefined, new Set([VACUUM_DP.CLEAN_STATS])),
      {
        rawDp: byteCodec,
        read: (name) => (name === "clearTime" ? { value: stats } : undefined),
      },
    );
    expect(acts.clearTime).toBe(600);
    expect(acts.clearArea).toBe(12);
    expect(acts.lifetimeCleanTime).toBe(360000);
    expect(acts.lifetimeCleanArea).toBe(4200);
    expect(acts.lifetimeCleanCount).toBe(210);
  });

  it("keeps reading the Tuya line's own DPs under the same names", () => {
    // The point of the second source: one name per figure, whichever family the device is on. A Tuya
    // robot reports each figure on its own DP and must not be routed through the protobuf path.
    const tuyaDps = new Set([
      TUYA_VACUUM_DP.CLEAR_TIME,
      TUYA_VACUUM_DP.CLEAR_AREA,
      TUYA_VACUUM_DP.CLEAR_TOTAL_TIME,
      TUYA_VACUUM_DP.CLEAR_TOTAL_AREA,
    ]);
    const values: Record<string, number> = {
      clearTime: 600,
      clearArea: 12,
      lifetimeCleanTime: 360000,
      lifetimeCleanArea: 4200,
    };
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home_tuya", tuyaDps), {
      rawDp: byteCodec,
      read: (name) => (name in values ? { value: values[name] } : undefined),
    });
    expect(acts.clearTime).toBe(600);
    expect(acts.clearArea).toBe(12);
    expect(acts.lifetimeCleanTime).toBe(360000);
    expect(acts.lifetimeCleanArea).toBe(4200);
    // No Tuya DP carries a run count, and DP 167 is absent here — so it is not offered at all.
    expect(acts.lifetimeCleanCount).toBeUndefined();
  });

  it("prefers a member's own wire over the borrowed payload", () => {
    // A device reporting both must answer from its own DP. Borrowing is the fallback, not the default.
    const both = new Set([VACUUM_DP.CLEAN_STATS, TUYA_VACUUM_DP.CLEAR_AREA]);
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, both), {
      rawDp: byteCodec,
      read: (name) => (name === "clearTime" ? { value: stats } : name === "clearArea" ? { value: 99 } : undefined),
    });
    expect(acts.clearArea).toBe(99);
  });

  it("still publishes one property per DP — the borrowed id is not claimed twice", () => {
    const named = (dp: number) => VACUUM_CLEAN.properties.filter((p) => p.paramType === dp).map((p) => p.name);
    expect(named(VACUUM_DP.CLEAN_STATS)).toEqual(["clearTime"]);
    // Each second-source member keeps its OWN spec, which is what makes it readable on the Tuya line.
    expect(named(TUYA_VACUUM_DP.CLEAR_AREA)).toEqual(["clearArea"]);
    expect(named(TUYA_VACUUM_DP.CLEAR_TOTAL_AREA)).toEqual(["lifetimeCleanArea"]);
  });

  it("grows no setters — every one of these is an accumulator the device owns", () => {
    const { acts } = bind<VacuumCleanActions>(
      "vacuum_clean",
      fakeCtx(undefined, undefined, new Set([VACUUM_DP.CLEAN_STATS])),
      {
        rawDp: byteCodec,
      },
    );
    const a = acts as Record<string, unknown>;
    for (const n of ["setClearArea", "setLifetimeCleanTime", "setLifetimeCleanArea", "setLifetimeCleanCount"]) {
      expect(a[n]).toBeUndefined();
    }
  });
});

describe("vacuum_clean — DP-based action routing", () => {
  // AIoT device: has reported DP 151 (power) and DP 153 (work status). DP 152 (MODE_CTRL) is write-only and never in paramIds.
  const aiotDps = new Set([VACUUM_DP.POWER, VACUUM_DP.WORK_STATUS]);
  // Tuya device: has reported DP 2 (play/pause) and DP 101 (go home).
  const tuyaDps = new Set([TUYA_VACUUM_DP.PLAY_PAUSE, TUYA_VACUUM_DP.GO_HOME]);

  it("write actions are present for non-Tuya-category devices — AIoT path (isAiotVacuum)", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx("T2250", undefined, aiotDps));
    expect(acts.startCleaning).toBeDefined();
    expect(acts.returnToDock).toBeDefined();
    expect(acts.pauseCleaning).toBeDefined();
  });

  it("write actions are absent for Tuya-category device with no Tuya DPs — bootstrapping window", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home_tuya"));
    expect(acts.startCleaning).toBeUndefined();
    expect(acts.returnToDock).toBeUndefined();
    expect(acts.pauseCleaning).toBeUndefined();
  });

  it("write actions are absent on a Tuya device, even when it reported DP 2 and DP 101", () => {
    // No Tuya clean-line write has been confirmed on a device, and dispatching one would route
    // through the Tuya command router, which refuses unverified writes by default. An advertised
    // verb that throws on the happy path is worse than an absent one.
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx("T2266", "eufy_home_tuya", tuyaDps));
    expect(acts.startCleaning).toBeUndefined();
    expect(acts.returnToDock).toBeUndefined();
    expect(acts.pauseCleaning).toBeUndefined();
  });

  it("dispatches the AIoT ModeCtrl frame, never a legacy bool DP", async () => {
    const { acts, sent } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx("T2351", undefined, tuyaDps));
    await acts.startCleaning!();
    await acts.returnToDock!();
    await acts.pauseCleaning!();
    expect(sent.every((c) => (c as { dp: number }).dp === VACUUM_DP.MODE_CTRL)).toBe(true);
  });

  it("setCleanParam dispatches DP 154 — the settings report's own data point, not a mode command", async () => {
    const { acts, sent } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx("T2351", undefined, aiotDps));
    await acts.setCleanParam!("mop", "normal", "middle");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "aiot-dp", dp: VACUUM_DP.CLEAN_PARAM });
  });

  it("setCleanParam is absent on the Tuya clean line — DP 154 is an AIoT message", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx("T2266", "eufy_home_tuya", tuyaDps));
    expect(acts.setCleanParam).toBeUndefined();
  });

  it("setPower is absent on the Tuya clean line — no confirmed power DP there", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx("T2266", "eufy_home_tuya", tuyaDps));
    expect(acts.setPower).toBeUndefined();
  });

  it("setPower is present on an AIoT device that has not reported DP 151", () => {
    // DP 151 belongs to the shared AIoT product schema rather than to a device's reported set, so the
    // write is gated on the platform. Gating it on the reported DP hid it on real devices.
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx("T2351", undefined, new Set()));
    expect(acts.setPower).toBeDefined();
  });

  it("dispatches DP 151 for setPower when DP 151 is in paramIds — AIoT clean line", async () => {
    const { acts, sent } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, aiotDps));
    await acts.setPower!(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "aiot-dp", dp: 151, value: true });
  });

  it("dispatches a ModeCtrlRequest for startCleaning — AIoT path (isAiotVacuum, no legacy DP 2)", async () => {
    const { acts, sent } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, aiotDps));
    await acts.startCleaning!();
    expect(sent[0]).toMatchObject({ kind: "aiot-dp", dp: 152 });
  });

  it("doNotDisturb is read-only — setter absent even when DP 107 is in paramIds", () => {
    const dps = new Set([TUYA_VACUUM_DP.FORBID_MODE]);
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, dps));
    expect((acts as Record<string, unknown>).setDoNotDisturb).toBeUndefined();
  });

  it("doNotDisturb getter is absent when DP 107 is not in paramIds", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, aiotDps));
    expect(acts.doNotDisturb).toBeUndefined();
  });

  it("the voice pack and the volume are reads only — no setter is installed on any device", () => {
    // The write direction for DP 161 rests on the product schema's `writable: true` and no live
    // publishDps capture. Unlike a Tuya dp write, an AIoT one is not refused by a router guard — it
    // reaches the device — so the setter stays off the surface until a capture exists. DP 162's write
    // is further off than that: a `LanguageRequest.Desc` carries a CDN url and an md5 the device
    // checks, so there is no value a caller could pass a setter.
    for (const category of ["eufy_home", "eufy_home_tuya", undefined]) {
      const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, category));
      expect((acts as Record<string, unknown>).setVoicePack).toBeUndefined();
      expect((acts as Record<string, unknown>).setLanguage).toBeUndefined();
      expect((acts as Record<string, unknown>).setVolume).toBeUndefined();
    }
  });

  it("the voice pack and the volume still read on an AIoT vacuum", () => {
    const reported = new Set([VACUUM_DP.LANGUAGE, VACUUM_DP.VOLUME]);
    // A real `LanguageResponse`: default_id 1, current_id 7, version 22, state UPDATING.
    const payload = frame([...int(1, 1), ...int(2, 7), ...int(3, 22), ...int(5, 1)]);
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home", reported), {
      read: (name) => (name === "voicePack" ? { value: payload } : name === "volume" ? { value: 38 } : undefined),
      rawDp: byteCodec,
    });

    expect(acts.voicePack).toBe(7);
    expect(acts.defaultVoicePack).toBe(1);
    expect(acts.voicePackVersion).toBe(22);
    expect(acts.voicePackState).toBe("updating");
    expect(acts.volume).toBe(38);
  });
});

describe("UnisettingResponse.unistate — device state, two levels down", () => {
  const UNISTATE = 10;
  const MAP_VALID = 4;
  const LIVE_MAP = 6;
  const STRATEGY = 7;
  /** The toggles sit at the top of the message; these sit inside `unistate`(10). */
  const state = (body: number[]): string => frame(sub(UNISTATE, body));

  it("reads map_valid through its Active wrapper", () => {
    expect(decodeUnistateFlag(state(sub(MAP_VALID, int(1, 1))), byteCodec, MAP_VALID)).toBe(true);
    expect(decodeUnistateFlag(state(sub(MAP_VALID, [])), byteCodec, MAP_VALID)).toBe(false);
  });

  it("answers undefined when the robot reports no unistate at all", () => {
    // Distinct from `false`: one is "this robot has no usable map", the other "it did not say".
    expect(decodeUnistateFlag(frame(sub(1, int(1, 1))), byteCodec, MAP_VALID)).toBeUndefined();
  });

  it("does not confuse a top-level toggle with a unistate field of the same number", () => {
    // `ai_see` is field 4 at the TOP level and `map_valid` is field 4 inside `unistate`. A reader that
    // stepped only one level would answer one for the other, which is the whole reason this decode
    // exists separately.
    const payload = frame([...sub(4, int(1, 1)), ...sub(UNISTATE, sub(MAP_VALID, []))]);

    expect(decodeUnisetting(payload, byteCodec, 4)).toBe(true);
    expect(decodeUnistateFlag(payload, byteCodec, MAP_VALID)).toBe(false);
  });

  it("reads the live-map bitmask one level deeper again", () => {
    // base(0) | rooms(1) = 0b0011
    const payload = state(sub(LIVE_MAP, int(1, 0b0011)));
    const bits = decodeUnistateNumber(payload, byteCodec, LIVE_MAP, 1);

    expect(bits).toBe(3);
    expect((bits! & (1 << LIVE_MAP_BITS.rooms)) !== 0).toBe(true);
    expect((bits! & (1 << LIVE_MAP_BITS.pet)) !== 0).toBe(false);
  });

  it("names the vendor's bit positions rather than hard-coding shifts", () => {
    expect(LIVE_MAP_BITS).toEqual({ base: 0, rooms: 1, kitchen: 2, pet: 3 });
  });

  it("reads a bare number in unistate, and an omitted one as zero", () => {
    expect(decodeUnistateNumber(state(int(STRATEGY, 7)), byteCodec, STRATEGY)).toBe(7);
    expect(decodeUnistateNumber(state([]), byteCodec, STRATEGY)).toBe(0);
  });

  it("refuses what it cannot read", () => {
    expect(decodeUnistateFlag("nope", byteCodec, MAP_VALID)).toBeUndefined();
    expect(decodeUnistateNumber(state(int(STRATEGY, 1)), undefined, STRATEGY)).toBeUndefined();
    expect(decodeUnistateNumber(state([]), byteCodec, LIVE_MAP, 1)).toBeUndefined();
  });

  it("leaves the three fields whose polarity is unconfirmed unread", () => {
    // `mop_holder_state_l`(1), `_r`(2) and `mop_state`(5) are each a bool the vendor annotates
    // "installed or removed" without saying which is which, and the decompile has them only as data.
    // No member reads them, on purpose — a backwards bool would tell a user the mop is fitted while it
    // sits on the bench. One capture settles all three.
    const surfaced = VACUUM_CLEAN.properties.map((p) => p.name).join(" ");
    for (const guess of ["mopHolder", "mopPadLeft", "mopPadRight", "customCleanMode"]) {
      expect(surfaced).not.toContain(guess);
    }
  });
});

describe("UnisettingResponse in the shape a T2351 sends", () => {
  // Synthetic values in the field layout a live T2351 reported: the toggles at the top, `unistate` at
  // #10 with a field (#8) nothing reads, a bare signal at #11, and five more top-level fields (#16, #18,
  // #21, #22, #23) no member names. #2 and #7 are absent, as on that robot.
  const payload = frame([
    ...sub(1, int(1, 1)),
    ...sub(3, []),
    ...sub(4, int(1, 1)),
    ...sub(5, []),
    ...sub(6, int(1, 1)),
    ...sub(8, int(1, 7200)),
    ...sub(9, []),
    ...sub(10, [...sub(1, int(1, 1)), ...sub(2, []), ...sub(4, int(1, 1)), ...sub(8, [])]),
    ...int(11, 55),
    ...sub(13, []),
    ...sub(14, int(1, 1)),
    ...sub(15, int(1, 1)),
    ...sub(16, int(1, 1)),
    ...sub(18, []),
    ...sub(21, []),
    ...sub(22, int(1, 1)),
    ...sub(23, [...sub(1, []), ...sub(2, []), ...sub(3, [])]),
  ]);
  const bound = () =>
    bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, undefined, new Set([VACUUM_DP.SETTINGS])), {
      rawDp: byteCodec,
      read: (name) => (name === "childLock" ? { value: payload } : undefined),
    });

  it("answers every read, and the fields no member names change nothing", () => {
    const acts = bound().acts;
    expect(acts.childLock).toBe(true);
    expect(acts.multiMap).toBe(false);
    expect(acts.aiSee).toBe(true);
    expect(acts.waterLevelSwitch).toBe(false);
    expect(acts.suggestRestricted).toBe(true);
    expect(acts.dustFullRemindMinutes).toBe(7200);
    expect(acts.livePhoto).toBe(false);
    expect(acts.hasValidMap).toBe(true);
    expect(acts.wifiSignal).toBe(55);
    expect(acts.smartFollow).toBe(false);
    expect(acts.poopAvoidance).toBe(true);
    expect(acts.petMode).toBe(true);
  });

  it("leaves a toggle the robot does not send undefined, which is not off", () => {
    const acts = bound().acts;
    expect(acts.cruiseContinue).toBeUndefined();
    expect(acts.deepMopCorner).toBeUndefined();
    expect(acts.mapLayers).toBeUndefined();
  });
});

describe("UnisettingResponse — the fields that are not switches", () => {
  const DUST_FULL_REMIND = 8;
  const AP_SIGNAL = 11;
  const POOP_AVOIDANCE = 14;
  const PET_MODE = 15;

  it("reads dust_full_remind as the minute count it is", () => {
    // The bug this replaced: `Numerical { uint32 value = 1 }` and `Switch { bool value = 1 }` are the
    // same two bytes, so the boolean reader accepted this and answered `true` for thirty minutes.
    // Nothing errored and the number was gone.
    const payload = frame(sub(DUST_FULL_REMIND, int(1, 30)));

    expect(decodeUnisettingNumber(payload, byteCodec, DUST_FULL_REMIND)).toBe(30);
    // What the old read said about the same bytes, kept as the demonstration:
    expect(decodeUnisetting(payload, byteCodec, DUST_FULL_REMIND)).toBe(true);
  });

  it("reads a zero delay as off rather than as missing", () => {
    expect(decodeUnisettingNumber(frame(sub(DUST_FULL_REMIND, [])), byteCodec, DUST_FULL_REMIND)).toBe(0);
  });

  it("reads ap_signal_strength off the TOP level, where it has no wrapper", () => {
    // The one field of this message that is a bare uint32. Both wrapper-stepping readers miss it
    // entirely — they look for a sub-message that is not there.
    const payload = frame([...sub(PET_MODE, int(1, 1)), ...int(AP_SIGNAL, 62)]);

    expect(decodeUnisettingTopLevel(payload, byteCodec, AP_SIGNAL)).toBe(62);
    expect(decodeUnisetting(payload, byteCodec, AP_SIGNAL)).toBeUndefined();
  });

  it("reads the two toggles that were never named", () => {
    const payload = frame([...sub(POOP_AVOIDANCE, int(1, 1)), ...sub(PET_MODE, [])]);

    expect(decodeUnisetting(payload, byteCodec, POOP_AVOIDANCE)).toBe(true);
    expect(decodeUnisetting(payload, byteCodec, PET_MODE)).toBe(false);
  });

  it("refuses what it cannot read", () => {
    expect(decodeUnisettingNumber("nope", byteCodec, DUST_FULL_REMIND)).toBeUndefined();
    expect(decodeUnisettingTopLevel(undefined, byteCodec, AP_SIGNAL)).toBeUndefined();
    expect(decodeUnisettingTopLevel(frame(int(AP_SIGNAL, 5)), undefined, AP_SIGNAL)).toBeUndefined();
  });
});

describe("the do-not-disturb WINDOW (Undisturbed.begin / end)", () => {
  const BEGIN = 2;
  const END = 3;
  /** Undisturbed(2) { sw 1, begin 2 { hour 1, minute 2 }, end 3 { … } } inside the response. */
  const window = (beginHM: [number, number], endHM: [number, number]): string =>
    frame(
      sub(2, [
        ...sub(1, int(1, 1)),
        ...sub(BEGIN, [...int(1, beginHM[0]), ...int(2, beginHM[1])]),
        ...sub(END, [...int(1, endHM[0]), ...int(2, endHM[1])]),
      ]),
    );

  it("reads both ends as HH:MM", () => {
    const payload = window([22, 30], [7, 0]);

    expect(decodeDoNotDisturbTime(payload, byteCodec, BEGIN)).toBe("22:30");
    expect(decodeDoNotDisturbTime(payload, byteCodec, END)).toBe("07:00");
  });

  it("pads a single-digit hour and minute", () => {
    expect(decodeDoNotDisturbTime(window([9, 5], [9, 5]), byteCodec, BEGIN)).toBe("09:05");
  });

  it("reads midnight as a real setting, not as absent", () => {
    // Both halves are the proto3 zero, so the TimePoint is present and empty. That is a configured
    // window starting at midnight — distinct from no window at all.
    const payload = frame(sub(2, [...sub(1, int(1, 1)), ...sub(BEGIN, []), ...sub(END, int(1, 6))]));

    expect(decodeDoNotDisturbTime(payload, byteCodec, BEGIN)).toBe("00:00");
    expect(decodeDoNotDisturbTime(payload, byteCodec, END)).toBe("06:00");
  });

  it("answers undefined when no window is configured", () => {
    expect(decodeDoNotDisturbTime(frame(sub(2, sub(1, int(1, 1)))), byteCodec, BEGIN)).toBeUndefined();
    expect(decodeDoNotDisturbTime(frame([]), byteCodec, BEGIN)).toBeUndefined();
    expect(decodeDoNotDisturbTime("nope", byteCodec, BEGIN)).toBeUndefined();
  });
});

describe("WorkStatus — charging and what triggered the state", () => {
  const CHARGING = 3;
  const TRIGGER = 20;

  it("answers undefined while the robot is not charging", () => {
    // The vendor omits the whole message rather than sending a "no". Absence IS the reading, and
    // reporting it as a gap would make "not charging" indistinguishable from "did not say".
    expect(decodeChargeState(frame(int(2, 5)), byteCodec)).toBeUndefined();
  });

  it("reads a present-but-empty charging message as charging", () => {
    expect(decodeChargeState(frame(sub(CHARGING, [])), byteCodec)).toBe("charging");
  });

  it("separates a finished charge from a faulted one", () => {
    expect(decodeChargeState(frame(sub(CHARGING, int(1, 1))), byteCodec)).toBe("charged");
    // ABNORMAL: contacts touching, nothing flowing — the state `activity` reports as a contented
    // "docked" and which a user needs told about.
    expect(decodeChargeState(frame(sub(CHARGING, int(1, 2))), byteCodec)).toBe("fault");
  });

  it("reads the trigger source", () => {
    expect(decodeTriggerSource(frame(sub(TRIGGER, int(1, 3))), byteCodec)).toBe("schedule");
    expect(decodeTriggerSource(frame(sub(TRIGGER, int(1, 2))), byteCodec)).toBe("button");
  });

  it("reads an omitted source as the vendor's own UNKNOWN", () => {
    // What a robot reports just after boot: the message is there, the source is its zero member.
    expect(decodeTriggerSource(frame(sub(TRIGGER, [])), byteCodec)).toBe("unknown");
  });

  it("refuses a payload it cannot read", () => {
    expect(decodeChargeState("nope", byteCodec)).toBeUndefined();
    expect(decodeTriggerSource(frame(sub(TRIGGER, int(1, 1))), undefined)).toBeUndefined();
  });
});

describe("encodeConsumableReset (ConsumableRequest.reset_types)", () => {
  const readBack = (part: ConsumablePart): number | undefined => {
    const hit = byteCodec.decode(encodeConsumableReset(part))?.find((f) => f.field === 1);
    return hit?.kind === "int" ? Number(hit.value) : undefined;
  };

  it("numbers the parts the REQUEST's way, not the report's", () => {
    // The trap: the report puts the side brush at field 1 and the dirty-water tank at 10, with 8 and 9
    // unused. The request enumerates from ZERO with no gap. Borrowing the reader's table here would
    // reset the wrong part — silently, since the device never says which it cleared.
    expect(readBack("sideBrush")).toBe(0);
    expect(readBack("rollingBrush")).toBe(1);
    expect(readBack("dirtyWaterTank")).toBe(7);
    expect(readBack("dirtyWaterFilter")).toBe(8);
  });

  it("disagrees with the report's numbering everywhere it should", () => {
    // Stated as a whole-table check rather than a spot check, because the two tables agreeing by
    // accident on one part is exactly how this would go unnoticed.
    expect(CONSUMABLE_PARTS.map((p) => CONSUMABLE_RESET_TYPE[p])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(Object.keys(CONSUMABLE_RESET_TYPE)).toHaveLength(CONSUMABLE_PARTS.length);
  });

  it("emits a zero part id explicitly rather than omitting it", () => {
    // `sideBrush` is 0 and proto3 would normally omit it — but an empty `ConsumableRequest` asks the
    // device to reset NOTHING, which is a different message. The writer emits what it is told to.
    expect(byteCodec.decode(encodeConsumableReset("sideBrush"))?.length).toBe(1);
  });

  it("ships declared and not installed, like every uncaptured write", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home", new Set([168])));
    expect((acts as Record<string, unknown>).setResetConsumable).toBeUndefined();
  });
});

describe("the Tuya clean line has one DP table", () => {
  it("covers every id the third-party legacy map names", () => {
    // The C2 diff, kept as a check rather than as a paragraph: `jeppesens/eufy-clean`'s
    // `LEGACY_DPS_MAP` lists these nine, and all nine are here, live-confirmed on a real X8 Pro. If one
    // is ever dropped, this fails and the comparison does not silently go stale.
    const legacyDpsMap = [2, 3, 5, 15, 101, 102, 103, 104, 106];
    const ours = new Set<number>(Object.values(TUYA_VACUUM_DP));

    expect(legacyDpsMap.filter((dp) => !ours.has(dp))).toEqual([]);
  });

  it("spells the find-robot id once, in the table, not in the capability that uses it", () => {
    expect(TUYA_VACUUM_DP.LOOK_FOR_SWEEPER).toBe(103);
  });

  it("names each id exactly once", () => {
    // A second table for this line is what this reconciliation removed; a duplicate id inside the
    // surviving one would be the same failure a level down.
    const ids = Object.values(TUYA_VACUUM_DP);
    expect(ids.length).toBe(new Set(ids).size);
  });

  it("does not reach into the scalar device class that reuses these numbers", () => {
    // The G50-class scalar line puts unrelated meanings on ids this table also uses — a brush-detangle
    // trigger on 153, a schedule blob on 151 — so it has to be told apart by value shape. Those ids
    // belong to the AIoT table here and must never be borrowed into the Tuya one.
    const scalarOnly = [118, 122, 135, 139, 142, 150, 151, 153, 154];
    const ours = new Set<number>(Object.values(TUYA_VACUUM_DP));

    expect(scalarOnly.filter((dp) => ours.has(dp))).toEqual([]);
  });
});

describe("DeviceInfo (DP 169) — a payload read across two capabilities", () => {
  const INFO_DP = 169;
  // DeviceInfo: product_name 1, device_mac 3, software 4, hardware 5, wifi_name 6, wifi_ip 7,
  // station 11 { software 1 }. Synthetic throughout — a real one carries a real MAC, SSID and LAN IP.
  const info = frame([
    ...str(1, "eufy Clean X10 Pro Omni"),
    ...str(3, "00:00:00:00:00:00"),
    ...str(4, "1.2.3"),
    ...int(5, 2),
    ...str(6, "example-ssid"),
    ...str(7, "192.0.2.10"),
    ...sub(11, str(1, "4.5.6")),
  ]);

  const bound = (paramIds: Set<number>) =>
    bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home", paramIds), {
      // The payload is stored under the name the DOCK capability owns — one flat namespace, one param,
      // one stored value, read from both objects.
      read: (name) => (name === "dockFirmwareVersion" ? { value: info } : undefined),
      rawDp: byteCodec,
    }).acts;

  it("reads the robot's own network facts off the dock capability's payload", () => {
    const acts = bound(new Set([INFO_DP]));

    expect(acts.wifiSsid).toBe("example-ssid");
    expect(acts.wifiIp).toBe("192.0.2.10");
    expect(acts.macAddress).toBe("00:00:00:00:00:00");
    expect(acts.hardwareVersion).toBe(2);
  });

  it("installs nothing when the device never reported DP 169", () => {
    // The borrowed param IS the evidence gate: no report, no getter — the same rule an owning member
    // follows, applied to an owner in another module.
    const acts = bound(new Set([VACUUM_DP.POWER])) as Record<string, unknown>;

    expect(acts.wifiSsid).toBeUndefined();
    expect("wifiSsid" in acts).toBe(false);
  });

  it("publishes no DP 169 property, so the dock capability keeps sole ownership", () => {
    // The whole reason these members borrow instead of claiming the id. A second spec for one param
    // would leave `Device` storing under the first name only, and these getters reading a name nothing
    // is ever stored under — undefined forever, and silently.
    expect(VACUUM_CLEAN.properties.filter((p) => p.paramType === INFO_DP)).toEqual([]);
  });

  it("answers undefined for a field the robot omitted rather than an empty string", () => {
    const sparse = frame([...str(3, "00:00:00:00:00:00")]);
    const acts = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home", new Set([INFO_DP])), {
      read: (name) => (name === "dockFirmwareVersion" ? { value: sparse } : undefined),
      rawDp: byteCodec,
    }).acts;

    expect(acts.macAddress).toBe("00:00:00:00:00:00");
    expect(acts.wifiSsid).toBeUndefined();
    expect(acts.wifiIp).toBeUndefined();
  });

  it("reads an omitted hardware revision as the proto3 zero", () => {
    const acts = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home", new Set([INFO_DP])), {
      read: (name) => (name === "dockFirmwareVersion" ? { value: frame(str(6, "example-ssid")) } : undefined),
      rawDp: byteCodec,
    }).acts;

    expect(acts.hardwareVersion).toBe(0);
  });

  it("does not read the account id or the video serial beside them", () => {
    // `last_user_id` (8) and `video_sn` (2) are in the message and deliberately unread — an account id
    // and a serial the caller already has by another name.
    const acts = bound(new Set([INFO_DP])) as Record<string, unknown>;
    for (const name of ["lastUserId", "userId", "videoSn", "productName"]) expect(name in acts).toBe(false);
  });
});

describe("ModeCtrl verbs — vocabulary declared, wire still unconfirmed", () => {
  const AIOT = new Set([VACUUM_DP.POWER, VACUUM_DP.WORK_STATUS]);

  it("keeps the captured verbs callable and every uncaptured one off the surface", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home", AIOT));
    const a = acts as Record<string, unknown>;
    // Live-verified on a T2351 — these three stay.
    expect(typeof a.startCleaning).toBe("function");
    expect(typeof a.returnToDock).toBe("function");
    // Method number from the vendor enum alone. A wrong number is a different command reaching real
    // hardware on a fire-and-forget wire, so declaring the verb must not install it.
    // Captured on a live T2351, so this one IS installed — the only mode verb that is.
    expect(typeof a.resumeCleaning).toBe("function");
    for (const name of [
      "stopCleaning",
      "startWashingMops",
      "stopWashingMops",
      "stopReturnToDock",
      "startSpotClean",
      "startMapping",
      "startCruise",
      "startRemoteControl",
      "stopRemoteControl",
      "stopSmartFollow",
    ]) {
      expect(a[name]).toBeUndefined();
      expect(a[`set${name[0].toUpperCase()}${name.slice(1)}`]).toBeUndefined();
    }
  });

  it("gives the whole vocabulary distinct method numbers", () => {
    // A duplicate here would silently make two verbs the same command.
    const numbers = Object.values(ModeCtrlMethod);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("leaves the param-carrying methods out of the enum entirely", () => {
    // Room, zone, goto and scene cleans need an argument this SDK cannot answer yet. Listing their
    // numbers would invite sending one with an empty payload — a valid frame meaning something else.
    expect(Object.values(ModeCtrlMethod)).not.toContain(24);
    expect(Object.values(ModeCtrlMethod)).not.toContain(1);
  });

  it("advances seq per request, so two outstanding writes stay distinguishable", () => {
    const first = encodeModeCtrl(ModeCtrlMethod.STOP_TASK, 1);
    const second = encodeModeCtrl(ModeCtrlMethod.STOP_TASK, 2);
    expect(first).not.toBe(second);
    expect(byteCodec.decode(first)).toEqual([
      { field: 1, kind: "int", value: 12n },
      { field: 2, kind: "int", value: 1n },
    ]);
  });
});

describe("area-selecting ModeCtrl frames", () => {
  /** Walk into the Param sub-message of a built frame. */
  const paramOf = (value: string, field: number): readonly RawDpField[] => {
    const p = byteCodec.decode(value)?.find((f) => f.field === field);
    return byteCodec.nested((p as { value: Buffer }).value) ?? [];
  };

  it("puts the payload in the Param field its method names", () => {
    const { method, param } = ModeCtrlParamMethod.SELECT_ROOMS;
    const fields = byteCodec.decode(encodeSelectRoomsClean(3, [{ id: 7 }]));
    expect(fields?.find((f) => f.field === 1)).toMatchObject({ kind: "int", value: BigInt(method) });
    expect(fields?.find((f) => f.field === param)).toMatchObject({ kind: "bytes" });
  });

  it("repeats one Room entry per room, carrying the map id beside them", () => {
    const inner = paramOf(
      encodeSelectRoomsClean(
        9,
        [
          { id: 4, order: 1 },
          { id: 5, order: 2 },
        ],
        2,
      ),
      4,
    );
    expect(inner.filter((f) => f.field === 1)).toHaveLength(2);
    expect(inner.find((f) => f.field === 2)).toMatchObject({ value: 2n }); // clean_times
    expect(inner.find((f) => f.field === 3)).toMatchObject({ value: 9n }); // map_id
    const first = byteCodec.nested((inner.find((f) => f.field === 1) as { value: Buffer }).value);
    expect(first).toEqual([
      { field: 1, kind: "int", value: 4n },
      { field: 2, kind: "int", value: 1n },
    ]);
  });

  it("ZigZags zone coordinates, so a negative one stays one byte and stays negative", () => {
    // The sharpest edge in the file. As a plain varint, -1 encodes as 2^64-1 and the robot drives
    // somewhere real and wrong. ZigZag maps -1 onto 1, and the frame stays small.
    const zone = {
      corners: [
        { x: -1, y: 2 },
        { x: 3, y: -4 },
        { x: 0, y: 0 },
        { x: 5, y: 6 },
      ],
    };
    const inner = paramOf(encodeSelectZonesClean(1, [zone]), 5);
    // Param → zones(1) → the Zone → quadrangle(1) → p0..p3, each a Point of two signed values.
    const zoneFields = byteCodec.nested((inner.find((f) => f.field === 1) as { value: Buffer }).value)!;
    const quad = byteCodec.nested((zoneFields.find((f) => f.field === 1) as { value: Buffer }).value)!;
    const p0 = byteCodec.nested((quad.find((f) => f.field === 1) as { value: Buffer }).value);
    expect(p0).toEqual([
      { field: 1, kind: "int", value: 1n }, // zigzag(-1)
      { field: 2, kind: "int", value: 4n }, // zigzag(2)
    ]);
    const p1 = byteCodec.nested((quad.find((f) => f.field === 2) as { value: Buffer }).value);
    expect(p1).toEqual([
      { field: 1, kind: "int", value: 6n }, // zigzag(3)
      { field: 2, kind: "int", value: 7n }, // zigzag(-4)
    ]);
  });

  it("lays the four corners out as consecutive fields p0..p3", () => {
    const zone = { corners: [0, 1, 2, 3].map((n) => ({ x: n, y: n })) };
    const inner = paramOf(encodeSelectZonesClean(1, [zone]), 5);
    const zoneFields = byteCodec.nested((inner.find((f) => f.field === 1) as { value: Buffer }).value)!;
    const quad = byteCodec.nested((zoneFields.find((f) => f.field === 1) as { value: Buffer }).value)!;
    expect(quad.map((f) => f.field)).toEqual([1, 2, 3, 4]);
  });

  it("starts an auto clean as method 0 with one AutoClean pass in Param field 3", () => {
    // The vendor's AutoClean.clean_times is valid only when non-zero, so the pass is stated rather
    // than left at the proto3 default. Method 0 stays off the wire, as on the bare frame.
    const fields = byteCodec.decode(encodeAutoClean());
    expect(fields?.find((f) => f.field === 1)).toBeUndefined();
    expect(fields?.find((f) => f.field === 2)).toMatchObject({ kind: "int" });
    expect(paramOf(encodeAutoClean(), ModeCtrlParamMethod.AUTO.param)).toEqual([{ field: 1, kind: "int", value: 1n }]);
  });

  it("carries a scene by its id alone", () => {
    const inner = paramOf(encodeSceneClean(12), ModeCtrlParamMethod.SCENE.param);
    expect(inner).toEqual([{ field: 1, kind: "int", value: 12n }]);
  });

  it("requires a map id rather than defaulting one", () => {
    // A default here is a guess dressed as an API: on a two-floor home it sends the right room ids
    // against the wrong floor's map. The signature makes the caller answer.
    const rooms: Parameters<typeof encodeSelectRoomsClean> = [3, [{ id: 1 }]];
    expect(typeof rooms[0]).toBe("number");
    expect(paramOf(encodeSelectRoomsClean(...rooms), 4).find((f) => f.field === 3)).toMatchObject({ value: 3n });
  });

  it("installs a verb for each on an AIoT robot, and none on a Tuya one", () => {
    const aiot = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home", new Set([151])));
    const a = aiot.acts as Record<string, unknown>;
    for (const name of ["startScene", "cleanRooms", "cleanZones"]) {
      expect(typeof a[name]).toBe("function");
    }
    // Never a bare property setter: the value each takes is not a stored property, so `setCleanRooms`
    // would be a second spelling of the verb resolving through the flat schema, which has no such name.
    expect(a["setCleanRooms"]).toBeUndefined();

    // Same gate as every other mode-control verb — DP 152 belongs to the AIoT schema alone.
    const tuya = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home_tuya", new Set([151])));
    for (const name of ["startScene", "cleanRooms", "cleanZones"]) {
      expect((tuya.acts as Record<string, unknown>)[name]).toBeUndefined();
    }
  });

  it("sends a scene by the id its own read reports", () => {
    // `scenes()` decodes SceneResponse off DP 180 and `VacuumScene.id` is what this verb takes, so a
    // caller never has to invent one. The two halves meeting is the whole point of the pairing.
    const { acts, sent } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home", new Set([151])));
    void (acts as { startScene: (id: number) => Promise<void> }).startScene(7);
    const fields = byteCodec.decode(String((sent[0] as { value?: unknown }).value));
    expect(fields?.find((f) => f.field === 1)).toMatchObject({ value: BigInt(ModeCtrlParamMethod.SCENE.method) });
    const param = fields?.find((f) => f.field === ModeCtrlParamMethod.SCENE.param) as { value: Buffer };
    expect(byteCodec.nested(param.value)).toEqual([{ field: 1, kind: "int", value: 7n }]);
  });
});

describe("what the T2351 product catalogue settled", () => {
  it("puts schedules on DP 164, which no source previously named", () => {
    // The open question was which DP carries `timing.proto`. The catalogue answers it outright:
    // dp 164 `timing`, TimerRequest down / TimerResponse up.
    expect(VACUUM_DP.TIMING).toBe(164);
    expect(VACUUM_DP_MESSAGE[164]).toEqual({ send: "TimerRequest", report: "TimerResponse" });
  });

  it("confirms the two DP numbers that were resolved offline and flagged as disputed", () => {
    expect(VACUUM_DP_MESSAGE[157]).toMatchObject({ report: "UndisturbedResponse" });
    expect(VACUUM_DP_MESSAGE[168]).toMatchObject({ report: "ConsumableRuntime" });
    expect(VACUUM_DP.DO_NOT_DISTURB).toBe(157);
    expect(VACUUM_DP.CONSUMABLES).toBe(168);
  });

  it("records DP 162 as a message pair, not a locale string", () => {
    // The reason the DP 162 write is still held: the catalogue types it Raw carrying
    // LanguageRequest/LanguageResponse, so a plain locale string was never the wire.
    expect(VACUUM_DP_MESSAGE[162]).toEqual({ send: "LanguageRequest", report: "LanguageResponse" });
  });

  it("marks the vendor's own dead ends as carrying no message", () => {
    // DP 150 is annotated "reserved, not used"; 165 and 175 are reserved with no message at all.
    // Recorded so nobody builds on them and then wonders why nothing answers.
    for (const dp of [150, 165, 175]) expect(VACUUM_DP_MESSAGE[dp]).toEqual({});
  });

  it("leaves remote control via STOP_TASK, as the DP 155 note specifies", () => {
    // Not STOP_RC_CLEAN(16), which an earlier revision assumed from the name alone. The catalogue
    // spells the flow out: enter with START_RC_CLEAN or a direction, leave with STOP_TASK.
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home", new Set([151])));
    expect((acts as Record<string, unknown>).stopRemoteControl).toBeUndefined(); // still unverified
    expect(ModeCtrlMethod.STOP_TASK).toBe(12);
  });

  it("keeps every newly named DP off the callable surface until a capture exists", () => {
    const dps = new Set([VACUUM_DP.REMOTE_CTRL, VACUUM_DP.RESUME_CLEAN]);
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home", dps), {
      // Stored as a real boolean: `Device.applyParams` coerces by the declared type before storing,
      // so a getter never sees the wire's "1". A string here reads as undefined, correctly.
      read: (name) => (name === "resumeClean" ? { value: true } : undefined),
    });
    const a = acts as Record<string, unknown>;
    // A plain Bool DP the device reports — the READ installs on evidence.
    expect(a.resumeClean).toBe(true);
    // Every write stays off: the catalogue names the wire, it does not prove what the app sends.
    expect(a.setResumeClean).toBeUndefined();
    expect(a.setRemoteControlDirection).toBeUndefined();
    expect(a.remoteControlDirection).toBeUndefined();
  });
});

describe("what the live T2351 capture confirmed", () => {
  const aiot = fakeCtx(undefined, "eufy_home", new Set([VACUUM_DP.POWER]));

  it("advances one seq across DIFFERENT verbs, as the app does", () => {
    // Captured: start(no method, seq 124) → pause(13, 125) → resume(14, 126) → gohome(6, 127).
    // One sequence over four verbs. Per-verb counters would have repeated a number and made two
    // outstanding requests indistinguishable, which is the one thing seq exists to prevent.
    const { acts, sent } = bind<VacuumCleanActions>("vacuum_clean", aiot);
    return Promise.all([acts.startCleaning!(), acts.pauseCleaning!(), acts.resumeCleaning!()]).then(() => {
      const seqs = sent.map((c) => {
        const f = byteCodec.decode((c as { value: string }).value);
        return Number((f?.find((x) => x.field === 2) as { value: bigint }).value);
      });
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(seqs[1]).toBe(seqs[0] + 1);
      expect(seqs[2]).toBe(seqs[1] + 1);
    });
  });

  it("names the method on the wire beside its seq", () => {
    expect(byteCodec.decode(encodeModeCtrl(ModeCtrlMethod.RESUME_TASK, 126))).toEqual([
      { field: 1, kind: "int", value: 14n },
      { field: 2, kind: "int", value: 126n },
    ]);
  });

  it("installs resume — the one mode verb a capture has proven", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", aiot);
    const a = acts as Record<string, unknown>;
    expect(typeof a.resumeCleaning).toBe("function");
    // Its neighbours in the same enum stay off: sharing a frame is not sharing evidence.
    for (const n of ["stopCleaning", "startWashingMops", "startMapping"]) expect(a[n]).toBeUndefined();
  });

  it("reads a paused robot as paused, from the captured WorkStatus shape", () => {
    // Live: state(2)=5 with cleaning(6){state(1)=1} while paused, and cleaning(6){} while running.
    const paused = frame([...int(2, 5), ...sub(6, int(1, 1))]);
    const running = frame([...int(2, 5), ...sub(6, [])]);
    expect(decodeVacuumActivity(paused, byteCodec)).toBe("paused");
    expect(decodeVacuumActivity(running, byteCodec)).toBe("cleaning");
  });

  it("does not read a station field present mid-clean as docked", () => {
    // The live report carried station(14){#4{}} WHILE cleaning. Treating any station field as
    // washing/drying would have called that "docked"; only field 3 means that.
    const cleaningWithStation = frame([...int(2, 5), ...sub(6, []), ...sub(14, sub(4, []))]);
    expect(decodeVacuumActivity(cleaningWithStation, byteCodec)).toBe("cleaning");
  });

  it("reads the do-not-disturb window the capture showed", () => {
    // active(1){value=1} beside undisturbed(2){sw{value=1}, begin{hour=9}, end{hour=23}} — a robot
    // inside its quiet window. The switch is ON and the window is OPEN, and they are separate reads.
    const live = frame([
      ...sub(1, int(1, 1)),
      ...sub(2, [...sub(1, int(1, 1)), ...sub(2, int(1, 9)), ...sub(3, int(1, 23))]),
    ]);
    expect(decodeDoNotDisturb(live, byteCodec)).toBe(true);
    expect(decodeDoNotDisturbActive(live, byteCodec)).toBe(true);
  });
});

describe("mop_mode — two scalars in one wrapper", () => {
  /** `clean_param(1) { mop_mode(4) { level(1), corner_clean(2) } }`, as a live T2351 sends it. */
  const mop = (body: number[]): string => frame(sub(1, sub(4, body)));

  it("reads level and corner_clean as the separate settings they are", () => {
    // Captured: water level High then edge-hug on gave mop_mode { level: 2, corner_clean: 1 }.
    const both = mop([...int(1, 2), ...int(2, 1)]);
    expect(decodeCleanParamValue(both, byteCodec, 4, 1)).toBe(2);
    expect(decodeCleanParamValue(both, byteCodec, 4, 2)).toBe(1);
  });

  it("does not read the level as the corner setting when only the level is set", () => {
    // The trap the named inner field exists for. Taking "the first varint" would answer 2 for BOTH,
    // reporting edge-hug as on because the water level happened to be high.
    const levelOnly = mop(int(1, 2));
    expect(decodeCleanParamValue(levelOnly, byteCodec, 4, 1)).toBe(2);
    expect(decodeCleanParamValue(levelOnly, byteCodec, 4, 2)).toBe(0);
    // …which is what the un-named form still does, and why it is only used on single-valued wrappers.
    expect(decodeCleanParamValue(levelOnly, byteCodec, 4)).toBe(2);
  });

  it("surfaces both on the bound device", () => {
    const acts = bind<VacuumCleanActions>(
      "vacuum_clean",
      fakeCtx(undefined, undefined, new Set([VACUUM_DP.CLEAN_PARAM])),
      { rawDp: byteCodec, read: (n) => (n === "cleanType" ? { value: mop([...int(1, 2), ...int(2, 1)]) } : undefined) },
    ).acts;
    expect(acts.mopLevel).toBe("high");
    expect(acts.mopCornerClean).toBe(true);
  });

  it("still publishes one property for DP 154, now with six readings of it", () => {
    const named = VACUUM_CLEAN.properties.filter((p) => p.paramType === VACUUM_DP.CLEAN_PARAM).map((p) => p.name);
    expect(named).toEqual(["cleanType"]);
  });
});
