import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { P2PRouterDeps } from "../command-router.js";
import { IDR, camera, keyframe, plainFrame, slice } from "./recording-fixtures.js";
import { ACCOUNT_ID, DEVICE_SN, STATION_SN, connectedSession, routerWithSession } from "./session-fixtures.js";

const RECORDING = "20260101120000";
const CIPHER_ID = 7;

/**
 * A router over a fake HomeBase 2 session that answers a download request with one recording, and a cipher
 * lookup that knows only {@link CIPHER_ID}.
 */
function homeBase2(deps: Partial<P2PRouterDeps> = {}) {
  const cam = camera();
  const key = randomBytes(32);
  const session = connectedSession();
  const sent: unknown[][] = [];
  const transfers = { active: 0, peak: 0 };
  const answer = (channel: number) => {
    transfers.active--;
    for (const frame of [keyframe(key, cam.publicKey, IDR, 0, 0), plainFrame(slice(1), 1, 67)]) {
      session.emit("data", { ...frame, dataType: 3, channel });
    }
    session.emit("data", { commandId: 1304, dataType: 3, signCode: 0, raw: Buffer.alloc(0), channel });
  };
  Object.assign(session, {
    sendStringPairCommand: vi.fn((...args: unknown[]) => {
      sent.push(args);
      transfers.peak = Math.max(transfers.peak, ++transfers.active);
      setTimeout(() => answer(args[3] as number), 5);
    }),
  });
  const getCiphers = vi.fn(async (ids: number[]) =>
    ids[0] === CIPHER_ID ? [{ cipher_id: CIPHER_ID, ecc_private_key: cam.eccHex }] : [],
  );
  const router = routerWithSession(session, { deps: { mega: { getCiphers } as never, ...deps } });
  return { media: router.mediaProviderFor(DEVICE_SN), sent, getCiphers, transfers };
}

describe("recording download through the router", () => {
  it("requests the camera's recording on its channel, as the station admin, and decodes it", async () => {
    const { media, sent, getCiphers } = homeBase2();

    const out = await media.downloadRecording!({ recording: RECORDING, cipherId: CIPHER_ID });

    expect(sent).toEqual([[1024, `/media/mmcblk0p1/Camera01/${RECORDING}.dat`, ACCOUNT_ID, 1]]);
    expect(getCiphers).toHaveBeenCalledWith([CIPHER_ID], ACCOUNT_ID, STATION_SN);
    expect(out.video).toEqual(Buffer.concat([IDR, slice(1)]));
    expect(out.frames).toBe(2);
  });

  it("runs one download at a time per station", async () => {
    const { media, sent, transfers } = homeBase2();

    await Promise.all([
      media.downloadRecording!({ recording: RECORDING, cipherId: CIPHER_ID }),
      media.downloadRecording!({ recording: "20260101120100", cipherId: CIPHER_ID }),
    ]);

    expect(sent).toHaveLength(2);
    expect(transfers.peak).toBe(1);
  });

  it("refuses a station the download is not confirmed on, before sending anything", async () => {
    const { media, sent } = homeBase2({
      listDevices: () =>
        [
          {
            sn: DEVICE_SN,
            stationSn: STATION_SN,
            raw: { parent_sn: STATION_SN, device_channel: 1, member: { admin_user_id: ACCOUNT_ID } },
          },
          { sn: STATION_SN, stationSn: STATION_SN, model: "T8030", raw: {} },
        ] as never,
    });

    await expect(media.downloadRecording!({ recording: RECORDING, cipherId: CIPHER_ID })).rejects.toMatchObject({
      reason: "unsupported",
    });
    expect(sent).toHaveLength(0);
  });

  it("refuses a recording name the station could not hold", async () => {
    const { media, sent } = homeBase2();

    await expect(media.downloadRecording!({ recording: "../x", cipherId: CIPHER_ID })).rejects.toMatchObject({
      reason: "invalid-recording",
    });
    expect(sent).toHaveLength(0);
  });

  it("refuses when only another cipher is answered", async () => {
    const { media, sent } = homeBase2();

    await expect(media.downloadRecording!({ recording: RECORDING, cipherId: CIPHER_ID + 1 })).rejects.toMatchObject({
      reason: "key-unavailable",
    });
    expect(sent).toHaveLength(0);
  });
});
