/**
 * Synthetic settings-bundle data, for a spec that needs a bundle-driven member installed on a product
 * without depending on the shipped `bundle-wires.generated.json`.
 */
const scalar = (cmd: number, value: number) => ({
  cmd,
  body: "groupA",
  channel: "$channel",
  payload: { value },
  valueKey: "value",
  coerce: "int",
});
const envelope = (subCmd: number, payload: object) => ({
  cmd: 1350,
  subCmd,
  mValue3: 0,
  body: "json1350",
  channel: "$channel",
  payload,
});
const inverted = { "0": "1", "1": "0" };
const ALL = "standalone hb2 hb3";

/** `camera_on_off`: 1035 inverted standalone, read on `standaloneOrder`; privacy 6250 inverted on a HomeBase. */
export const power = (standaloneOrder = "1035") => ({
  write: {
    standalone: { "1": scalar(1035, 0), "0": scalar(1035, 1) },
    "hb2 hb3": { "1": envelope(6250, { switch: 0 }), "0": envelope(6250, { switch: 1 }) },
  },
  read: {
    standalone: { order: standaloneOrder, map: { 1035: inverted } },
    "hb2 hb3": { order: "6250", map: { 6250: inverted } },
  },
});

/** A switch written and read as is on `param`, every topology. */
export const toggle = (param: number) => ({
  write: { [ALL]: { "1": scalar(param, 1), "0": scalar(param, 0) } },
  read: { [ALL]: { order: String(param) } },
});

/** Night vision 100/102/103 written on 1277, read on `param` as raw 0/1/2. */
export const nightVision = (param = 1277) => ({
  write: {
    [ALL]: {
      "100": envelope(1277, { night_sion: 0 }),
      "102": envelope(1277, { night_sion: 1 }),
      "103": envelope(1277, { night_sion: 2 }),
    },
  },
  read: { [ALL]: { order: String(param), map: { [param]: { "0": "100", "1": "102", "2": "103" } } } },
});

/** The data module's shape: each identifier's entry under the space-joined `models`. */
export const bundleData = (models: string, entries: Record<string, object>) => ({
  default: { wires: Object.fromEntries(Object.entries(entries).map(([id, e]) => [id, { [models]: e }])) },
});
