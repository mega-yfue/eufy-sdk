import { describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { Device } from "../../model/device.js";
import { PushClient } from "../../transport/push/push-client.js";

const SN = "T85L0P0000000000";
const record = { model: "T85L0", category: "eufy_security", params: { 6000: "4" }, paramUpdatedAt: {} };

/**
 * A lock unlocked and auto-relocked between two poll passes: the cloud announces the unlock by push and
 * sends nothing for the relock, so both passes read param 6000 = 4. The push has to land 6000 = 3, on
 * the device and on the poll baseline, for the second pass to see the relock.
 */
describe("a lock push followed by an unannounced relock", () => {
  it("lands the unlock from the push and announces the relock on the next poll pass", async () => {
    const eufy = new EufyMega({
      email: "user@example.invalid",
      password: "unused",
      autoRealtime: false,
      pushStore: {
        load: () => ({
          creds: { fid: "f", androidId: "0", securityToken: "0", fcmToken: "t", createdAt: 0 },
          persistentIds: [],
        }),
        save: () => {},
        clear: () => {},
      },
    });
    const internal = eufy as any;
    Object.defineProperty(internal.mega, "auth", { configurable: true, get: () => ({ userId: "u", authToken: "t" }) });
    vi.spyOn(internal.mega, "registerPushToken").mockResolvedValue(undefined);
    vi.spyOn(PushClient.prototype, "connect").mockImplementation(function (this: PushClient) {
      this.emit("connect");
    });
    const cloud = [{ sn: SN, model: "T85L0", category: "eufy_security", params: { 6000: "4" } }];
    internal.registry.devices = structuredClone(cloud);
    vi.spyOn(internal.registry, "getDevices").mockImplementation(async () => structuredClone(cloud));
    vi.spyOn(internal.registry, "record").mockResolvedValue(record);
    vi.spyOn(internal, "widenCapabilities").mockResolvedValue(undefined);
    vi.spyOn(internal, "syncMqttRoster").mockResolvedValue(undefined);
    vi.spyOn(internal, "readTuyaDevices").mockResolvedValue(undefined);
    const dev = Device.fromRecord(SN, record);
    internal.liveDevices.set(SN, new WeakRef(dev));
    const seen: unknown[] = [];
    eufy.on("propertyChanged", (e) => seen.push(e));

    await internal.pollOnce();
    const client: PushClient = await internal.startPush();
    client.emit("push", { deviceSn: SN, eventType: 260, payload: {} });
    expect(dev.getProperty("locked")?.value).toBe(false);
    await internal.pollOnce();

    expect(dev.getProperty("locked")?.value).toBe(true);
    expect(seen).toEqual([
      { deviceSn: SN, property: "locked", value: false },
      { deviceSn: SN, property: "locked", value: true },
    ]);
  });
});
