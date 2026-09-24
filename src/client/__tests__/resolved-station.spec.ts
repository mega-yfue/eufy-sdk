import { describe, expect, it } from "vitest";
import { resolvedStationSn } from "../../transport/p2p/station-channels.js";

/**
 * Which station a device's traffic belongs to.
 *
 * `parent_sn` carries the parent on an attached device. `station_sn` is frequently absent there — empty on
 * every attached sensor of a T8010 — and serves only as a fallback. An empty string states no station.
 *
 * A device naming no parent answers its own serial, so every device has a station.
 */
describe("resolvedStationSn", () => {
  it("answers the parent for a device attached to a base", () => {
    expect(resolvedStationSn({ parent_sn: "T8010P0000000000", station_sn: "" }, "T8210P0000000001")).toBe(
      "T8010P0000000000",
    );
  });

  it("answers the parent when the station field names something else", () => {
    expect(
      resolvedStationSn({ parent_sn: "T8010P0000000000", station_sn: "T9999P0000000000" }, "T8210P0000000001"),
    ).toBe("T8010P0000000000");
  });

  it("answers a standalone device its own serial, which is what standing alone means", () => {
    expect(resolvedStationSn({ parent_sn: "T8410P0000000002" }, "T8410P0000000002")).toBe("T8410P0000000002");
  });

  it("answers its own serial when the record names no parent at all", () => {
    expect(resolvedStationSn({}, "T8410P0000000002")).toBe("T8410P0000000002");
  });

  it("falls back to the station field when there is one and no parent", () => {
    expect(resolvedStationSn({ station_sn: "T8010P0000000000" }, "T8210P0000000001")).toBe("T8010P0000000000");
  });

  /** An empty string states no station. */
  it("treats an empty station field as absent rather than as a station", () => {
    expect(resolvedStationSn({ station_sn: "", parent_sn: "" }, "T8410P0000000002")).toBe("T8410P0000000002");
  });

  it("answers one base's serial for its attached cameras, and its own for a standalone one", () => {
    const base = "T8010P0000000000";
    const grouped = [
      resolvedStationSn({ parent_sn: base }, "T8210P0000000001"),
      resolvedStationSn({ parent_sn: base }, "T8114P0000000003"),
      resolvedStationSn({}, "T8410P0000000002"),
    ];
    expect(grouped).toEqual([base, base, "T8410P0000000002"]);
  });
});
