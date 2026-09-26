import { DeviceRegistry } from "../device-registry.js";
import { SessionExpiredError, type MegaHttpClient } from "../../transport/http/mega-client.js";

/**
 * A minimal fake `MegaHttpClient` — only the two methods DeviceRegistry calls (`post`,
 * `getDeviceParamList`). `post` is routed by path so one fake serves house-list + devs-list.
 */
type PostFn = (service: string, path: string, body?: unknown) => Promise<any>;
function fakeMega(opts: { post: PostFn; getDeviceParamList?: (sn: string) => Promise<any> }): MegaHttpClient {
  return {
    post: (service: string, path: string, body?: unknown) => opts.post(service, path, body),
    getDeviceParamList: (sn: string) => (opts.getDeviceParamList ?? (async () => ({})))(sn),
  } as unknown as MegaHttpClient;
}

/** A raw devs-list device record (the get_devs_list shape). */
function rawDevice(sn: string, extra: Record<string, unknown> = {}) {
  return {
    device_sn: sn,
    device_name: `name-${sn}`,
    device_model: "T8410",
    station_sn: sn,
    p2p_did: "DID-XYZ", // → realtime "p2p"
    category: "eufy_security",
    device_type: 30,
    params: [{ param_type: 1101, param_value: "88" }],
    ...extra,
  };
}

describe("DeviceRegistry", () => {
  describe("getDevices — house-scoped merge/dedupe", () => {
    it("queries {} + every house_id, unions and dedupes by serial (last write wins)", async () => {
      const errors: unknown[] = [];
      const bodiesSeen: unknown[] = [];
      const mega = fakeMega({
        post: async (_s, path, body) => {
          if (path.endsWith("get_house_list")) return { house_infos: [{ house_id: "H1" }, { house_id: "H2" }] };
          bodiesSeen.push(body);
          // {} → A,B ; H1 → B (dupe, newer params) ; H2 → C
          if (JSON.stringify(body) === "{}") return { devices: [rawDevice("A"), rawDevice("B")] };
          if ((body as any).house_id === "H1")
            return { devices: [rawDevice("B", { params: [{ param_type: 1101, param_value: "42" }] })] };
          return { devices: [rawDevice("C")] };
        },
      });
      const reg = new DeviceRegistry({ mega, onError: (e) => errors.push(e) });

      const devs = await reg.getDevices();

      expect(bodiesSeen).toEqual([{}, { house_id: "H1" }, { house_id: "H2" }]);
      expect(devs.map((d) => d.sn).sort()).toEqual(["A", "B", "C"]);
      const b = devs.find((d) => d.sn === "B");
      expect(b?.params?.[1101]).toBe("42"); // H1's later record won
      expect(errors).toEqual([]);
      expect(reg.list()).toBe(devs);
    });

    it("skips records without a device_sn and folds params into a keyed map", async () => {
      const mega = fakeMega({
        post: async (_s, path) => {
          if (path.endsWith("get_house_list")) return { house_infos: [] };
          return { devices: [{ no_sn: true }, rawDevice("A")] };
        },
      });
      const reg = new DeviceRegistry({ mega, onError: () => {} });
      const devs = await reg.getDevices();
      expect(devs.map((d) => d.sn)).toEqual(["A"]);
      expect(devs[0].params).toEqual({ 1101: "88" });
    });
  });

  describe("getDevices — error resilience", () => {
    it("still queries {} when get_house_list throws, and surfaces the error via onError", async () => {
      const errors: unknown[] = [];
      const mega = fakeMega({
        post: async (_s, path) => {
          if (path.endsWith("get_house_list")) throw new Error("house boom");
          return { devices: [rawDevice("A")] };
        },
      });
      const reg = new DeviceRegistry({ mega, onError: (e) => errors.push(e) });
      const devs = await reg.getDevices();
      expect(devs.map((d) => d.sn)).toEqual(["A"]); // the {} body still ran
      expect(errors).toHaveLength(1);
      expect((errors[0] as Error).message).toBe("house boom");
    });

    it("skips a throwing per-body devs-list call (not fatal) and reports it", async () => {
      const errors: unknown[] = [];
      const mega = fakeMega({
        post: async (_s, path, body) => {
          if (path.endsWith("get_house_list")) return { house_infos: [{ house_id: "H1" }] };
          if ((body as any).house_id === "H1") throw new Error("body boom");
          return { devices: [rawDevice("A")] };
        },
      });
      const reg = new DeviceRegistry({ mega, onError: (e) => errors.push(e) });
      const devs = await reg.getDevices();
      expect(devs.map((d) => d.sn)).toEqual(["A"]);
      expect((errors[0] as Error).message).toBe("body boom");
    });

    /**
     * A rejected session is not a subset of the account.
     *
     * Tolerating a failed query is right for an outage — a partial answer beats none, and the devices it did
     * not return are kept rather than dropped. It is wrong for a token the cloud has finished with: every
     * query fails the same way, so "what it has" is nothing on a fresh client, and a caller is handed an empty
     * account that reads exactly like an account with no devices. A host that believes it tears down every
     * object it had. The transport has already tried to recover this by logging in again; reaching here
     * means it could not, so the caller is the one who has to know.
     */
    it("rejects rather than presenting a dead session as an account with no devices", async () => {
      const errors: unknown[] = [];
      const mega = fakeMega({
        post: async () => {
          throw new SessionExpiredError("/app/house/get_devs_list failed (401): token does not exist");
        },
      });
      const reg = new DeviceRegistry({ mega, onError: (e) => errors.push(e) });

      await expect(reg.getDevices()).rejects.toBeInstanceOf(SessionExpiredError);
      expect(errors).toEqual([]); // the caller is told by the rejection, not beside a successful-looking result
    });

    /** The devices already known stay known: a rejection is not a reason to forget the account. */
    it("keeps the devices it had when a later refresh is rejected", async () => {
      let alive = true;
      const mega = fakeMega({
        post: async (_s, path) => {
          if (!alive) throw new SessionExpiredError("token does not exist");
          if (path.endsWith("get_house_list")) return {};
          return { devices: [rawDevice("A")] };
        },
      });
      const reg = new DeviceRegistry({ mega, onError: () => {} });
      await reg.getDevices();

      alive = false;
      await expect(reg.getDevices()).rejects.toBeInstanceOf(SessionExpiredError);
      expect(reg.list().map((d) => d.sn)).toEqual(["A"]);
    });
  });

  describe("record — param overlay", () => {
    const listMega = (getDeviceParamList: (sn: string) => Promise<any>) =>
      fakeMega({
        post: async (_s, path) => {
          if (path.endsWith("get_house_list")) return { house_infos: [] };
          return { devices: [rawDevice("A")] };
        },
        getDeviceParamList,
      });

    it("overlays a fresh get_device_param_list on top of the device-list params", async () => {
      const reg = new DeviceRegistry({
        mega: listMega(async () => ({
          params: [
            { param_type: 1101, param_value: "5" },
            { param_type: 9, param_value: "x" },
          ],
        })),
        onError: () => {},
      });
      const rec = await reg.record("A");
      expect(rec.params[1101]).toBe("5"); // live overlay won over the device-list "88"
      expect(rec.params[9]).toBe("x"); // and added the new param
      expect(rec.deviceType).toBe(30);
      expect(rec.model).toBe("T8410");
    });

    it("falls back to device-list params when the live call throws (no throw out)", async () => {
      const reg = new DeviceRegistry({
        mega: listMega(async () => {
          throw new Error("param boom");
        }),
        onError: () => {},
      });
      const rec = await reg.record("A");
      expect(rec.params[1101]).toBe("88"); // device-list value
    });

    it("throws a helpful error for an unknown serial", async () => {
      const reg = new DeviceRegistry({ mega: listMega(async () => ({})), onError: () => {} });
      await expect(reg.record("NOPE")).rejects.toThrow(/device NOPE not found/);
    });

    it("carries each param's update_time through the live overlay", async () => {
      const reg = new DeviceRegistry({
        mega: listMega(async () => ({ params: [{ param_type: 1101, param_value: "5", update_time: 1_700_000_500 }] })),
        onError: () => {},
      });
      const rec = await reg.record("A");
      expect(rec.paramUpdatedAt[1101]).toBe(1_700_000_500);
    });
  });

  describe("param freshness (update_time → lastSeenMs)", () => {
    const withParams = (params: unknown[]) =>
      fakeMega({
        post: async (_s, path) => {
          if (path.endsWith("get_house_list")) return { house_infos: [] };
          return { devices: [rawDevice("A", { params })] };
        },
      });

    it("keeps update_time per param (unix seconds) and derives lastSeenMs from the newest", async () => {
      const reg = new DeviceRegistry({
        mega: withParams([
          { param_type: 1101, param_value: "88", update_time: 1_700_000_000 },
          { param_type: 1141, param_value: "-55", update_time: 1_700_000_600 }, // newest
          { param_type: 1550, param_value: "1", update_time: 1_700_000_300 },
        ]),
        onError: () => {},
      });
      const [dev] = await reg.getDevices();

      expect(dev.paramUpdatedAt).toEqual({ 1101: 1_700_000_000, 1141: 1_700_000_600, 1550: 1_700_000_300 });
      // seconds → ms, converted exactly once, comparable to Date.now()
      expect(dev.lastSeenMs).toBe(1_700_000_600_000);
    });

    it("omits a param that carried no usable update_time rather than stamping it 0", async () => {
      const reg = new DeviceRegistry({
        mega: withParams([
          { param_type: 1101, param_value: "88" }, // absent
          { param_type: 1102, param_value: "1", update_time: 0 }, // present but meaningless
          { param_type: 1103, param_value: "1", update_time: "not-a-number" },
          { param_type: 1141, param_value: "-55", update_time: 1_700_000_600 },
        ]),
        onError: () => {},
      });
      const [dev] = await reg.getDevices();

      // All four values survive; only the real stamp is recorded.
      expect(Object.keys(dev.params ?? {})).toEqual(["1101", "1102", "1103", "1141"]);
      expect(dev.paramUpdatedAt).toEqual({ 1141: 1_700_000_600 });
      // A stamped 0 must not drag lastSeenMs down to the epoch.
      expect(dev.lastSeenMs).toBe(1_700_000_600_000);
    });

    it("leaves lastSeenMs undefined when the record stamped nothing", async () => {
      const reg = new DeviceRegistry({
        mega: withParams([{ param_type: 1101, param_value: "88" }]),
        onError: () => {},
      });
      const [dev] = await reg.getDevices();

      expect(dev.paramUpdatedAt).toEqual({});
      expect(dev.lastSeenMs).toBeUndefined();
    });
  });

  describe('pollParamChanges — the source:"poll" producer', () => {
    /** A fake whose devs-list response can be swapped between polls. */
    const seq = (responses: Array<Array<Record<string, unknown>>>) => {
      let i = 0;
      return fakeMega({
        post: async (_s, path) => {
          if (path.endsWith("get_house_list")) return { house_infos: [] };
          return { devices: responses[Math.min(i++, responses.length - 1)] };
        },
      });
    };
    const dev = (params: unknown[]) => rawDevice("A", { params });

    it("reports nothing on the first pass — a device appearing is discovery, not a change", async () => {
      const reg = new DeviceRegistry({
        mega: seq([[dev([{ param_type: 1101, param_value: "88" }])]]),
        onError: () => {},
      });
      expect((await reg.pollChanges()).params).toEqual([]);
    });

    it("reports a changed param with from/to and the post-change param map", async () => {
      const reg = new DeviceRegistry({
        mega: seq([
          [dev([{ param_type: 1101, param_value: "88" }])],
          [
            dev([
              { param_type: 1101, param_value: "81" }, // changed
              { param_type: 1141, param_value: "-55" }, // newly appeared
            ]),
          ],
        ]),
        onError: () => {},
      });
      await reg.pollChanges(); // prime the snapshot

      const changes = (await reg.pollChanges()).params;

      expect(changes).toHaveLength(1); // the new param is NOT a change (nothing to change from)
      expect(changes[0]).toMatchObject({ deviceSn: "A", paramType: 1101, from: "88", to: "81" });
      expect(changes[0].params[1141]).toBe("-55"); // siblings available for interpretation
    });

    it("reports nothing when a poll returns identical params", async () => {
      const reg = new DeviceRegistry({
        mega: seq([[dev([{ param_type: 1101, param_value: "88" }])]]),
        onError: () => {},
      });
      await reg.pollChanges();
      expect((await reg.pollChanges()).params).toEqual([]);
    });
  });

  describe("capabilitiesForFrame", () => {
    const twoDeviceMega = () =>
      fakeMega({
        post: async (_s, path) => {
          if (path.endsWith("get_house_list")) return { house_infos: [] };
          return {
            devices: [
              rawDevice("STA", { station_sn: "STA", device_channel: 0 }), // standalone / station, ch0
              rawDevice("CAM", { station_sn: "STA", device_channel: 2 }), // attached camera on ch2
            ],
          };
        },
      });

    it("resolves a standalone device on channel 0 and an attached camera by channel", async () => {
      const reg = new DeviceRegistry({ mega: twoDeviceMega(), onError: () => {} });
      await reg.getDevices();
      expect(reg.capabilitiesForFrame("STA", 0)).toBeInstanceOf(Set);
      expect(reg.capabilitiesForFrame("STA", 2)).toBeInstanceOf(Set); // the attached camera
    });

    it("negative-caches an unresolvable (station, channel) as undefined", async () => {
      const reg = new DeviceRegistry({ mega: twoDeviceMega(), onError: () => {} });
      await reg.getDevices();
      expect(reg.capabilitiesForFrame("STA", 9)).toBeUndefined(); // no device on ch9
      expect(reg.capabilitiesForFrame("OTHER", 0)).toBeUndefined();
    });

    it("clears the caps cache on a fresh getDevices (stale (station,channel) dropped)", async () => {
      let channel = 2;
      const mega = fakeMega({
        post: async (_s, path) => {
          if (path.endsWith("get_house_list")) return { house_infos: [] };
          return { devices: [rawDevice("CAM", { station_sn: "STA", device_channel: channel })] };
        },
      });
      const reg = new DeviceRegistry({ mega, onError: () => {} });
      await reg.getDevices();
      expect(reg.capabilitiesForFrame("STA", 2)).toBeInstanceOf(Set);
      expect(reg.capabilitiesForFrame("STA", 5)).toBeUndefined(); // negative-cached

      channel = 5; // device moved to ch5
      await reg.getDevices(); // must clear both the positive and negative cache
      expect(reg.capabilitiesForFrame("STA", 5)).toBeInstanceOf(Set); // re-resolved, not stale-undefined
      expect(reg.capabilitiesForFrame("STA", 2)).toBeUndefined();
    });
  });

  describe("require — the loud record lookup the command sink routes on", () => {
    const oneDeviceMega = () =>
      fakeMega({
        post: async (_s, path) => {
          if (path.endsWith("get_house_list")) return { house_infos: [] };
          return { devices: [rawDevice("SN1")] };
        },
      });

    it("returns the cached device for a known serial", async () => {
      const reg = new DeviceRegistry({ mega: oneDeviceMega(), onError: () => {} });
      await reg.getDevices();
      expect(reg.require("SN1").sn).toBe("SN1");
    });

    it("throws on an unloaded serial rather than defaulting (a routing decision must never fall through)", async () => {
      const reg = new DeviceRegistry({ mega: oneDeviceMega(), onError: () => {} });
      await reg.getDevices();
      expect(() => reg.require("NOPE")).toThrow(/device NOPE not loaded/);
    });
  });
});

describe("pollChanges — account roster", () => {
  /**
   * Devs-list responses swapped per POLL, not per call: one refresh issues several devs-list queries
   * (the bare body plus one per house), so the round advances on the house-list call that opens each
   * refresh. `failHouse` makes every devs-list query of that round throw, i.e. a partial refresh.
   */
  const seq = (rounds: Array<{ devices: string[]; failHouse?: boolean }>) => {
    let round = -1;
    return fakeMega({
      post: async (_s, path) => {
        if (path.endsWith("get_house_list")) {
          round++;
          return { house_infos: [{ house_id: "H1" }] };
        }
        const r = rounds[Math.min(Math.max(round, 0), rounds.length - 1)];
        if (r.failHouse) throw new Error("house query down");
        return { devices: r.devices.map((sn) => rawDevice(sn)) };
      },
    });
  };

  it("reports a device that joined the account", async () => {
    const reg = new DeviceRegistry({ mega: seq([{ devices: ["A"] }, { devices: ["A", "B"] }]), onError: () => {} });
    await reg.pollChanges();

    const diff = await reg.pollChanges();

    expect(diff.added.map((d) => d.sn)).toEqual(["B"]);
    expect(diff.removed).toEqual([]);
  });

  it("reports a device that left the account", async () => {
    const reg = new DeviceRegistry({ mega: seq([{ devices: ["A", "B"] }, { devices: ["A"] }]), onError: () => {} });
    await reg.pollChanges();

    const diff = await reg.pollChanges();

    expect(diff.removed.map((d) => d.sn)).toEqual(["B"]);
    expect(diff.added).toEqual([]);
  });

  /**
   * The account a host already has is not a stream of pairings. Nothing was known before the first
   * pass, so that pass establishes the baseline and reports no additions at all — a host enumerating
   * what exists calls `getDevices()`.
   */
  it("does not report the first enumeration as a burst of additions", async () => {
    const reg = new DeviceRegistry({ mega: seq([{ devices: ["A", "B", "C"] }]), onError: () => {} });

    expect((await reg.pollChanges()).added).toEqual([]);
    expect((await reg.pollChanges()).added).toEqual([]);
  });

  /**
   * The mirror image of the removal guard. A device missing from a partial baseline is not new, so
   * announcing it on recovery would present a chunk of an existing account as freshly paired — the same
   * damage as a phantom removal, in the other direction.
   */
  it("does not report additions against a baseline that only partly resolved", async () => {
    const reg = new DeviceRegistry({
      mega: seq([{ devices: [], failHouse: true }, { devices: ["A", "B"] }, { devices: ["A", "B", "C"] }]),
      onError: () => {},
    });
    await reg.pollChanges(); // baseline is incomplete

    expect((await reg.pollChanges()).added).toEqual([]); // A and B are not joins
    expect((await reg.pollChanges()).added.map((d) => d.sn)).toEqual(["C"]); // a real join still lands
  });

  /**
   * The poll diff must not be taken against the shared device cache: anything that needs a device
   * refreshes that cache — a host's own `getDevices()`, a command sink resolving a serial before an
   * on-demand P2P open — and would silently absorb the delta, leaving the next poll to see an
   * unchanged account and emit nothing.
   */
  it("still reports a change when something else refreshed the cache in between", async () => {
    const reg = new DeviceRegistry({ mega: seq([{ devices: ["A"] }, { devices: ["A", "B"] }]), onError: () => {} });
    await reg.pollChanges();

    await reg.getDevices(); // an unrelated caller pulls the new roster first

    expect((await reg.pollChanges()).added.map((d) => d.sn)).toEqual(["B"]);
  });

  /**
   * A host acting on a removal typically deletes an accessory, so an absence caused by an outage must
   * never look like an unpairing — a partial refresh reports no removals at all.
   *
   * Nor may it empty the cache: every serial lookup the command sink and event
   * fan-out perform reads this list, and wiping it during an outage would break routing and then
   * present the whole account as newly discovered on recovery.
   */
  it("keeps devices a partial refresh didn't return, and reports no churn on recovery", async () => {
    const reg = new DeviceRegistry({
      mega: seq([{ devices: ["A", "B"] }, { devices: [], failHouse: true }, { devices: ["A", "B"] }]),
      onError: () => {},
    });
    await reg.pollChanges();

    const outage = await reg.pollChanges();
    expect(
      reg
        .list()
        .map((d) => d.sn)
        .sort(),
    ).toEqual(["A", "B"]); // cache survived
    expect(outage.removed).toEqual([]);

    const recovered = await reg.pollChanges();
    expect(recovered.added).toEqual([]); // not rediscovered
    expect(recovered.removed).toEqual([]);
  });

  it("suppresses removals when the refresh only partly resolved", async () => {
    const errors: unknown[] = [];
    const reg = new DeviceRegistry({
      mega: seq([{ devices: ["A", "B"] }, { devices: [], failHouse: true }]),
      onError: (e) => errors.push(e),
    });
    await reg.pollChanges();

    const diff = await reg.pollChanges();

    expect(diff.removed).toEqual([]);
    expect(errors).toHaveLength(2); // both devs-list queries of that round failed
  });
});

/**
 * Device classification is DERIVED from the resolved codec, not from an id list.
 *
 * `codecForType` already owns the DeviceType space and treats camera as the residual bucket, so a
 * newly-released SKU classifies correctly with no edit here.
 */
describe("deviceClass — derived from the codec", () => {
  const classOf = async (deviceType: number, model: string, category = "eufy_security") => {
    const mega = fakeMega({
      post: async (_s, path) => {
        if (path.endsWith("get_house_list")) return { house_infos: [] };
        return {
          devices: [
            { device_sn: "A", device_model: model, device_type: deviceType, category, p2p_did: "DID-XYZ", params: [] },
          ],
        };
      },
    });
    const reg = new DeviceRegistry({ mega, onError: () => {} });
    return (await reg.getDevices())[0].deviceClass;
  };

  it("classifies the real HomeBase types as homebase", async () => {
    expect(await classOf(0, "T8010")).toBe("homebase"); // STATION
    expect(await classOf(18, "T8030")).toBe("homebase"); // HB3
  });

  /**
   * CAMERA2 (9) is a battery eufyCam, not a station. Getting this wrong misreports `deviceClass` to a
   * host, and the power tier keys off it — a standalone one would be treated as mains-powered and
   * never idle-detach.
   */
  it("classifies a battery eufyCam as a camera, not a station", async () => {
    expect(await classOf(9, "T8114")).toBe("camera");
  });

  it("classifies sensors, locks and the keypad", async () => {
    expect(await classOf(2, "T8900")).toBe("sensor");
    expect(await classOf(10, "T8910")).toBe("sensor");
    expect(await classOf(50, "T8500")).toBe("other"); // lock
    expect(await classOf(11, "T8960")).toBe("other"); // keypad
  });

  it("classifies an unlisted future camera id without needing an edit", async () => {
    // Not enumerated anywhere: it lands in the codec's residual camera bucket.
    expect(await classOf(10099, "T8999")).toBe("camera");
  });

  /**
   * The residual camera bucket is the right default for the security ecosystem and wrong for anything
   * else — a home appliance on secure MQTT that reaches it is unclassified, not a camera. Reporting
   * `"other"` keeps "we don't know" distinguishable from a confident wrong answer.
   */
  it("does not call an unrecognised MQTT appliance a camera", async () => {
    const applianceClass = async (deviceType: number) => {
      const mega = fakeMega({
        post: async (_s, path) => {
          if (path.endsWith("get_house_list")) return { house_infos: [] };
          return {
            devices: [
              { device_sn: "A", device_model: "T9999", device_type: deviceType, category: "eufy_home", params: [] },
            ],
          };
        },
      });
      return (await new DeviceRegistry({ mega, onError: () => {} }).getDevices())[0].deviceClass;
    };

    expect(await applianceClass(100)).toBe("other"); // inside the security id range, but not a security device
    expect(await applianceClass(99999)).toBe("other"); // outside it, hits the blanket fallback
  });

  describe("getDevices — the user's name for a unit", () => {
    const vacuum = (extra: Record<string, unknown>) =>
      rawDevice("V", {
        device_model: "T2351",
        category: "eufy_home",
        p2p_did: undefined,
        device_type: undefined,
        params: [],
        ...extra,
      });
    async function nameOf(record: Record<string, unknown>): Promise<string | undefined> {
      const mega = fakeMega({
        post: async (_s, path) => (path.endsWith("get_house_list") ? { house_infos: [] } : { devices: [record] }),
      });
      const [dev] = await new DeviceRegistry({ mega, onError: () => {} }).getDevices();
      return dev?.name;
    }

    it("reads a robot vacuum's alias_name before the product label in device_name", async () => {
      expect(await nameOf(vacuum({ device_name: "RoboVac", alias_name: "Kitchen" }))).toBe("Kitchen");
    });

    it("falls back to device_name on a robot vacuum with no alias", async () => {
      expect(await nameOf(vacuum({ device_name: "RoboVac", alias_name: "" }))).toBe("RoboVac");
      expect(await nameOf(vacuum({ device_name: "RoboVac" }))).toBe("RoboVac");
    });

    it("keeps device_name first on a camera", async () => {
      expect(await nameOf(rawDevice("C", { device_name: "Front door", alias_name: "Other" }))).toBe("Front door");
    });
  });
});
