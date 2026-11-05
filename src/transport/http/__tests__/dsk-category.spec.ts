import { describe, expect, it, vi } from "vitest";
import { MegaHttpClient } from "../mega-client.js";

const SECURITY_SN = "T8030P0000000000";
const CARE_CAMERA_SN = "T8360P0000000001";
const CARE_BASE_SN = "T8351P0000000002";

function client() {
  const mega = new MegaHttpClient({
    email: "synthetic@example.invalid",
    password: "synthetic",
    region: "us-pr",
  });
  const post = vi.spyOn(mega, "post").mockResolvedValue({ device_dsks: [] });
  return { mega, post };
}

describe("per-station DSK categories", () => {
  it("preserves Security and Care categories in the same lookup and rotation body", async () => {
    const { mega, post } = client();
    const securityKey = "0".repeat(32);
    const careKey = "1".repeat(32);
    post.mockResolvedValue({
      device_dsks: [
        { device_sn: SECURITY_SN, dsk_key: securityKey, expiration: 1700000000 },
        { device_sn: CARE_CAMERA_SN, dsk_key: careKey, expiration: 1700000010 },
      ],
    });

    const keys = await mega.getDskKeys(
      [
        { sn: SECURITY_SN, category: "eufy_security" },
        { sn: CARE_CAMERA_SN, category: "eufy_care" },
        { sn: CARE_BASE_SN, category: "eufy_care" },
      ],
      { [SECURITY_SN]: "2".repeat(32), [CARE_CAMERA_SN]: "3".repeat(32) },
    );

    expect(post).toHaveBeenCalledExactlyOnceWith("devicerelation", "/app/devicerelation/get_dsk_keys", {
      device_dsks: [
        { invalid_dsk: "2".repeat(32), device_sn: SECURITY_SN, category: "eufy_security" },
        { invalid_dsk: "3".repeat(32), device_sn: CARE_CAMERA_SN, category: "eufy_care" },
        { invalid_dsk: "", device_sn: CARE_BASE_SN, category: "eufy_care" },
      ],
      invalid_dsks: {
        [SECURITY_SN]: "2".repeat(32),
        [CARE_CAMERA_SN]: "3".repeat(32),
        [CARE_BASE_SN]: "",
      },
      station_sns: [SECURITY_SN, CARE_CAMERA_SN, CARE_BASE_SN],
    });
    expect(keys).toEqual({
      [SECURITY_SN]: { dskKey: securityKey, expiration: 1700000000 },
      [CARE_CAMERA_SN]: { dskKey: careKey, expiration: 1700000010 },
    });
  });

  it("preserves the Security category for a station whose record has no category", async () => {
    const { mega, post } = client();

    await mega.getDskKeys([{ sn: SECURITY_SN, category: "" }]);

    expect(post).toHaveBeenCalledExactlyOnceWith("devicerelation", "/app/devicerelation/get_dsk_keys", {
      device_dsks: [{ invalid_dsk: "", device_sn: SECURITY_SN, category: "eufy_security" }],
      invalid_dsks: { [SECURITY_SN]: "" },
      station_sns: [SECURITY_SN],
    });
  });
});
