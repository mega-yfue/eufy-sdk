import { describe, expect, it } from "vitest";
import type { P2PRouterDeps } from "../command-router.js";
import {
  connectedSession,
  routerWithSession,
  traceCollector,
  ACCOUNT_ID,
  DEVICE_SN,
  STATION_MODEL,
  STATION_SN,
} from "./session-fixtures.js";

/**
 * What a station was taken to be, stated before anything is sent to it.
 *
 * A call that fails during resolution sends no media command, so nothing else records the topology it was
 * resolved under — and an attached camera's media start has no unencrypted form, so whether a device was taken
 * as attached is what decides what its failure means.
 *
 * `stationAdmin` is the other half: a key this account cannot resolve is one outcome for a station the account
 * administers and another for a station shared with it. `unstated` is a device record naming no administrator,
 * which is not the same as naming another.
 */
describe("the station a call resolves", () => {
  const resolved = async (deps?: Partial<P2PRouterDeps>) => {
    const { logger, traces } = traceCollector();
    const router = routerWithSession(connectedSession(), { deps: { logger, ...deps } });
    await router
      .mediaProviderFor(DEVICE_SN)
      .live()
      .catch(() => undefined);
    return traces.find((trace) => trace.phase === "station-resolved");
  };

  it("states the topology and channel it was resolved under", async () => {
    expect(await resolved()).toMatchObject({ phase: "station-resolved", topology: "attached", channel: 1 });
  });

  it("states the model of the station it resolved, not of the device on it", async () => {
    expect(await resolved()).toMatchObject({ stationModel: STATION_MODEL });
  });

  it("states the signed-in account as the station's administrator where it is", async () => {
    expect(await resolved({ mega: { auth: { userId: ACCOUNT_ID } } as never })).toMatchObject({ stationAdmin: "self" });
  });

  it("states another administrator apart from an unstated one", async () => {
    expect(await resolved({ mega: { auth: { userId: `9${"0".repeat(39)}` } } as never })).toMatchObject({
      stationAdmin: "other",
    });

    const unstated = await resolved({
      listDevices: () =>
        [{ sn: DEVICE_SN, stationSn: STATION_SN, raw: { parent_sn: STATION_SN, device_channel: 1 } }] as never,
    });
    expect(unstated, "a record naming no administrator states that, rather than naming another").toMatchObject({
      stationAdmin: "unstated",
    });
  });
});
