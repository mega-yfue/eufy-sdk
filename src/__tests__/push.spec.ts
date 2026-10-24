import { describe, it, expect, vi } from "vitest";
import protobuf from "protobufjs";
import { MCS_PROTO, CHECKIN_PROTO } from "../transport/push/proto.js";
import { McsParser } from "../transport/push/parser.js";
import { generateFid } from "../transport/push/fcm.js";
import { PushClient } from "../transport/push/push-client.js";
import { MessageTag } from "../transport/push/message-tags.js";
import { detectionName, DoorbellPushEvent } from "../model/push-events.js";

describe("FCM/MCS push primitives", () => {
  it("generates a valid Firebase installation id", () => {
    for (let i = 0; i < 20; i++) {
      const fid = generateFid();
      expect(fid).toMatch(/^[cdef][\w-]{21}$/); // 22 chars, header nibble 0b0111x
    }
  });

  it("parses the MCS + checkin proto schemas", () => {
    const mcs = protobuf.parse(MCS_PROTO).root;
    expect(mcs.lookupType("mcs_proto.LoginRequest")).toBeTruthy();
    expect(mcs.lookupType("mcs_proto.DataMessageStanza")).toBeTruthy();
    const checkin = protobuf.parse(CHECKIN_PROTO).root;
    expect(checkin.lookupType("CheckinRequest")).toBeTruthy();
    expect(checkin.lookupType("CheckinResponse")).toBeTruthy();
  });

  it("reassembles a split MCS stream and decodes a DataMessageStanza", () => {
    const root = protobuf.parse(MCS_PROTO).root;
    const DMS = root.lookupType("mcs_proto.DataMessageStanza");
    const LR = root.lookupType("mcs_proto.LoginResponse");

    const json = JSON.stringify({ device_sn: "T8900X", payload: { event_type: 3102, pic_url: "https://x/y.jpg" } });
    const b64 = Buffer.concat([Buffer.from(json), Buffer.from([0])]).toString("base64");
    const dms = Buffer.concat([
      Buffer.from([MessageTag.DataMessageStanza]),
      DMS.encodeDelimited({
        from: "f",
        category: "c",
        persistentId: "p1",
        appData: [{ key: "payload", value: b64 }],
      }).finish(),
    ]);
    const first = Buffer.concat([
      Buffer.from([41, MessageTag.LoginResponse]),
      LR.encodeDelimited({ id: "1" }).finish(),
    ]);

    const parser = new McsParser();
    const tags: number[] = [];
    let payloadJson = "";
    parser.on("message", (m) => {
      tags.push(m.tag);
      if (m.tag === MessageTag.DataMessageStanza) {
        const kv = m.object.appData[0];
        payloadJson = Buffer.from(kv.value, "base64").toString("utf8").replace(/\0+$/, "");
      }
    });
    parser.handleData(first);
    // feed the data frame split across two chunks to exercise reassembly
    parser.handleData(dms.subarray(0, 4));
    parser.handleData(dms.subarray(4));

    expect(tags).toContain(MessageTag.LoginResponse);
    expect(tags).toContain(MessageTag.DataMessageStanza);
    expect(JSON.parse(payloadJson).payload.event_type).toBe(3102);
  });

  it("resolves AI-detection event names", () => {
    expect(detectionName(DoorbellPushEvent.FACE_DETECTION)).toBe("FACE_DETECTION");
    expect(detectionName(3101)).toBe("MOTION_DETECTION");
    expect(detectionName(99999)).toBe("EVENT_99999");
  });

  it("treats a transient MCS login rejection as retryable, surfacing an error only once it persists", () => {
    const client = new PushClient({
      fid: "x",
      androidId: "1",
      securityToken: "2",
      fcmToken: "t",
    } as never);
    const destroy = vi.fn();
    const errors: Error[] = [];
    client.on("error", (e) => errors.push(e));
    (client as unknown as { socket: unknown }).socket = { destroy };
    const loginError = { tag: MessageTag.LoginResponse, object: { error: "wrong_secret" } };
    const onMessage = (m: unknown) => (client as unknown as { onMessage(x: unknown): void }).onMessage(m);

    onMessage(loginError); // attempt 1 — transient, reconnect
    onMessage(loginError); // attempt 2 — transient
    expect(errors).toHaveLength(0);
    expect(destroy).toHaveBeenCalledTimes(2); // each closes the socket to trigger a reconnect

    onMessage(loginError); // attempt 3 — now surfaces
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("wrong_secret");

    // A successful login resets the counter so a later transient is tolerated again.
    onMessage({ tag: MessageTag.LoginResponse, object: {} });
    onMessage(loginError);
    expect(errors).toHaveLength(1);
    client.close();
  });

  it("closes a half-open socket when no inbound frame arrives within a heartbeat window", () => {
    vi.useFakeTimers();
    try {
      const client = new PushClient({ fid: "x", androidId: "1", securityToken: "2", fcmToken: "t" } as never);
      const write = vi.fn();
      const destroy = vi.fn();
      const internals = client as unknown as { socket: unknown; onMessage(m: unknown): void };
      internals.socket = { write, destroy };
      internals.onMessage({ tag: MessageTag.LoginResponse, object: {} }); // logs in → starts the heartbeat

      // First tick: the link is fresh, so we ping rather than tear down.
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(write).toHaveBeenCalledTimes(1);
      expect(destroy).not.toHaveBeenCalled();

      // An ack answers that ping: the next tick keeps the socket and pings again, never tearing down.
      internals.onMessage({ tag: MessageTag.HeartbeatAck, object: {} });
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(destroy).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledTimes(2);

      // Now no ack answers: the following tick sees a full silence window → close, and write no ping.
      vi.advanceTimersByTime(5 * 60 * 1000);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledTimes(2);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
