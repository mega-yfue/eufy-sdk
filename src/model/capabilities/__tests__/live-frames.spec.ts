import { describe, expect, it } from "vitest";
import { liveFrames } from "../bundle.js";

/**
 * The frames the generated bundle data gives a product's live view and talkback, picked by the app's
 * `getConnectType(parent_sn)`. Synthetic serials: only the prefix (and HB3E's character 7) is read.
 */
const OWN = (model: string) => `${model}P0000000000`.slice(0, 16);
const HB1 = "T8001P0000000000";
const HB2 = "T8010P0000000000";
const HB3 = "T8030P0000000000";
const HB3E = "T8030P0100000000";

describe("liveFrames", () => {
  it("starts a standalone T8111 with the direct 1003, counter bumped, and stops it with the direct 1004", () => {
    const f = liveFrames("T8111", OWN("T8111"), [])!;
    expect(f.start).toMatchObject({ cmd: 1003, body: "native", layout: "0x2db020", counter: "bump" });
    expect(f.stop).toMatchObject({ cmd: 1004, body: "native", layout: "u32-ch" });
    expect(f.talkStart).toMatchObject({ cmd: 1005, layout: "u32-ch" });
  });

  it("starts a standalone T8122 with 1700/1000 and no counter, and talks over 1700/1001", () => {
    const f = liveFrames("T8122", OWN("T8122"), [])!;
    expect(f.start).toMatchObject({ cmd: 1700, subCmd: 1000, body: "json1700" });
    expect(f.start.counter).toBeUndefined();
    expect(f.start.payload).not.toHaveProperty("extValue");
    expect(f.talkStart).toMatchObject({ cmd: 1700, subCmd: 1001 });
  });

  it("starts a standalone T8170 with 1700/1000 carrying extValue 1000 and a bumped counter", () => {
    const f = liveFrames("T8170", OWN("T8170"), [])!;
    expect(f.start).toMatchObject({ cmd: 1700, subCmd: 1000, counter: "bump", payload: { extValue: 1000 } });
  });

  it("starts an HB2-attached camera with the 1350/1003 params-as-body and stops it with the direct 1004", () => {
    for (const parent of [HB1, HB2]) {
      const f = liveFrames("T8122", parent, [])!;
      expect(f.start).toMatchObject({
        cmd: 1350,
        body: "json",
        counter: "bump",
        payload: { cmd: 1003, mValue3: 1003, mValueStrSub: "$userId", payload: { key: "$key", ClientOS: "ANDROID" } },
      });
      expect(f.stop).toMatchObject({ cmd: 1004, body: "native" });
    }
  });

  it("stops an HB3-attached camera with 1350/1004, and tells HB3E apart by character 7", () => {
    expect(liveFrames("T8122", HB3, [])!.stop).toMatchObject({ cmd: 1350, body: "json1350", subCmd: 1004 });
    expect(liveFrames("T8110", HB3, [])!.start.payload).not.toHaveProperty("cameraType");
    expect(liveFrames("T8110", HB3E, [])!.start.payload).toMatchObject({ payload: { cameraType: 0 } });
  });

  it("keeps a T8162's talkback on 1700 even attached", () => {
    expect(liveFrames("T8162", HB2, [])!.talkStart).toMatchObject({ cmd: 1700, subCmd: 1001 });
  });

  it("reads the ability off the parent's param 1103 first, then the device's, as an integer", () => {
    expect(liveFrames("T8122", HB2, [{ 1103: "130" }, { 1103: "2" }])!.ability).toBe(130);
    expect(liveFrames("T8122", HB2, [{ 1103: "x" }, { 1103: "2" }])!.ability).toBe(2);
    expect(liveFrames("T8122", HB2, [undefined, {}])!.ability).toBe(0);
  });

  it("gives a product the bundles have no live view for nothing", () => {
    expect(liveFrames("T8500", OWN("T8500"), [])).toBeUndefined();
  });
});
