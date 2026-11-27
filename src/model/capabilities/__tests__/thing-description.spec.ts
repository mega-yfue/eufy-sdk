import { conditionsPass, parseThingsList, resolveThing } from "../thing-description.js";
import { readFileSync } from "node:fs";
import { resolvedEnum } from "../members.js";

/**
 * A synthetic `get_things_list` reply shaped like the service's: one product with a property of every
 * kind the service uses, conditions of each shape, an action and an event. Values are made up.
 */
const REPLY = {
  things_list: [
    {
      is_filter: false,
      version: "1.0",
      update_time: 1700000000,
      large_version: 12,
      large_version_update_time: 1700000100,
      profile: {
        product_code: "T0000",
        version: "1.0.0",
        plugin_id: "plugin-id",
        plugin_path: "https://cdn.example/T0000Handle.mix.js",
        plugin_id_zip: "zip-id",
        plugin_path_zip: "https://cdn.example/T0000.zip",
        plugin_id_qjsc: "",
        plugin_path_qjsc: "",
      },
      properties: [
        {
          identifier: "nightvision_type",
          access_mode: "RW",
          data_type: { type: "bool", specs: { defaultValue: "true" } },
          read_conditions: {},
          write_conditions: {},
          available_conditions: {},
          dispatch_type: "",
          scene_config: { action_conditions: {}, trigger_conditions: {} },
        },
        {
          identifier: "nightvision_type_new",
          access_mode: "RW",
          data_type: {
            type: "enum",
            specs: {
              eunmList: [
                { associatedValue: "1", desc: "night_vision_infrared", isDefault: 1, value: "102" },
                { associatedValue: "0", desc: "night_vision_off", isDefault: 0, value: "100" },
              ],
            },
          },
        },
        {
          identifier: "activityzone_config",
          access_mode: "R",
          data_type: { type: "tenum", specs: { eunmList: [{ desc: "768", value: "zoneWidth" }] } },
        },
        {
          identifier: "speaker_volume",
          access_mode: "RW",
          data_type: { type: "int", specs: { min: 0, max: 100, step: "1", unit: "%", defaultValue: "50" } },
        },
        {
          identifier: "nightvision_type__v1",
          access_mode: "RW",
          data_type: { type: "bool", specs: { defaultValue: "true" } },
          read_conditions: {
            condition_list: [{ conditions: [{ qualifier: "<=", type: "device_version", value: "2.1.7.7" }] }],
          },
          available_conditions: {
            condition_list: [
              {
                conditions: [
                  { qualifier: "RE", type: "parent_sn", value: "^(T0001).*$" },
                  { prop_id: "ai_empower", qualifier: "=", type: "associated_field", value: "1" },
                ],
              },
            ],
          },
        },
        { access_mode: "R", data_type: { type: "bool" } },
      ],
      actions: [
        {
          identifier: "arming_config",
          input_data: { specs: {}, type: "string" },
          output_data: { specs: {}, type: "string" },
          available_conditions: {},
        },
        { identifier: "reset_device" },
      ],
      events: [
        {
          identifier: "event_device_alarm",
          event_type: "",
          output_data: { specs: { defaultValue: "1201,1202" }, type: "string" },
          available_conditions: {},
        },
      ],
    },
    { profile: {}, properties: [] },
  ],
};

describe("parseThingsList", () => {
  const t = parseThingsList(REPLY).T0000!;

  it("keeps the product's identity, versions and settings bundle", () => {
    expect(t).toMatchObject({
      productCode: "T0000",
      version: "1.0",
      updateTime: 1700000000,
      largeVersion: 12,
      largeVersionUpdateTime: 1700000100,
      bundle: {
        id: "plugin-id",
        path: "https://cdn.example/T0000Handle.mix.js",
        zipId: "zip-id",
        zipPath: "https://cdn.example/T0000.zip",
      },
    });
  });

  it("reads each property's access, type, members and specs", () => {
    expect(t.properties.nightvision_type).toEqual({
      identifier: "nightvision_type",
      accessMode: "RW",
      type: "bool",
      members: [],
      defaultValue: "true",
      readConditions: [],
      availableConditions: [],
    });
    expect(t.properties.nightvision_type_new?.members, "wire value apart from the UI value").toEqual([
      { value: "102", wireValue: "1", desc: "night_vision_infrared", isDefault: true },
      { value: "100", wireValue: "0", desc: "night_vision_off", isDefault: false },
    ]);
    expect(t.properties.activityzone_config?.members, "a named constant has no wire value").toEqual([
      { value: "zoneWidth", desc: "768", isDefault: false },
    ]);
    expect(t.properties.speaker_volume).toMatchObject({ min: 0, max: 100, step: 1, unit: "%", defaultValue: "50" });
  });

  it("keeps every condition list as data", () => {
    expect(t.properties.nightvision_type__v1?.readConditions).toEqual([
      [{ type: "device_version", qualifier: "<=", value: "2.1.7.7" }],
    ]);
    expect(t.properties.nightvision_type__v1?.availableConditions).toEqual([
      [
        { type: "parent_sn", qualifier: "RE", value: "^(T0001).*$" },
        { type: "associated_field", qualifier: "=", value: "1", propId: "ai_empower" },
      ],
    ]);
  });

  it("reads actions and events", () => {
    expect(t.actions.arming_config).toEqual({
      identifier: "arming_config",
      inputType: "string",
      outputType: "string",
      availableConditions: [],
    });
    expect(t.actions.reset_device).toEqual({ identifier: "reset_device", availableConditions: [] });
    expect(t.events.event_device_alarm).toEqual({
      identifier: "event_device_alarm",
      eventType: "",
      outputType: "string",
      defaultValue: "1201,1202",
      availableConditions: [],
    });
  });

  it("skips what it cannot key, never reaches a prototype, and serialises as it is", () => {
    expect(Object.keys(t.properties)).toHaveLength(5);
    expect(Object.keys(parseThingsList(REPLY))).toEqual(["T0000"]);
    expect(t.properties.constructor).toBeUndefined();
    expect(JSON.parse(JSON.stringify(t)).properties.nightvision_type_new.members[0].wireValue).toBe("1");
  });

  it("answers an empty result for a reply it does not recognise", () => {
    for (const raw of [undefined, null, 42, "x", {}, { things_list: {} }]) expect(parseThingsList(raw)).toEqual({});
  });
});

describe("conditionsPass", () => {
  const c = (type: string, qualifier: string, value: string, propId?: string) => ({
    type,
    qualifier,
    value,
    ...(propId ? { propId } : {}),
  });
  const pass = (list: ReturnType<typeof c>[][], facts = {}) => conditionsPass(list, facts);

  it("passes an empty list, any passing entry, and an entry only when all its conditions pass", () => {
    expect(pass([])).toBe(true);
    const fw = { firmwareVersion: "2.0.0.0" };
    expect(pass([[c("device_version", ">=", "3.0.0.0")], [c("device_version", "<", "3.0.0.0")]], fw)).toBe(true);
    expect(pass([[c("device_version", "<", "3.0.0.0"), c("device_version", ">", "2.5.0.0")]], fw)).toBe(false);
    expect(pass([[c("unknown_type", "=", "x")]])).toBe(false);
  });

  it("compares firmware as versions, dropping trailing letters", () => {
    const at = (firmwareVersion: string, q: string, v: string) =>
      pass([[c("device_version", q, v)]], { firmwareVersion });
    expect(at("2.1.7.7", "<=", "2.1.7.7")).toBe(true);
    expect(at("2.1.10.0", ">=", "2.1.9.9"), "numerically, not as text").toBe(true);
    expect(at("3.1.1.7a", "=", "3.1.1.7")).toBe(true);
    expect(at("2.3", ">=", "2.3.0.0"), "missing parts count as 0").toBe(true);
    expect(at("2.2.9.9", "!=", "2.3.0.0")).toBe(true);
  });

  it("reads topology from the station serial, the device's own when it stands alone", () => {
    const sn = (stationSerial: string | undefined) => ({ serial: "T8400P0000000000", stationSerial });
    const behind = [[c("parent_sn", "RE", "^(T8030).*$")]];
    expect(pass(behind, sn("T8030P0000000000"))).toBe(true);
    expect(pass(behind, sn(undefined))).toBe(false);
    expect(pass([[c("parent_sn", "RE", "^(T8400).*$")]], sn(undefined)), "standalone").toBe(true);
    expect(pass([[c("parent_sn", "RE", "^(?!T8400|T7000).*$")]], sn(undefined))).toBe(false);
  });

  it("strips a suffixed station's firmware suffix before comparing, and only that station's", () => {
    const st = (stationSerial: string) =>
      pass([[c("parent_version", ">=", "3.2.8.6")]], { stationSerial, stationFirmwareVersion: "3.2.8.6_EU" });
    expect(st("T8010P0000000000")).toBe(true);
    expect(st("T8030P0000000000")).toBe(false);
  });

  it("honours Java's inline (?i), passes an empty value, and fails an invalid pattern", () => {
    expect(pass([[c("user_country", "RE", "^(?i)(jp).*$")]], { country: "JP" })).toBe(true);
    expect(pass([[c("user_country", "RE", "(?i)^(?!(JP|OM)).*$")]], { country: "fr" })).toBe(true);
    expect(pass([[c("user_country", "RE", "^(JP).*$")]], {}), "an empty value passes, as in the app").toBe(true);
    expect(pass([[c("device_sn", "RE", "([")]], { serial: "T8170P0000000000" })).toBe(false);
  });

  it("evaluates sdk_version against the app's own", () => {
    expect(pass([[c("sdk_version", "<=", "2.3.3.1")]])).toBe(true);
    expect(pass([[c("sdk_version", ">", "2.3.3.1")]])).toBe(false);
  });

  it("compares an associated field with the value the settings bundle parses from its reported param", () => {
    const field = (propId: string, q: string, v: string, params: Record<number, string>) =>
      pass([[c("associated_field", q, v, propId)]], { params });
    expect(field("is_support_silent_ota_switch", "=", "true", { 6287: "0" }), "reported at all").toBe(true);
    expect(field("is_support_silent_ota_switch", "=", "true", {})).toBe(false);
    expect(field("ai_empower", "=", "1", { 1299: "1" })).toBe(true);
    expect(field("ai_empower", "!=", "1", { 1299: "0" })).toBe(true);
    expect(field("ai_empower", "=", "0", { 1299: "none" }), "not JSON: as an integer, 0 when none").toBe(true);
    expect(field("device_power_supply_mode", "=", "2", { 6445: '{"power_source":2}' })).toBe(true);
    expect(field("device_power_supply_mode", "=", "5", { 6445: '{"source":5}' }), "source when no power_source").toBe(
      true,
    );
    expect(field("device_power_supply_mode", "=", "1", { 6445: "" }), "an empty param is 1").toBe(true);
    expect(field("ai_empower", "=", "", {}), "an unreported param compares an empty value").toBe(true);
    expect(field("view_mode", "=", "", { 1299: "1" }), "an identifier with no derivation, the same").toBe(true);
  });

  it("matches a reported param for camera_info", () => {
    const params = { 1234: "on" };
    expect(pass([[c("camera_info", "equals", '{"param":1234,"value":"on"}')]], { params })).toBe(true);
    expect(pass([[c("camera_info", "RE", '{"param":1234,"regex":"^o"}')]], { params })).toBe(true);
    expect(pass([[c("camera_info", "equals", '{"param":99,"value":"on"}')]], { params })).toBe(false);
  });

  it("matches a reported JSON param for camera_info's json_match", () => {
    const at = (reported: string, match: object) =>
      pass([[c("camera_info", "json_match", JSON.stringify({ param: 1092, json_match: match }))]], {
        params: { 1092: reported },
      });
    const onvif = { mode: "all", contains_key: ["onvif_support"], value_equals: { onvif_support: 1 } };
    expect(at('{"onvif_support":1}', onvif)).toBe(true);
    expect(at('{"onvif_support":0}', onvif)).toBe(false);
    expect(at("{}", onvif)).toBe(false);
    expect(at("not json", onvif)).toBe(false);
    expect(at('{"a":1}', { mode: "any", contains_key: ["a", "b"] })).toBe(true);
    expect(at('{"a":"x1"}', { not_contains_key: ["b"], value_not_equals: { a: "y" }, value_regex: { a: "^x" } })).toBe(
      true,
    );
    expect(at('{"a":1}', { mode: "any" }), "any with no check fails").toBe(false);
  });
});

describe("resolveThing", () => {
  const prop = (identifier: string, type: string, extra: Record<string, unknown> = {}) => ({
    identifier,
    access_mode: "RW",
    data_type: { type },
    ...extra,
  });
  const cond = (...conditions: { type: string; qualifier: string; value: string }[]) => ({
    condition_list: [{ conditions }],
  });
  const td = parseThingsList({
    things_list: [
      {
        profile: { product_code: "T0000" },
        properties: [
          prop("nightvision_type", "tenum"),
          prop("nightvision_type__v1", "bool", {
            read_conditions: cond({ type: "device_version", qualifier: "<=", value: "2.1.7.7" }),
          }),
          prop("mode", "enum"),
          prop("mode__v1", "int", { read_conditions: cond({ type: "parent_sn", qualifier: "RE", value: "^T8030" }) }),
          prop("mode__v2", "string", {
            read_conditions: cond(
              { type: "parent_sn", qualifier: "RE", value: "^T8030" },
              { type: "device_version", qualifier: ">=", value: "3.0.0.0" },
            ),
          }),
          prop("mode__v3", "bool"),
          prop("hidden", "bool", {
            available_conditions: cond({ type: "parent_sn", qualifier: "RE", value: "^T8030" }),
          }),
        ],
        actions: [
          { identifier: "always" },
          {
            identifier: "behind_only",
            available_conditions: cond({ type: "parent_sn", qualifier: "RE", value: "^T8030" }),
          },
        ],
      },
    ],
  }).T0000!;
  const standalone = (firmwareVersion: string) => resolveThing(td, { serial: "T0000P0000000000", firmwareVersion });

  it("picks the firmware variant the app picks, keyed by the base identifier", () => {
    expect(standalone("2.1.7.7").properties.nightvision_type).toMatchObject({
      identifier: "nightvision_type__v1",
      type: "bool",
    });
    expect(standalone("2.3.0.0").properties.nightvision_type).toMatchObject({
      identifier: "nightvision_type",
      type: "tenum",
    });
    expect(standalone("2.3.0.0").properties.nightvision_type__v1).toBeUndefined();
  });

  it("prefers the passing variant with the most conditions, never one without read conditions", () => {
    const behind = (firmwareVersion: string) =>
      resolveThing(td, { serial: "T0000P0000000000", stationSerial: "T8030P0000000000", firmwareVersion }).properties
        .mode?.identifier;
    expect(behind("3.1.0.0")).toBe("mode__v2");
    expect(behind("2.0.0.0")).toBe("mode__v1");
    expect(standalone("3.1.0.0").properties.mode?.identifier).toBe("mode");
  });

  it("leaves out what is unavailable", () => {
    expect(standalone("2.3.0.0").properties.hidden).toBeUndefined();
    expect(Object.keys(standalone("2.3.0.0").actions)).toEqual(["always"]);
  });
});

describe("a member's thing gives its enum options on the device", () => {
  const member = {
    param: 1,
    type: "number" as const,
    kind: "enum" as const,
    enumValues: { 0: "Off", 1: "Low", 2: "High" },
    thing: ["mode_new", "mode"],
    description: "synthetic",
  };
  const things = (properties: Record<string, unknown>[]) =>
    parseThingsList({ things_list: [{ profile: { product_code: "T0000" }, properties }] }).T0000!;
  const enumOf = (properties: Record<string, unknown>[]) =>
    resolvedEnum(member, { codec: "camera", things: things(properties) });
  const listed = (identifier: string, wire: string[]) => ({
    identifier,
    data_type: { type: "enum", specs: { eunmList: wire.map((associatedValue) => ({ associatedValue })) } },
  });

  it("takes the first listed identifier the device has, keeping the values the member names", () => {
    expect(enumOf([listed("mode", ["0", "1", "2"]), listed("mode_new", ["2", "0", "7"])])).toEqual({
      values: { 0: "Off", 2: "High" },
      dynamic: true,
    });
    expect(enumOf([{ identifier: "mode", data_type: { type: "bool" } }]).values, "a bool is 0 and 1").toEqual({
      0: "Off",
      1: "Low",
    });
  });

  it("keeps the static domain without a listed property, a named value or an enum", () => {
    expect(enumOf([listed("other", ["1"])])).toEqual({ values: member.enumValues, dynamic: false });
    expect(enumOf([listed("mode", ["9"])]).dynamic).toBe(false);
    expect(resolvedEnum(member, { codec: "camera" }).dynamic).toBe(false);
    expect(
      resolvedEnum({ ...member, enumValues: undefined }, { codec: "camera", things: things([listed("mode", ["1"])]) }),
    ).toEqual({ values: undefined, dynamic: false });
  });
});

/**
 * Trimmed `get_things_list` entries of one product per family, as the service returns them, with the
 * bundle ids and URLs synthesized, each beside the `wire` the product's settings bundle declares for its
 * identifiers (`scripts/dev/things-corpus.ts --fixture`).
 */
const FIXTURES = {
  smartlight: "T8L00",
  vacuum: "T2351",
  "vacuum-legacy": "T2250",
  mower: "T2801",
  security: "T8410",
  radar: "T8C00",
} as const;
type Wire = {
  via: string;
  dp?: number;
  method?: string;
  tag?: number;
  code?: string;
  cmd?: { id?: number };
  subCmd?: { id?: number };
};
const fixture = (name: keyof typeof FIXTURES) =>
  JSON.parse(readFileSync(new URL(`fixtures/things/${name}.json`, import.meta.url), "utf8")) as {
    things_list: Array<Record<"properties" | "actions" | "events", Array<{ identifier: string }>>>;
    wire: Record<string, { reads: Wire[]; writes: Wire[] }>;
  };
const described = (name: keyof typeof FIXTURES) => parseThingsList(fixture(name))[FIXTURES[name]]!;

describe("a service reply of each product family", () => {
  it.each(Object.keys(FIXTURES) as (keyof typeof FIXTURES)[])("parses the %s entry whole", (name) => {
    const raw = fixture(name).things_list[0]!;
    const td = described(name);
    const ids = (xs: Array<{ identifier: string }>) => xs.map((x) => x.identifier);
    expect(Object.keys(td.properties)).toEqual(ids(raw.properties));
    expect(Object.keys(td.actions)).toEqual(ids(raw.actions));
    expect(Object.keys(td.events)).toEqual(ids(raw.events));
    expect(td.bundle.path).toBe(`https://cdn.example/${FIXTURES[name]}Handle.mix.js`);
  });

  it("parses an unchanged product's short reply to its revision with nothing listed", () => {
    const td = parseThingsList({
      things_list: [{ profile: { product_code: "T0000" }, update_time: 1700000000 }],
    }).T0000!;
    expect([td.updateTime, Object.keys(td.properties).length, Object.keys(td.actions).length]).toEqual([
      1700000000, 0, 0,
    ]);
  });

  it("resolves the camera's night vision to the firmware variant, with its wire values", () => {
    const at = (firmwareVersion: string) =>
      resolveThing(described("security"), { serial: "T8410P0000000000", firmwareVersion }).properties.nightvision_type!;
    expect(at("2.1.7.7").type).toBe("bool");
    expect(at("2.1.7.8").members.map((m) => m.wireValue)).toEqual(["1", "3", "0"]);
  });

  it("offers a station-gated variant only behind the stations its pattern admits", () => {
    const alarm = (stationSerial: string) =>
      resolveThing(described("security"), { serial: "T8410P0000000000", stationSerial }).properties.set_alarm_type;
    expect(alarm("T8410P0000000000")).toBeUndefined();
    expect(alarm("T8010P0000000000")?.members.map((m) => m.wireValue)).toEqual(["1", "4"]);
  });
});
