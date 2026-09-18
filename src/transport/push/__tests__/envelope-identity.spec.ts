import { describe, it, expect } from "vitest";
import { PushClient, normalizePushEvent } from "../push-client.js";
import type { PushEvent } from "../types.js";

/**
 * A real eufy push carries its identity in the app_data envelope and its detail in the base64
 * `payload` entry — `device_sn` is a SIBLING of `payload`, never a child. Narrowing the emitted
 * envelope to the decoded `payload` therefore drops the serial, and every consumer receives an
 * event it cannot attribute to a device. Shapes below are redacted but structurally real.
 */
const appData = (): { key: string; value: string }[] => [
  { key: "device_sn", value: "T8000P0000000000" },
  { key: "station_sn", value: "T8000P0000000000" },
  { key: "type", value: "5" },
  {
    key: "payload",
    // base64( NUL-terminated JSON ) — detail only, carries no serial of its own
    value: Buffer.from(
      JSON.stringify({ event_type: 3103, channel: 0, pic_url: "https://example.test/t.jpg" }) + "\0",
    ).toString("base64"),
  },
];

describe("push envelope keeps device identity", () => {
  it("emits a push whose deviceSn comes from the envelope, not the nested payload", () => {
    const client = new PushClient({ androidId: "1", securityToken: "2" } as never);
    const seen: PushEvent[] = [];
    client.on("push", (e: PushEvent) => seen.push(e));

    (client as unknown as { handleDataMessage(o: unknown): void }).handleDataMessage({
      appData: appData(),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.deviceSn).toBe("T8000P0000000000");
    expect(seen[0]?.stationSn).toBe("T8000P0000000000");
    // the nested detail still decodes — the envelope is kept in addition to it, not instead
    expect(seen[0]?.eventType).toBe(3103);
  });

  it("normalizePushEvent resolves the serial from the envelope when the payload lacks one", () => {
    const event = normalizePushEvent({
      payload: {
        device_sn: "T8000P0000000000",
        payload: { event_type: 3103 },
      },
    } as never);

    expect(event.deviceSn).toBe("T8000P0000000000");
    expect(event.eventType).toBe(3103);
  });
});
