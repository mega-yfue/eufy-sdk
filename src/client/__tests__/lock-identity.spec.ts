import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "../../core/contracts.js";
import { EufyMega } from "../eufy-mega.js";

const HUB = "T8030P0000000000";
const OWNER = "0000000000000000000000000000000000000000";
const ME = "2222222222222222222222222222222222222222";

afterEach(() => vi.restoreAllMocks());

/**
 * A lock shared to the signed-in user by `OWNER`, its `member_user_id` someone else: `AnkerAccountManager.e` gives
 * the user's own id there, while the app's lock commands quote the record's `admin_user_id` as stated.
 */
async function sent(sn: string, model: string, deviceType: number): Promise<Command> {
  const client = new EufyMega({ email: "test@example.com", password: "x", autoRealtime: false });
  const internal = client as any;
  Object.defineProperty(internal.mega, "auth", { get: () => ({ userId: ME }) });
  const record = { deviceType, model, parentSn: HUB, params: {}, paramUpdatedAt: {} };
  internal.registry.devices = [
    {
      sn,
      model,
      stationSn: HUB,
      channel: 3,
      p2pDid: "XXXXXXX-000000-XXXXX",
      params: {},
      category: "eufy_security",
      raw: {
        device_type: deviceType,
        parent_sn: HUB,
        device_channel: 3,
        member: { admin_user_id: OWNER, member_user_id: "someone-else", short_user_id: "0002" },
      },
    },
    { sn: HUB, model: "T8030", raw: { device_type: 18, member: { admin_user_id: OWNER } } },
  ];
  vi.spyOn(internal.registry, "record").mockResolvedValue(record);
  const dispatch = vi.spyOn(internal.p2p, "dispatchCommand").mockResolvedValue(undefined);
  const dev = await client.getDevice(sn);
  await dev.lock!()!.lock!();
  return dispatch.mock.calls[0]![1] as Command;
}

describe("a lock command's member id", () => {
  it("quotes the record's admin_user_id in the classic Wi-Fi lock's keyed payload", async () => {
    expect(await sent("T8520P2000000000", "T8520", 51)).toMatchObject({
      kind: "keyed-payload-actuate",
      adminUserId: OWNER,
    });
  });

  it("quotes it as the video lock's userId (ESLAnkerP2PService, plain 1961)", async () => {
    expect(await sent("T8530P0000000000", "T8530", 55)).toMatchObject({
      kind: "set-payload",
      cmd: 1961,
      payload: { userId: OWNER },
    });
  });

  it("keys an ff09 frame with it, as the bundle's user_id and esiotkit's getAesKey read it", async () => {
    expect(await sent("T8520P0000000000", "T8520", 51)).toMatchObject({ kind: "ff09-actuate", adminUserId: OWNER });
  });
});
