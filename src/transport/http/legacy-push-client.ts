import { createHash } from "node:crypto";
import type { Logger } from "../../core/logger.js";
import { noopLogger } from "../../core/logger.js";
import type { SessionStore } from "../../core/store.js";

export interface LegacyPushSession {
  authToken: string;
  userId: string;
  openudid: string;
  serialNumber: string;
  country: string;
  apiBase?: string;
  /** Unix milliseconds. 0/undefined means unknown. */
  tokenExpiresAt?: number;
}

export interface LegacyPushClientOptions {
  store: SessionStore<LegacyPushSession>;
  logger?: Logger;
}

interface ApiEnvelope {
  code?: number;
  msg?: string;
  data?: unknown;
}

const DOMAIN_SERVICE = "https://extend.eufylife.com";

function isSessionUsable(session: LegacyPushSession | null): session is LegacyPushSession {
  if (!session?.authToken || !session.userId || !session.openudid || !session.serialNumber || !session.country) {
    return false;
  }

  if (session.tokenExpiresAt && Date.now() >= session.tokenExpiresAt - 5 * 60_000) {
    return false;
  }

  return true;
}

function gtoken(userId: string): string {
  return createHash("md5").update(userId).digest("hex");
}

function timezone(): string {
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const absolute = Math.abs(offset);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  return `GMT${sign}${hours}:${minutes}`;
}

/**
 * Minimal client for the classic eufy Security backend.
 *
 * This transport intentionally owns ONLY push registration. Device discovery,
 * properties, commands and P2P remain exclusively on the v6/Mega stack.
 */
export class LegacyPushClient {
  private readonly store: SessionStore<LegacyPushSession>;
  private readonly logger: Logger;

  constructor(options: LegacyPushClientOptions) {
    this.store = options.store;
    this.logger = options.logger ?? noopLogger;
  }

  private async discoverApiBase(country: string): Promise<string> {
    const response = await fetch(`${DOMAIN_SERVICE}/domain/${encodeURIComponent(country.toUpperCase())}`, {
      signal: AbortSignal.timeout(20_000),
    });

    const body = (await response.json()) as ApiEnvelope & {
      data?: { domain?: string };
    };

    if (!response.ok || body.code !== 0 || !body.data?.domain) {
      throw new Error(
        `legacy domain discovery failed (${response.status}/${body.code}): ${body.msg ?? "unknown error"}`,
      );
    }

    return body.data.domain.startsWith("http") ? body.data.domain : `https://${body.data.domain}`;
  }

  private headers(session: LegacyPushSession): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-auth-token": session.authToken,
      gtoken: gtoken(session.userId),

      App_version: "v4.6.0_1630",
      Os_type: "android",
      Os_version: "31",
      Phone_model: "ONEPLUS A3003",
      Country: session.country.toUpperCase(),
      Language: "en",
      Openudid: session.openudid,
      Sn: session.serialNumber,
      Model_type: "PHONE",
      Net_type: "wifi",
      Mnc: "02",
      Mcc: "262",
      Timezone: timezone(),
      "Cache-Control": "no-cache",
    };
  }

  private async session(): Promise<LegacyPushSession> {
    const session = this.store.load();

    if (!isSessionUsable(session)) {
      throw new Error("legacy push session is unavailable or expired");
    }

    if (!session.apiBase) {
      session.apiBase = await this.discoverApiBase(session.country);
      this.store.save(session);
    }

    return session;
  }

  async registerPushToken(token: string): Promise<boolean> {
    const session = await this.session();

    const response = await fetch(`${session.apiBase}/v1/apppush/register_push_token`, {
      method: "POST",
      headers: this.headers(session),
      body: JSON.stringify({
        is_notification_enable: true,
        token,
        transaction: String(Date.now()),
      }),
      signal: AbortSignal.timeout(20_000),
    });

    let body: ApiEnvelope = {};

    try {
      body = (await response.json()) as ApiEnvelope;
    } catch {
      // Leave the envelope empty; status handling below still explains failure.
    }

    if (response.status === 401) {
      this.logger.debug("[legacy-push] stored session rejected");
      this.store.clear();
      return false;
    }

    const ok = response.ok && body.code === 0;

    if (ok) {
      this.logger.debug("[legacy-push] FCM token registered");
    } else {
      this.logger.debug(
        `[legacy-push] FCM registration rejected (${response.status}/${body.code ?? "?"}): ${body.msg ?? "unknown error"}`,
      );
    }

    return ok;
  }

  async checkPushToken(): Promise<boolean> {
    const session = await this.session();

    const response = await fetch(`${session.apiBase}/v1/app/review/app_push_check`, {
      method: "POST",
      headers: this.headers(session),
      body: JSON.stringify({
        app_type: "eufySecurity",
        transaction: String(Date.now()),
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (response.status === 401) {
      this.store.clear();
      return false;
    }

    try {
      const body = (await response.json()) as ApiEnvelope;
      return response.ok && body.code === 0;
    } catch {
      return false;
    }
  }
}
