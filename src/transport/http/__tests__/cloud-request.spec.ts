import { describe, expect, it, vi } from "vitest";
import { MegaHttpClient } from "../mega-client.js";

/** A settings bundle's cloud call resolved to its host as the app resolves `domain`. Synthetic. */
describe("a bundle cloud call", () => {
  const client = () => {
    const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic", region: "eu-pr" });
    const post = vi.spyOn(mega, "postSigned").mockResolvedValue({});
    return { mega, post };
  };
  const call = { method: "POST", path: "/v1/x", body: { a: 1 } };

  it("posts eufy_security to the security-app host and a cloud module to its app host", async () => {
    const { mega, post } = client();
    await mega.cloudRequest({ ...call, domain: "eufy_security" });
    await mega.cloudRequest({ ...call, domain: "DeviceManage" });
    await mega.cloudRequest({ ...call, domain: "CloudStorage" });
    await mega.cloudRequest({ ...call, domain: "Basic", headers: { h: "1" } });
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      "security-app-eu.eufylife.com",
      "app-devicemanage-eu-pr.eufy.com",
      "app-cloudstor-eu-pr.eufy.com",
      "mega-eu-pr.eufy.com",
    ]);
    expect(post.mock.calls[3]!.slice(1)).toEqual(["/v1/x", { a: 1 }, true, {}, { h: "1" }]);
    await mega.cloudRequest({ ...call, path: "v3/app/update_devs_info", domain: "eufy_security" });
    expect(post.mock.calls[4]![1], "under the host's root").toBe("/v3/app/update_devs_info");
  });

  it("throws for an unknown domain, another category and a method it does not sign", async () => {
    const { mega, post } = client();
    await expect(mega.cloudRequest({ ...call, domain: "security" })).rejects.toThrow(/no host/);
    await expect(mega.cloudRequest({ ...call, domain: "eufy_clean" })).rejects.toThrow(/no host/);
    await expect(mega.cloudRequest({ ...call, method: "GET", domain: "eufy_security" })).rejects.toThrow(/not signed/);
    expect(post).not.toHaveBeenCalled();
  });
});
