import { parseDpCatalog, EMPTY_DP_CATALOG } from "../dp-catalog.js";

describe("parseDpCatalog", () => {
  it("returns EMPTY_DP_CATALOG for null/undefined/non-object inputs", () => {
    expect(parseDpCatalog(null)).toBe(EMPTY_DP_CATALOG);
    expect(parseDpCatalog(undefined)).toBe(EMPTY_DP_CATALOG);
    expect(parseDpCatalog(42)).toBe(EMPTY_DP_CATALOG);
    expect(parseDpCatalog("string")).toBe(EMPTY_DP_CATALOG);
    expect(parseDpCatalog([])).toBe(EMPTY_DP_CATALOG);
  });

  it("returns EMPTY_DP_CATALOG when data_point_list is absent or empty", () => {
    expect(parseDpCatalog({})).toBe(EMPTY_DP_CATALOG);
    expect(parseDpCatalog({ data_point_list: [] })).toBe(EMPTY_DP_CATALOG);
    expect(parseDpCatalog({ data_point_list: null })).toBe(EMPTY_DP_CATALOG);
  });

  it("parses dp_id (primary field name) and non-enum type — adds no range entry", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 159, data_type: "bool" }],
    });
    expect(catalog.enumRanges.has(159)).toBe(false);
    expect(catalog).not.toBe(EMPTY_DP_CATALOG);
  });

  it("parses enum range from a plain number array", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 158, data_type: "enum", property: [0, 1, 2, 3] }],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
  });

  it("parses enum range from a JSON-stringified number array", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 158, data_type: "enum", property: "[0,1,2,3]" }],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
  });

  it('parses enum range from a JSON-stringified {"range":[...]} object', () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 158, data_type: "enum", property: '{"range":["0","1","2","3"]}' }],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
  });

  it("parses numeric-string members within a plain array", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 158, data_type: "Enum", property: ["0", "1", "2"] }],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2]);
  });

  it("handles string dp_id for enum type", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: "158", data_type: "enum", property: [0, 1, 2, 3] }],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
  });

  it("skips entries with invalid dp_id — valid entry still parsed", () => {
    const catalog = parseDpCatalog({
      data_point_list: [
        { dp_id: -1, data_type: "bool" },
        { dp_id: 0, data_type: "bool" },
        { data_type: "bool" },
        { dp_id: 158, data_type: "enum", property: [0, 1] },
      ],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1]);
  });

  it("returns EMPTY_DP_CATALOG when all entries are invalid", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: -1 }, {}],
    });
    expect(catalog).toBe(EMPTY_DP_CATALOG);
  });

  it("does not add enum range when property is missing or empty", () => {
    const catalog = parseDpCatalog({
      data_point_list: [
        { dp_id: 158, data_type: "enum" },
        { dp_id: 159, data_type: "enum", property: [] },
      ],
    });
    expect(catalog.enumRanges.has(158)).toBe(false);
    expect(catalog.enumRanges.has(159)).toBe(false);
    expect(catalog).not.toBe(EMPTY_DP_CATALOG);
  });

  it("handles multiple DPs of mixed types in one response", () => {
    const catalog = parseDpCatalog({
      data_point_list: [
        { dp_id: 158, data_type: "enum", property: [0, 1, 2, 3] },
        { dp_id: 159, data_type: "bool" },
        { dp_id: 160, data_type: "integer" },
      ],
    });
    expect(catalog.enumRanges.size).toBe(1);
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
    expect(catalog.enumRanges.has(159)).toBe(false);
    expect(catalog.enumRanges.has(160)).toBe(false);
  });

  it("reads a real catalog entry — every field the response actually declares", () => {
    const catalog = parseDpCatalog({
      data_point_list: [
        {
          dp_id: 158,
          code: "suction",
          name: "Suction",
          mode: "rw",
          data_type: "Enum",
          desc: "",
          property: '{"type":"enum","range":["0","1","2","3"]}',
          create_time: 0,
          update_time: 0,
        },
      ],
    });
    expect(catalog.enumRanges.get(158)).toEqual([0, 1, 2, 3]);
  });

  it("reads no range from the pre-confirmation field names — the response declares neither", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 158, type: "enum", values: [0, 1, 2, 3] }],
    });
    expect(catalog.enumRanges.has(158)).toBe(false);
    expect(catalog).not.toBe(EMPTY_DP_CATALOG);
  });

  it("ignores invalid JSON in a stringified property — DP still parsed, no range added", () => {
    const catalog = parseDpCatalog({
      data_point_list: [{ dp_id: 158, data_type: "enum", property: "not-json" }],
    });
    expect(catalog.enumRanges.has(158)).toBe(false);
    expect(catalog).not.toBe(EMPTY_DP_CATALOG);
  });
});
