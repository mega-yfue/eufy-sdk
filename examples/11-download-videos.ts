/**
 * Example 11 — page a HomeBase 2 archive and download elementary video/audio streams.
 * Build first, then run: node examples/11-download-videos.ts <stationSn> [flags]
 * --list; --count N (default 20); --from YYYYMMDD; --to YYYYMMDD; --out DIR.
 * The end date is exclusive. Muxing the saved H.264 and ADTS AAC is the caller's job.
 * Observed HomeBase 2 archive cipher IDs above 24 bits resolve through their low byte.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loginClient } from "./_client.ts";

interface Row {
  record_id: number;
  device_sn: string;
  storage_path: string;
  start_time: string;
  cipher_id: number;
  frame_num: number;
}

async function main(): Promise<void> {
  const [stationSn, ...args] = process.argv.slice(2);
  if (!stationSn) throw new Error("usage: node examples/11-download-videos.ts <stationSn> [flags]");
  const value = (flag: string, fallback: string): string => {
    const at = args.indexOf(flag);
    return at < 0 ? fallback : (args[at + 1] ?? fallback);
  };
  const count = Number(value("--count", "20"));
  if (!Number.isInteger(count) || count < 1) throw new Error("--count must be a positive integer");
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const endDate = `${tomorrow.getFullYear()}${String(tomorrow.getMonth() + 1).padStart(2, "0")}${String(tomorrow.getDate()).padStart(2, "0")}`;
  const eufy = await loginClient({ autoRealtime: false });
  eufy.on("error", (error) => console.error(error.message));
  try {
    const devices = await eufy.getDevices();
    const station = devices.find((device) => device.sn === stationSn);
    const member = (station?.raw as { member?: { admin_user_id?: string } } | undefined)?.member;
    const accountId = member?.admin_user_id;
    if (!accountId) throw new Error("no admin_user_id on station record");
    await eufy.connectStation(stationSn);
    const session = eufy.getP2pSessions().get(stationSn);
    if (!session) throw new Error("no station session");
    const rows = new Map<number, Row>();
    let startTime = "0";
    while (rows.size < count) {
      const reply = await session.queryRecordPage({
        accountId,
        startDate: value("--from", "20150101"),
        endDate: value("--to", endDate),
        startTime,
        count: 20,
      });
      const page = reply.flatMap((group) => {
        const table = group as { table_name: string; payload: Row[] };
        return table.table_name === "history_record_info" ? table.payload : [];
      });
      for (const row of page) if (row.storage_path && row.frame_num > 0) rows.set(row.record_id, row);
      if (page.length < 20) break;
      const next = page.map((row) => row.start_time.replace(/\D/g, "")).sort()[0];
      if (!next || (startTime !== "0" && next >= startTime)) break;
      startTime = next;
    }
    const outDir = value("--out", "downloads");
    if (!args.includes("--list")) await mkdir(outDir, { recursive: true });
    for (const row of [...rows.values()].slice(0, count)) {
      console.log(`${row.start_time}: ${row.storage_path} (${row.frame_num} pictures)`);
      if (args.includes("--list")) continue;
      const camera = (await eufy.getDevice(row.device_sn)).camera?.();
      if (!camera?.downloadRecording) throw new Error("camera recording download unavailable");
      const recording = path.posix.basename(row.storage_path, ".dat");
      const cipherId = row.cipher_id > 0xffffff ? row.cipher_id & 0xff : row.cipher_id;
      const clip = await camera.downloadRecording({ recording, cipherId });
      const name = path.join(outDir, `${row.record_id}_${recording}`);
      await writeFile(`${name}.h264`, clip.video);
      if (clip.audio) await writeFile(`${name}.aac`, clip.audio);
      console.log(`${clip.frames} pictures, ${clip.missingFrames} missing, ${clip.fps} fps`);
      if (clip.frames !== row.frame_num) {
        console.warn(`Archive count differs: expected ${row.frame_num} pictures, received ${clip.frames}`);
      }
    }
  } finally {
    await eufy.disconnect();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("FATAL", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
