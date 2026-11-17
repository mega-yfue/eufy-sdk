import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { encryptP2PData, p2pCommandEncryptionKey } from "../codec.js";
import { P2PSession } from "../p2p-session.js";

/**
 * A `CMD_DATABASE` reply reaches `readDatabase` as text whichever way the station sealed it.
 *
 * A station that has negotiated a session key seals its database replies under it (signCode 2). The
 * frame is opened with that key, and the text handed to the read must be that opened text: a level-1
 * pass over the sealed bytes yields noise, so the read never sees a document and times out with the
 * reply already received.
 */
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";
const CMD_DATABASE = 1306;
const SESSION_KEY = Buffer.alloc(32, 7);

const TABLE = JSON.stringify({
  cmd: 10000,
  count: 2,
  data: [
    { name: "Alex", person_id: 1 },
    { name: "stranger1", person_id: 2 },
  ],
  mIntRet: 0,
});

function session(): P2PSession {
  const built = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID });
  const internals = built as unknown as { connectAddress: unknown; send: () => void };
  internals.connectAddress = { host: "127.0.0.1", port: 0 };
  internals.send = vi.fn();
  return built;
}

/** Deliver one reply frame as the datagram reassembly would. */
function deliver(target: P2PSession, signCode: number, payload: Buffer): void {
  (target as unknown as { handleFrame(h: unknown, p: Buffer, d: number): void }).handleFrame(
    { commandId: CMD_DATABASE, channel: 255, signCode, bytesToRead: payload.length, type: 0 },
    payload,
    1,
  );
}

/** A station-sealed frame body: `tag(16) ‖ nonce(12) ‖ ciphertext`, AES-256-GCM. */
function sealed(text: string): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", SESSION_KEY, nonce);
  cipher.setAAD(Buffer.from("eufy security"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(text, "utf8")), cipher.final()]);
  return Buffer.concat([cipher.getAuthTag(), nonce, ciphertext]);
}

describe("P2PSession database reply", () => {
  it("answers the rows of a reply sealed under the session key", async () => {
    const s = session();
    s.setLevel2Key(SESSION_KEY);
    const read = s.readDatabase("person_basic_info", { accountId: "ADMIN-0000", timeoutMs: 200 });
    deliver(s, 2, sealed(TABLE));
    expect((await read).map((r) => (r as { name: string }).name)).toEqual(["Alex", "stranger1"]);
  });

  it("assembles a sealed reply that arrives as several frames", async () => {
    const s = session();
    s.setLevel2Key(SESSION_KEY);
    const read = s.readDatabase("person_basic_info", { timeoutMs: 200 });
    const mid = Math.floor(TABLE.length / 2);
    deliver(s, 2, sealed(TABLE.slice(0, mid)));
    deliver(s, 2, sealed(TABLE.slice(mid)));
    expect(await read).toHaveLength(2);
  });

  it("still answers a level-1 reply on a session holding no session key", async () => {
    const s = session();
    const read = s.readDatabase("person_basic_info", { timeoutMs: 200 });
    const padded = Buffer.alloc(Math.ceil(TABLE.length / 16) * 16);
    padded.write(TABLE, "utf8");
    deliver(s, 1, encryptP2PData(padded, Buffer.from(p2pCommandEncryptionKey(STATION_SN, P2P_DID))));
    expect(await read).toHaveLength(2);
  });
});
