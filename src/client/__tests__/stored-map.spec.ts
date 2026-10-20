import { describe, expect, it } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { SessionExpiredError } from "../../transport/http/mega-client.js";
import { BIZ_CHANNEL } from "../../transport/mqtt/biz-stream.js";
import { frame, sint, sub } from "../../model/capabilities/__tests__/proto-bytes.js";

/**
 * `loadVacuumMap` reads a robot's map from the `clean` service the way the vendor app does on opening
 * one: every decoded channel, page by page, `content` joined, into the same map store a live stream
 * fills. A pose is the one piece small enough to write out, so it carries the assertions.
 */

const SN = "T2000P0000000000";

/** A `DynamicData` with one pose, as the hex a stored channel's `content` carries. */
const POSE_HEX = Buffer.from(frame(sub(1, [...sint(1, -320), ...sint(2, 145), ...sint(3, -157)])), "base64").toString(
  "hex",
);

type Call = { sn: string; channelId: number; num: number; page: number };
type Answer = (call: Call) => Promise<unknown>;

function client(answer: Answer): { eufy: EufyMega; calls: Call[] } {
  const eufy = new EufyMega({ email: "t@example.com", password: "x" });
  const calls: Call[] = [];
  (eufy as unknown as { mega: unknown }).mega = {
    getDeviceMapList: (sn: string, channelId: number, num: number, page: number) => {
      const call = { sn, channelId, num, page };
      calls.push(call);
      return answer(call);
    },
  };
  return { eufy, calls };
}

describe("EufyMega.loadVacuumMap", () => {
  it("joins a channel's pages and lands the piece in the device's map, announcing it", async () => {
    const half = POSE_HEX.length / 2;
    const { eufy, calls } = client(async ({ channelId, page }) =>
      channelId !== BIZ_CHANNEL.DYNAMIC_DATA
        ? {}
        : page === 1
          ? { content: POSE_HEX.slice(0, half), is_next_page: true }
          : { content: POSE_HEX.slice(half), is_next_page: false },
    );
    const announced: unknown[] = [];
    eufy.on("map", (info) => announced.push(info));

    const { map, channels } = await eufy.loadVacuumMap(SN);

    expect(channels.find((c) => c.channelId === BIZ_CHANNEL.DYNAMIC_DATA)).toEqual({
      channelId: BIZ_CHANNEL.DYNAMIC_DATA,
      outcome: "applied",
    });
    expect(map?.pose).toEqual({ x: -320, y: 145, theta: -157 });
    expect(announced).toEqual([{ deviceSn: SN, map }]);
    expect(calls.filter((c) => c.channelId === BIZ_CHANNEL.DYNAMIC_DATA)).toEqual([
      { sn: SN, channelId: BIZ_CHANNEL.DYNAMIC_DATA, num: 1000, page: 1 },
      { sn: SN, channelId: BIZ_CHANNEL.DYNAMIC_DATA, num: 1000, page: 2 },
    ]);
    expect(calls[0]?.channelId).toBe(BIZ_CHANNEL.MAP_DATA);
  });

  it("reports a refused channel, content that is not hex or does not decode, and reads the rest", async () => {
    const { eufy } = client(async ({ channelId }) => {
      if (channelId === BIZ_CHANNEL.MAP_DATA) throw new Error("20004 not the owner");
      if (channelId === BIZ_CHANNEL.ROOM_OUTLINE) return { content: "not hex" };
      if (channelId === BIZ_CHANNEL.ROOM_PARAMS) return { content: "00ff" };
      return channelId === BIZ_CHANNEL.DYNAMIC_DATA ? { content: POSE_HEX } : {};
    });

    const { map, channels } = await eufy.loadVacuumMap(SN);

    expect(map?.pose).toEqual({ x: -320, y: 145, theta: -157 });
    expect(channels).toEqual([
      { channelId: BIZ_CHANNEL.MAP_DATA, outcome: "refused", detail: "20004 not the owner" },
      { channelId: BIZ_CHANNEL.ROOM_OUTLINE, outcome: "notHex", detail: "7 chars" },
      { channelId: BIZ_CHANNEL.ROOM_PARAMS, outcome: "undecoded" },
      { channelId: BIZ_CHANNEL.RESTRICTED_ZONE, outcome: "empty" },
      { channelId: BIZ_CHANNEL.DYNAMIC_DATA, outcome: "applied" },
    ]);
  });

  it("answers no map when nothing is stored", async () => {
    const { eufy } = client(async () => ({}));

    expect((await eufy.loadVacuumMap(SN)).map).toBeUndefined();
  });

  it("lets a rejected session through", async () => {
    const { eufy } = client(async () => Promise.reject(new SessionExpiredError("expired")));

    await expect(eufy.loadVacuumMap(SN)).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
