import { describe, expect, it } from "vitest";
import { bindMembers, unobservableMembers } from "../members.js";
import type { CommandContext } from "../types.js";

/**
 * A caller deciding whether to offer a control has to tell "observed as off" from "cannot be observed at
 * all". Absence of a getter carries that information, but only as an absence: a caller reading
 * `cam.privacy === undefined` cannot distinguish a device that reports privacy as unset from one that never
 * reports it, and TypeScript hides the difference behind the same `undefined`. Guessing either way is the
 * thing that must not happen — refusing a working camera withdraws it, allowing a dead one shows a viewer a
 * stream that will never carry frames.
 *
 * So the members table states it: a member the device ACCEPTS but never reports back is named, per device,
 * as unobservable.
 */
const ctx = (paramIds: number[]): CommandContext =>
  ({
    channel: 0,
    paramIds: new Set(paramIds),
    deviceType: 30,
    model: "T8410",
    capabilities: new Set(["camera"]),
  }) as unknown as CommandContext;

const sink = { dispatch: async () => undefined };

function bind(members: Record<string, unknown>, paramIds: number[]) {
  return bindMembers(members as never, ctx(paramIds), sink as never, () => undefined) as Record<string, unknown>;
}

const writeOnlyMember = {
  type: "bool" as const,
  kind: "boolean" as const,
  writeOnly: true as const,
  provenance: "verified" as const,
  description: "a setting the device never reports back",
  write: () => ({ kind: "set-param" as const, param: 1, value: 1, channel: 0 }),
};

const readableMember = {
  param: 1035,
  type: "bool" as const,
  kind: "boolean" as const,
  provenance: "verified" as const,
  description: "a setting the device does report",
};

describe("unobservable members", () => {
  it("names a member the device accepts but never reports", () => {
    const bound = bind({ privacy: writeOnlyMember }, []);
    expect(unobservableMembers(bound)).toEqual(["privacy"]);
  });

  it("does not name a member the device reports", () => {
    const bound = bind({ enabled: readableMember }, [1035]);
    expect(unobservableMembers(bound)).toEqual([]);
  });

  it("still names the write-only member alongside a readable one", () => {
    const bound = bind({ enabled: readableMember, privacy: writeOnlyMember }, [1035]);
    expect(unobservableMembers(bound)).toEqual(["privacy"]);
    expect("privacy" in bound).toBe(false);
    expect("enabled" in bound).toBe(true);
  });

  it("is the statement a caller needs: the setter exists while the read never can", () => {
    const bound = bind({ privacy: writeOnlyMember }, []);
    expect(typeof bound.setPrivacy).toBe("function");
    expect(unobservableMembers(bound)).toContain("privacy");
  });

  it("does not name a member this device does not have at all", () => {
    const bound = bind({ privacy: { ...writeOnlyMember, available: () => false } }, []);
    expect(unobservableMembers(bound)).toEqual([]);
  });

  it("is frozen, so a caller cannot rewrite the statement", () => {
    const bound = bind({ privacy: writeOnlyMember }, []);
    expect(Object.isFrozen(unobservableMembers(bound))).toBe(true);
  });

  it("does not appear among the capability's own keys — it describes the surface, not a member of it", () => {
    const bound = bind({ enabled: readableMember, privacy: writeOnlyMember }, [1035]);
    expect(Object.keys(Object.getOwnPropertyDescriptors(bound))).not.toContain("unobservable");
  });

  it("answers empty for a surface it was never attached to", () => {
    expect(unobservableMembers({})).toEqual([]);
  });
});
