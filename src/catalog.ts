/**
 * The thing descriptions of every product in the corpus the settings-bundle wires are generated from, as
 * the descriptions state them: per property identifier, each distinct variant (type, access mode, range
 * and unit when stated, enum options as `[value, desc]` pairs in the description's order, and the raw value
 * each option stores where the descriptions name one) with the product codes that describe it. A label is the
 * description's text or key, verbatim. A device's own options are still the ones its description lists at
 * runtime.
 */
import DATA from "./model/capabilities/things-catalog.generated.json" with { type: "json" };

export interface ThingCatalog {
  readonly source: { readonly corpus: string; readonly bundles: Readonly<Record<string, string>> };
  readonly properties: Readonly<
    Record<
      string,
      readonly {
        readonly type: string;
        readonly access: string;
        readonly min?: number;
        readonly max?: number;
        readonly step?: number;
        readonly unit?: string;
        readonly options?: readonly (readonly [value: string, label: string])[];
        /**
         * Per option value, the value the device stores for it (the description's `associatedValue`, a bound
         * member's `wireValue`), where the description names one. Two options of one variant can share a label and
         * differ here; products storing other values are another variant.
         */
        readonly wireValues?: Readonly<Record<string, string>>;
        readonly products: readonly string[];
      }[]
    >
  >;
}

export const catalog = DATA as unknown as ThingCatalog;
