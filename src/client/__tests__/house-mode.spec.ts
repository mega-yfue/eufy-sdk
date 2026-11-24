import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import type { EufyDevice } from "../../core/types.js";
import { CommandResultError, StationUnreachableError, type Command } from "../../core/contracts.js";
import { ArmingMode } from "../../model/capabilities/arming.js";

/**
 * `setHouseMode` as the app's house arming runs it: the cloud config first, then the stations its
 * `get_home_config` names (else the house's own), written in parallel where online and not already in the
 * mode. Serials and ids are synthetic.
 */
const HOUSE = "house-0";
const BASE = "T8030P0000000000";
const SOLO = "T8113P0000000000";
const OFFLINE = "T8030P0000000001";
const SAME = "T8030P0000000002";
const LOCK = "T8520P0000000000";
const GUEST = "T8010P0000000000";
const OTHER_HOUSE = "T8010P0000000001";
const SHARED = "T8010P0000000002";
const LIGHT = "T81A0P0000000000";
const PRO = "T9000P0000000000";
const HUB = "T8010P0000000003";
const BARE = "T8010P0000000004";

const common = { category: "eufy_security", api: "mega", realtime: "p2p", houseId: HOUSE, memberType: 2 };
const FLEET = [
  { ...common, sn: BASE, stationSn: BASE, name: "Base", params: { 1131: "1", 1224: "63", 1172: "30" } },
  { ...common, sn: SOLO, stationSn: SOLO, params: { 1131: "1", 1171: "15" } },
  { ...common, sn: OFFLINE, stationSn: OFFLINE, params: { 1131: "0", 1224: "63" } },
  { ...common, sn: SAME, stationSn: SAME, params: { 1131: "1", 1224: "0", 1172: "45" } },
  { ...common, sn: LOCK, stationSn: LOCK, params: { 1131: "1" } },
  { ...common, sn: GUEST, stationSn: GUEST, memberType: 0, params: { 1131: "1" } },
  { ...common, sn: OTHER_HOUSE, stationSn: OTHER_HOUSE, houseId: "house-1", params: { 1131: "1" } },
  { ...common, sn: SHARED, stationSn: SHARED, houseId: undefined, params: { 1131: "1" } },
  { ...common, sn: LIGHT, stationSn: BASE, params: { 1131: "0" } },
  { ...common, sn: PRO, stationSn: PRO, params: { 1131: "1", 1224: "63", 1172: "99" } },
  { ...common, sn: HUB, stationSn: HUB, params: { 1140: "1", 1224: "63" } },
  { ...common, sn: BARE, stationSn: BARE, params: { 1131: "1", 1224: "63" } },
] as unknown as EufyDevice[];

const PRO_AWAY = JSON.stringify({ count_down_arm: { channel_list: [], delay_time: 60 } });

function client(stationSns: string[] | undefined, cloud: (path: string) => unknown = () => ({})) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x" });
  const posts: Array<[string, string, unknown]> = [];
  const sent: Array<[string, Command]> = [];
  const t = eufy as any;
  t.mega.post = async (service: string, path: string, body: unknown) => {
    posts.push([service, path, body]);
    const answer = cloud(path);
    if (answer instanceof Error) throw answer;
    return path.endsWith("get_home_config") ? { station_sns: stationSns } : answer;
  };
  vi.spyOn(t.registry, "list").mockReturnValue(FLEET);
  vi.spyOn(t.registry, "paramOf").mockImplementation(
    (sn: unknown, p: unknown) => FLEET.find((d) => d.sn === sn)?.params?.[p as number],
  );
  vi.spyOn(t, "commandContext").mockImplementation(async (sn: unknown) => ({
    channel: 0,
    paramIds: new Set(),
    serial: sn,
    ...(sn === PRO
      ? {
          model: "T9000",
          things: {
            properties: {
              arming_get_alarm_away_mode: { identifier: "arming_get_alarm_away_mode", defaultValue: PRO_AWAY },
            },
          },
        }
      : {}),
  }));
  t.routeAndReflect = async (sn: string, cmd: Command) => (sent.push([sn, cmd]), sn !== SOLO);
  return { eufy, posts, sent };
}

describe("setHouseMode", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("updates the cloud config, then writes the online stations it names whose mode differs", async () => {
    const c = client([BASE, SOLO, OFFLINE, SAME, "T8030P0000000099"]);
    const results = await c.eufy.setHouseMode(HOUSE, ArmingMode.away);
    expect(c.posts).toEqual([
      ["butler", "/app/butler/update_home_config", { house_id: HOUSE, arm_status: 2 }],
      ["butler", "/app/butler/get_home_config", { house_id: HOUSE }],
    ]);
    expect(c.sent.map(([sn, cmd]) => [sn, cmd.kind, (cmd as { channel: number }).channel])).toEqual([
      [BASE, "p2p-station-scalar", 255],
      [SOLO, "p2p-station-scalar", 0],
    ]);
    expect(results).toEqual([
      { sn: BASE, name: "Base", mode: "away", armDelay: 30, result: "answered" },
      { sn: SOLO, mode: "home", armDelay: 15, result: "failed" },
      { sn: OFFLINE, mode: "disarmed", armDelay: 0, result: "skipped" },
      { sn: SAME, mode: "away", armDelay: 45, result: "skipped" },
    ]);
  });

  it("reads a T9000's arm delay off its mode's thing property", async () => {
    const c = client([PRO]);
    expect(await c.eufy.setHouseMode(HOUSE, ArmingMode.away)).toEqual([
      { sn: PRO, mode: "away", armDelay: 60, result: "answered" },
    ]);
  });

  it("gives an attached T81A0 reporting offline its station's online answer", async () => {
    const c = client([LIGHT]);
    await c.eufy.setHouseMode(HOUSE, ArmingMode.away);
    expect(c.sent.map(([sn]) => sn)).toEqual([LIGHT]);
  });

  it("treats an unreported mode as home", async () => {
    const c = client([SOLO]);
    expect(await c.eufy.setHouseMode(HOUSE, ArmingMode.home)).toEqual([
      { sn: SOLO, mode: "home", armDelay: 15, result: "skipped" },
    ]);
  });

  it("falls back to the house's own stations the app arms when the config names none it knows", async () => {
    const c = client(["T8030P0000000099"]);
    await c.eufy.setHouseMode(HOUSE, ArmingMode.disarmed);
    expect(c.posts[0]?.[2]).toEqual({ house_id: HOUSE, arm_status: 3 });
    expect(c.sent.map(([sn]) => sn)).toEqual([SOLO, SAME]);
  });

  it('falls back to every listed station for house "" and the house-less ones for "shared.devices"', async () => {
    const all = client([]);
    await all.eufy.setHouseMode("", ArmingMode.disarmed);
    expect(all.sent.map(([sn]) => sn)).toEqual([SOLO, SAME, OTHER_HOUSE, SHARED]);
    const shared = client([]);
    await shared.eufy.setHouseMode("shared.devices", ArmingMode.disarmed);
    expect(shared.sent.map(([sn]) => sn)).toEqual([SHARED]);
  });

  it("gates a described station on the app's device_is_online: its 1140, offline where none is listed", async () => {
    const c = client([HUB, BARE]);
    const online = { identifier: "device_is_online", defaultValue: " false" };
    vi.spyOn((c.eufy as any).registry, "thingsOf").mockImplementation((sn: unknown) =>
      sn === HUB ? { properties: { device_is_online: online } } : sn === BARE ? { properties: {} } : undefined,
    );
    await c.eufy.setHouseMode(HOUSE, ArmingMode.away);
    expect(c.sent.map(([sn]) => sn)).toEqual([HUB]);
  });

  it("reports no result for a refusal with code 1 or a session that did not connect, as the app", async () => {
    const c = client([BASE, SOLO, PRO]);
    (c.eufy as any).routeAndReflect = async (sn: string) => {
      throw sn === BASE
        ? new CommandResultError(sn, 1224, 1, 6000)
        : sn === SOLO
          ? new StationUnreachableError(sn, 6000)
          : new CommandResultError(sn, 1224, undefined, 6000);
    };
    const results = await c.eufy.setHouseMode(HOUSE, ArmingMode.away);
    expect(results.map((r) => [r.sn, r.result])).toEqual([[PRO, "failed"]]);
  });

  it("rejects and writes no station when one fails before its write, as the app's use case", async () => {
    const c = client([BASE, SOLO]);
    const t = c.eufy as any;
    const context = t.commandContext;
    t.commandContext = async (sn: string) => ({ ...(await context(sn)), ...(sn === SOLO ? { deviceType: 104 } : {}) });
    await expect(c.eufy.setHouseMode(HOUSE, ArmingMode.away)).rejects.toThrow("user_name");
    expect(c.sent).toEqual([]);
  });

  it("sends nothing when the cloud refuses the config", async () => {
    const c = client([BASE], (path) => (path.endsWith("update_home_config") ? new Error("refused") : {}));
    await expect(c.eufy.setHouseMode(HOUSE, ArmingMode.away)).rejects.toThrow("refused");
    expect(c.posts).toHaveLength(1);
    expect(c.sent).toEqual([]);
  });
});
