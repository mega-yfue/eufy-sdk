import { describe, it, expect } from "vitest";
import { EufyMega } from "../eufy-mega.js";

/**
 * The account country is read from `countryCode` alone and defaults to `"US"`. A caller that passes
 * `country` instead would get a client routed to the US shard, where login still succeeds and the house list
 * answers with an empty placeholder — so the misnamed option is refused at construction.
 */
function construct(extra: Record<string, unknown>) {
  return () => new EufyMega({ email: "t@example.com", password: "x", ...extra });
}

describe("a misnamed country option", () => {
  it("throws when `country` is passed without `countryCode`", () => {
    expect(construct({ country: "GB" })).toThrow(TypeError);
    expect(construct({ country: "GB" })).toThrow(/"countryCode"/);
  });

  it("constructs when `countryCode` is set", () => {
    expect(construct({ country: "GB", countryCode: "GB" })).not.toThrow();
  });
});
