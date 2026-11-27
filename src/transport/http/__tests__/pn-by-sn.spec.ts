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

describe("a signed call naming a device", () => {
  it("carries the device's category as Category and app-tab when it sends none", async () => {
    const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic", region: "us-pr" });
    const internals = mega as unknown as Record<string, unknown>;
    internals.ensureSessionKey = async () => ({ shareKey: "00".repeat(32), keyIdent: "k" });
    const sent: Record<string, string>[] = [];
    internals.httpPost = vi.fn(async (_u: string, _b: unknown, headers: Record<string, string>) => {
      sent.push(headers);
      return { status: 200, data: { code: 0, data: {} } };
    });
    mega.categoryOf = (sn) => (sn === "T8170P0000000000" ? "eufy_security" : undefined);
    await mega.postSigned("app-things-us-pr.eufy.com", "/app/things/get_pn_by_sn", { device_sn: "T8170P0000000000" });
    await mega.postSigned(
      "app-x-us-pr.eufy.com",
      "/x",
      { station_sn: ["T8170P0000000000"] },
      true,
      {},
      { category: "eufy_home" },
    );
    await mega.postSigned("app-x-us-pr.eufy.com", "/x", { device_sn: "T8000P0000000000" });
    expect(sent.map((h) => [h.category, h["app-tab"]])).toEqual([
      ["eufy_security", "eufy_security"],
      ["eufy_home", "eufy_home"],
      [undefined, undefined],
    ]);
  });
});
