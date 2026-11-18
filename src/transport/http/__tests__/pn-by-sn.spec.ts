import { describe, expect, it, vi } from "vitest";
import { MegaHttpClient } from "../mega-client.js";

describe("MegaHttpClient.getPnBySn", () => {
  it("posts the serial to things' get_pn_by_sn and answers its pn, or empty when the reply has none", async () => {
    const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic", region: "us-pr" });
    const post = vi.spyOn(mega, "post").mockResolvedValueOnce({ pn: "T85D0", device_sn: "T85D0K0000000000" });
    expect(await mega.getPnBySn("T85D0K0000000000")).toBe("T85D0");
    expect(post).toHaveBeenCalledWith("things", "/app/things/get_pn_by_sn", { device_sn: "T85D0K0000000000" });
    post.mockResolvedValueOnce({});
    expect(await mega.getPnBySn("T85D0K0000000000")).toBe("");
  });
});
