import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import type { EufyDevice } from "../../core/types.js";
import { DeviceType } from "../../model/device-types.js";

/**
 * Which serials `reboot` restarts.
 *
 * `RESTART_HUB` goes out on the station's broadcast channel, so it restarts whatever owns the P2P
 * session. A HomeBase and a standalone camera each own theirs; a camera attached to a HomeBase does
 * not, and restarting it would restart the base — so that serial must throw, as must a non-camera one.
 * The station key resolves through the real router from the seeded registry; only the context build
 * and the send are stubbed.
 */
const BASE_SN = "T8000P0000000000";
const CHILD_SN = "T8000P0000000001";
const SOLO_SN = "T8000P0000000002";
const LOCK_SN = "T8000P0000000003";

function fleet(): EufyDevice[] {
  const common = { category: "eufy_security", api: "mega", realtime: "p2p", p2pDid: "XXXXXXX-000000-XXXXX" };
  return [
    { ...common, sn: BASE_SN, model: "T8010", deviceClass: "homebase", stationSn: BASE_SN },
    { ...common, sn: CHILD_SN, model: "T8199", deviceClass: "camera", stationSn: BASE_SN, raw: { parent_sn: BASE_SN } },
    { ...common, sn: SOLO_SN, model: "T8299", deviceClass: "camera", stationSn: SOLO_SN },
    { ...common, sn: LOCK_SN, model: "T8599", deviceClass: "other", stationSn: LOCK_SN },
  ] as unknown as EufyDevice[];
}
const CONTEXTS: Record<string, { codec: string; deviceType?: number; model: string }> = {
  [BASE_SN]: { codec: "station", deviceType: DeviceType.STATION, model: "T8010" },
  [CHILD_SN]: { codec: "camera", model: "T8199" },
  [SOLO_SN]: { codec: "camera", model: "T8299" },
  [LOCK_SN]: { codec: "lock", model: "T8599" },
};

function makeClient() {
  const eufy = new EufyMega({ email: "t@example.com", password: "x" });
  vi.spyOn((eufy as any).registry, "list").mockReturnValue(fleet());
  vi.spyOn(eufy as any, "commandContext").mockImplementation(async (sn: unknown) => CONTEXTS[sn as string]);
  const send = vi.spyOn((eufy as any).p2p, "rebootStation").mockResolvedValue(undefined);
  return { eufy, send };
}

describe("reboot", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("restarts a HomeBase", async () => {
    const c = makeClient();
    await c.eufy.reboot(BASE_SN);
    expect(c.send).toHaveBeenCalledWith(BASE_SN);
  });

  it("restarts a camera that is its own station", async () => {
    const c = makeClient();
    await c.eufy.reboot(SOLO_SN);
    expect(c.send).toHaveBeenCalledWith(SOLO_SN);
  });

  it("refuses a camera attached to a HomeBase, whose restart would reach the base", async () => {
    const c = makeClient();
    await expect(c.eufy.reboot(CHILD_SN)).rejects.toThrow(/neither a HomeBase nor a standalone camera/);
    expect(c.send).not.toHaveBeenCalled();
  });

  it("refuses a standalone device outside the camera family", async () => {
    const c = makeClient();
    await expect(c.eufy.reboot(LOCK_SN)).rejects.toThrow(/neither a HomeBase nor a standalone camera/);
    expect(c.send).not.toHaveBeenCalled();
  });
});
