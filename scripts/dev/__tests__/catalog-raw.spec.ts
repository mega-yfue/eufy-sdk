import { withRaw, type Catalog } from "../catalog-raw.ts";

/** Synthetic descriptions: product codes, identifiers, values and labels are made up. */
const describe =
  (lists: Record<string, Record<string, { value: string; associatedValue?: string }[]>>) =>
  (product: string, identifier: string) =>
    lists[product]?.[identifier];

const variant = (products: string[]) => ({
  type: "enum",
  access: "RW",
  options: [
    ["100", "mode_off"],
    ["101", "mode_on"],
    ["102", "mode_on"],
  ] as [string, string][],
  products,
});

test("a variant takes the raw value its products' descriptions agree on, after its options", () => {
  const catalog: Catalog = { source: {}, properties: { mode_set: [variant(["T0001", "T0002"])] } };
  const list = [
    { value: "100", associatedValue: "0" },
    { value: "101", associatedValue: "3" },
    { value: "102", associatedValue: "1" },
  ];
  const out = withRaw(catalog, describe({ T0001: { mode_set: list }, T0002: { mode_set: [...list].reverse() } }));
  const [only] = out.properties.mode_set!;
  expect(only!.raw).toEqual({ "100": "0", "101": "3", "102": "1" });
  expect(Object.keys(only!)).toEqual(["type", "access", "options", "raw", "products"]);
});

test("a value the descriptions disagree on, or a product listing other values, adds nothing", () => {
  const catalog: Catalog = { source: {}, properties: { mode_set: [variant(["T0001", "T0002", "T0003"])] } };
  const out = withRaw(
    catalog,
    describe({
      T0001: {
        mode_set: [{ value: "100", associatedValue: "0" }, { value: "101", associatedValue: "3" }, { value: "102" }],
      },
      T0002: {
        mode_set: [{ value: "100", associatedValue: "0" }, { value: "101", associatedValue: "4" }, { value: "102" }],
      },
      T0003: { mode_set: [{ value: "100", associatedValue: "9" }] },
    }),
  );
  expect(out.properties.mode_set![0]!.raw).toEqual({ "100": "0" });
});

test("a variant no product of which the corpus describes stays as it was", () => {
  const catalog: Catalog = { source: {}, properties: { mode_set: [variant(["T0009"])] } };
  expect(withRaw(catalog, describe({})).properties.mode_set![0]).toEqual(variant(["T0009"]));
});
