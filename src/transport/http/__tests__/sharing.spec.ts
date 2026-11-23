import { describe, expect, it, vi } from "vitest";
import { MegaHttpClient } from "../mega-client.js";

const SN = "T8410P0000000000";
const STATION = "T8010P0000000000";
const ref = { invite_id: 7, device_sn: SN, sub_sns: "", category: "eufy_security", owner_user_id: "owner-0" };
const STAMP = expect.stringMatching(/^\d+$/);

function client() {
  const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic", region: "us-pr" });
  return { mega, post: vi.spyOn(mega, "post").mockResolvedValue({}) };
}
const lastBody = (post: ReturnType<typeof client>["post"]) => post.mock.lastCall![2] as Record<string, unknown>;

describe("MegaHttpClient sharing calls", () => {
  it("invites by email with the app's defaults, forcing admin on eufy_pet, and seals a share code on security", async () => {
    const { mega, post } = client();
    post.mockResolvedValueOnce({ email_sent: true });
    const sent = await mega.inviteShare("guest@example.invalid", "Guest", [
      { device_sn: SN, category: "eufy_security", member_type: 0, device_name: "Cam" },
      { device_sn: "PET0000000000000", category: "eufy_pet", member_type: 0 },
    ]);
    expect(sent.emailSent).toBe(true);
    expect(sent.authCode).toMatch(/^[1-9]\d{5}$/);
    const body = lastBody(post) as { invites: Array<{ encrypted_data: string }> };
    const sealed = body.invites[0]!.encrypted_data;
    expect(Buffer.from(sealed, "base64").length).toBeGreaterThan(44);
    expect(post).toHaveBeenCalledWith("devicerelation", "/app/devicerelation/device_invite", {
      transaction: "",
      email: "guest@example.invalid",
      nick_name: "Guest",
      invites: [
        {
          permissions: 0,
          encrypted_data: sealed,
          sub_sns: "",
          device_sn: SN,
          category: "eufy_security",
          member_type: 0,
          device_name: "Cam",
        },
        {
          permissions: 0,
          encrypted_data: sealed,
          sub_sns: "",
          device_sn: "PET0000000000000",
          category: "eufy_pet",
          member_type: 1,
        },
      ],
    });

    // The invitee side: the code opens the invite, anything else is refused before the cloud is asked.
    post.mockClear();
    await expect(mega.confirmShareInvites([{ ...ref, encrypted_data: sealed }], "000000")).rejects.toThrow(
      /share code/,
    );
    await expect(mega.confirmShareInvites([{ ...ref, encrypted_data: sealed }])).rejects.toThrow(/share code/);
    expect(post).not.toHaveBeenCalled();
    await mega.confirmShareInvites([{ ...ref, encrypted_data: sealed }], sent.authCode);
    expect(post).toHaveBeenLastCalledWith("devicerelation", "/app/devicerelation/confirm_invite", {
      transaction: STAMP,
      invites: [ref],
    });
  });

  it("seals nothing when no invite is eufy_security", async () => {
    const { mega, post } = client();
    expect(
      await mega.inviteShare("g@example.invalid", "G", [{ device_sn: "PET0", category: "eufy_pet", member_type: 1 }]),
    ).toEqual({
      emailSent: false,
    });
    expect((lastBody(post).invites as Array<{ encrypted_data: string }>)[0]!.encrypted_data).toBe("");
  });

  it("reads the invitee's app version as the app does, current on silence", async () => {
    const { mega, post } = client();
    post.mockResolvedValueOnce({ app_version: "v6.0.29_123" });
    expect(await mega.inviteeAppOutdated("g@example.invalid")).toBe(true);
    expect(post).toHaveBeenLastCalledWith("passport", "/passport/get_latest_app_version_by_email", {
      email: "g@example.invalid",
    });
    post.mockResolvedValueOnce({ app_version: "6.1.32" });
    expect(await mega.inviteeAppOutdated("g@example.invalid")).toBe(false);
    post.mockResolvedValueOnce({ app_version: "", os_app_version_map: { android: "5.9.1" } });
    expect(await mega.inviteeAppOutdated("g@example.invalid")).toBe(true);
    post.mockRejectedValueOnce(new Error("down"));
    expect(await mega.inviteeAppOutdated("g@example.invalid")).toBe(false);
  });

  it("lists members and invites, sending is_inviter as the inverse of own", async () => {
    const { mega, post } = client();
    post.mockResolvedValueOnce({ relateds: [{ member_user_id: "m-0" }] });
    expect(await mega.getShareMembers()).toEqual([{ member_user_id: "m-0" }]);
    expect(post).toHaveBeenLastCalledWith("devicerelation", "/app/devicerelation/get_related", {
      transaction: "",
      num: 300,
      page: 0,
      orderby: "",
      categories: [],
      add_pns: [],
    });
    post.mockResolvedValueOnce({ invites: [{ id: 7 }] });
    expect(await mega.getShareInvites(false)).toEqual([{ id: 7 }]);
    expect(post).toHaveBeenLastCalledWith("devicerelation", "/app/devicerelation/get_invites", {
      transaction: STAMP,
      is_inviter: 1,
      categories: [],
      add_pns: [],
    });
    expect(await mega.getShareInvites(true)).toEqual([]);
    expect(post).toHaveBeenLastCalledWith("devicerelation", "/app/devicerelation/get_invites", {
      transaction: "",
      is_inviter: 0,
      categories: [],
      add_pns: [],
    });
  });

  it("confirms, ignores, updates, promotes and leaves on devicerelation", async () => {
    const { mega, post } = client();
    await mega.confirmShareInvites([ref]);
    expect(lastBody(post)).toEqual({ invites: [ref] });
    await mega.ignoreShareInvites([ref], false);
    expect(lastBody(post)).toEqual({ invites: [ref], is_inviter: 1 });
    await mega.ignoreShareInvites([{ ...ref, encrypted_data: "sealed" }], false);
    expect(lastBody(post)).toEqual({ transaction: STAMP, invites: [ref], is_inviter: 1 });
    await mega.ignoreShareInvites([{ ...ref, recevicer_user_id: "m-0" }], true);
    expect(post).toHaveBeenLastCalledWith("devicerelation", "/app/devicerelation/ignore_invite", {
      transaction: "",
      invites: [{ ...ref, recevicer_user_id: "m-0" }],
      is_inviter: 0,
    });
    await mega.updateShare({ user_id: "m-0", nick_name: "Guest", receive_email: "guest@example.invalid" }, [
      { device_sn: SN, category: "eufy_security", member_type: 0, is_delete: true },
    ]);
    expect(post).toHaveBeenLastCalledWith("devicerelation", "/app/devicerelation/update_share", {
      transaction: "",
      user_id: "m-0",
      nick_name: "Guest",
      receive_email: "guest@example.invalid",
      devices: [
        { permissions: 0, is_delete: true, sub_devices: [], device_sn: SN, category: "eufy_security", member_type: 0 },
      ],
    });
    await mega.promoteGuest("m-0", [{ device_sn: SN, category: "eufy_security" }]);
    expect(post).toHaveBeenLastCalledWith("devicerelation", "/app/devicerelation/promote_guest", {
      transaction: "",
      device_sn: "",
      user_id: "m-0",
      promote_devices: [{ device_sn: SN, category: "eufy_security" }],
    });
    const leave = { device_sn: STATION, sub_sns: SN, category: "eufy_security", owner_user_id: "owner-0" };
    await mega.clearShare(leave);
    expect(post).toHaveBeenLastCalledWith("devicerelation", "/app/devicerelation/clear_share", {
      transaction: STAMP,
      ...leave,
    });
  });

  it("speaks the home-sharing calls on the house service", async () => {
    const { mega, post } = client();
    const cat = { categories: [], add_pns: [] };
    const code = await mega.inviteHouseMember("house-0", "guest@example.invalid");
    expect(code).toMatch(/^[1-9]\d{5}$/);
    const sealed = lastBody(post).encrypted_data as string;
    expect(post).toHaveBeenLastCalledWith("house", "/app/house/invite_house_member", {
      transaction: STAMP,
      house_id: "house-0",
      email: "guest@example.invalid",
      encrypted_data: expect.stringMatching(/^[A-Za-z0-9+/]{40,}={0,2}$/),
      ...cat,
    });
    post.mockResolvedValueOnce({ house_invite_records: [{ id: 3 }] });
    expect(await mega.getHouseInvites()).toEqual([{ id: 3 }]);
    expect(post).toHaveBeenLastCalledWith("house", "/app/house/get_house_invite_records", {
      transaction: expect.stringMatching(/^transaction_\d+$/),
      is_inviter: 1,
    });
    post.mockClear();
    await expect(
      mega.confirmHouseInvite({ house_id: "house-0", id: 3, encrypted_data: sealed }, "000000"),
    ).rejects.toThrow(/share code/);
    expect(post).not.toHaveBeenCalled();
    await mega.confirmHouseInvite({ house_id: "house-0", id: 3, encrypted_data: sealed }, code);
    expect(post).toHaveBeenLastCalledWith("house", "/app/house/confirm_house_invited", {
      transaction: STAMP,
      house_id: "house-0",
      is_inviter: 1,
      invite_id: 3,
      ...cat,
    });
    await mega.ignoreHouseInvite("house-0", 3, false);
    expect(lastBody(post)).toEqual({ transaction: STAMP, house_id: "house-0", is_inviter: 1, invite_id: 3, ...cat });
    await mega.ignoreHouseInvite("house-0", 3, true);
    expect(post).toHaveBeenLastCalledWith("house", "/app/house/ignore_house_invited", {
      transaction: "transaction_id",
      house_id: "house-0",
      is_inviter: 0,
      invite_id: 3,
      ...cat,
    });
    await mega.removeHouseUser("house-0", "m-0");
    expect(post).toHaveBeenLastCalledWith("house", "/app/house/remove_house_user", {
      transaction: "transaction_id",
      house_id: "house-0",
      user_id: "m-0",
      ...cat,
    });
    await mega.leaveHouse("house-0");
    expect(post).toHaveBeenLastCalledWith("house", "/app/house/clear_share_member", {
      transaction: expect.stringMatching(/^transaction_\d+$/),
      house_id: "house-0",
      ...cat,
    });
  });
});
