import type { RawDpCodec, RawDpField } from "../../../core/contracts.js";
import type { CommandContext } from "../types.js";
import {
  VACUUM_CLEAN,
  decodeVacuumActivity,
  decodeCleanType,
  encodeModeCtrl,
  ModeCtrlMethod,
  type VacuumCleanActions,
  type VacuumActivity,
  type VacuumCleanType,
} from "../vacuum-clean.js";
import { bind } from "./bind.js";

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
 * Method 0 (START_AUTO_CLEAN) is omitted per proto3 default — field#2 only.
 */
describe("encodeModeCtrl", () => {
  it("START_AUTO_CLEAN (method 0, seq 112) — field #1 omitted per proto3 default", () => {
    // body: [0x10, 0x70]  (field2 tag + varint 112)
    // wire: [0x02, 0x10, 0x70]
    expect(Buffer.from(encodeModeCtrl(ModeCtrlMethod.START_AUTO_CLEAN, 112), "base64")).toEqual(
      Buffer.from([0x02, 0x10, 0x70]),
    );
  });

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
    // body (method 0): [0x10, 0xc8, 0x01] — field#1 still omitted for method 0
    // wire: [0x03, 0x10, 0xc8, 0x01]
    expect(Buffer.from(encodeModeCtrl(ModeCtrlMethod.START_AUTO_CLEAN, 200), "base64")).toEqual(
      Buffer.from([0x03, 0x10, 0xc8, 0x01]),
    );
  });
});

/** Minimal `CommandContext` for a given model and/or category. */
function fakeCtx(model?: string, category?: string): CommandContext {
  return { channel: 0, codec: "vacuum", model, category, paramIds: new Set() };
}

describe("vacuum_clean capability module", () => {
  it("declares the capability + schema", () => {
    expect(VACUUM_CLEAN.capability).toBe("vacuum_clean");
    expect(VACUUM_CLEAN.properties.map((p) => p.name)).toEqual([
      "power",
      "activity",
      "volume",
      "battery",
      "cleanType",
      "batteryLegacy",
      "errorCode",
      "workStatus",
      "workMode",
      "cleaningStrength",
      "mopWater",
      "x8CleanType",
      "clearTime",
      "clearArea",
      "loudness",
    ]);
  });

  it("every property has a string name + numeric paramType", () => {
    for (const p of VACUUM_CLEAN.properties) {
      expect(typeof p.name).toBe("string");
      expect(typeof p.paramType).toBe("number");
    }
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
    expect(decodeVacuumActivity("payload", workStatus(15))).toBe("paused");
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
const _cleanType: Exact<typeof vac.cleanType, VacuumCleanType | undefined> = true;

// setPower is gated by available: isAiotVacuum — absent on eufy_home_tuya devices, optional on the surface.
const _setPowerOptional: Exact<undefined extends typeof vac.setPower ? true : false, true> = true;
const _setPowerArg: Exact<Parameters<NonNullable<typeof vac.setPower>>[0], boolean> = true;

// Read-only members get no setter — nothing writes the activity or the battery back.
const _noSetActivity: Exact<"setActivity" extends keyof VacuumCleanActions ? true : false, false> = true;
const _noSetBattery: Exact<"setBattery" extends keyof VacuumCleanActions ? true : false, false> = true;

// startCleaning available: isAiotVacuum || isTuyaVacuum — optional on the surface (availability is a runtime guard).
const _startCleaning: Exact<typeof vac.startCleaning, (() => Promise<void>) | undefined> = true;

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
];

describe("vacuum_clean — AIoT vs legacy guard (negative exclusion)", () => {
  it("write actions are present when category is absent — defaults to AIoT", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx("T2250"));
    expect(acts.startCleaning).toBeDefined();
    expect(acts.returnToDock).toBeDefined();
    expect(acts.pauseCleaning).toBeDefined();
  });

  it("write actions are present when model and category are both absent — defaults to AIoT", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined));
    expect(acts.startCleaning).toBeDefined();
  });

  it("startCleaning/returnToDock/pauseCleaning are present for eufy_home_tuya (Tuya dispatch path)", () => {
    const { acts } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home_tuya"));
    expect(acts.startCleaning).toBeDefined();
    expect(acts.returnToDock).toBeDefined();
    expect(acts.pauseCleaning).toBeDefined();
  });

  it("dispatches DP 151 for setPower on eufy_home category (Anker AIoT MQTT)", async () => {
    const { acts, sent } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home"));
    await acts.setPower!(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: "aiot-dp", dp: 151, value: true });
  });

  it("dispatches a ModeCtrlRequest for startCleaning on eufy_home category", async () => {
    const { acts, sent } = bind<VacuumCleanActions>("vacuum_clean", fakeCtx(undefined, "eufy_home"));
    await acts.startCleaning!();
    expect(sent[0]).toMatchObject({ kind: "aiot-dp", dp: 152 });
  });
});
