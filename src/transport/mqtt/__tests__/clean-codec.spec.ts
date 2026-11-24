import { describe, it, expect, vi } from "vitest";
import { buildCleanDpEnvelope } from "../clean-codec.js";
import { MqttCommandRouter } from "../command-router.js";
import type { EufyDevice } from "../../../core/types.js";

/**
 * `buildCleanDpEnvelope` — AIoT MQTT command envelope for clean-line DP writes. The injectable
 * `opts` params pin the non-deterministic fields (timestamp / UUID) so the wire constants
 * (`head.cmd`, `head.cmd_status`, `head.sign_code`, `payload.protocol`) can be asserted exactly
 * against the values confirmed from a live T2351 capture.
 */
const FIXED = { timestamp: 1700000000000, uuid: "test-uuid-1234" };

describe("buildCleanDpEnvelope", () => {
  it("sets the head constants confirmed from the T2351 capture", () => {
    const outer = JSON.parse(buildCleanDpEnvelope("<acct>", "<sn>", 151, true, FIXED));
    expect(outer.head.cmd).toBe(65537);
    expect(outer.head.cmd_status).toBe(2);
    expect(outer.head.sign_code).toBe(0);
    expect(outer.head.timestamp).toBe(FIXED.timestamp);
  });

  it("encodes the DP map inside a stringified payload", () => {
    const outer = JSON.parse(buildCleanDpEnvelope("<acct>", "<sn>", 163, 88, FIXED));
    const inner = JSON.parse(outer.payload);
    expect(inner.account_id).toBe("<acct>");
    expect(inner.device_sn).toBe("<sn>");
    expect(inner.protocol).toBe(2);
    expect(inner.t).toBe(FIXED.uuid);
    expect(inner.data).toEqual({ "163": 88 });
  });

  it("encodes boolean, number, and base64-string DP values as-is", () => {
    const b64 = Buffer.from([0x08, 0x06, 0x10, 0x70]).toString("base64");
    const parsePayload = (raw: string) => JSON.parse(JSON.parse(raw).payload);

    expect(parsePayload(buildCleanDpEnvelope("<a>", "<s>", 151, true, FIXED)).data).toEqual({ "151": true });
    expect(parsePayload(buildCleanDpEnvelope("<a>", "<s>", 161, 80, FIXED)).data).toEqual({ "161": 80 });
    expect(parsePayload(buildCleanDpEnvelope("<a>", "<s>", 152, b64, FIXED)).data).toEqual({ "152": b64 });
  });

  it("keys the DP map on the numeric DP id as a string", () => {
    const inner = JSON.parse(JSON.parse(buildCleanDpEnvelope("<a>", "<s>", 152, true, FIXED)).payload);
    expect(Object.keys(inner.data)).toEqual(["152"]);
  });

  it("defaults to live timestamp and UUID when opts are omitted", () => {
    const outer = JSON.parse(buildCleanDpEnvelope("<a>", "<s>", 151, true));
    const inner = JSON.parse(outer.payload);
    expect(typeof outer.head.timestamp).toBe("number");
    expect(typeof inner.t).toBe("string");
  });
});

/**
 * The clean line's `account_id`: the record's admin id when it states one, else the signed-in user's own id. The
 * write is done once published: the app reads no reply.
 */
describe("an aiot-dp write's account id", () => {
  it.each([
    ["the admin id", "2".repeat(40), "2".repeat(40)],
    ["the own id where the member states no admin", "", "1".repeat(40)],
  ])("is %s", async (_name, admin, expected) => {
    const dev = { sn: "T2351P0000000000", raw: { device_new_pn: "T2351", member: { admin_user_id: admin } } };
    const mqtt = { publish: vi.fn(async () => {}) };
    const router = new MqttCommandRouter({
      mega: { auth: { userId: "1".repeat(40) } } as never,
      listDevices: () => [dev as unknown as EufyDevice],
      ensureDevices: async () => {},
      secureTransport: async () => mqtt as never,
      onCommandAck: () => {},
      onError: () => {},
    });
    await expect(router.dispatchCommand(dev.sn, { kind: "aiot-dp", dp: 151, value: true })).resolves.toBe(true);
    const [, body] = mqtt.publish.mock.calls[0] as unknown as [string, string];
    expect(JSON.parse(JSON.parse(body).payload).account_id).toBe(expected);
  });
});
