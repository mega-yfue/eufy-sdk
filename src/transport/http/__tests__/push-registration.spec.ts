import { describe, expect, it, vi } from "vitest";

import { MegaHttpClient } from "../mega-client.js";

describe("MegaHttpClient push registration", () => {
  it("registers the FCM token once, on the app's push endpoint", async () => {
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

    await mega.registerPushToken("synthetic-fcm-token");

    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith("push", "/app/push/register_push_token", {
      is_notification_enable: true,
      token: "synthetic-fcm-token",
      voip_token: "",
    });
    expect(securityAppPost).not.toHaveBeenCalled();
  });
});
