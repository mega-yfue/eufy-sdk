import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchStoredMaps, signMapRead } from "../map-storage.js";
import type { TuyaClient } from "../client.js";

const credentials = {
  ak: "example",
  sk: "synthetic-secret",
  bucket: "bucket",
  endpoint: "storage.example.com",
  region: "storage.example.com",
  token: "synthetic-token",
};
afterEach(() => vi.unstubAllGlobals());
function client(results: unknown[]) {
  const call = vi.fn();
  for (const result of results) call.mockResolvedValueOnce(result);
  return { call } as unknown as Pick<TuyaClient, "call">;
}
describe("Tuya stored-map download", () => {
  it("uses a deterministic signed HTTPS GET", () => {
    const url = new URL(signMapRead(credentials, "/folder/a b", new Date("2025-01-01T00:00:00Z")));
    expect(url.origin).toBe("https://bucket.storage.example.com");
    expect(url.pathname).toBe("/folder/a%20b");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20250101T000000Z");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/);
  });
  it("returns no maps without requesting storage credentials for an empty listing", async () => {
    const c = client([{ success: true, result: { datas: [], totalCount: 0 } }]);
    expect(await fetchStoredMaps(c, "synthetic-device")).toEqual([]);
    expect(c.call).toHaveBeenCalledTimes(1);
  });
  it("downloads the display map instead of its record copy", async () => {
    const c = client([
      { success: true, result: { datas: [{ file: "/1-map_42,/1-show_map_42", fileName: "Floor A" }], totalCount: 1 } },
      { success: true, result: credentials },
    ]);
    const get = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    vi.stubGlobal("fetch", get);
    expect(await fetchStoredMaps(c, "synthetic-device")).toEqual([{ name: "Floor A", data: Buffer.from([1, 2, 3]) }]);
    expect(new URL(get.mock.calls[0]![0]).pathname).toBe("/1-show_map_42");
  });
  it("propagates API rejection", async () => {
    await expect(
      fetchStoredMaps(client([{ success: false, errorCode: "DENIED" }]), "synthetic-device"),
    ).rejects.toThrow("DENIED");
  });
  it("rejects failed downloads", async () => {
    const c = client([
      { success: true, result: { datas: [{ file: "/1-map_42" }], totalCount: 1 } },
      { success: true, result: credentials },
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    await expect(fetchStoredMaps(c, "synthetic-device")).rejects.toThrow("HTTP 403");
  });
});
