import { describe, expect, it } from "vitest";
import { notifyTrace, redactNotifyValue } from "../notify-trace.js";
import type { P2PFrame } from "../../transport/p2p/p2p-session.js";

const ACCOUNT = "0000000000000000000000000000000000000000";

const frame = (over: Partial<P2PFrame>): P2PFrame =>
  ({
    stationSn: "T8000P0000000000",
    commandId: 1351,
    commandName: "CMD_NOTIFY_PAYLOAD",
    bytesToRead: 0,
    channel: 0,
    signCode: 1,
    type: 0,
    dataType: 0,
    data: Buffer.alloc(48),
    raw: Buffer.alloc(48),
    ...over,
  }) as P2PFrame;

describe("notify trace", () => {
  it("records a notification nothing decoded, with its JSON redacted", () => {
    const trace = notifyTrace(
      frame({ json: { cmd: 6246, account_id: ACCOUNT, payload: { num: 1, name: "Living room" } } }),
      104,
      false,
    );
    expect(trace).toEqual({
      deviceType: 104,
      channel: 0,
      commandId: 1351,
      signCode: 1,
      decoded: true,
      json: { cmd: 6246, account_id: "<string:40>", payload: { num: 1, name: "<string:11>" } },
    });
  });

  it("records a notification whose payload did not parse by its size", () => {
    expect(notifyTrace(frame({ signCode: 2 }), undefined, false)).toEqual({
      channel: 0,
      commandId: 1351,
      signCode: 2,
      decoded: false,
      bytes: 48,
    });
  });

  it("skips a notification a capability decoded", () => {
    expect(notifyTrace(frame({ json: { cmd: 6030, payload: {} } }), 104, true)).toBeUndefined();
  });

  it("records the params a frame volunteered even when they were decoded", () => {
    const trace = notifyTrace(
      frame({ commandId: 1103, commandName: "CMD_CAMERA_INFO", params: { 1225: "9", 1104: "T8000P0000000000" } }),
      104,
      true,
    );
    expect(trace?.params).toEqual({ 1225: "9", 1104: "<string:16>" });
  });

  it("never records a binary frame without params", () => {
    expect(notifyTrace(frame({ commandId: 1300, commandName: "CMD_VIDEO_FRAME" }), 104, false)).toBeUndefined();
  });

  it("reduces deep or long containers to their size", () => {
    expect(redactNotifyValue({ a: { b: { c: { d: 1 } } } })).toEqual({ a: { b: { c: "<object:1>" } } });
    expect(redactNotifyValue(Array.from({ length: 17 }, () => 0))).toBe("<array:17>");
    expect(redactNotifyValue("-12")).toBe("-12");
    expect(redactNotifyValue("1234567")).toBe("<string:7>");
  });
});
