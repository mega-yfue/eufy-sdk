import { describe, expect, it } from "vitest";
import { bindMembers, unobservableMembers, unreflectedMembers } from "../members.js";
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

  it("survives neither a spread nor JSON — it describes the surface, not a member of it", () => {
    const bound = bind({ enabled: readableMember, privacy: writeOnlyMember }, [1035]);
    expect(unobservableMembers({ ...bound })).toEqual([]);
    expect(JSON.stringify(bound)).not.toContain("privacy");
    expect(Object.getOwnPropertyNames(bound)).not.toContain("unobservable");
  });

  it("does not name a member whose write is unverified — it has no setter and its intent throws", () => {
    const bound = bind({ privacy: { ...writeOnlyMember, unverified: true } }, []);
    expect(bound.setPrivacy).toBeUndefined();
    expect(unobservableMembers(bound)).toEqual([]);
  });

  it("does not name a write-only member that declares no write at all", () => {
    const { write, ...noWrite } = writeOnlyMember;
    const bound = bind({ privacy: noWrite }, []);
    expect(unobservableMembers(bound)).toEqual([]);
  });

  it("answers empty for a surface it was never attached to", () => {
    expect(unobservableMembers({})).toEqual([]);
  });
});

/**
 * A readable value that silently disagrees with its own setter is worse than an unreadable one: the caller has
 * no reason to distrust it. That happens where a family routes the write to a different wire than the read
 * observes, and the read then answers honestly about a param the write never touched.
 */
describe("unreflected members", () => {
  const routedElsewhere = {
    ...readableMember,
    readReflectsWrite: (c: CommandContext) => c.model !== "T8410",
    write: () => ({ kind: "set-param" as const, param: 6250, value: 1, channel: 0 }),
  };

  it("names a member whose write lands on a wire its read does not observe", () => {
    const bound = bind({ enabled: routedElsewhere }, [1035]);
    expect(unreflectedMembers(bound)).toEqual(["enabled"]);
  });

  it("still reports the value — the point is that it cannot be trusted, not that it is absent", () => {
    const bound = bind({ enabled: routedElsewhere }, [1035]);
    expect("enabled" in bound).toBe(true);
    expect(typeof bound.setEnabled).toBe("function");
  });

  it("says nothing about a member whose read does reflect its write", () => {
    const bound = bind({ enabled: { ...routedElsewhere, readReflectsWrite: () => true } }, [1035]);
    expect(unreflectedMembers(bound)).toEqual([]);
  });

  it("says nothing about a member that never declared the distinction", () => {
    const bound = bind({ enabled: { ...readableMember, write: routedElsewhere.write } }, [1035]);
    expect(unreflectedMembers(bound)).toEqual([]);
  });

  it("keeps the two statements separate — a write-only member is unobservable, not unreflected", () => {
    const bound = bind({ privacy: writeOnlyMember, enabled: routedElsewhere }, [1035]);
    expect(unobservableMembers(bound)).toEqual(["privacy"]);
    expect(unreflectedMembers(bound)).toEqual(["enabled"]);
  });

  it("answers empty for a surface it was never attached to", () => {
    expect(unreflectedMembers({})).toEqual([]);
  });
});
