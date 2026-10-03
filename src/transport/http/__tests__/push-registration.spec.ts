import { describe, expect, it, vi } from "vitest";

import { MegaHttpClient } from "../mega-client.js";

describe("MegaHttpClient push registration", () => {
  it("registers the same FCM token with Mega and Security, then checks Security push", async () => {
    const mega = new MegaHttpClient({
      email: "synthetic@example.invalid",
      password: "synthetic",
      countryCode: "US",
      region: "us-pr",
    });

    const internals = mega as unknown as {
      post: (service: string, path: string, body: unknown) => Promise<unknown>;
      securityAppPost: (path: string, body: Record<string, unknown>) => Promise<unknown>;
    };

    const post = vi.fn(async () => undefined);
    const securityAppPost = vi.fn(async () => undefined);

    internals.post = post;
    internals.securityAppPost = securityAppPost;

    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);

    await mega.registerPushToken("synthetic-fcm-token");

    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith("push", "/app/push/register_push_token", {
      is_notification_enable: true,
      token: "synthetic-fcm-token",
      voip_token: "",
    });

    expect(securityAppPost).toHaveBeenCalledTimes(2);
    expect(securityAppPost).toHaveBeenNthCalledWith(1, "/v1/apppush/register_push_token", {
      is_notification_enable: true,
      token: "synthetic-fcm-token",
      transaction: "1700000000000",
    });
    expect(securityAppPost).toHaveBeenNthCalledWith(2, "/v1/app/review/app_push_check", {
      app_type: "eufySecurity",
      transaction: "1700000000000",
    });

    expect(post.mock.invocationCallOrder[0]).toBeLessThan(securityAppPost.mock.invocationCallOrder[0]!);
  });
});
