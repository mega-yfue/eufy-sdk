import { type DoorbellActions, type QuickResponse } from "../doorbell.js";
import { CAMERA_CMD, type CameraActions } from "../camera.js";
import type { AudioActions } from "../audio.js";
import { bind } from "./bind.js";
import type { CommandContext } from "../types.js";
import type { MediaProvider } from "../../../core/contracts.js";

/** The bound `dev.doorbell()` object — every method is a member, derived in the barrel. */
const doorbellOf = (media?: MediaProvider) => bind<DoorbellActions>("doorbell", ctx, { media });

/**
 * Doorbell capability-native surface (offline). The status LED is NOT a doorbell action — it's the
 * shared `camera().setStatusLed()` surface (family-aware; see camera.spec). Here: play rides the
 * `set-param` direct-binary scalar (1706, value = voice_id), and the `quickResponses` query accessor
 * is present only when a media provider is bound (and parses its generic p2pQuery reply).
 */
const ctx: CommandContext = { channel: 3, codec: "camera", deviceType: 94, model: "T8214", paramIds: new Set() };

describe("doorbell actions", () => {
  it("has no setStatusLed — the LED is the shared camera surface, not a doorbell action", () => {
    const { acts } = doorbellOf();
    expect((acts as Record<string, unknown>).setStatusLed).toBeUndefined();
  });

  it("playQuickResponse with {engage:false} emits a direct-binary set-param (1706, value = voiceId)", async () => {
    const { acts, sent } = doorbellOf();
    // Caller says they already have a stream open → skip engagement, just dispatch.
    await acts.playQuickResponse!(2, { engage: false });
    expect(sent).toEqual([{ kind: "set-param", param: 1706, value: 2, form: "direct-binary", channel: 3 }]);
  });

  it("playQuickResponse THROWS when engage is requested but no stream comes up (no silent success)", async () => {
    const { acts, sent } = doorbellOf();

    // (a) engage default, but the device isn't bound to a live client (no media provider).
    await expect(acts.playQuickResponse!(2)).rejects.toThrow(/not bound to a live client/);

    // (b) engage default, media present but live() fails → must reject, and NOT dispatch 1706.
    const media = {
      live: async () => {
        throw new Error("stream boom");
      },
    } as unknown as MediaProvider;
    await expect(doorbellOf(media).acts.playQuickResponse!(2)).rejects.toThrow(/could not engage a live stream/);
    expect(sent).toEqual([]); // nothing fired into the void
  });

  it("quickResponses is absent without a media provider, and parses the generic p2pQuery reply with one", async () => {
    expect(doorbellOf().acts.quickResponses).toBeUndefined();

    // The doorbell owns the semantics: it queries sub-cmd 6237 and parses {voice_list} → QuickResponse[].
    let queriedSubCmd = -1;
    const media = {
      p2pQuery: async (subCmd: number) => {
        queriedSubCmd = subCmd;
        return {
          voice_list: [
            { voice_id: 2, voice_name: "Please leave it at the door", voice_path: "/system/snd//QuickReply_2.snd" },
            { voice_id: 100, voice_name: "hello", voice_path: "/user/quick_respone_diy//QuickReply_4.aac" },
          ],
        };
      },
    } as unknown as MediaProvider;
    const { acts } = doorbellOf(media);
    expect(acts.quickResponses).toBeDefined();
    const list = await acts.quickResponses!();
    expect(queriedSubCmd).toBe(6237); // doorbell supplies the sub-command, not the transport
    expect(list).toEqual<QuickResponse[]>([
      { voiceId: 2, name: "Please leave it at the door", path: "/system/snd//QuickReply_2.snd", custom: false },
      { voiceId: 100, name: "hello", path: "/user/quick_respone_diy//QuickReply_4.aac", custom: true },
    ]);
  });
});

describe("Video Doorbell C30/C31 (call route, no doorbell write tried)", () => {
  const c30: CommandContext = {
    channel: 0,
    codec: "camera",
    deviceType: 95,
    model: "T8224",
    paramIds: new Set([CAMERA_CMD.DEV_LED_SWITCH]),
    capabilities: new Set(["camera", "audio", "doorbell"]),
  };

  it("binds no doorbell write and no ringtone volume", () => {
    const { acts } = bind<Record<string, unknown>>("doorbell", c30);
    expect(Object.keys(acts).filter((k) => /^(set|play)/.test(k))).toEqual([]);
    expect(bind<AudioActions>("audio", c30).acts.setRingtoneVolume).toBeUndefined();
  });

  it("keeps the status LED on the generic 1045 wire", async () => {
    const { acts, sent } = bind<CameraActions>("camera", c30);
    await acts.setStatusLed!(true);
    expect(sent).toEqual([expect.objectContaining({ param: CAMERA_CMD.DEV_LED_SWITCH, value: 1 })]);
  });
});
