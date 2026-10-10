import { describe, expect, it, vi } from "vitest";
import { P2PSession } from "../p2p-session.js";

/**
 * `readDatabase` assembles a `CMD_DATABASE` reply into its rows.
 *
 * The frames carry no index, no total and no terminator, and the last is padded past the document's
 * closing brace — so the accumulation is never valid JSON in its entirety, and the document's own
 * structure is the only completion signal in the stream. These pin that, and the two ways the scan
 * can answer a WRONG list rather than none: a stale tail from an earlier reply, and latin1 text.
 */
const STATION_SN = "T8000P0000000000";
const P2P_DID = "XXXXXXX-000000-XXXXX";

/**
 * A connected session whose socket write is stubbed, so a spec drives the reply without one.
 *
 * `queryDatabase` itself runs: it carries the in-flight guard, so stubbing it would stub out the
 * behaviour half these specs are about.
 */
function session(): P2PSession {
  const built = new P2PSession({ stationSn: STATION_SN, p2pDid: P2P_DID });
  const internals = built as unknown as { connectAddress: unknown; send: () => void };
  internals.connectAddress = { host: "127.0.0.1", port: 0 };
  internals.send = vi.fn();
  return built;
}

/** Feed decrypted frame text in, as `onData` would. */
function chunk(target: P2PSession, text: string): void {
  target.emit("dbChunk", { stationSn: STATION_SN, text });
}

const TABLE = JSON.stringify({
  cmd: 10000,
  count: 2,
  data: [
    { age: 0, name: "Alex", person_id: 1, relation: "1" },
    { age: 0, name: "stranger1", person_id: 2, relation: "0" },
  ],
});

describe("P2PSession.readDatabase", () => {
  it("answers the rows once the document closes", async () => {
    const s = session();
    const read = s.readDatabase("person_basic_info", { accountId: "ADMIN-0000" });
    const mid = Math.floor(TABLE.length / 2);
    chunk(s, TABLE.slice(0, mid));
    chunk(s, TABLE.slice(mid));
    expect((await read).map((r) => (r as { name: string }).name)).toEqual(["Alex", "stranger1"]);
  });

  it("reads past the trailing padding the last frame carries", async () => {
    const s = session();
    const read = s.readDatabase("person_basic_info");
    chunk(s, `${TABLE}\u0000\u0000padding`);
    expect(await read).toHaveLength(2);
  });

  /**
   * The blocker this scan exists for. A reply that timed out leaves a tail starting mid-row, which
   * closes into a perfectly valid object carrying no rows — answering it would report an empty table
   * for a full one, which is exactly the partial answer the completion rule is meant to prevent.
   */
  it("skips a stale tail from an earlier reply instead of answering it empty", async () => {
    const s = session();
    const read = s.readDatabase("person_basic_info");
    chunk(s, `{"person_id":9,"name":"Leftover","relation":"1"}]}${TABLE}`);
    expect((await read).map((r) => (r as { name: string }).name)).toEqual(["Alex", "stranger1"]);
  });

  it("answers a name outside ASCII in the encoding it was written in", async () => {
    // `dbChunk` carries latin1 — one byte per character — so a UTF-8 name arrives as its bytes and
    // reads `JosÃ©` until the whole document is decoded back.
    const s = session();
    const read = s.readDatabase("person_basic_info");
    const table = JSON.stringify({ data: [{ name: "José", person_id: 3 }] });
    chunk(s, Buffer.from(table, "utf8").toString("latin1"));
    expect((await read)[0]).toMatchObject({ name: "José" });
  });

  it("does not answer a truncated document", async () => {
    const s = session();
    const read = s.readDatabase("person_basic_info", { timeoutMs: 20 });
    chunk(s, TABLE.slice(0, TABLE.length - 8));
    await expect(read).rejects.toThrow(/no complete person_basic_info/);
  });

  it("refuses a second read while one is accumulating", async () => {
    // The frames tie no chunk to its request, so two in flight would share one buffer.
    const s = session();
    const first = s.readDatabase("person_basic_info", { timeoutMs: 30 });
    await expect(s.readDatabase("person_basic_info")).rejects.toThrow(/already reading/);
    await expect(first).rejects.toThrow(/no complete/);
  });

  /**
   * The guard is on `queryDatabase`, not on `readDatabase`, because any query answers `{data:[…]}`:
   * a `face_feature_info` reply landing in this buffer would be answered as the roster.
   */
  it("refuses any other query while a read is accumulating", async () => {
    const s = session();
    const read = s.readDatabase("person_basic_info", { timeoutMs: 30 });
    expect(() => s.requestFaceFeatures()).toThrow(/already reading/);
    expect(() => s.queryDatabase("history_record_info")).toThrow(/already reading/);
    await expect(read).rejects.toThrow(/no complete/);
  });

  it("lets a query through once the read has answered", async () => {
    const s = session();
    const read = s.readDatabase("person_basic_info");
    chunk(s, TABLE);
    await read;
    expect(() => s.requestFaceFeatures()).not.toThrow();
  });

  it("releases the read once it has answered", async () => {
    const s = session();
    const first = s.readDatabase("person_basic_info");
    chunk(s, TABLE);
    await first;
    const second = s.readDatabase("person_basic_info");
    chunk(s, TABLE);
    expect(await second).toHaveLength(2);
  });

  it("stops listening on every exit", async () => {
    const s = session();
    const read = s.readDatabase("person_basic_info");
    chunk(s, TABLE);
    await read;
    expect(s.listenerCount("dbChunk")).toBe(0);

    const timedOut = s.readDatabase("person_basic_info", { timeoutMs: 20 });
    await expect(timedOut).rejects.toThrow();
    expect(s.listenerCount("dbChunk")).toBe(0);
  });

  it("gives up when the caller aborts", async () => {
    const control = new AbortController();
    const s = session();
    const read = s.readDatabase("person_basic_info", { signal: control.signal });
    control.abort();
    await expect(read).rejects.toThrow(/aborted/);
  });

  it("queries a dated recording page with the station's record command", async () => {
    const s = session();
    const query = vi.spyOn(s, "queryDatabase");
    const read = s.queryRecordPage({
      accountId: "ADMIN-0000",
      startDate: "20260101",
      endDate: "20261004",
      startTime: "20260930100000",
      count: 700,
    });
    expect(query).toHaveBeenCalledWith("history_record_info", {
      accountId: "ADMIN-0000",
      innerCmd: 10017,
      query: {
        count: 700,
        start_date: "20260101",
        end_date: "20261004",
        start_time: "20260930100000",
        event_type: 0,
        ai_type: 0,
        storage_cloud: -1,
        trigger_type: 0,
        detection_type: 0,
        flag: 0,
      },
    });
    chunk(s, JSON.stringify({ data: [{ table_name: "history_record_info", payload: [{ record_id: 1 }] }] }));
    expect(await read).toEqual([{ table_name: "history_record_info", payload: [{ record_id: 1 }] }]);
  });

  it("rejects a station refusal even if the reply includes an empty data array", async () => {
    const s = session();
    const read = s.queryRecordPage({ startDate: "20260101", endDate: "20261004" });
    chunk(s, JSON.stringify({ mIntRet: -104, data: [] }));
    await expect(read).rejects.toThrow("history_record_info refused: -104");
  });

  it("answers an empty recording page whose data is the station's string-encoded array", async () => {
    const s = session();
    const read = s.queryRecordPage({ startDate: "20260101", endDate: "20260102" });
    chunk(s, JSON.stringify({ cmd: 10017, mIntRet: 0, data: "[]" }));
    expect(await read).toEqual([]);
    expect(s.listenerCount("dbChunk")).toBe(0);
  });
});
