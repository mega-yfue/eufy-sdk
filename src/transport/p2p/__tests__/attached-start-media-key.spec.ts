import { createECDH } from "node:crypto";
import { describe, expect, it } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { parseDataFrameHeader } from "../codec.js";

/**
 * Which media key an attached camera's start offers.
 *
 * The current app's attached start carries a P-256 public point (128 hex characters, `x ‖ y`) as `key`, and
 * the camera then wraps each keyframe's media key in an ECIES envelope for it. An attached start offers the
 * same, and offers the session's RSA modulus instead only when a start on that channel went unanswered until
 * its re-issue, so a station that answers either type is reached by one of two consecutive starts. The P-256
 * offer is limited to the HomeBase 3, the one station it was observed on; any other station is offered RSA.
 */
const STATION_SN = "T8030P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

function attachedSession(stationSn = STATION_SN) {
  const built = new P2PSession({ stationSn, p2pDid: P2P_DID });
  const internals = built as unknown as {
    connectAddress?: { address: string; port: number };
    level2Key?: Buffer;
    send: (...args: unknown[]) => void;
    decryptLevel2: (payload: Buffer, signCode: number) => Buffer | undefined;
    handleFrame: (header: unknown, payload: Buffer, dataType: number) => void;
  };
  internals.connectAddress = { address: "203.0.113.1", port: 32100 };
  internals.level2Key = Buffer.alloc(32, 7);
  const sent: unknown[][] = [];
  internals.send = (...args: unknown[]) => sent.push(args);
  const offered = (): string => {
    const data = sent.at(-1)![2] as Buffer;
    const header = parseDataFrameHeader(data.subarray(4));
    const plain = internals.decryptLevel2(data.subarray(20, 20 + header.bytesToRead), header.signCode);
    return JSON.parse(plain!.toString("utf8")).payload.key;
  };
  const video = (channel: number) =>
    internals.handleFrame({ commandId: 1300, channel, signCode: 0, bytesToRead: 22 }, Buffer.alloc(22), 1);
  return { session: built, offered, video };
}

const start = (session: P2PSession, channel = 2) => session.startLiveMedia(channel, "account", true);

describe("an attached camera's media start", () => {
  it("offers a HomeBase 3 the session's P-256 point as 128 hex characters, the app's form, and others RSA", () => {
    const { session, offered } = attachedSession();
    const other = attachedSession("T8000P0000000000");

    start(session);
    start(other.session);

    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(session.mediaEccPrivateKey!);
    expect(offered()).toMatch(/^[0-9a-f]{128}$/);
    expect(offered()).toBe(ecdh.getPublicKey().subarray(1).toString("hex"));
    expect(other.offered()).toMatch(/^[0-9a-f]{256}$/);
    expect(other.session.mediaEccPrivateKey).toBeUndefined();
  });

  it("offers the RSA modulus when the previous start went unanswered, then ECC again", () => {
    const { session, offered } = attachedSession();
    start(session);
    const ecc = offered();

    start(session);
    const rsa = offered();
    start(session);

    expect(ecc).toMatch(/^[0-9a-f]{128}$/);
    expect(rsa).toMatch(/^[0-9a-f]{256}$/);
    expect(offered()).toBe(ecc);
  });

  it("keeps the key type that video answered", () => {
    const { session, offered, video } = attachedSession();
    start(session);
    const ecc = offered();
    start(session);
    const rsa = offered();
    expect(rsa).not.toBe(ecc);

    video(2);
    start(session);

    expect(rsa).toMatch(/^[0-9a-f]{256}$/);
    expect(offered()).toBe(rsa);
  });

  it("does not count another channel's video as an answer", () => {
    const { session, offered, video } = attachedSession();
    start(session);
    const ecc = offered();

    video(0);
    start(session);

    expect(offered()).not.toBe(ecc);
  });
});
