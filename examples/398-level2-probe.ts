/**
 * #398 probe (debug branch only, not for merge): open live on each camera for 8 s and print the level-2
 * derivation lines this branch logs. Shapes only (lengths, one framing byte, key header text); the
 * station serial is masked, so the output can be pasted as is.
 *
 *   EUFY_EMAIL=you@example.com EUFY_PASSWORD=… EUFY_COUNTRY=… node examples/398-level2-probe.ts
 *
 * Requires `npm run build` first.
 */
import { loginClient } from "./_client.ts";

const sink = () => {};
const eufy = await loginClient({
  logger: {
    debug: (m: string) => {
      if (/level-2 (inputs|probe|derivation failed|key negotiated|rsa-)/.test(m))
        console.log(m.replace(/\] \S+ level-2/, "] <sn> level-2"));
    },
    info: sink,
    warn: sink,
    error: sink,
  },
});
for (const d of await eufy.getDevices()) {
  const cam = (await eufy.getDevice(d.sn)).camera?.();
  if (!cam?.live) continue;
  console.log(`--- ${d.model?.slice(0, 5)}`);
  try {
    const stream = await cam.live();
    await new Promise((r) => setTimeout(r, 8000));
    stream.stop();
  } catch (e) {
    console.log(`error ${(e as Error).message.replace(/[A-Z0-9]{16}/g, "<sn>")}`);
  }
}
await eufy.disconnect();
process.exit(0);
