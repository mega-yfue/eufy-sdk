import { describe, expect, it, vi } from "vitest";
import { DeviceChannelUnresolvedError } from "../../../core/contracts.js";
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

  describe("an attached device with no usable channel is refused, not guessed", () => {
    const TWIN = "T8114P0000000001";
    const attached = (sn: string, channel?: number) => ({
      sn,
      stationSn: STATION_SN,
      raw: { parent_sn: STATION_SN, ...(channel === undefined ? {} : { device_channel: channel }) },
    });
    const refused = async (devices: unknown[]) => {
      const { logger, traces } = traceCollector();
      const router = routerWithSession(connectedSession(), {
        deps: { logger, listDevices: () => [...devices, { sn: STATION_SN, stationSn: STATION_SN, raw: {} }] as never },
      });
      const error = await router
        .mediaProviderFor(DEVICE_SN)
        .live()
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      return { error, traces };
    };

    it("refuses a channel another device on the same station also states, and sends nothing", async () => {
      const { error, traces } = await refused([attached(DEVICE_SN, 1), attached(TWIN, 1)]);
      expect(error).toBeInstanceOf(DeviceChannelUnresolvedError);
      expect(error).toMatchObject({ sn: DEVICE_SN, stationSn: STATION_SN });
      expect(traces.find((t) => t.phase === "station-channel-unresolved")).toMatchObject({ issue: "shared" });
      expect(traces.some((t) => t.phase === "station-resolved")).toBe(false);
      expect(traces.some((t) => t.phase === "media-command")).toBe(false);
    });

    it("refuses a capability command to a shared-channel device too, and nothing reaches the wire", async () => {
      const session = connectedSession();
      const sent = vi.fn();
      Object.assign(session, {
        sendRawLevel2: sent,
        sendSetPayload: sent,
        sendControlLevel2: sent,
        sendRawLevel2Bytes: sent,
      });
      const router = routerWithSession(session, {
        deps: {
          listDevices: () =>
            [attached(DEVICE_SN, 1), attached(TWIN, 1), { sn: STATION_SN, stationSn: STATION_SN, raw: {} }] as never,
        },
      });
      await expect(
        router.dispatchCommand(DEVICE_SN, { kind: "set-json-raw", cmd: 1271, data: { a: 1 }, channel: 1 }),
      ).rejects.toBeInstanceOf(DeviceChannelUnresolvedError);
      await expect(
        router.dispatchCommand(DEVICE_SN, {
          kind: "set-payload",
          cmd: 1350,
          payload: { a: 1 },
          channel: 1,
          mValue3: 0,
        } as never),
      ).rejects.toBeInstanceOf(DeviceChannelUnresolvedError);
      expect(sent).not.toHaveBeenCalled();
    });

    it("does not hold the station warm for a refused call", async () => {
      const router = routerWithSession(connectedSession(), {
        deps: {
          listDevices: () =>
            [attached(DEVICE_SN, 1), attached(TWIN, 1), { sn: STATION_SN, stationSn: STATION_SN, raw: {} }] as never,
        },
      });
      const bump = vi.spyOn((router as unknown as { manager: { bumpCommand: () => void } }).manager, "bumpCommand");
      await router
        .mediaProviderFor(DEVICE_SN)
        .live()
        .catch(() => undefined);
      expect(bump).not.toHaveBeenCalled();
    });

    it("refuses an attached device whose record states no channel, rather than addressing channel 0", async () => {
      const { error, traces } = await refused([attached(DEVICE_SN)]);
      expect(error).toBeInstanceOf(DeviceChannelUnresolvedError);
      expect(traces.find((t) => t.phase === "station-channel-unresolved")).toMatchObject({ issue: "missing" });
    });
  });
});
