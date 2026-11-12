import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command, DeviceUserDirectory, Ff09SettingsReader } from "../../core/contracts.js";
import type { EufyDevice } from "../../core/types.js";
import type { CommandContext } from "../../model/capabilities/types.js";
import { DeviceType } from "../../model/device-types.js";
import { EufyMega } from "../eufy-mega.js";

const STANDALONE = "T85V0K0000000000";
const ATTACHED = "T85V0K0000000001";
const S330 = "T8531K0000000000";
const HUB = "T8010P0000000000";
const ADMIN = "0000000000000000000000000000000000000000";

afterEach(() => vi.restoreAllMocks());

const newClient = () =>
  new EufyMega({
    email: "test@example.com",
    password: "synthetic",
    autoRealtime: false,
    pollMs: 0,
    storedSnapshotCache: false,
  });

describe("video lock ff09 routing", () => {
  it("sends a standalone video lock's lock frames and auto-lock read over secure MQTT, an attached one's over P2P", async () => {
    const internals = newClient() as unknown as {
      registry: { devices: EufyDevice[] };
      mqtt: {
        dispatchCommand(sn: string, cmd: Command): Promise<void>;
        getAutoLockState(sn: string, cmd: unknown): Promise<unknown>;
        exchangeFf09(sn: string, req: unknown): Promise<unknown>;
      };
      p2p: {
        dispatchCommand(sn: string, cmd: Command): Promise<void>;
        getAutoLockState(sn: string, cmd: unknown): Promise<unknown>;
      };
      routeCommand(sn: string, cmd: Command): Promise<void>;
      ff09SettingsReaderFor(sn: string, ctx: CommandContext): Ff09SettingsReader | undefined;
    };
    const raw = (parent_sn: string, device_type: number = DeviceType.LOCK_85V0) => ({ device_type, parent_sn });
    internals.registry.devices = [
      { sn: STANDALONE, model: "T85V0", api: "mega", p2pDid: "XXXXXXX-000000-XXXXX", raw: raw(STANDALONE) },
      { sn: ATTACHED, model: "T85V0", api: "mega", p2pDid: "XXXXXXX-000001-XXXXX", raw: raw(HUB) },
      { sn: S330, model: "T8531", api: "mega", p2pDid: "XXXXXXX-000002-XXXXX", raw: raw(S330, DeviceType.LOCK_8530) },
    ] as EufyDevice[];
    const mqtt = vi.spyOn(internals.mqtt, "dispatchCommand").mockResolvedValue();
    const p2p = vi.spyOn(internals.p2p, "dispatchCommand").mockResolvedValue();
    const mqttRead = vi.spyOn(internals.mqtt, "getAutoLockState").mockResolvedValue({});
    const p2pRead = vi.spyOn(internals.p2p, "getAutoLockState").mockResolvedValue({});
    const unlock = (deviceSn: string): Command => ({
      kind: "ff09-actuate",
      engage: false,
      adminUserId: ADMIN,
      username: "someone+tag",
      shortUserId: "0000",
      deviceSn,
    });
    const ctx = (serial: string): CommandContext => ({
      channel: 0,
      serial,
      paramIds: new Set(),
      adminUserId: ADMIN,
      hasP2p: true,
    });

    await internals.routeCommand(STANDALONE, unlock(STANDALONE));
    await internals.routeCommand(S330, unlock(S330));
    await internals.ff09SettingsReaderFor(STANDALONE, ctx(STANDALONE))!.getAutoLockState();
    expect(mqtt.mock.calls).toEqual([
      [STANDALONE, unlock(STANDALONE)],
      [S330, unlock(S330)],
    ]);
    expect(mqttRead).toHaveBeenCalledExactlyOnceWith(STANDALONE, { adminUserId: ADMIN, deviceSn: STANDALONE });

    await internals.routeCommand(ATTACHED, unlock(ATTACHED));
    await internals.ff09SettingsReaderFor(ATTACHED, ctx(ATTACHED))!.getAutoLockState();
    expect(p2p).toHaveBeenCalledExactlyOnceWith(ATTACHED, unlock(ATTACHED));
    expect(p2pRead).toHaveBeenCalledExactlyOnceWith(ATTACHED, { adminUserId: ADMIN, deviceSn: ATTACHED });

    const exchange = vi.spyOn(internals.mqtt, "exchangeFf09").mockResolvedValue({ status: 0, fields: new Map() });
    await internals.ff09SettingsReaderFor(STANDALONE, ctx(STANDALONE))!.exchange!(0x24, 6012, []);
    expect(exchange).toHaveBeenCalledExactlyOnceWith(STANDALONE, {
      adminUserId: ADMIN,
      deviceSn: STANDALONE,
      commandCode: 0x24,
      apiCommand: 6012,
      fields: [],
    });
    expect("exchange" in internals.ff09SettingsReaderFor(ATTACHED, ctx(ATTACHED))!).toBe(false);
  });
});

describe("lock local users", () => {
  it("keeps a device's local users under its serial and its parent station's, empty when it has none", async () => {
    const internals = newClient() as unknown as {
      mega: { securityAppPost(path: string, body: unknown): Promise<unknown> };
      deviceUsersFor(sn: string, ctx: CommandContext): DeviceUserDirectory;
    };
    const post = vi.spyOn(internals.mega, "securityAppPost").mockResolvedValue({ short_user_id: "0007" });
    const own = internals.deviceUsersFor(STANDALONE, { channel: 0, paramIds: new Set() });

    await expect(own.addUser("Guest")).resolves.toBe("0007");
    await own.savePassword("0007", "000C", "{}");
    await internals.deviceUsersFor(ATTACHED, { channel: 0, paramIds: new Set(), stationSerial: HUB }).addUser("Guest");
    expect(post.mock.calls).toEqual([
      ["/v3/app/device/local_user/add", { device_sn: STANDALONE, nick_name: "Guest", station_sn: "" }],
      [
        "/v3/app/device/password/save_or_update",
        {
          device_sn: STANDALONE,
          short_user_id: "0007",
          station_sn: "",
          password_list: [{ password_id: "000C", password_type: 1, schedule: "{}" }],
        },
      ],
      ["/v3/app/device/local_user/add", { device_sn: ATTACHED, nick_name: "Guest", station_sn: HUB }],
    ]);
  });
});
