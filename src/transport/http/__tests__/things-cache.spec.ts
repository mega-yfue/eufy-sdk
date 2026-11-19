import { describe, expect, it, vi } from "vitest";

import { MemorySessionStore, type PersistedSession } from "../../../core/store.js";
import { MegaHttpClient, SessionExpiredError } from "../mega-client.js";

/** A usable stored session, synthetic throughout. */
const stored: PersistedSession = {
  userId: "synthetic-user",
  accountUserId: "synthetic-user",
  authToken: "synthetic-token",
  region: "us-pr",
  openudid: "SYNTHETIC-UDID",
  shareKey: "00".repeat(16),
  keyIdent: "00".repeat(16),
  tokenExpiresAt: 0,
  savedAt: 0,
};

const description = (code: string, properties: unknown[] = [{ identifier: "camera_on_off" }]) => ({
  profile: { product_code: code },
  properties,
});

/** A client on `store` whose things call answers as `post` does. */
function client(store: MemorySessionStore, post: () => Promise<unknown>) {
  const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic", store });
  (mega as unknown as { post: typeof post }).post = vi.fn(post);
  return mega;
}

describe("the last thing description of each product", () => {
  it("answers a failed get_things_list from the descriptions the session last stored", async () => {
    const store = new MemorySessionStore();
    store.save(stored);
    await client(store, async () => ({ things_list: [description("T8410"), description("T8114")] })).getThingsList([
      "T8410",
      "T8114",
    ]);
    await client(store, async () => ({ things_list: [description("T8114", [])] })).getThingsList(["T8114"]);

    const offline = client(store, () => Promise.reject(new Error("unreachable")));
    expect(await offline.getThingsList(["T8410", "T8114"])).toEqual({
      things_list: [description("T8410"), description("T8114")],
    });
    await expect(offline.getThingsList(["T8162"]), "no stored description").rejects.toThrow("unreachable");
    const expired = client(store, () => Promise.reject(new SessionExpiredError("expired")));
    await expect(expired.getThingsList(["T8410"])).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
