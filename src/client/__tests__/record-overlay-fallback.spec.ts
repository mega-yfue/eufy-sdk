import { afterEach, describe, expect, it, vi } from "vitest";
import { DeviceRegistry } from "../device-registry.js";
import { MegaApiError, OWNER_ONLY_CODE, SessionExpiredError } from "../../transport/http/mega-client.js";

/**
 * `record()` starts from the device-list params and overlays a per-device `get_device_param_list`. That
 * overlay is **owner-gated**: a shared/member account gets `20004 "Only the owner can change settings"` for
 * every device, forever. The failure was swallowed by a bare catch, so `record()` silently answered with the
 * cached device-list params — and it only re-fetched that list when it had none at all.
 *
 * The consequence is that a read-through refresh could never bring a new value on such an account: it
 * re-applied the same cached params with a fresh timestamp every time, so an observation like camera
 * enablement could not change for the life of the client while looking perfectly healthy.
 *
 * The device list carries the same `{param_type, param_value, update_time}` and is NOT owner-gated, so it is
 * the fallback the overlay's own contract prescribes.
 */
const SN = "T8000P0000000000";
const OTHER_SN = "T8000P0000000001";

/** A devs-list record carrying `params` in the wire shape, mirroring `device-registry.spec.ts`. */
function rawDevice(params: Record<number, string>, sn: string = SN) {
  return {
    device_sn: sn,
    device_name: "cam",
    device_model: "T8410",
    station_sn: SN,
    p2p_did: "DID-XYZ",
    category: "eufy_security",
    device_type: 30,
    params: Object.entries(params).map(([param_type, param_value]) => ({
      param_type: Number(param_type),
      param_value,
      update_time: 1,
    })),
  };
}

function registryWith(opts: {
  overlay: (sn: string) => Promise<unknown>;
  params: () => Record<number, string>;
  debug?: (message: string) => void;
  onList?: () => void;
}) {
  const errors: unknown[] = [];
  let listFetches = 0;
  const overlay = vi.fn(opts.overlay);
  const mega = {
    post: async (_service: string, path: string) => {
      if (path.endsWith("get_house_list")) return { house_infos: [] };
      listFetches++;
      opts.onList?.();
      return { devices: [rawDevice(opts.params()), rawDevice(opts.params(), OTHER_SN)] };
    },
    getDeviceParamList: overlay,
    getThingsList: async () => ({ things_list: [] }),
  } as never;
  const registry = new DeviceRegistry({
    mega,
    onError: (e) => errors.push(e),
    logger: { debug: opts.debug ?? (() => {}), info: () => {}, warn: () => {}, error: () => {} } as never,
  });
  return { registry, overlay, errors, listFetches: () => listFetches };
}

/** What the client throws for this endpoint on a shared or member account. */
const ownerGated = async () => {
  throw new MegaApiError(
    "/app/devicemanage/get_device_param_list failed (200/20004): Only the owner can change settings.",
    OWNER_ONLY_CODE,
    200,
  );
};

afterEach(() => {
  vi.useRealTimers();
});

describe("record() when the per-device overlay is unavailable", () => {
  it("re-fetches once the reuse window has passed, so a changed value can still be observed", async () => {
    vi.useFakeTimers();
    let current = "true";
    const { registry } = registryWith({ overlay: ownerGated, params: () => ({ 2001: current }) });

    const first = await registry.record(SN);
    expect(first.params[2001]).toBe("true");

    current = "false";
    await vi.advanceTimersByTimeAsync(6000);
    const second = await registry.record(SN);

    expect(second.params[2001]).toBe("false");
  });

  it("reuses a list younger than the window, so resolving a fleet costs ONE list not one per device", async () => {
    const { registry, listFetches } = registryWith({ overlay: ownerGated, params: () => ({ 2001: "true" }) });
    await registry.record(SN);
    const afterFirst = listFetches();

    await registry.record(SN);
    await registry.record(SN);
    await registry.record(SN);

    expect(listFetches()).toBe(afterFirst);
  });

  it("stops attempting an overlay that is permanently refused", async () => {
    const { registry, overlay } = registryWith({ overlay: ownerGated, params: () => ({ 2001: "true" }) });

    await registry.record(SN);
    await registry.record(SN);
    await registry.record(SN);

    expect(overlay).toHaveBeenCalledTimes(1);
  });

  it("does NOT latch on a transient failure — an entitled account keeps its freshest source", async () => {
    let attempt = 0;
    const { registry, overlay, errors } = registryWith({
      overlay: async () => {
        if (++attempt === 1) throw new Error("socket hang up");
        return { params: [{ param_type: 2001, param_value: "false", update_time: 2 }] };
      },
      params: () => ({ 2001: "true" }),
    });

    const first = await registry.record(SN);
    const second = await registry.record(SN);

    expect(first.params[2001]).toBe("true");
    expect(second.params[2001]).toBe("false");
    expect(overlay).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
  });

  it("classifies by the envelope code, not by the wording of a message", async () => {
    const { registry, overlay } = registryWith({
      overlay: async () => {
        throw new MegaApiError("request failed", OWNER_ONLY_CODE, 200);
      },
      params: () => ({ 2001: "true" }),
    });

    await registry.record(SN);
    await registry.record(SN);

    expect(overlay).toHaveBeenCalledTimes(1);
  });

  it("does not latch on a DIFFERENT api failure that merely mentions the number", async () => {
    const { registry, overlay } = registryWith({
      overlay: async () => {
        throw new MegaApiError("failed (500/20004 devices scanned): server error", 500, 500);
      },
      params: () => ({ 2001: "true" }),
    });

    await registry.record(SN);
    await registry.record(SN);

    expect(overlay).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes onto one device-list fetch", async () => {
    vi.useFakeTimers();
    const { registry, listFetches } = registryWith({ overlay: ownerGated, params: () => ({ 2001: "true" }) });
    await registry.record(SN);
    const before = listFetches();
    await vi.advanceTimersByTimeAsync(6000);

    await Promise.all([registry.record(SN), registry.record(SN), registry.record(SN)]);

    expect(listFetches() - before).toBe(1);
  });

  it("never surfaces the refusal as an error — a host may treat one as a failed discovery", async () => {
    const { registry, errors } = registryWith({ overlay: ownerGated, params: () => ({ 2001: "true" }) });

    await registry.record(SN);
    await registry.record(OTHER_SN);

    expect(errors).toEqual([]);
  });

  it("logs it once for the ACCOUNT rather than once per device", async () => {
    const debug = vi.fn();
    const { registry } = registryWith({ overlay: ownerGated, params: () => ({ 2001: "true" }), debug });

    await registry.record(SN);
    await registry.record(OTHER_SN);

    expect(debug).toHaveBeenCalledTimes(1);
    expect(String(debug.mock.calls[0][0])).toMatch(/owner-gated/i);
  });

  it("keeps using the overlay while it works, and does not re-fetch the list for nothing", async () => {
    const { registry, listFetches } = registryWith({
      overlay: async () => ({ params: [{ param_type: 2001, param_value: "false", update_time: 2 }] }),
      params: () => ({ 2001: "true" }),
    });

    const first = await registry.record(SN);
    const afterFirst = listFetches();
    const second = await registry.record(SN);

    expect(first.params[2001]).toBe("false");
    expect(second.params[2001]).toBe("false");
    expect(listFetches()).toBe(afterFirst);
  });
});

/**
 * The fallback fetch's two failure modes, which are not the same failure and must not share an answer.
 *
 * {@link DeviceRegistry.getDevices} tolerates a failing house/body query as a PARTIAL — it reports the error
 * and answers with what it got, keeping previously known devices — and rejects only for a rejected session.
 * So the reuse window is a statement that a fetch RESOLVED, not that the account came back whole: holding it
 * over a partial outage is deliberate, because retrying per device is how one outage becomes N bursts.
 *
 * A dead session is the one that must not be absorbed. It is not a statement about the overlay's
 * availability, and the fallback runs over the same session, so answering `undefined` turns an expiry into
 * "no such device" — or worse, serves the params this call already held as current. That is the conflation
 * removed one level up, where an empty list stopped standing in for a rejected token.
 */
describe("record() when the fallback list fetch itself fails", () => {
  it("lets a rejected token surface instead of answering with a device that is missing", async () => {
    let sessionAlive = true;
    const { registry } = registryWith({
      overlay: async () => {
        if (!sessionAlive) throw new SessionExpiredError("/app/devicemanage/get_device_param_list failed (401)");
        return { params: [{ param_type: 2001, param_value: "true", update_time: 2 }] };
      },
      params: () => ({ 2001: "true" }),
      onList: () => {
        if (!sessionAlive) throw new SessionExpiredError("/app/house/get_devs_list failed (401)");
      },
    });

    await registry.record(SN);
    sessionAlive = false;

    await expect(registry.record(SN)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("does not open the reuse window on a rejected session, so a recovered one is read at once", async () => {
    let sessionAlive = false;
    const { registry, listFetches } = registryWith({
      overlay: ownerGated,
      params: () => ({ 2001: "true" }),
      onList: () => {
        if (!sessionAlive) throw new SessionExpiredError("/app/house/get_devs_list failed (401)");
      },
    });

    await expect(registry.record(SN)).rejects.toBeInstanceOf(SessionExpiredError);
    const afterRejection = listFetches();
    sessionAlive = true;
    const recovered = await registry.record(SN);

    expect(listFetches()).toBe(afterRejection + 1);
    expect(recovered.params[2001]).toBe("true");
  });

  it("holds the window over a partial outage, so one outage is not multiplied per device", async () => {
    const { registry, listFetches, errors } = registryWith({
      overlay: ownerGated,
      params: () => ({ 2001: "true" }),
      onList: () => {
        throw new Error("socket hang up");
      },
    });

    await expect(registry.record(SN)).rejects.toThrow(/not found/);
    const afterFirst = listFetches();
    await expect(registry.record(OTHER_SN)).rejects.toThrow(/not found/);

    expect(listFetches()).toBe(afterFirst);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("still absorbs a transient failure, answering from what it already holds", async () => {
    let listAlive = true;
    const { registry } = registryWith({
      overlay: async () => {
        throw new Error("socket hang up");
      },
      params: () => ({ 2001: "true" }),
      onList: () => {
        if (!listAlive) throw new Error("socket hang up");
      },
    });

    const first = await registry.record(SN);
    listAlive = false;
    const second = await registry.record(SN);

    expect(first.params[2001]).toBe("true");
    expect(second.params[2001]).toBe("true");
  });
});
