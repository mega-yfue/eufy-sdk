import { describe, expect, it, vi } from "vitest";
import { DeviceRegistry } from "../device-registry.js";
import { MegaApiError, OWNER_ONLY_CODE } from "../../transport/http/mega-client.js";

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

/** A devs-list record carrying `params` in the wire shape, mirroring `device-registry.spec.ts`. */
function rawDevice(params: Record<number, string>) {
  return {
    device_sn: SN,
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

function registryWith(opts: { overlay: (sn: string) => Promise<unknown>; params: () => Record<number, string> }) {
  const errors: unknown[] = [];
  let listFetches = 0;
  const overlay = vi.fn(opts.overlay);
  const mega = {
    post: async (_service: string, path: string) => {
      if (path.endsWith("get_house_list")) return { house_infos: [] };
      listFetches++;
      return { devices: [rawDevice(opts.params())] };
    },
    getDeviceParamList: overlay,
  } as never;
  const registry = new DeviceRegistry({ mega, onError: (e) => errors.push(e) });
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

describe("record() when the per-device overlay is unavailable", () => {
  it("re-fetches the device list, so a changed value can still be observed", async () => {
    let current = "true";
    const { registry } = registryWith({ overlay: ownerGated, params: () => ({ 2001: current }) });

    const first = await registry.record(SN);
    expect(first.params[2001]).toBe("true");

    current = "false";
    const second = await registry.record(SN);

    expect(second.params[2001]).toBe("false");
  });

  it("reports the overlay failure instead of swallowing it, so a permanent one is diagnosable", async () => {
    const { registry, errors } = registryWith({ overlay: ownerGated, params: () => ({ 2001: "true" }) });

    await registry.record(SN);

    expect(errors).toHaveLength(1);
    expect(String((errors[0] as { message?: string }).message)).toMatch(/20004|owner/i);
  });

  it("reports it only once per device, not on every refresh", async () => {
    const { registry, errors } = registryWith({ overlay: ownerGated, params: () => ({ 2001: "true" }) });

    await registry.record(SN);
    await registry.record(SN);
    await registry.record(SN);

    expect(errors).toHaveLength(1);
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
    const { registry, listFetches } = registryWith({ overlay: ownerGated, params: () => ({ 2001: "true" }) });
    await registry.record(SN);
    const before = listFetches();

    await Promise.all([registry.record(SN), registry.record(SN), registry.record(SN)]);

    expect(listFetches() - before).toBe(1);
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
