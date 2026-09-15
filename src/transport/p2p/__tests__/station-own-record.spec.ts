import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EufyDevice } from "../../../core/types.js";
import type { P2PRouterDeps } from "../command-router.js";

/** Every `P2PSession` the router constructed, in order — reset per test by the `beforeEach` below. */
const opened: Array<{ stationSn: string; p2pDid: string; dskKey?: string }> = [];

vi.mock("../p2p-session.js", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  class FakeP2PSession extends EventEmitter {
    isConnected = true;
    hasLevel2Key = false;
    constructor(opts: { stationSn: string; p2pDid: string; dskKey?: string }) {
      super();
      opened.push({ stationSn: opts.stationSn, p2pDid: opts.p2pDid, dskKey: opts.dskKey });
    }
    connect = vi.fn(async () => {});
  }
  return { ...(await importOriginal<typeof import("../p2p-session.js")>()), P2PSession: FakeP2PSession };
});

const { P2PCommandRouter } = await import("../command-router.js");

const STATION_SN = "T8010P0000000000";
const ATTACHED_SN = "T8210P0000000001";
const STATION_DID = "XXXXXXX-000000-XXXXX";
const ATTACHED_DID = "YYYYYYY-000000-YYYYY";
const DSK_KEY = "0".repeat(32);

const station = {
  sn: STATION_SN,
  deviceClass: "homebase",
  api: "mega",
  realtime: "p2p",
  p2pDid: STATION_DID,
  stationSn: STATION_SN,
  raw: { member: { admin_user_id: "0".repeat(40) } },
} as unknown as EufyDevice;

const attached = {
  sn: ATTACHED_SN,
  deviceClass: "camera",
  api: "mega",
  realtime: "p2p",
  p2pDid: ATTACHED_DID,
  stationSn: STATION_SN,
  raw: { parent_sn: STATION_SN, device_channel: 0, member: { admin_user_id: "0".repeat(40) } },
} as unknown as EufyDevice;

function router(devices: EufyDevice[]) {
  const errors: Error[] = [];
  const deps: P2PRouterDeps = {
    mega: {
      auth: { userId: "u1", authToken: "t" },
      getDskKeys: vi.fn().mockResolvedValue({ [STATION_SN]: { dskKey: DSK_KEY } }),
      getCiphers: vi.fn().mockResolvedValue([]),
    } as unknown as P2PRouterDeps["mega"],
    listDevices: () => devices,
    ensureDevices: async () => {},
    onConnect: () => {},
    onClose: () => {},
    onError: (e) => errors.push(e as Error),
    onLevel2Ready: () => {},
    onFrame: () => {},
  };
  return { p2p: new P2PCommandRouter(deps), errors };
}

beforeEach(() => {
  opened.length = 0;
});

/**
 * A station absent from the device list has no session to open.
 *
 * `openStation` used to fall back to the first device naming that station as its parent, and built the
 * whole session from the attached device's record — its endpoint, its addresses, its admin user id —
 * while keying the session and the DSK lookup on the absent station's serial. One connection carried
 * two identities, and the key fetch for a serial the account does not list failed best-effort and
 * silently. Reachable by construction: a tolerated per-house `get_devs_list` failure yields a subset,
 * and the backfill can only restore devices a PREVIOUS list carried, so a first fetch has nothing.
 */
describe("opening a station whose own record is absent from the device list", () => {
  it("throws instead of building the session from an attached device's record", async () => {
    const { p2p, errors } = router([attached]);

    await expect(p2p.ensureStation(STATION_SN)).rejects.toThrow(/not in the device list/);

    expect(opened).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it("still resolves the attached device to that station, so the failure names the station", async () => {
    const { p2p } = router([attached]);

    expect(p2p.stationKeyOf(ATTACHED_SN)).toBe(STATION_SN);
    await expect(p2p.deviceFor(ATTACHED_SN)).rejects.toThrow(STATION_SN);
  });
});

describe("opening a station present in the device list", () => {
  it("dials the station's own endpoint and keys the DSK lookup on the same serial", async () => {
    const { p2p } = router([station, attached]);

    await p2p.ensureStation(STATION_SN);

    expect(opened).toEqual([{ stationSn: STATION_SN, p2pDid: STATION_DID, dskKey: DSK_KEY }]);
  });

  it("serves an attached device from its parent's session, never its own endpoint", async () => {
    const { p2p } = router([station, attached]);

    await p2p.deviceFor(ATTACHED_SN);

    expect(opened.map((o) => o.p2pDid)).toEqual([STATION_DID]);
  });
});
