import { describe, it, expect } from "vitest";
import { EufyMega } from "../eufy-mega.js";

/**
 * The account country is read from `countryCode` alone and defaults to `"US"`. A caller that passes
 * `country` instead has it silently ignored. The constructor refuses only the case that actually
 * misroutes — a non-`"US"` `country` with no `countryCode`, which would run on the US shard where
 * login still succeeds and the house list answers with an empty placeholder. `country: "US"` already
 * matches the default route, so it is left to pass through.
 */
function construct(extra: Record<string, unknown>) {
  return () => new EufyMega({ email: "t@example.com", password: "x", ...extra });
}

describe("a misnamed country option", () => {
  it("throws when a non-US `country` is passed without `countryCode`", () => {
    expect(construct({ country: "GB" })).toThrow(TypeError);
    expect(construct({ country: "GB" })).toThrow(/"countryCode"/);
  });

  it('does not throw for `country: "US"` — the routing already matches the default', () => {
    expect(construct({ country: "US" })).not.toThrow();
    expect(construct({ country: "us" })).not.toThrow();
  });

  it("constructs when `countryCode` is set (even alongside a stray `country`)", () => {
    expect(construct({ country: "GB", countryCode: "GB" })).not.toThrow();
  });
});
