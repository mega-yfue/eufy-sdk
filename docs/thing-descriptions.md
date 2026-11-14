# Thing descriptions and their wire

A product's **thing description** is what the vendor's `things` service returns for its product code
from `app/things/get_things_list`: every property, action and event of the product, keyed by a stable
identifier, with its type, its values and the conditions that gate it per device. The SDK reads it
through `parseThingsList` and `resolveThing`, and every capability context carries the resolved result
as `ctx.things`.

## The request

`POST app/things/get_things_list` on the `things` host, with `{ product_codes, code_time_map }`. The
keys are snake_case; any product code is answered, owned or not. `code_time_map` names, per code, the
`update_time` already held: an unchanged product comes back with that `update_time` and no properties.

## The reply

`data.things_list` holds one entry per product:

| key                                       | content                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `profile`                                 | `product_code`, `version`, and the settings bundle below                                           |
| `properties`                              | `identifier`, `access_mode` (`R` / `RW`), `data_type {type, specs}`, read and available conditions |
| `actions`, `events`                       | `identifier`, input / output types, available conditions                                           |
| `update_time`, `large_version`, `version` | revision metadata                                                                                  |

Types seen across products: `int`, `bool`, `string`, `text`, `enum`, `tenum`, `ienum`. An enum lists its
members in `eunmList` (the vendor's spelling): the app's UI `value`, a label `desc` and, when the member
maps onto the device, the wire value `associatedValue`. A property may exist as `identifier__v1`,
`__v2`, … each gated on the device's firmware, station, serial, country or another property's value.

Another property's value (`associated_field`) is the one the settings bundle parses from a reported param;
`resolveThing` derives it for the identifiers the catalogue conditions on most: `is_support_silent_ota_switch`
(param 6287 reported), `ai_empower` (1299) and `device_power_supply_mode` (6445), which cover 370 of its
400 uses. Any other compares an empty value. `camera_info` compares a reported param, as a value, a pattern
or a JSON object (`json_match`). The catalogue uses no write condition and no `user_domain`,
`user_permission` or `parent_associated_field` condition; a condition type the SDK does not handle fails.

Identifier families: security products use plain names (`nightvision_type`, `led_on_off`), vacuums
`ecl_*`, mowers `ecl_mow_*`, smart lights `light_*` and `device_*`.

## The settings bundle — where the wire is

A description names no wire. `profile` points at the product's **settings bundle**, the app's own
per-product script: `plugin_path` (with `plugin_id` its md5), the same script zipped at `plugin_path_zip`,
and an unused precompiled slot `plugin_path_qjsc`. The app downloads it per product code, checks the md5,
and runs it for every command and every report: it is the app's translation between identifiers and
frames. The bundles encode the wire in a few shapes:

| family      | reads                                                                      | writes                                                                                                   |
| ----------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| security    | parser class per identifier, `getCommandIds`; a command → identifier table | `cmd`, and `subCmd` when riding a payload command                                                        |
| vacuum      | per data point, the protobuf field path of each identifier                 | a request encoder and its method, sent on a data point; older models send a value on a data point inline |
| mower       | data point per identifier, protobuf field path per data point              | data point per action                                                                                    |
| smart light | TLV tag per identifier in the status report; an event's command code       | MQTT command code per action                                                                             |
| radar       | —                                                                          | MQTT command code per action, as smart lights                                                            |

A bundle is the vendor's code: it never goes in this repository and is never run.

## The evidence corpus

`scripts/dev/things-corpus.ts` fetches the descriptions and bundles for a set of product codes into a
directory outside the repository, and extracts per identifier the wire its bundle declares. A bundle is
downloaded again only when its md5 no longer matches `plugin_id`.

```bash
node scripts/dev/things-corpus.ts ~/things-corpus T8410 T2351 T2801 T8L00   # named products
node scripts/dev/things-corpus.ts ~/things-corpus                           # refresh what is there
node scripts/dev/things-corpus.ts --check ~/things-corpus/bundles/T8410.js nightvision_type
node scripts/dev/things-corpus.ts --fixture ~/things-corpus T8410 nightvision_type led_on_off  # a spec fixture
node scripts/dev/things-corpus.ts --coverage ~/things-corpus                                   # what is wired
```

An extraction is a lead for a capability's evidence, not a verified wire: an identifier may come out on
several commands or firmware branches, and a constant the bundle defines twice resolves to its name only.
A write still needs a capture or a run on a real device before it ships.

### Coverage

Over 181 products (properties and actions listed, 2026-11):

| family      | products | wired       | named, not wired | absent from the bundle | wired from several reads |
| ----------- | -------- | ----------- | ---------------- | ---------------------- | ------------------------ |
| security    | 127      | 7828 (54 %) | 1844             | 4930                   | 1833                     |
| vacuum      | 41       | 7511 (62 %) | 553              | 3972                   | 170                      |
| mower       | 4        | 1589 (86 %) | 145              | 112                    | 0                        |
| smart light | 8        | 273 (72 %)  | 34               | 70                     | 8                        |
| radar       | 1        | 2 (50 %)    | 2                | 0                      | 0                        |

What is left, by kind:

- **Absent from the bundle** — app and cloud state the bundle never handles: UI layout
  (`live_*_toolbar_list`), presence and versions (`device_is_online`, `firmware_main_version`), the app's
  own context (`ecl_app_info_*`), sharing and cloud OTA. Their source, when there is one, is outside the
  bundle (the app itself or the cloud device record).
- **Named, not wired** — shapes the extractor does not follow yet. Vacuums: `ecl_decode_*` decode a map,
  path or zone blob passed in, with no data point of their own; sharing and OTA actions go to the cloud.
  Mowers: replies to an extended command, keyed by its type (`EXTEND_CMD_TYPE_ANTI_THEFT`, …) rather than
  by a data point. Security: device-info fields filled from the cloud device record (`device_model`,
  `ip_address`), and stream and recording controls routed through generic modules. Smart lights and radar:
  a TLV tag decoded through a loop or a list (`device_light_led_status`, a bitfield on tag `A7`;
  `radar_sn` in a list of radar entries).
- **Wired from several reads** — the same identifier decoded from different commands per model, firmware
  or station (`case "vN"` switches), or on two tags by firmware branch (`light_effect_mode`, 167 or 168).
  The right one for a device is a per-capability question.
- **By name only** — 93 security identifiers whose command constant the bundle defines with two numbers;
  the extraction keeps the name.

## Fixtures and the cross-check

`src/model/capabilities/__tests__/fixtures/things/` holds one trimmed entry per family (`smartlight` T8L00,
`vacuum` T2351, `vacuum-legacy` T2250, `mower` T2801, `security` T8410, `radar` T8C00), each with its
`wire`, made by `--fixture`. `thing-description.spec.ts` parses them and resolves the firmware and station
variants; `thing-wire.spec.ts` asserts every wire the SDK already drives against the bundle's. A fixture
wire it does not assert — mower control and battery-status data points, the radar's codes, the second
light-effect-mode tag — is a lead from the bundle alone.

`code_time_map`'s short reply (an unchanged product: its `update_time`, nothing listed) is parsed as an
empty description; the reply shape itself is stated by the service's client, not captured.
