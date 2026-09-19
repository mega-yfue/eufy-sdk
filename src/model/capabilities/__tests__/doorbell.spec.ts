import {
  DOORBELL,
  DOORBELL_CMD,
  DoorbellRingtone,
  DoorbellVideoQuality,
  DOORBELL_MEMBERS,
  type DoorbellActions,
} from "../doorbell.js";
import { buildCommand } from "../index.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";

const ctx = (channel = 0, extra: Partial<CommandContext> = {}): CommandContext => ({
  channel,
  codec: "camera",
  // The barrel's `buildCommand` only lets a module answer for a capability the device HAS; these ctxs
  // hand evidence directly rather than through detection, so the resolved set is stated.
  capabilities: new Set(["doorbell"] as const),
  paramIds: new Set<number>(),
  ...extra,
});

describe("doorbell capability module", () => {
  it("declares the capability + schema", () => {
    expect(DOORBELL.capability).toBe("doorbell");
    expect(DOORBELL.properties.map((p) => p.name)).toEqual([
      "chimeSwitch",
      "mechanicalChimeSwitch",
      "wdrSwitch",
      "ringtoneVolume",
      "dingdongVolume",
      "dingdongRingtone",
      "videoQuality",
      "notificationMode",
    ]);
  });

  it("does not publish the camera-owned status LED under the doorbell capability", () => {
    expect(DOORBELL.properties.some((p) => p.name === "doorbellLedEnable")).toBe(false);
    const doorbellCtx = ctx(3, {
      capabilities: new Set(["camera", "doorbell"]),
      deviceType: 94,
      model: "T8214",
      paramIds: new Set([1716]),
    });
    expect(buildCommand("doorbellLedEnable", true, doorbellCtx)).toBeUndefined();
  });

  it("detects via the doorbell model-name regex", () => {
    const re = DOORBELL.detection!.modelHints![0];
    expect(re.test("Video Doorbell")).toBe(true);
    expect(re.test("Indoor Cam")).toBe(false);
  });

  describe("buildCommand — direct-binary chime/image toggles (wire captured live on T8214)", () => {
    it("mechanicalChimeSwitch on → set-param 'direct-binary' scalar for 1703", () => {
      expect(buildCommand("mechanicalChimeSwitch", true, ctx(2))).toEqual({
        kind: "set-param",
        param: DOORBELL_CMD.MECHANICAL_CHIME_SWITCH,
        value: 1,
        form: "direct-binary",
        channel: 2,
      });
    });

    it("mechanicalChimeSwitch off → value 0, same shape", () => {
      expect(buildCommand("mechanicalChimeSwitch", false, ctx(2))).toEqual({
        kind: "set-param",
        param: DOORBELL_CMD.MECHANICAL_CHIME_SWITCH,
        value: 0,
        form: "direct-binary",
        channel: 2,
      });
    });

    it("wdrSwitch on/off → same 136-byte direct-binary shape for 1704, on ctx.channel (not hardcoded)", () => {
      expect(buildCommand("wdrSwitch", true, ctx(3))).toEqual({
        kind: "set-param",
        param: DOORBELL_CMD.WDR_SWITCH,
        value: 1,
        form: "direct-binary",
        channel: 3,
      });
      expect(buildCommand("wdrSwitch", false, ctx(3))).toMatchObject({ value: 0 });
    });
  });

  describe("buildCommand — 1350 SET_PAYLOAD dingdong controls (wire captured live on T8214)", () => {
    it("dingdongVolume → set-payload cmd 1717, {dingdong_volume}, explicit mValue3:0", () => {
      expect(buildCommand("dingdongVolume", 25, ctx(2))).toEqual({
        kind: "set-payload",
        cmd: DOORBELL_CMD.DINGDONG_VOLUME,
        payload: { dingdong_volume: 25 },
        channel: 2,
        mValue3: 0,
        form: "auto",
      });
    });

    it("dingdongVolume on ctx.channel (not hardcoded)", () => {
      expect(buildCommand("dingdongVolume", 3, ctx(7))).toMatchObject({ channel: 7 });
    });

    it("dingdongVolume rejects anything outside 0..100, like every sibling volume setter", () => {
      expect(() => buildCommand("dingdongVolume", 250, ctx(2))).toThrow(
        /dingdongVolume: 250 is not a valid value \(must be in 0\.\.100\)/,
      );
      expect(() => buildCommand("dingdongVolume", -10, ctx(2))).toThrow(
        /dingdongVolume: -10 is not a valid value \(must be in 0\.\.100\)/,
      );
    });

    it("dingdongRingtone → set-payload cmd 1718, {dingdong_ringtone}, explicit mValue3:0 (an index, not a bool)", () => {
      expect(buildCommand("dingdongRingtone", 4, ctx(2))).toEqual({
        kind: "set-payload",
        cmd: DOORBELL_CMD.DINGDONG_RINGTONE,
        payload: { dingdong_ringtone: 4 },
        channel: 2,
        mValue3: 0,
        form: "auto",
      });
    });

    it("dingdongRingtone accepts 0 (a valid selection index, not a falsy no-op)", () => {
      expect(buildCommand("dingdongRingtone", 0, ctx(2))).toEqual({
        kind: "set-payload",
        cmd: DOORBELL_CMD.DINGDONG_RINGTONE,
        payload: { dingdong_ringtone: 0 },
        channel: 2,
        mValue3: 0,
        form: "auto",
      });
    });

    it(
      "dingdongRingtone THROWS on an out-of-range/non-numeric index — a selection, so a bad pick " +
        "must not land on a real-but-wrong tone",
      () => {
        for (const bad of [99, -5, "x", 4.5]) {
          expect(() => buildCommand("dingdongRingtone", bad, ctx(2))).toThrow(
            /dingdongRingtone: .+ is not a valid value \(must be one of 0\/1\/2\/3\/4\/5\/6\/7\/8\/9\)/,
          );
        }
      },
    );
  });

  describe("DoorbellRingtone — index↔name map (T8214, 2026-07-23)", () => {
    it("has 10 entries, 0-indexed (anchors 0/7/8 wire-tested, rest inferred from the picker read-off)", () => {
      expect(DoorbellRingtone).toEqual({
        Default: 0,
        Silent: 1,
        Beacon: 2,
        Chord: 3,
        Christmas: 4,
        Circuit: 5,
        Clock: 6,
        Ding: 7,
        Hillside: 8,
        Presto: 9,
      });
    });

    it("plugs straight into buildCommand's dingdongRingtone case", () => {
      expect(buildCommand("dingdongRingtone", DoorbellRingtone.Hillside, ctx(2))).toMatchObject({
        payload: { dingdong_ringtone: 8 },
      });
    });
  });

  describe("buildCommand — the wireless chime, on its own captured wire", () => {
    /**
     * 1702 rides the same 136-byte direct-binary struct as its 1703 sibling, captured from the app on a
     * T8210 (OFF sent 0, ON sent 1) and replayed through this surface on that device — so the setter
     * exists, on `ctx.channel`, and the value is a plain boolean rather than the range-sharing guess the
     * member refused before.
     */
    it("chimeSwitch on/off → direct-binary scalar for 1702, on ctx.channel", () => {
      expect(buildCommand("chimeSwitch", true, ctx(2))).toEqual({
        kind: "set-param",
        param: DOORBELL_CMD.CHIME_SWITCH,
        value: 1,
        form: "direct-binary",
        channel: 2,
      });
      expect(buildCommand("chimeSwitch", false, ctx(3))).toMatchObject({ value: 0, channel: 3 });
      const { acts } = bind<DoorbellActions>("doorbell", ctx(2));
      expect("setChimeSwitch" in acts).toBe(true);
    });

    it("an unhandled action returns undefined (falls through to another module)", () => {
      expect(buildCommand("nope", true, ctx())).toBeUndefined();
    });
  });

  describe("1705 — one integer carrying two settings", () => {
    // value = quality + (highCompression ? 5 : 0). Six of the eight combinations were written from the
    // app and read back; 0 and 2 follow the same arithmetic and were not individually written.
    const quality = DOORBELL_MEMBERS.videoQuality.decode!;
    const compression = DOORBELL_MEMBERS.highCompressionEncoding.decode!;

    it("splits the observed values into their two halves", () => {
      const observed: Array<[number, number, boolean]> = [
        [1, DoorbellVideoQuality.Low, false],
        [3, DoorbellVideoQuality.High, false],
        [5, DoorbellVideoQuality.Auto, true],
        [6, DoorbellVideoQuality.Low, true],
        [7, DoorbellVideoQuality.Medium, true],
        [8, DoorbellVideoQuality.High, true],
      ];
      for (const [raw, q, high] of observed) {
        expect(quality(raw)).toBe(q);
        expect(compression(raw)).toBe(high);
      }
    });

    it("answers undefined for a value that is not one of the eight, rather than a wrong half", () => {
      // 4 and 9 are in range but outside the encoding: reading 9 as 9 % 5 would answer a quality of 4.
      // null and "" would become 0 through Number(), and 0 is a real value here — Auto on low
      // compression — so an absent reading must not decode as a setting.
      for (const bad of [-1, 4, 9, 1.5, "x", "", null, undefined, true]) {
        expect(quality(bad)).toBeUndefined();
        expect(compression(bad)).toBeUndefined();
      }
    });

    it("one setter carries both halves — the wire has no way to send one", async () => {
      const { acts, sent } = bind<DoorbellActions>("doorbell", ctx(2));
      await acts.setVideoQuality(DoorbellVideoQuality.Low, true);
      expect(sent[0]).toMatchObject({ param: DOORBELL_CMD.VIDEO_QUALITY, value: 6, channel: 2 });
      await acts.setVideoQuality(DoorbellVideoQuality.High, false);
      expect(sent[1]).toMatchObject({ value: 3 });
      await acts.setVideoQuality(DoorbellVideoQuality.Auto, true);
      expect(sent[2]).toMatchObject({ value: 5 });
    });

    it("takes both halves rather than preserving one from a read — that failed on hardware", async () => {
      // An earlier shape took only the quality and rebuilt the integer from the state reader. The reader
      // is the snapshot the device was bound with, so a second write composed against the value from
      // before the first: setting Low on 8 gave 6 correctly, then setting low compression re-read 8 and
      // sent 3, reverting the quality. Requiring both arguments removes the stale copy entirely, so no
      // reader is consulted here at all.
      const { acts, sent } = bind<DoorbellActions>("doorbell", ctx(2), {
        read: (n) => (n === "videoQuality" ? { value: 8 } : undefined),
      });
      await acts.setVideoQuality(DoorbellVideoQuality.Low, false);
      expect(sent[0]).toMatchObject({ value: 1 });
    });

    it("refuses a quality outside the enum", async () => {
      const { acts, sent } = bind<DoorbellActions>("doorbell", ctx(2));
      await expect(acts.setVideoQuality(9 as never, true)).rejects.toThrow(/videoQuality/);
      expect(sent).toHaveLength(0);
    });
  });
});
