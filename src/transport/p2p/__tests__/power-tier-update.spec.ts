import { P2PCommandRouter } from "../command-router.js";
import type { EufyDevice } from "../../../core/types.js";

const BASE = "T8000P0000000000";
const CHILD = "T8000P0000000001";
const OTHER_CHILD = "T8000P0000000002";

function router(devices: EufyDevice[]) {
  return new P2PCommandRouter({
    mega: {} as never,
    listDevices: () => devices,
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: () => {},
    onLevel2Ready: () => {},
    onFrame: () => {},
  });
}

describe("P2P power-tier update", () => {
  it("updates an attached camera's source without changing its HomeBase session tier", () => {
    const child = { sn: CHILD, stationSn: BASE, raw: { parent_sn: BASE, device_channel: 2 } } as EufyDevice;
    const p2p = router([child]);
    const source = { setPowerTier: vi.fn() };
    (p2p as any).liveSources.set(`${BASE}:2`, source);
    (p2p as any).liveSourceOpts.set(`${BASE}:2`, { powered: "battery" });
    const refresh = vi.spyOn((p2p as any).manager, "refreshPower");
    p2p.updatePowerTier(CHILD, "wired");
    expect(source.setPowerTier).toHaveBeenCalledWith("wired");
    expect((p2p as any).liveSourceOpts.get(`${BASE}:2`).powered).toBe("wired");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-evaluates an idle standalone session when its local claim changes", () => {
    const solo = { sn: CHILD, stationSn: CHILD, raw: { device_channel: 0 } } as EufyDevice;
    const p2p = router([solo]);
    const refresh = vi.spyOn((p2p as any).manager, "refreshPower");
    p2p.updatePowerTier(CHILD, "battery");
    expect(refresh).toHaveBeenCalledWith(CHILD);
  });

  it("does not change another attached camera's stream when their station channel is shared", () => {
    const child = { sn: CHILD, stationSn: BASE, raw: { parent_sn: BASE, device_channel: 2 } } as EufyDevice;
    const other = { sn: OTHER_CHILD, stationSn: BASE, raw: { parent_sn: BASE, device_channel: 2 } } as EufyDevice;
    const p2p = router([child, other]);
    const source = { setPowerTier: vi.fn() };
    (p2p as any).liveSources.set(`${BASE}:2`, source);
    (p2p as any).liveSourceOpts.set(`${BASE}:2`, { powered: "battery" });
    p2p.updatePowerTier(CHILD, "wired");
    expect(source.setPowerTier).not.toHaveBeenCalled();
    expect((p2p as any).liveSourceOpts.get(`${BASE}:2`).powered).toBe("battery");
  });
});
