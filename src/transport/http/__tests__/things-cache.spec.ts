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

describe("the get_things_list request", () => {
  it("is the app's GetThingListRequest with its defaults, asking for a gzipped reply", async () => {
    const store = new MemorySessionStore();
    const mega = client(store, async () => ({ things_list: [] }));
    await mega.getThingsList(["T8410"], { T8410: 7 });
    expect((mega as unknown as { post: ReturnType<typeof vi.fn> }).post).toHaveBeenCalledWith(
      "things",
      "/app/things/get_things_list",
      {
        product_codes: ["T8410"],
        code_time_map: { T8410: 7 },
        rn_bundle_version: "9.9.9.9",
        use_network_version: true,
      },
      { "x-accept-encoding": "gzip" },
    );
  });
});

describe("a several-product get_things_list that times out", () => {
  it("is asked again one product at a time, and stays that way", async () => {
    const asked: string[][] = [];
    const mega = client(new MemorySessionStore(), async () => ({}));
    (mega as unknown as { post: unknown }).post = vi.fn(
      async (_s: string, _p: string, body: { product_codes: string[] }) => {
        asked.push(body.product_codes);
        if (body.product_codes.length > 1)
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        if (body.product_codes[0] === "T8114") throw new Error("unreachable");
        return { things_list: [description(body.product_codes[0]!)] };
      },
    );
    expect(await mega.getThingsList(["T8410", "T8114", "T8162"])).toEqual({
      things_list: [description("T8410"), description("T8162")],
    });
    expect(asked).toEqual([["T8410", "T8114", "T8162"], ["T8410"], ["T8114"], ["T8162"]]);
    await mega.getThingsList(["T8410", "T8162"]);
    expect(asked.slice(4)).toEqual([["T8410"], ["T8162"]]);
  });
});

describe("the RTC signalling login of each station", () => {
  it("persists with the session and comes back on the next run", () => {
    const store = new MemorySessionStore();
    store.save(stored);
    const token = { aes: "A".repeat(16), contactId: "synthetic-contact", addr: "192.0.2.1", authTimestamp: 1 };
    client(store, async () => ({})).saveRtcToken("T9000P0000000000", token);
    expect(store.load()?.rtc).toEqual({ T9000P0000000000: token });
    expect(client(store, async () => ({})).rtcToken("T9000P0000000000")).toEqual(token);
  });
});
