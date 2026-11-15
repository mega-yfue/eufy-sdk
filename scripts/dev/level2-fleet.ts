/**
 * Fleet check for the level-2 negotiation: opens live view on every camera of the account in the
 * environment for 8 s and prints, per camera, the level-2 lines (gateway-info header version, cipher,
 * outcome) and how many video frames arrived. Serials are replaced by a stable per-run alias and DIDs masked, so the output can be pasted.
 *
 *   npm run build && node --env-file=.env scripts/dev/level2-fleet.ts [MODEL_PREFIX...]
 *
 * Signs in like the examples (see examples/_client.ts). Model prefixes (e.g. T8114) limit the run.
 */
const aliases = new Map<string, string>();
const alias = (sn: string) => aliases.get(sn) ?? (aliases.set(sn, `<sn${aliases.size + 1}>`), aliases.get(sn)!);
const mask = (s: string) => s.replace(/\b[A-Z0-9]{16}\b/g, alias).replace(/\b[A-Z]{4,8}-\d{6}-[A-Z]{5}\b/g, "<did>");
const only = process.argv.slice(2);
const sink = () => {};
const { loginClient } = await import("../../examples/_client.ts");
const eufy = await loginClient({
  logger: {
    debug: (m: string, d?: unknown) => {
      const line = d === undefined ? m : `${m} ${JSON.stringify(d)}`;
      if (/level-?2/.test(line)) console.log(`    ${mask(line)}`);
    },
    info: sink,
    warn: sink,
    error: sink,
  },
});
for (const d of await eufy.getDevices()) {
  if (only.length && !only.some((p) => d.model?.startsWith(p))) continue;
  const cam = (await eufy.getDevice(d.sn)).camera?.();
  if (!cam?.live) continue;
  console.log(`--- ${d.model?.slice(0, 5)} ${mask(d.sn)} on ${mask(d.stationSn ?? d.sn)}`);
  try {
    const stream = await cam.live();
    let frames = 0;
    stream.on("video", () => frames++);
    await new Promise((r) => setTimeout(r, 8000));
    stream.stop();
    console.log(`    video frames: ${frames}`);
  } catch (e) {
    console.log(`    error ${mask((e as Error).message)}`);
  }
}
await eufy.disconnect();
process.exit(0);
