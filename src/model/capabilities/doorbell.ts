import { setTimeout as sleep } from "node:timers/promises";
import { asBool, coerceEnumValue, enumLabels } from "../../core/util.js";
import { DoorbellPushEvent } from "../push-events.js";
import { setPayload, setScalar } from "./access.js";
import { method, propertiesOf, provided, type Members, type Surface } from "./members.js";
import type { CapabilityModule } from "./types.js";
import type { MediaProvider } from "../../core/contracts.js";

/**
 * The P2P **feature-command ids** this doorbell capability drives. Capability-owned wire vocabulary
 * (transport forwards `cmd.param` opaquely; full id→name catalog in the generated
 * `transport/p2p/commands.ts`).
 */
export const DOORBELL_CMD = {
  /**
   * Doorbell "quick response" — make the doorbell PLAY a stored voice reply. Same 136-byte
   * direct-binary shape as the camera setters: `value` = the `voice_id` to play. Reversed from a
   * live capture (outer-cmd 1706, signCode 8, on the doorbell's `device_channel`) + the app's
   * `PlayQuickResponseParser` (`{cmd:1706,voice_id}`).
   */
  QUICK_RESPONSE: 1706,
  /**
   * Mechanical (wired) chime enable/disable — whether the doorbell drives an existing wired chime box
   * (as opposed to / in addition to the wireless indoor chime, param 1702 `chimeSwitch` above). Same
   * 136-byte direct-binary shape as `QUICK_RESPONSE`/camera on-off: `[u32 channel][u32 value][account_id
   * ASCII, zero-padded to 128 bytes]`, outer P2P cmd = 1703 itself, signCode 8, on the device's own
   * channel. Reversed from a live capture (outer-cmd 1703, signCode 8, captured on the doorbell's
   * `device_channel` — channel 2 for that unit, NOT a wire constant, always use `ctx.channel`):
   * turning ON sent `value=1`, turning OFF sent `value=0` — a plain boolean, 1=on/0=off.
   * App `APP_CMD_BAT_DOORBELL_MECHANICAL_CHIME_SWITCH`.
   */
  MECHANICAL_CHIME_SWITCH: 1703,
  /**
   * Wide Dynamic Range (WDR) image switch — a video/image tone-mapping setting that widens the
   * exposure range in high-contrast scenes (bright sky behind a visitor, etc). SAME 136-byte
   * direct-binary shape/polarity/capture session as `MECHANICAL_CHIME_SWITCH` immediately above: outer
   * P2P cmd 1704, signCode 8, device channel, `value` 1=on/0=off.
   * App `APP_CMD_BAT_DOORBELL_WDR_SWITCH`.
   */
  WDR_SWITCH: 1704,
  /**
   * Doorbell chime ("ding-dong") volume — app `APP_CMD_BAT_DOORBELL_SET_DINGDONG_VOLUME`. UNLIKE the 1703/1704 direct-binary switches above, this rides the
   * `SET_PAYLOAD` (1350) JSON envelope: `{account_id,cmd:1717,mChannel:<deviceCh>,mValue3:0,
   * payload:{dingdong_volume:N}}`, GCM signCode 8, on the doorbell's `device_channel` (2 for the
   * captured unit — always use `ctx.channel`, don't hardcode). `mValue3` is an EXPLICIT `0`, not the
   * `SET_PAYLOAD` default of `mValue3:cmd` (see {@link module:./intent setPayload}'s doc comment) —
   * both live frames captured showed `mValue3:0`. Reversed from a live capture (values 3 and 25
   * observed) — a 0-100 loudness level, distinct from the already-shipped `ringtoneVolume` (1708,
   * direct-binary, `audio.ts`), which is a DIFFERENT control.
   */
  DINGDONG_VOLUME: 1717,
  /**
   * Doorbell chime ("ding-dong") RINGTONE SELECTION — app `APP_CMD_BAT_DOORBELL_SET_DINGDONG_RINGTONE`.
   * SAME `SET_PAYLOAD` (1350) JSON envelope shape as
   * `DINGDONG_VOLUME` immediately above: `{account_id,cmd:1718,mChannel:<deviceCh>,mValue3:0,
   * payload:{dingdong_ringtone:N}}`, GCM signCode 8, doorbell `device_channel`, explicit `mValue3:0`.
   * Reversed from a live capture (values 4 and 0 observed) — `N` is an INTEGER INDEX picking one of
   * several stored chime tones, NOT a boolean.
   */
  DINGDONG_RINGTONE: 1718,
  /**
   * Live-view quality AND the video encoding format, both in one integer — app
   * `CMD_BAT_DOORBELL_VIDEO_QUALITY`. The value is `quality + (highCompression ? 5 : 0)`, where quality
   * is 0 Auto / 1 Low / 2 Medium / 3 High ({@link DoorbellVideoQuality}). The app drives the two from
   * separate menus and each write carries both, so setting either requires the other's current value —
   * which is why neither is a derived setter.
   *
   * The encoding is reversed from writing every option in the app and reading the parameter back: High
   * on high compression is 8 and on low compression 3, Low on low compression 1, Auto on high
   * compression 5. Six of the eight combinations were observed that way; `0` (Auto, low compression) and
   * `2` (Medium, low compression) follow the same arithmetic but were not individually written.
   *
   * Wire captured byte-exact from the app on a T8210 behind a HomeBase: outer P2P cmd 1705 itself — no
   * wrapper — signCode 8, on the doorbell's own channel, the same 136-byte direct-binary
   * `[u32 channel][u32 value][account_id ASCII pad 128]` struct as its 1703/1704 siblings. The station
   * answers with an unencrypted level-1 frame carrying 0.
   *
   * Replayed from this SDK and confirmed on that device: three writes in one session, each read back off
   * the parameter — quality alone, then the encoding format with the quality held, then a restore.
   */
  VIDEO_QUALITY: 1705,
  /**
   * Doorbell quick-response LIST fetch — the sub-command carried inside a `SET_PAYLOAD` (1350)
   * wrapper (app `APP_CMD_GET_CUSTOMIZE_VICOE_LIST`). The station replies with a `NOTIFY_PAYLOAD`
   * (1351) frame whose JSON is `{cmd:6237, payload:{voice_list:[{voice_id,voice_name,voice_path}]}}`.
   * Reversed from the app's `GetQuickResponseListP2pParser` + the capture heap. NOTE: 6238
   * (`APP_CMD_GET_QUICK_RESPONSE`) is the single-file DOWNLOAD, not the list.
   */
  GET_QUICK_RESPONSE_LIST: 6237,
} as const;

/**
 * Doorbell chime ("ding-dong") ringtone selection, as a 0-indexed list. Three indices were confirmed
 * on-device (`0→Default`, `7→Ding`, `8→Hillside`) and land exactly on a plain top-to-bottom order, so
 * the remaining indices follow that same linear order rather than being individually tested. Full name list
 * (10 entries) read off the app's own picker UI. `Circuit` (index 5) is a BEST-EFFORT spelling — its
 * index was not individually wire-tested, only its position in the read-off list.
 */
export const DoorbellRingtone = {
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
} as const;
/** A doorbell ringtone option — the value side of {@link DoorbellRingtone}. */
export type DoorbellRingtoneValue = (typeof DoorbellRingtone)[keyof typeof DoorbellRingtone];

// Deliberately NOT JSDoc: re-exported publicly, and the publication guard rejects wire detail on the
// generated page. The wire is documented on DOORBELL_CMD.VIDEO_QUALITY, which stays internal.
// Ranks, not resolutions — the app's own picker reads Auto/Low/Medium/High on this device.
export const DoorbellVideoQuality = {
  /** The doorbell picks a quality from the link. */
  Auto: 0,
  Low: 1,
  Medium: 2,
  High: 3,
} as const;
/** A doorbell live-view quality — the value side of {@link DoorbellVideoQuality}. */
export type DoorbellVideoQualityValue = (typeof DoorbellVideoQuality)[keyof typeof DoorbellVideoQuality];

/**
 * One of a Video Doorbell's **quick responses** — a canned voice reply it can play at a visitor.
 * Returned by `dev.doorbell()?.quickResponses()`; pass `voiceId` to `playQuickResponse`. Owned by the
 * doorbell capability (the client transport stays doorbell-agnostic — it only knows generic P2P).
 */
export interface QuickResponse {
  /** The response's `voice_id` — pass to `playQuickResponse` to play it. */
  voiceId: number;
  /** Human-readable label, e.g. "Please leave it at the door". */
  name: string;
  /** On-device audio path, e.g. `/system/snd//QuickReply_1.snd` or `/user/quick_respone_diy//QuickReply_5.aac`. */
  path: string;
  /** `false` = predefined/eufy-shipped (`/system/snd/`); `true` = user-recorded custom (`/user/…`). */
  custom: boolean;
}

/**
 * Bound doorbell controls — the object returned by `dev.doorbell()`. The status LED is NOT here: a
 * doorbell is a `camera`-codec device, so its LED lives on the shared `dev.camera().setStatusLed()`
 * surface, which swaps to the doorbell's own wire by family (one action, not a duplicate here).
 * `playQuickResponse` is always present (it orchestrates a live stream); `quickResponses` (a P2P
 * request/reply query that RETURNS data) is present only when the device is bound to a live client
 * with a {@link MediaProvider} — hence optional, call with `?.`.
 */
export type DoorbellActions = Surface<typeof DOORBELL_MEMBERS>;

/**
 * The composite {@link DOORBELL_CMD.VIDEO_QUALITY} value, or `undefined` if it is not one the encoding
 * can produce. Valid values are `quality + (highCompression ? 5 : 0)` for a quality of 0-3, so 4 and 9
 * are NOT in the domain even though they are in range — reading 9 as `9 % 5` would answer a quality of
 * 4, which is not one. Shared by both halves so they cannot disagree about what a value means.
 */
function composite(raw: unknown): number | undefined {
  // The cloud reports parameters as strings, so a numeric string is the normal case — but `Number` maps
  // `null` and `""` to 0, which is a real value here (Auto, low compression), so the type is checked
  // first rather than letting an absent reading decode as a setting.
  if (typeof raw !== "number" && (typeof raw !== "string" || raw.trim() === "")) return undefined;
  const v = Number(raw);
  return Number.isInteger(v) && v >= 0 && v <= 8 && v % 5 <= 3 ? v : undefined;
}

/**
 * Parse a doorbell `voice_list` (the `{voice_id,voice_name,voice_path}` records the station returns
 * in the quick-response GET reply) into typed {@link QuickResponse}s. Pure/offline. The `custom` flag
 * is derived from the `voice_path` **prefix** (robust) — predefined responses live under `/system/snd/`,
 * user-recorded ones under `/user/…` — NOT from the id range (ids 1–3 predefined, 100+ custom, but the
 * path is authoritative).
 */
export function parseQuickResponses(
  voiceList: Array<{ voice_id?: unknown; voice_name?: unknown; voice_path?: unknown }>,
): QuickResponse[] {
  return (voiceList ?? []).map((v) => {
    const path = typeof v.voice_path === "string" ? v.voice_path : "";
    return {
      voiceId: Number(v.voice_id),
      name: typeof v.voice_name === "string" ? v.voice_name : "",
      path,
      custom: !path.startsWith("/system/snd/"),
    };
  });
}

/**
 * `doorbell` — chime / ringtone configuration. CONFIRMED against a real Video Doorbell (T8214):
 * the live ids are the `1702-1719` `CMD_BAT_DOORBELL_*` range (provenance "mega", observed). The
 * legacy `2015/2022/1306` ids are excluded — they appear on NO owned device. The button-
 * press *event* (ring) is delivered out-of-band via `CMD_DOORBELL_NOTIFY_PAYLOAD` (1701) /
 * push/MQTT — it is handled by the Phase-1 event normalizers, not as a device-list param.
 */
/**
 * Every `doorbell` feature, declared once.
 *
 * Three of the seven reads are read-ONLY here even though the device accepts a write, because the write
 * does not belong to this capability or is not confirmed:
 *  - `ringtoneVolume` (1708) — the WRITE lives on `audio`, which owns every volume wire. 1708 leaks
 *    onto non-doorbell cameras, so `audio` gates its setter on the doorbell capability instead.
 *  - `chimeSwitch` (1702) — READ confirmed on a T8214, the WRITE wire never captured. Its 1703/1704
 *    siblings share the param range but that is NOT evidence of a shared frame, and a wrong guess on a
 *    fire-and-forget P2P write looks exactly like success.
 *  - `notificationMode` (1710) — a config JSON the device reports whole; no write is captured.
 *
 * Exported but NOT published: each entry states its wire id and the evidence it was confirmed on,
 * which the reference site does not carry.
 * @internal
 */
export const DOORBELL_MEMBERS = {
  /**
   * The WIRELESS indoor chime — the separate plug-in unit, not the wired chime box
   * `mechanicalChimeSwitch` drives. `unverified: true` with no `write` at all: the read is confirmed but
   * the write frame has never been captured, so the setter is absent from the surface (a compile-time
   * signal) and the intent path throws rather than reporting the doorbell as lacking the feature.
   * Sharing the 1702-1719 range with its captured siblings is not evidence of a shared frame shape.
   */
  chimeSwitch: {
    param: 1702,
    type: "bool",
    kind: "boolean",
    provenance: "mega",
    unverified: true,
    description:
      "Wireless indoor chime enabled (1702 CMD_BAT_DOORBELL_CHIME_SWITCH; READ confirmed on T8214 — the " +
      "WRITE wire is unconfirmed, so no setter is offered rather than guessing it).",
  },
  /**
   * `provenance` is "verified" not "mega": the actual write wire is confirmed (
   * our own P2P decrypt), not merely the param id observed on a live device. Direct-binary
   * `[ch][value][acct]`, 1=on/0=off — verified live on a T8214 (ON then OFF).
   */
  mechanicalChimeSwitch: {
    param: DOORBELL_CMD.MECHANICAL_CHIME_SWITCH,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    description: "Mechanical chime enabled (1703; confirmed on T8214).",
    write: (v, ctx) => setScalar(DOORBELL_CMD.MECHANICAL_CHIME_SWITCH, asBool(v) ? 1 : 0, ctx, "direct-binary"),
  },
  /** Same reasoning and the same capture session as {@link DOORBELL_MEMBERS.mechanicalChimeSwitch}. */
  wdrSwitch: {
    param: DOORBELL_CMD.WDR_SWITCH,
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    description:
      "Wide Dynamic Range (WDR) image switch (1704; write wire-confirmed live on T8214 — see DOORBELL_CMD.WDR_SWITCH).",
    write: (v, ctx) => setScalar(DOORBELL_CMD.WDR_SWITCH, asBool(v) ? 1 : 0, ctx, "direct-binary"),
  },
  /**
   * The READ half of a control whose write lives on `audio` — hence `writtenElsewhere`, which is what
   * keeps the published schema's `writable` true even though this member declares no `write`. The split
   * is deliberate: `audio` owns every volume wire, but 1708 leaks onto non-doorbell cameras, so `audio`
   * gates its setter on this capability while the read stays here where it is doorbell-only. Distinct
   * from `dingdongVolume` (1717), which is a different control on a different wire.
   */
  ringtoneVolume: {
    param: 1708,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "mega",
    writtenElsewhere: true,
    description:
      "Ringtone volume (1708; confirmed on T8214, observed value 80). The WRITE is `audio`'s " +
      "setRingtoneVolume — that capability owns every volume wire.",
  },
  /**
   * A `1350` SET_PAYLOAD envelope (NOT direct-binary) with an explicit `mValue3` 0 — both live frames
   * captured that value. Bounded 0-100 like every sibling volume setter: the write is fire-and-forget,
   * so an out-of-range value would otherwise be sent as-is and look like it worked. `provenance` is
   * "verified" on our own capture, not merely an observed param id.
   */
  dingdongVolume: {
    param: DOORBELL_CMD.DINGDONG_VOLUME,
    type: "number",
    unit: "%",
    kind: "percent",
    provenance: "verified",
    min: 0,
    max: 100,
    description:
      "Doorbell chime volume, 0-100 (1717 APP_CMD_BAT_DOORBELL_SET_DINGDONG_VOLUME; SET_PAYLOAD " +
      "envelope, distinct from the direct-binary ringtoneVolume/1708 — see DOORBELL_CMD.DINGDONG_VOLUME). " +
      "Write wire-confirmed live on T8214, observed values 3 and 25.",
    write: (v, ctx) =>
      setPayload(DOORBELL_CMD.DINGDONG_VOLUME, { dingdong_volume: Number(v) }, ctx, 0, undefined, "auto"),
  },
  /**
   * The same `1350` SET_PAYLOAD shape and capture session as {@link DOORBELL_MEMBERS.dingdongVolume},
   * but an INDEX rather than a level. Clamping a bad index would land on a real-but-wrong tone (garbage
   * → 0, too-big → 9) instead of failing, and only 3 of the 10 indices (0, 7, 8) are wire-tested — so
   * anything outside {@link DoorbellRingtone} is refused.
   */
  dingdongRingtone: {
    param: DOORBELL_CMD.DINGDONG_RINGTONE,
    type: "number",
    kind: "enum",
    enumValues: enumLabels(DoorbellRingtone),
    provenance: "verified",
    args: [{ name: "ringtone", kind: "enum", description: "A tone INDEX, not a volume." }],
    description:
      "Doorbell chime ringtone SELECTION INDEX, not a bool (1718 APP_CMD_BAT_DOORBELL_SET_DINGDONG_RINGTONE; " +
      "SET_PAYLOAD envelope — see DOORBELL_CMD.DINGDONG_RINGTONE). Write wire-confirmed live on T8214, " +
      "observed values 4 and 0. Named options: see the {@link DoorbellRingtone} enum. A write outside " +
      "that enum is REJECTED, not clamped into range — this is a " +
      "selection, not a volume, so a bad index would otherwise land on a real-but-wrong tone.",
    write: (v, ctx) => {
      const tone = coerceEnumValue(DoorbellRingtone, v);
      return tone === undefined
        ? undefined
        : setPayload(DOORBELL_CMD.DINGDONG_RINGTONE, { dingdong_ringtone: tone }, ctx, 0, undefined, "auto");
    },
  },
  /**
   * The live-view quality half of {@link DOORBELL_CMD.VIDEO_QUALITY}, lifted out of the composite by
   * `decode`. `writtenElsewhere` because the setter needs the OTHER half's current value to rebuild the
   * integer, which a member's `write` — given only the new value and the context — cannot read.
   */
  videoQuality: {
    param: DOORBELL_CMD.VIDEO_QUALITY,
    type: "number",
    kind: "enum",
    enumValues: enumLabels(DoorbellVideoQuality),
    provenance: "verified",
    writtenElsewhere: true,
    decode: (raw) => {
      const v = composite(raw);
      return v === undefined ? undefined : v % 5;
    },
    decodedKind: "enum",
    decodedValues: Object.values(DoorbellVideoQuality),
    description:
      "Live-view quality: 0 Auto / 1 Low / 2 Medium / 3 High (1705 CMD_BAT_DOORBELL_VIDEO_QUALITY). " +
      "The parameter also carries the video encoding format, so this is the remainder mod 5 — see " +
      "highCompressionEncoding for the other half. Ranks, not resolutions: the app's picker reads " +
      "Auto/Low/Medium/High. Written by setVideoQuality, which takes the encoding format too — " +
      "hardware-confirmed on a T8210.",
  },
  /**
   * The encoding half of the SAME integer, so it declares no param of its own and reaches into the
   * owner's value — two members claiming 1705 would leave the second reading a name nothing is stored
   * under, and a paramless member publishes no schema entry at all, which is what keeps that from
   * happening structurally. High compression is the app's default on the captured device.
   */
  highCompressionEncoding: {
    readsFrom: "videoQuality",
    type: "bool",
    kind: "boolean",
    provenance: "verified",
    decode: (raw) => {
      const v = composite(raw);
      return v === undefined ? undefined : v >= 5;
    },
    description:
      "Video encoding format: true = high compression, false = low compression (the +5 offset inside " +
      "1705, which also carries videoQuality). Set through setVideoQuality, which takes both halves " +
      "because the wire carries both.",
  },
  /**
   * Set both halves of {@link DOORBELL_CMD.VIDEO_QUALITY} at once, because the wire has no way to set
   * one alone: every frame carries the whole integer.
   *
   * Taking both is not a convenience choice. An earlier shape took one and preserved the other by
   * reading it back, and it failed on hardware: the state reader is the snapshot the device was bound
   * with, so a second write in the same session composed against the value from before the first and
   * silently reverted it. Requiring both puts that decision where it can be made correctly — a caller
   * reads {@link DOORBELL_MEMBERS.videoQuality} and {@link DOORBELL_MEMBERS.highCompressionEncoding}
   * and passes what it wants, instead of the SDK guessing from a stale copy.
   */
  setVideoQuality: method(
    ({ ctx, sink }) =>
      async (quality: DoorbellVideoQualityValue, highCompression: boolean): Promise<void> => {
        const q = coerceEnumValue(DoorbellVideoQuality, quality);
        if (q === undefined) {
          throw new Error(`videoQuality: ${String(quality)} is not one of ${enumLabels(DoorbellVideoQuality)}`);
        }
        await sink.dispatch(
          setScalar(DOORBELL_CMD.VIDEO_QUALITY, q + (asBool(highCompression) ? 5 : 0), ctx, "direct-binary"),
        );
      },
    "Set the live-view quality and the video encoding format, which share one wire.",
  ),
  /**
   * A config blob the device reports WHOLE, so it is typed `string` and handed back unparsed — three
   * settings live inside it (motion notifications, ring notifications, notification style) and the SDK
   * lifts none of them out, because no `decode` is evidenced for the shape. Read-only: no write frame
   * has been captured for it, and a config JSON is exactly where a guessed write does the most damage.
   */
  notificationMode: {
    param: 1710,
    type: "string",
    kind: "text",
    provenance: "mega",
    description:
      "Notification config JSON {notification_motion_onoff,notification_ring_onoff," +
      "notification_style} (1710; confirmed on T8214).",
  },
  /**
   * Play one of the doorbell's quick responses at the visitor. `voiceId` comes from
   * {@link DOORBELL_MEMBERS.quickResponses}. The doorbell only plays while it has an active media
   * session, so by default this briefly engages a live stream, sends, then tears it down.
   * `{ engage: false }` leaves an already-open stream alone.
   *
   * If engagement was requested but no stream comes up this THROWS, rather than firing 1706 into the
   * void and reporting success — the doorbell would play nothing. The wire is `QUICK_RESPONSE` 1706,
   * the SAME direct-binary command as camera on/off, carrying the voice id as its value.
   */
  playQuickResponse: method(
    ({ ctx, sink, media }) =>
      async (voiceId: number, opts: { engage?: boolean } = {}): Promise<void> => {
        const engage = opts.engage ?? true;
        let stream: Awaited<ReturnType<MediaProvider["live"]>> | undefined;
        if (engage) {
          if (!media) {
            throw new Error(
              "playQuickResponse needs a live media session to engage, but the device is not bound to a " +
                "live client — open a stream and call with { engage: false }",
            );
          }
          try {
            stream = await media.live();
          } catch (e) {
            throw new Error(
              `playQuickResponse could not engage a live stream (the doorbell only plays while live): ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          }
          await sleep(2500); // let the doorbell come live
        }
        try {
          await sink.dispatch(setScalar(DOORBELL_CMD.QUICK_RESPONSE, voiceId, ctx, "direct-binary"));
          if (stream) await sleep(1500); // let playback start before teardown
        } finally {
          try {
            stream?.stop();
          } catch {
            /* ignore */
          }
        }
      },
    "Play a quick response at the visitor.",
  ),

  /**
   * Fetch the doorbell's quick-response list — a P2P request/reply query that returns data, so it
   * exists only on a device bound to a media provider that offers one.
   *
   * The transport stays doorbell-agnostic: it runs a GENERIC SET_PAYLOAD query (sub-cmd → reply
   * payload); this capability owns the sub-command id (6237) and the reply parsing.
   */
  quickResponses: provided(
    "media",
    (m) =>
      m.p2pQuery &&
      (async (opts?: { timeoutMs?: number }): Promise<QuickResponse[]> => {
        const payload = await m.p2pQuery!(DOORBELL_CMD.GET_QUICK_RESPONSE_LIST, opts);
        const voiceList = Array.isArray(payload?.voice_list)
          ? (payload.voice_list as Array<Record<string, unknown>>)
          : [];
        return parseQuickResponses(voiceList);
      }),
    "Fetch the doorbell's quick-response list.",
  ),
} as const satisfies Members;

export const DOORBELL: CapabilityModule = {
  capability: "doorbell",
  description: "Doorbell chime / ringtone configuration (ring press is an event, not a param).",
  members: DOORBELL_MEMBERS,
  properties: propertiesOf(DOORBELL_MEMBERS),
  /** Doorbells self-report no single unambiguous param; the model name is the reliable signal. */
  detection: { modelHints: [/doorbell/i] },
  /**
   * Inbound FCM doorbell events (`DoorbellPushEvent`): ring press and the package trio.
   *
   * Pet (3106) is NOT here. The id is declared identically in the doorbell, indoor and HB3-paired
   * vocabularies, so it belongs to the camera-wide `motion` module that every camera binds; claiming
   * it here as well would make it a contested id that a doorbell — which has both capabilities —
   * matches twice, emitting one push as two events.
   */
  events: [
    { source: "push", match: DoorbellPushEvent.PRESS_DOORBELL, emit: "doorbellPress" },
    { source: "push", match: DoorbellPushEvent.PACKAGE_DELIVERED, emit: "packageDelivered" },
    { source: "push", match: DoorbellPushEvent.PACKAGE_TAKEN, emit: "packageTaken" },
    { source: "push", match: DoorbellPushEvent.PACKAGE_STRANDED, emit: "packageStranded" },
  ],
};
