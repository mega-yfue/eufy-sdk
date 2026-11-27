import { describe, expect, it } from "vitest";
import { P2P_STATION_WAITS, StationUnreachableError } from "../index.js";

/** Synthetic — never a real station. */
const STATION_SN = "T8010P0000000000";

describe("station reachability at the package entry point", () => {
  it("publishes the waits a caller places its own bound above", () => {
    expect(P2P_STATION_WAITS.connect).toBeGreaterThan(0);
  });

  it("publishes the refusal a caller narrows on", () => {
    const error = new StationUnreachableError(STATION_SN, 20_000);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("StationUnreachableError");
    expect(error.retryable).toBe(true);
    expect(error.waitedMs).toBe(20_000);
    expect(error.stationSn).toBe(STATION_SN);
  });
});
