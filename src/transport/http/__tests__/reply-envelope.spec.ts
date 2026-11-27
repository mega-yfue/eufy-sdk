import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import { encryptBody, signRequest } from "../../../core/crypto.js";
import { MegaApiError, MegaHttpClient } from "../mega-client.js";

/**
 * How an encrypted reply is read, as the app's `NetworkDecryptResponseUtil` reads it: the envelope `signature`
 * checked against `data` under the `X-Request-Ts` / `X-Request-Once` the request sent (the app's response decrypt
 * takes the request's, not the reply's), then decrypted and gunzipped when gzipped. Synthetic key and payload.
 */
const SHARE_KEY = "11".repeat(32);

/** The `X-Request-Ts` / `X-Request-Once` a reply carries, which are not the request's. */
const REPLY_TS = "1700000099";
const REPLY_ONCE = "synthetic-reply-once";

type Sign = (data: string, request: { ts: string; once: string }) => string;

/** A client whose server replies with `plain` (gzipped when asked), signed by `sign`. */
function client(sign: Sign, gzip = false) {
  const mega = new MegaHttpClient({ email: "synthetic@example.invalid", password: "synthetic", region: "us-pr" });
  const internals = mega as unknown as Record<string, unknown>;
  internals.ensureSessionKey = async () => ({ shareKey: SHARE_KEY, keyIdent: "k" });
  internals.httpPost = vi.fn(async (_url: string, _body: unknown, sent: Record<string, string>) => {
    const plain = Buffer.from(JSON.stringify({ things_list: [] }));
    const data = encryptBody(gzip ? gzipSync(plain) : plain, SHARE_KEY);
    const signature = sign(data, { ts: sent["x-request-ts"]!, once: sent["x-request-once"]! });
    const headers = new Headers({ "X-Request-Ts": REPLY_TS, "X-Request-Once": REPLY_ONCE });
    return { status: 200, data: { code: 0, data, signature }, headers };
  });
  return mega;
}

/** Signed as the server signs: over the request's timestamp and nonce. */
const byRequest: Sign = (data, { ts, once }) => signRequest(SHARE_KEY, ts, once, data);

describe("an encrypted reply", () => {
  it("is gunzipped after decryption when it carries the gzip magic", async () => {
    const mega = client(byRequest, true);
    expect(await mega.postSigned("app-things-us-pr.eufy.com", "/x", {})).toEqual({ things_list: [] });
  });

  it("is read when its signature matches the request's timestamp and nonce, whatever the reply's headers carry", async () => {
    expect(await client(byRequest).postSigned("app-things-us-pr.eufy.com", "/x", {})).toEqual({ things_list: [] });
  });

  it("is refused when its signature is over the reply's own headers rather than the request's", async () => {
    const mega = client((data) => signRequest(SHARE_KEY, REPLY_TS, REPLY_ONCE, data));
    await expect(mega.postSigned("app-things-us-pr.eufy.com", "/x", {})).rejects.toBeInstanceOf(MegaApiError);
  });

  it("is refused when its signature does not match", async () => {
    const mega = client(() => "0".repeat(64));
    await expect(mega.postSigned("app-things-us-pr.eufy.com", "/x", {})).rejects.toBeInstanceOf(MegaApiError);
  });
});
