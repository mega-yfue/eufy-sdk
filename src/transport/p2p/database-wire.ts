/**
 * Database wire — the ids and the whole-table query a station's on-station table and stored-image
 * reads are built from.
 *
 * A HomeBase answers them over its P2P session and a T9000 over its portal control channel, with the
 * same inner payloads, so both transports build their reads from this one module. The barrel does not
 * re-export it: these are wire ids, not part of the package surface.
 *
 * @module p2p/database-wire
 */

/** CMD_DATABASE_IMAGE (1308) — fetch one stored image by its on-station path. */
export const CMD_DATABASE_IMAGE = 1308;
/** CMD_DATABASE (1306) — query one on-station table; reply carries `{cmd:10000,count,data:[…]}`. */
export const CMD_DATABASE = 1306;
/**
 * Inner query cmds carried in a {@link CMD_DATABASE} payload. `FULL_TABLE` reads one table whole;
 * `COMBINATION_WITH_AI` is the AI event-history read that bundles the face roster.
 */
export const DB_QUERY = { FULL_TABLE: 10000, COMBINATION_WITH_AI: 10011, QUERY_LOCAL: 10017 } as const;

/** How long a station's database reply has to arrive whole, when the caller states no bound. */
export const DB_TABLE_TIMEOUT_MS = 15_000;

/**
 * The query params the vendor app sends with a whole-table `CMD_DATABASE` read (inner `cmd 10000`).
 * `count` bounds the row count.
 */
export function fullTableQuery(count = 2000): Record<string, unknown> {
  return {
    count,
    start_date: "",
    end_date: "",
    start_id: 0,
    end_id: 1,
    flag: 0,
    need_ai: 1,
    res_unzip: 1,
    update_time: "0",
    start_time: "0",
    alarm_id: "",
  };
}
