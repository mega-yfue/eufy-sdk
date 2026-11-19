# Smart Display

The eufy Smart Display (T87A0, "Smart Display E10") is the smallest surface in this SDK, and the
reason is worth stating before the API: **almost nothing about it is on a wire anyone here has read.**

```ts
const display = dev.display?.();

display?.battery; // 0-100 — the screen's charge
```

That is the whole capability. There is no screen control, no volume, no assistant — not because they
are unimplemented, but because the one captured unit reported no parameter for any of them.

Three more params ARE readable, without a typed getter:

```ts
const props = dev.getProperties();
props.modelName?.value; // "Smart Display E10"
props.modelCode?.value; // "T87A0"
props.softwareVersion?.value; // "2.9.05" — version-shaped; see the warning below
```

A typed getter is a recommendation, not just a decoding, and these three do not earn one. `modelName` and
`modelCode` restate what `dev.info?.()` already answers from the curated registry and the cloud record —
their whole evidence is that agreement, so a getter beside `info` would offer a second spelling of what
you just read; being named in the display's param dictionary is enough to keep them readable.
`softwareVersion` is a guess, and a guess must not reach a surface where a caller cannot see the label —
so it is in the property SCHEMA, carrying its type and its `guessed` label, and `getProperty` answers for
it, with no getter on the bound object.

## What the device actually reported

One T87A0, captured 2026-09-04. It connects over **secure MQTT with no `p2p_did`**, so it never speaks
P2P at all, and it reported six parameters in the ids `8001`-`8006` — an id range no other eufy line
uses.

| Param | Value on the capture   | Modelled as                             |
| ----- | ---------------------- | --------------------------------------- |
| 8001  | `"100"`                | `battery` — the one typed getter        |
| 8002  | `"1"`                  | —                                       |
| 8003  | `"2.9.05"`             | `softwareVersion` (a guess — see below) |
| 8004  | a serial-shaped string | —                                       |
| 8005  | `"Smart Display E10"`  | `modelName`                             |
| 8006  | `"T87A0"`              | `modelCode`                             |

**Two of the six are deliberately unnamed.** `1` fits any enum or flag, and a serial-shaped value could
be the display's own or the station it is bound to. One value does not settle either, and a name here
would be read downstream as a fact. They are reported as raw ids instead.

**8001 is the battery because the maintainer identified it.** `"100"` fits a percentage of brightness,
volume or charge equally well, so the capture could not have said which, and picking one would have been a
coin toss presented to users as a fact. It took someone who knows the device — not another capture, and not
the cloud data-point list.

The 0-100 scale rests on the reading rather than on convention alone: a full charge reads `255` on a
0-255 scale and `1000` on a 0-1000 one, so `"100"` on a charged unit is positive evidence for a
percentage. What nobody has done is watch it **move**, which is the one thing that would distinguish a
healthy value from one frozen at 100.

A display's charge is read through `dev.display?.()`, not `dev.battery?.()`. The two mean the same thing on
different wires — a camera's is param 1101 in the security id space, a display's is 8001 in this one — and
reading both from one capability would be a claim that the ecosystems share a param space, which is the
door this line was split to close.

::: warning `softwareVersion` is an inference
It is the only one of the four nothing corroborates, and why it has no typed getter. The device sent a
dotted version-shaped string. `modelName` and `modelCode` hold VALUES already known from elsewhere — the
retail name and the model code — so the match is evidence about the id, not a shape that suggests one.
`battery` is a real id with a consistent reading, named by a person rather than by a data-point list.

Where the cloud record carries a firmware version, `dev.info()?.firmwareVersion` is the field to trust.
This device's record did not, which is the only reason 8003 is named at all.
:::

## Why it is not part of the security line

A Smart Display shares a cloud account with the cameras and nothing else. Grouping it into the `security`
product line and param namespace — which its `device_type` of `1` invites, since that falls inside the
security residual range — leaves two doors open:

- **A future security parameter assigned in the 8000s** would have been decoded off a Smart Display as
  whatever that id means on a camera.
- **Any security capability detected by a NAME regex** became attachable to it. eufy's retail vocabulary
  collides across ecosystems, and detection evidence is OR-ed, so this was measured rather than
  hypothetical: with an adversarial device name, six security capabilities attached — light, doorbell,
  leak, smoke, CO, lock — none of which this device could ever answer for, because it has no P2P path.

Both are shut by `display` being its own product line with its own parameter dictionary. The adversarial
case is pinned in `line-partition.spec.ts`, and the naming it buys in `display.spec.ts`: the captured
record's six params, each one named or explicitly raw.

## Nothing is writable

No write is offered for any display parameter, and none is guessed. An AIoT data-point write is
fire-and-forget — the device acknowledges nothing — so a wrong frame to a device that cannot contradict
you looks exactly like success. The reads have to arrive before a control can be honest about what it
moves.

## What would open this up

A capture of the vendor app driving the display's own settings, **one control at a time, with the
reported parameters diffed after each change.** That is what would name 8002 and 8004, confirm or
correct `softwareVersion`, and reveal whichever ids carry the screen, the volume and the assistant —
none of which appeared in the capture at all, which suggests they arrive on a channel this SDK has not
yet looked at rather than as parameters it simply failed to name.

See [Devices & capabilities](/devices) for how capability resolution works.
