import { parseThingsList } from "../thing-description.js";

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

  it("keeps the product's identity, versions and plugin", () => {
    expect(t).toMatchObject({
      productCode: "T0000",
      version: "1.0",
      updateTime: 1700000000,
      largeVersion: 12,
      largeVersionUpdateTime: 1700000100,
      plugin: {
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
      writeConditions: [],
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
