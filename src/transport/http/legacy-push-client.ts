import { createCipheriv, createECDH, createHash, randomBytes } from "node:crypto";

import type { Logger } from "../../core/logger.js";
import { noopLogger } from "../../core/logger.js";
import type { SessionStore } from "../../core/store.js";

const LEGACY_SERVER_PUBLIC_KEY =
  "04c5c00c4f8d1197cc7c3167c52bf7acb054d722f0ef08dcd7e0883236e0d72a3868d9750cb47fa4619248f3d83f0f662671dadc6e2d31c2f41db0161651c7c076";

interface LegacyEnvelope<T = unknown> {
  code: number;
  msg?: string;
  data?: T;
}

interface LegacyLoginData {
  auth_token: string;
  user_id: string;
  token_expires_at?: number;
  server_secret_info?: {
    public_key?: string;
  };
}

export interface LegacyPushSession {
  authToken: string;
  userId: string;
  openudid: string;
  serialNumber: string;
  country: string;
  apiBase?: string;
  /** Unix milliseconds. 0/undefined means unknown. */
  tokenExpiresAt?: number;
  /** Server ECDH key returned by login, if supplied. */
  serverPublicKey?: string;
}

export interface LegacyPushClientOptions {
  email: string;
  password: string;
  country: string;
  openudid: string;
  store: SessionStore<LegacyPushSession>;
  logger?: Logger;
}

function md5(value: string): string {
  return createHash("md5").update(value).digest("hex");
}

function randomSerialNumber(): string {
  return randomBytes(6).toString("hex");
}

export class LegacyPushClient {
  private readonly logger: Logger;

  constructor(private readonly opts: LegacyPushClientOptions) {
    this.logger = opts.logger ?? noopLogger;
  }

  private usableSession(): LegacyPushSession | null {
    const session = this.opts.store.load();
    if (!session) return null;

    if (session.tokenExpiresAt && Date.now() >= session.tokenExpiresAt - 5 * 60_000) {
      this.opts.store.clear();
      return null;
    }

    return session;
  }

  private baseHeaders(identity: { country: string; openudid: string; serialNumber: string }): Record<string, string> {
    return {
      "Content-Type": "application/json",
      App_version: "v4.6.0_1630",
      Os_type: "android",
      Os_version: "31",
      Phone_model: "ONEPLUS A3003",
      Country: identity.country,
      Language: "en",
      Openudid: identity.openudid,
      Net_type: "wifi",
      Mnc: "02",
      Mcc: "262",
      Sn: identity.serialNumber,
      Model_type: "PHONE",
      "Cache-Control": "no-cache",
    };
  }

  private authHeaders(session: LegacyPushSession): Record<string, string> {
    return {
      ...this.baseHeaders({
        country: session.country,
        openudid: session.openudid,
        serialNumber: session.serialNumber,
      }),
      "X-Auth-Token": session.authToken,
      gtoken: md5(session.userId),
    };
  }

  private async discoverApiBase(country: string): Promise<string> {
    const response = await fetch(`https://extend.eufylife.com/domain/${country}`, {
      method: "GET",
      headers: {
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) {
      throw new Error(`legacy domain discovery failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as LegacyEnvelope<{
      domain?: string;
    }>;

    const domain = body.data?.domain;
    if (!domain) {
      throw new Error(`legacy domain discovery failed: code=${body.code} msg=${body.msg ?? "unknown"}`);
    }

    const apiBase = domain.startsWith("http") ? domain.replace(/\/+$/, "") : `https://${domain.replace(/\/+$/, "")}`;

    const current = this.opts.store.load();
    if (current) {
      this.opts.store.save({
        ...current,
        apiBase,
      });
    }

    return apiBase;
  }

  async ensureSession(): Promise<LegacyPushSession> {
    const existing = this.usableSession();
    if (existing) return existing;

    const country = this.opts.country;
    const apiBase = await this.discoverApiBase(country);

    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();

    const secret = ecdh.computeSecret(Buffer.from(LEGACY_SERVER_PUBLIC_KEY, "hex"));

    const key = secret.subarray(0, 32);
    const iv = key.subarray(0, 16);

    const cipher = createCipheriv("aes-256-cbc", key, iv);
    const encryptedPassword = cipher.update(this.opts.password, "utf8", "base64") + cipher.final("base64");

    const serialNumber = randomSerialNumber();
    const timezoneOffset = new Date().getTimezoneOffset();

    const response = await fetch(`${apiBase}/v2/passport/login_sec`, {
      method: "POST",
      headers: this.baseHeaders({
        country,
        openudid: this.opts.openudid,
        serialNumber,
      }),
      body: JSON.stringify({
        ab: country,
        client_secret_info: {
          public_key: ecdh.getPublicKey("hex"),
        },
        enc: 0,
        email: this.opts.email,
        password: encryptedPassword,
        time_zone: timezoneOffset !== 0 ? -timezoneOffset * 60 * 1000 : 0,
        transaction: `${Date.now()}`,
      }),
    });

    let body: LegacyEnvelope<LegacyLoginData>;
    try {
      body = (await response.json()) as LegacyEnvelope<LegacyLoginData>;
    } catch {
      throw new Error(`legacy login returned non-JSON response (HTTP ${response.status})`);
    }

    if (!response.ok) {
      throw new Error(`legacy login failed with HTTP ${response.status}: ${body.msg ?? "unknown"}`);
    }

    if (body.code !== 0 || !body.data?.auth_token || !body.data.user_id) {
      throw new Error(`legacy login unavailable: code=${body.code} msg=${body.msg ?? "unknown"}`);
    }

    const rawExpiry = body.data.token_expires_at ?? 0;

    const tokenExpiresAt = rawExpiry > 10_000_000_000 ? rawExpiry : rawExpiry ? rawExpiry * 1000 : 0;

    const session: LegacyPushSession = {
      authToken: body.data.auth_token,
      userId: body.data.user_id,
      openudid: this.opts.openudid,
      serialNumber,
      country,
      apiBase,
      tokenExpiresAt,
      serverPublicKey: body.data.server_secret_info?.public_key ?? LEGACY_SERVER_PUBLIC_KEY,
    };

    this.opts.store.save(session);

    this.logger.debug("[legacy-push] authenticated");

    return session;
  }

  async registerPushToken(token: string): Promise<boolean> {
    const session = await this.ensureSession();

    const apiBase = session.apiBase ?? (await this.discoverApiBase(session.country));

    const response = await fetch(`${apiBase}/v1/apppush/register_push_token`, {
      method: "POST",
      headers: this.authHeaders(session),
      body: JSON.stringify({
        is_notification_enable: true,
        token,
        transaction: `${Date.now()}`,
      }),
    });

    if (response.status === 401) {
      this.opts.store.clear();
      return false;
    }

    let body: LegacyEnvelope;
    try {
      body = (await response.json()) as LegacyEnvelope;
    } catch {
      return false;
    }

    if (response.ok && body.code === 0) {
      this.logger.debug("[legacy-push] FCM token registered");
      return true;
    }

    this.logger.warn(`[legacy-push] registration failed code=${body.code} msg=${body.msg ?? "unknown"}`);

    return false;
  }

  async checkPushToken(): Promise<boolean> {
    const session = this.usableSession();
    if (!session) return false;

    const apiBase = session.apiBase ?? (await this.discoverApiBase(session.country));

    const response = await fetch(`${apiBase}/v1/app/review/app_push_check`, {
      method: "POST",
      headers: this.authHeaders(session),
      body: JSON.stringify({
        app_type: "eufySecurity",
        transaction: `${Date.now()}`,
      }),
    });

    if (response.status === 401) {
      this.opts.store.clear();
      return false;
    }

    try {
      const body = (await response.json()) as LegacyEnvelope;
      return response.ok && body.code === 0;
    } catch {
      return false;
    }
  }
}
