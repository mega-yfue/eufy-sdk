# Pan-tilt-zoom (PTZ)

Cameras that pan, tilt, and zoom expose a `ptz()` accessor. Like every capability accessor it is
`undefined` on a device that lacks it (or on an unbound model), so call it with `?.` — or check
`dev.has("ptz")` first.

```ts
const ptz = dev.ptz?.();
if (!ptz) throw new Error("not a PTZ camera");
```

## Move & zoom

Movement is **command-driven** — the camera has no "go to angle X" write; it steps in a direction.

```ts
import { PtzDirection } from "@mega-yfue/eufy-sdk";

await ptz.rotate(PtzDirection.left, 1.0); // step in a direction (optional zoom factor)
await ptz.left(); // shorthands: left / right / up / down
await ptz.up();
await ptz.rotate360(); // full 360° pan (room scan)

await ptz.zoom?.(2); // digital zoom to a factor (no movement)
await ptz.zoom?.(1); // back to the full wide view
```

`PtzDirection` is exported from the package — pass the named member so the choices autocomplete and
can't drift.

Zoom is a **dual-lens** feature (a second telephoto camera). `zoom` is therefore present **only on
cameras that have it** — it's `undefined` on a single-lens pan-tilt cam, so call it with `?.` (or check
`if (ptz.zoom)`). This is resolved when the device loads — no wire call. There's no way to read the
_current_ zoom level at rest; observe changes via the `ptzNotify` event instead.

## Presets

A **preset** is a stored camera position (a slot the camera can snap back to). All preset operations
live under the `preset()` sub-API:

```ts
const preset = ptz.preset();

await preset.goto(3); // move to stored preset 3
await preset.preview(3); // move to it transiently (preview before committing)
await preset.save(3); // save the CURRENT position into slot 3 (create or overwrite)
await preset.preview(3); // …then park on it before setting default (see note below)
await preset.setDefault(3); // make preset 3 the home position
await preset.delete(3); // remove preset 3
```

| Method           | What it does                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `goto(id)`       | Move to stored preset `id`.                                                                                                                            |
| `preview(id)`    | Move to `id` transiently — the app's "preview before default" step.                                                                                    |
| `save(id)`       | Save the camera's current position into slot `id` (create/overwrite).                                                                                  |
| `setDefault(id)` | Make preset `id` the home position — sets the default to the preset the camera is parked on, so `preview(id)` and let the pan finish first (see note). |
| `delete(id)`     | Remove preset `id`.                                                                                                                                    |
| `list?()`        | List stored presets (live-only, see below).                                                                                                            |
| `image?(id)`     | Fetch preset `id`'s thumbnail (live-only, see below).                                                                                                  |

### Only `save` populates a slot — the rest are fire-and-forget

Preset writes get no acknowledgement back, so referencing an **empty** slot is a **silent no-op**:
`goto` / `preview` / `setDefault` / `delete` on an id that was never `save`d simply do nothing — no
error surfaces. If the id might not exist, check `list?()` first.

`setDefault(id)` additionally sets the default to the preset the camera is **currently parked on** — so
`preview(id)`, let the pan finish, then `setDefault(id)`. Sent with the camera elsewhere it has no effect.

### Reading presets (live-only)

`list()` and `image()` are request/reply reads, so they are present **only when the device is bound
to a live client** — call them with `?.`:

```ts
const presets = (await ptz.preset().list?.()) ?? []; // [{ id, raw }, …]
console.log(presets.map((p) => p.id)); // e.g. [0, 1, 3]

const thumb = await ptz.preset().image?.(3); // { index, data } — data is a base64 JPEG
if (thumb) console.log(`${thumb.data.length} bytes`);
```

`list()` returns `{ id, raw }` per preset (`raw` preserves any model-specific fields). `image()`
returns `{ index, data }` with the thumbnail as a base64 JPEG; a very large thumbnail may not come
back over the live channel yet — treat an empty result as "not available".

## Example

<<< @/../examples/04-ptz.ts

Next: [Events](/events) · [Live media](/live-media).
