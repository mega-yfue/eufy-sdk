import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import { encryptBody, signRequest } from "../../../core/crypto.js";
import { MegaApiError, MegaHttpClient } from "../mega-client.js";

/**
 * How an encrypted reply is read, as the app's `NetworkDecryptResponseUtil` reads it: the envelope `signature`
 * checked against the reply's `X-Request-Ts` / `X-Request-Once` and `data`, then decrypted and gunzipped when
 * gzipped. Synthetic key and payload.
 */
const SHARE_KEY = "11".repeat(32);

function client(reply: (body: Buffer) => { data: string; signature?: string }) {
  const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic", region: "us-pr" });
  const internals = mega as unknown as Record<string, unknown>;
  internals.ensureSessionKey = async () => ({ shareKey: SHARE_KEY, keyIdent: "k" });
  internals.httpPost = vi.fn(async () => {
    const env = reply(Buffer.from(JSON.stringify({ things_list: [] })));
    const headers = new Headers({ "X-Request-Ts": "1700000000", "X-Request-Once": "synthetic-once" });
    return { status: 200, data: { code: 0, ...env }, headers };
  });
  return mega;
}

const sealed = (
  plain: Buffer,
  signature = (data: string) => signRequest(SHARE_KEY, "1700000000", "synthetic-once", data),
) => {
  const data = encryptBody(plain, SHARE_KEY);
  return { data, signature: signature(data) };
};

describe("an encrypted reply", () => {
  it("is gunzipped after decryption when it carries the gzip magic", async () => {
    const mega = client((body) => sealed(gzipSync(body)));
    expect(await mega.postSigned("app-things-us-pr.eufy.com", "/x", {})).toEqual({ things_list: [] });
  });

  it("is refused when its signature does not match", async () => {
    const mega = client((body) => sealed(body, () => "0".repeat(64)));
    await expect(mega.postSigned("app-things-us-pr.eufy.com", "/x", {})).rejects.toBeInstanceOf(MegaApiError);
    expect(await client((body) => sealed(body)).postSigned("app-things-us-pr.eufy.com", "/x", {})).toEqual({
      things_list: [],
    });
  });
});
