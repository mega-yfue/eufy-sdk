import { createECDH } from "node:crypto";
import { describe, expect, it } from "vitest";
import { P2PSession } from "../p2p-session.js";
import { parseDataFrameHeader } from "../codec.js";

/**
 * Which media key an attached camera's start offers.
 *
 * The current app's attached start carries a P-256 public point (128 hex characters, `x ‖ y`) as `key`, and
 * the camera then wraps each keyframe's media key in an ECIES envelope for it. An attached start offers the
 * same first, and the session's RSA modulus for every start after one on that channel that no keyframe
 * answered before its re-issue. The P-256 offer is limited to the HomeBase 3, the one station it was observed
 * on; any other station is offered RSA.
 */
const STATION_SN = "T8030P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

function attachedSession(stationSn = STATION_SN) {
  const built = new P2PSession({ stationSn, p2pDid: P2P_DID, noBroadcast: true });
  built.on("error", () => undefined);
  const internals = built as unknown as {
    connectAddress?: { address: string; port: number };
    level2Key?: Buffer;
    send: (...args: unknown[]) => void;
    decryptLevel2: (payload: Buffer, signCode: number) => Buffer | undefined;
    handleFrame: (header: unknown, payload: Buffer, dataType: number) => void;
  };
  const sendable = () => {
    internals.connectAddress = { address: "203.0.113.1", port: 32100 };
    internals.level2Key = Buffer.alloc(32, 7);
  };
  sendable();
  const sent: unknown[][] = [];
  internals.send = (...args: unknown[]) => {
    sent.push(args);
    (args[4] as (() => void) | undefined)?.();
  };
  const startPayload = (): { key: string; ClientOS: string } => {
    const data = sent.at(-1)![2] as Buffer;
    const header = parseDataFrameHeader(data.subarray(4));
    const plain = internals.decryptLevel2(data.subarray(20, 20 + header.bytesToRead), header.signCode);
    return JSON.parse(plain!.toString("utf8")).payload;
  };
  const offered = (): string => startPayload().key;
  const video = (channel: number) =>
    internals.handleFrame({ commandId: 1300, channel, signCode: 0, bytesToRead: 22 }, Buffer.alloc(22), 1);
  const unsendable = () => {
    internals.connectAddress = undefined;
    internals.level2Key = undefined;
  };
  return { session: built, offered, startPayload, video, sent, sendable, unsendable };
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

  it("offers the RSA modulus once a start went unanswered, and keeps offering it", () => {
    const { session, offered } = attachedSession();
    start(session);
    const ecc = offered();

    start(session);
    const rsa = offered();
    start(session);
    start(session);

    expect(ecc).toMatch(/^[0-9a-f]{128}$/);
    expect(rsa).toMatch(/^[0-9a-f]{256}$/);
    expect(offered()).toBe(rsa);
  });

  it("keeps the key type a keyframe answered, even an earlier start's", () => {
    const { session, offered } = attachedSession();
    start(session);
    const ecc = offered();
    start(session);
    const rsa = offered();

    expect(session.settleAttachedKey(2, "rsa")).toBe(false);
    start(session);
    expect(offered()).toBe(rsa);
    expect(session.settleAttachedKey(2, "ecc")).toBe(false);
    start(session);
    expect(offered()).toBe(ecc);
  });

  it("does not count video no key opened as an answer", () => {
    const { session, offered, video } = attachedSession();
    start(session);
    const ecc = offered();

    video(2);
    start(session);

    expect(offered()).not.toBe(ecc);
  });

  it("labels the P-256 start as the app captures do, and the RSA start Android", () => {
    const { session, startPayload } = attachedSession();
    start(session);
    const ecc = startPayload();
    start(session);
    const rsa = startPayload();

    expect(ecc.key).toMatch(/^[0-9a-f]{128}$/);
    expect(ecc.ClientOS).toBe("IOS");
    expect(rsa.key).toMatch(/^[0-9a-f]{256}$/);
    expect(rsa.ClientOS).toBe("Android");
  });

  it("asks with RSA once when a plaintext keyframe answers an unanswered P-256 offer, then keeps RSA", () => {
    const { session, offered } = attachedSession();
    start(session);
    const ecc = offered();

    expect(session.settleAttachedKey(2, "plain")).toBe(true);
    start(session);
    const rsa = offered();
    expect(session.settleAttachedKey(2, "plain")).toBe(false);
    start(session);

    expect(ecc).toMatch(/^[0-9a-f]{128}$/);
    expect(rsa).toMatch(/^[0-9a-f]{256}$/);
    expect(offered()).toBe(rsa);
  });

  it("keeps an answered P-256 offer through a plaintext keyframe", () => {
    const { session, offered } = attachedSession();
    start(session);
    const ecc = offered();

    session.settleAttachedKey(2, "ecc");
    expect(session.settleAttachedKey(2, "plain")).toBe(false);
    start(session);

    expect(offered()).toBe(ecc);
  });

  it("keeps an answered type through re-issues that no keyframe follows", () => {
    const { session, offered } = attachedSession();
    start(session);
    const ecc = offered();
    session.settleAttachedKey(2, "ecc");

    start(session);
    start(session);
    expect(offered()).toBe(ecc);

    const plain = attachedSession();
    start(plain.session);
    expect(plain.session.settleAttachedKey(2, "plain")).toBe(true);
    start(plain.session);
    const rsa = plain.offered();
    expect(plain.session.settleAttachedKey(2, "plain")).toBe(false);
    start(plain.session);
    start(plain.session);
    expect(plain.offered()).toBe(rsa);
    expect(plain.session.settleAttachedKey(2, "plain")).toBe(false);
  });

  it("does not count another channel's keyframe as an answer", () => {
    const { session, offered } = attachedSession();
    start(session);
    const ecc = offered();

    expect(session.settleAttachedKey(0, "ecc")).toBe(false);
    start(session);

    expect(offered()).not.toBe(ecc);
  });

  it("offers the P-256 point on the first start sent, after a start that could not be sent", () => {
    const { session, offered, sent, sendable, unsendable } = attachedSession();
    unsendable();
    start(session);
    expect(sent).toHaveLength(0);

    sendable();
    start(session);

    expect(offered()).toMatch(/^[0-9a-f]{128}$/);
  });

  it("offers the P-256 point again on a new connection after an unanswered offer on the last one", async () => {
    const { session, offered, sendable } = attachedSession();
    start(session);
    start(session);
    expect(offered()).toMatch(/^[0-9a-f]{256}$/);

    await session.connect();
    await session.close();
    await session.connect();
    sendable();
    try {
      start(session);
      expect(offered()).toMatch(/^[0-9a-f]{128}$/);
    } finally {
      await session.close();
    }
  });
});
