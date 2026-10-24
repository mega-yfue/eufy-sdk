import { describe, it, expect, vi } from "vitest";
import { ACCOUNT_ID, DEVICE_SN, STATION_SN, connectedSession, routerWithSession } from "./session-fixtures.js";

type Manager = { resetWhenUnused: (key: string) => Promise<void> };

/** The fixture fleet with the station record reporting `model`, as a standalone cam-station does. */
function fleet(model: string) {
  return () =>
    [
      {
        sn: DEVICE_SN,
        stationSn: STATION_SN,
        model: "T8114",
        channel: 1,
        raw: { parent_sn: STATION_SN, device_channel: 1, member: { admin_user_id: ACCOUNT_ID } },
      },
      { sn: STATION_SN, stationSn: STATION_SN, p2pDid: "", model, raw: { member: { admin_user_id: ACCOUNT_ID } } },
    ] as never[];
}

function spyReset(router: ReturnType<typeof routerWithSession>) {
  const manager = (router as unknown as { manager: Manager }).manager;
  return vi.spyOn(manager, "resetWhenUnused").mockResolvedValue(undefined);
}

describe("resetStandaloneSession", () => {
  it("keeps a T8423's level-1 session open", async () => {
    const router = routerWithSession(connectedSession(false), { deps: { listDevices: fleet("T8423") } });
    const reset = spyReset(router);

    await router.resetStandaloneSession(STATION_SN);

    expect(reset).not.toHaveBeenCalled();
  });

  it("resets a T8423's level-2 session", async () => {
    const router = routerWithSession(connectedSession(true), { deps: { listDevices: fleet("T8423") } });
    const reset = spyReset(router);

    await router.resetStandaloneSession(STATION_SN);

    expect(reset).toHaveBeenCalledWith(STATION_SN);
  });

  it("resets another model's level-1 session", async () => {
    const router = routerWithSession(connectedSession(false), { deps: { listDevices: fleet("T8410") } });
    const reset = spyReset(router);

    await router.resetStandaloneSession(STATION_SN);

    expect(reset).toHaveBeenCalledWith(STATION_SN);
  });

  it("resets a T8423 with no open session", async () => {
    const router = routerWithSession(connectedSession(false), {
      deps: { listDevices: fleet("T8423") },
      register: false,
    });
    const reset = spyReset(router);

    await router.resetStandaloneSession(STATION_SN);

    expect(reset).toHaveBeenCalledWith(STATION_SN);
  });
});
