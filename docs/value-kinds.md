# What a reading means

A typed getter hands you a value; it does not tell you how to show it. `dev.battery?.()?.level` and
`dev.battery?.()?.temperature` are both a number, and nothing in that number says one is a percentage
and the other a temperature. A host that wants to render a reading — pick a suffix, format
an instant as a date, put a bar on a scale — needs the meaning as **data**, not as a table it
maintains per property.

Every property a device exposes carries that meaning.

```ts
const dev = await eufy.getDevice(sn);

for (const p of dev.properties) {
  console.log(p.name, p.kind, p.unit ?? "");
  // battery             percent    %
  // batteryTemperature  celsius    °C
  // rssi                dbm        dBm
  // lastSeen            timestamp
}
```

`kind` is what the value **means**; the `type` beside it is only how it is stored. The two answer
different questions and a host almost always wants the first.

## The vocabulary

| kind                                                                                     | what a host does with it                                       |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `boolean`                                                                                | show a switch or a state, never a number                       |
| `percent`, `celsius`, `dbm`, `seconds`, `minutes`, `millimetres`, `megabytes`, `degrees` | render with the matching unit, which the property also carries |
| `scalar`                                                                                 | a bare number in no unit — show it as-is                       |
| `bitfield`                                                                               | several flags packed in one number, not a magnitude            |
| `enum`                                                                                   | look the value up in the option set shipped with it            |
| `identifier`                                                                             | an opaque id — display or pass through, never compute on       |
| `timestamp`                                                                              | an instant in unix seconds — format as a date                  |
| `text`                                                                                   | show as text, no further promise                               |

Three of these are close enough to confuse, so the distinction each time:

- **A bare number vs a measured quantity.** If the device reports a unit, the kind names that unit. If
  there is none, it is `scalar`: a sensitivity step, a mode index, a segment count. Ordered and
  comparable, but the range and its direction belong to the device — a higher number is not reliably
  "more" of anything, and two devices' scales are not the same scale.
- **An id vs a choice.** An `enum` travels with its options, so you can render a label without asking
  anyone. An `identifier` cannot: its list is held somewhere outside the device, so there is nothing to
  ship with the value, and arithmetic on it — sorting, nearest match, a range — is meaningless.
- **Flags vs a choice.** A `bitfield` combines: several meanings can be true in one value, so it has no
  single label and its size tells you nothing. Where a capability offers named flags it also offers the
  helpers to read and build them; prefer those over doing bit arithmetic yourself.

## Values are never converted

A reading comes out exactly as the device reports it. Temperatures stay Celsius, storage stays
megabytes, angles stay degrees. Converting inside the SDK would mean inventing a number the device
never sent, and a host that wants Fahrenheit knows its own audience better than we do — the kind is
what tells you a conversion is even meaningful.

The same applies to duration and instant. `seconds` is a length of time, `timestamp` is a point in
time, and both are numbers of seconds; treating one as the other produces a plausible, wrong answer
that no type check catches. The kind is the only thing that separates them.

## Handle a kind you do not know

The set is open on purpose. New kinds get modelled as more of the ecosystem is understood, and that
must not break a host that compiled against today's list — so treat it as a string you mostly
recognise, with a fallback:

```ts
function render(p: { kind?: string; unit?: string }, value: unknown): string {
  switch (p.kind) {
    case "percent":
      return `${value}%`;
    case "timestamp":
      return new Date(Number(value) * 1000).toLocaleString();
    case "boolean":
      return value ? "on" : "off";
    default:
      return p.unit ? `${value} ${p.unit}` : String(value);
  }
}
```

The default branch is not a formality: a kind you have never seen degrades to a raw reading, which is
always safe to show, instead of a crash or a wrong unit.

If you would rather branch on it explicitly, `isKnownValueKind` narrows a kind to the set this version
models, and `KNOWN_VALUE_KINDS` is that set as data:

<!-- typecheck: host log -->

```ts
import { isKnownValueKind, KNOWN_VALUE_KINDS } from "@mega-yfue/eufy-sdk";

if (!isKnownValueKind(kind)) log(`unmodelled kind ${kind} — showing the raw value`);
```

That is the same list the SDK checks its own annotations against, so it cannot fall behind them.

## A few carry no kind

A property whose stored value is a whole configuration payload has no single meaning of its own — the
value a host cares about is one field inside it. Those expose the meaning on the reading rather than on
the property, and the typed getter already returns the lifted value. If a property has no `kind` and no
getter, nothing has confirmed what it means yet, and guessing on your side is no safer than guessing on
ours.

See [Devices & capabilities](/devices) for how a device comes to have the properties it has.
