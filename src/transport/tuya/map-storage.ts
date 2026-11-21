import { createHash, createHmac } from "node:crypto";
import type { TuyaClient } from "./client.js";

/** A stored object's label and downloaded bytes. @internal */
export interface StoredMapFile {
  name: string;
  data: Buffer;
}

/** Sign a short-lived object read using the storage service's regional signing scope. @internal */
export function signMapRead(config: Record<string, string>, path: string, now = new Date()): string {
  const encode = (s: string) =>
    encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  for (const key of ["ak", "sk", "bucket", "endpoint", "token"]) {
    if (!config[key]) throw new Error("Incomplete Tuya storage credentials");
  }
  const host = `${config.bucket}.${config.endpoint}`;
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) throw new Error("Invalid Tuya storage host");
  const uri = "/" + path.replace(/^\/+/, "").split("/").map(encode).join("/");
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = stamp.slice(0, 8),
    region = config.region || config.endpoint;
  const scope = `${date}/${region}/s3/aws4_request`;
  const params: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${config.ak}/${scope}`,
    "X-Amz-Date": stamp,
    "X-Amz-Expires": "300",
    "X-Amz-SignedHeaders": "host",
    "X-Amz-Security-Token": config.token!,
  };
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encode(k)}=${encode(params[k]!)}`)
    .join("&");
  const canonical = ["GET", uri, query, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  let key: Buffer = Buffer.from("AWS4" + config.sk);
  for (const part of [date, region!, "s3", "aws4_request"]) key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key)
    .update(["AWS4-HMAC-SHA256", stamp, scope, createHash("sha256").update(canonical).digest("hex")].join("\n"))
    .digest("hex");
  return `https://${host}${uri}?${query}&X-Amz-Signature=${signature}`;
}

/** Read stored map objects through the authenticated session. No device commands are sent. @internal */
export async function fetchStoredMaps(client: Pick<TuyaClient, "call">, devId: string): Promise<StoredMapFile[]> {
  const entries: { file: string; fileName?: string }[] = [];
  for (let offset = 0; ; offset += 8) {
    const reply = await client.call<{ datas: { file: string; fileName?: string }[]; totalCount: number }>({
      a: "tuya.m.dev.common.file.list",
      v: "1.0",
      postData: JSON.stringify({ devId, offset, limit: 8, fileType: "collect_recode" }),
    });
    if (!reply.success) throw new Error(`Tuya map listing rejected: ${reply.errorCode ?? "unknown"}`);
    if (!reply.result || !Array.isArray(reply.result.datas)) throw new Error("Invalid Tuya map listing");
    entries.push(...reply.result.datas);
    if (entries.length >= reply.result.totalCount || reply.result.datas.length < 8) break;
    if (offset >= 1016) throw new Error("Tuya map listing exceeds limit");
  }
  if (!entries.length) return [];
  const config = await client.call<Record<string, string>>({
    a: "smartlife.m.dev.storage.config.get",
    v: "1.0",
    postData: JSON.stringify({ devId, type: "Common" }),
  });
  if (!config.success || !config.result) throw new Error(`Tuya map storage rejected: ${config.errorCode ?? "unknown"}`);
  const result: StoredMapFile[] = [];
  for (const entry of entries) {
    const paths = entry.file.split(",");
    const path = paths.find((p) => /-show_map_\d+$/.test(p)) ?? paths.find((p) => /-map_\d+$/.test(p));
    if (!path) continue;
    const response = await fetch(signMapRead(config.result, path), {
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok || !response.body) throw new Error(`Tuya map download failed: HTTP ${response.status}`);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 8 * 1024 * 1024) throw new Error("Tuya map exceeds size limit");
      chunks.push(Buffer.from(chunk));
    }
    result.push({ name: entry.fileName ?? "", data: Buffer.concat(chunks) });
  }
  return result;
}
