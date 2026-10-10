import { describe, expect, it } from "vitest";
import type { CommandContext } from "../types.js";
import { MOWER, MOWER_DP, type MowerActions } from "../mower.js";
import { detectCapabilities, decodeState } from "../index.js";
import { namespaceForCodec, paramDef } from "../../param-namespace.js";
import { bind } from "./bind.js";

function mowerCtx(paramIds: ReadonlySet<number>): CommandContext {
  return { channel: 0, codec: "mower", paramIds, category: "eufy_home_tuya" };
}

/** A fixture reader answering each property name from a table, as the device's stored state would. */
function reader(values: Record<string, unknown>) {
  return (name: string) => (name in values ? { value: values[name] } : undefined);
}

describe("mower capability module", () => {
  it("is the mower codec's clean-line capability", () => {
    expect(MOWER.capability).toBe("mower");
    expect(MOWER.line).toBe("clean");
    expect(MOWER.detection?.codecs).toEqual(["mower"]);
    expect(detectCapabilities({ model: "T2880", category: "eufy_home_tuya" }, "mower")).toContain("mower");
  });

  it("is not attached to a vacuum", () => {
    expect(detectCapabilities({ model: "T2351", category: "eufy_home" }, "vacuum")).not.toContain("mower");
  });

  it("publishes no setter: every property is read-only", () => {
    expect(MOWER.properties.length).toBeGreaterThan(0);
    for (const p of MOWER.properties) expect(p.writable, p.name).toBeFalsy();
  });
});

describe("mower — reads", () => {
  it("installs a getter only for a data point the mower reported", () => {
    const { acts } = bind<MowerActions>("mower", mowerCtx(new Set([MOWER_DP.BATTERY])), {
      read: reader({ battery: 87, cutHeight: 45 }),
    });
    expect(acts.battery).toBe(87);
    expect(acts.cutHeight).toBeUndefined();
  });

  it("reads the scalar data points by their schema meaning", () => {
    const ids = new Set<number>(Object.values(MOWER_DP));
    const { acts } = bind<MowerActions>("mower", mowerCtx(ids), {
      read: reader({
        battery: 64,
        cutHeight: 50,
        childLock: true,
        rainAutoReturn: false,
        bladeUsedTime: 1200,
        workAngle: -30,
        edgeDistance: -50,
      }),
    });
    expect(acts.battery).toBe(64);
    expect(acts.cutHeight).toBe(50);
    expect(acts.childLock).toBe(true);
    expect(acts.rainAutoReturn).toBe(false);
    expect(acts.bladeUsedTime).toBe(1200);
    expect(acts.workAngle).toBe(-30);
    expect(acts.edgeDistance).toBe(-50);
  });

  it("decodes the network link, and answers undefined outside the schema's range", () => {
    const ids = new Set<number>([MOWER_DP.NETWORK]);
    expect(bind<MowerActions>("mower", mowerCtx(ids), { read: reader({ network: "Cellular" }) }).acts.network).toBe(
      "Cellular",
    );
    expect(
      bind<MowerActions>("mower", mowerCtx(ids), { read: reader({ network: "4G" }) }).acts.network,
    ).toBeUndefined();
  });
});

describe("mower — inbound state", () => {
  it("keeps its own data points from a report and drops the rest", () => {
    const report = { 8: "100", 110: "45", 102: "Cg==", 5: "standby" };
    expect(
      MOWER.decodeState?.({ source: "mqtt", deviceSn: "T2880P0000000000", topic: "t", raw: {}, dpParams: report }),
    ).toEqual({
      params: { 8: "100", 110: "45" },
    });
  });

  it("is reached through the barrel's state decode for a mower", () => {
    const signal = {
      source: "mqtt" as const,
      deviceSn: "T2880P0000000000",
      topic: "t",
      raw: {},
      dpParams: { 126: "20000" },
    };
    expect(decodeState(signal, new Set(["mower" as const]))).toEqual([{ params: { 126: "20000" } }]);
  });

  it("ignores a report with none of its data points", () => {
    expect(
      MOWER.decodeState?.({
        source: "mqtt",
        deviceSn: "T2880P0000000000",
        topic: "t",
        raw: {},
        dpParams: { 102: "Cg==" },
      }),
    ).toBeNull();
  });
});

describe("mower — param namespace", () => {
  it("reads its own namespace, so a mower id is never named with a vacuum's meaning", () => {
    expect(namespaceForCodec("mower")).toBe("mower");
    expect(paramDef("mower", 110)?.name).toBe("cutHeight");
    expect(paramDef("clean", 110)?.name).not.toBe("cutHeight");
  });
});
