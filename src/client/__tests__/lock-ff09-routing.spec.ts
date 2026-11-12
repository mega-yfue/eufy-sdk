import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command, Ff09SettingsReader } from "../../core/contracts.js";
import type { EufyDevice } from "../../core/types.js";
import type { CommandContext } from "../../model/capabilities/types.js";
import { DeviceType } from "../../model/device-types.js";
import { EufyMega } from "../eufy-mega.js";

const STANDALONE = "T85V0K0000000000";
const ATTACHED = "T85V0K0000000001";
const HUB = "T8010P0000000000";
const ADMIN = "0000000000000000000000000000000000000000";

afterEach(() => vi.restoreAllMocks());

describe("T85V0 ff09 routing", () => {
  it("sends a standalone T85V0's lock frames and auto-lock read over secure MQTT, an attached one's over P2P", async () => {
    const client = new EufyMega({
      email: "test@example.com",
      password: "synthetic",
      autoRealtime: false,
      pollMs: 0,
      storedSnapshotCache: false,
    });
    const internals = client as unknown as {
      registry: { devices: EufyDevice[] };
      mqtt: {
        dispatchCommand(sn: string, cmd: Command): Promise<void>;
        getAutoLockState(sn: string, cmd: unknown): Promise<unknown>;
      };
      p2p: {
        dispatchCommand(sn: string, cmd: Command): Promise<void>;
        getAutoLockState(sn: string, cmd: unknown): Promise<unknown>;
      };
      routeCommand(sn: string, cmd: Command): Promise<void>;
      ff09SettingsReaderFor(sn: string, ctx: CommandContext): Ff09SettingsReader | undefined;
    };
    const raw = { device_type: DeviceType.LOCK_85V0 };
    internals.registry.devices = [
      { sn: STANDALONE, model: "T85V0", api: "mega", p2pDid: "XXXXXXX-000000-XXXXX", stationSn: STANDALONE, raw },
      { sn: ATTACHED, model: "T85V0", api: "mega", p2pDid: "XXXXXXX-000001-XXXXX", stationSn: HUB, raw },
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
    await internals.ff09SettingsReaderFor(STANDALONE, ctx(STANDALONE))!.getAutoLockState();
    expect(mqtt).toHaveBeenCalledExactlyOnceWith(STANDALONE, unlock(STANDALONE));
    expect(mqttRead).toHaveBeenCalledExactlyOnceWith(STANDALONE, { adminUserId: ADMIN, deviceSn: STANDALONE });

    await internals.routeCommand(ATTACHED, unlock(ATTACHED));
    await internals.ff09SettingsReaderFor(ATTACHED, ctx(ATTACHED))!.getAutoLockState();
    expect(p2p).toHaveBeenCalledExactlyOnceWith(ATTACHED, unlock(ATTACHED));
    expect(p2pRead).toHaveBeenCalledExactlyOnceWith(ATTACHED, { adminUserId: ADMIN, deviceSn: ATTACHED });
  });
});
