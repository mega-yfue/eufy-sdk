/**
 * Example 07 — live stream with the power-aware battery budget.
 *
 * A camera's power source is a RUNTIME fact (derived from the device's reported capabilities, not its
 * model): a device with the `battery` capability (incl. solar — solar only trickle-charges) drains
 * while streaming, so the SDK bounds a continuous stream to a **budget**; a **wired/mains** camera
 * streams unbounded.
 *
 * When the budget elapses the stream emits a `budget` notice carrying an `extend()` handle. The host
 * decides: call `extend()` to keep streaming (re-pushes the budget), or do nothing and the SDK
 * auto-stops after a short grace to protect the battery. This example extends a fixed number of times
 * then lets it stop — the pattern a host uses to cap battery drain while still allowing
 * "keep watching".
 *
 *   EUFY_EMAIL=… EUFY_PASSWORD=… node examples/07-live-stream-battery-budget.ts <serial> [maxExtends]
 *
 * Tip: pass a short budget via the options to see it quickly (the defaults are 45s budget / 10s grace).
 * Requires `npm run build` first.
 */
import { loginClient } from "./_client.ts";

async function main(): Promise<void> {
  const sn = process.argv[2];
  const maxExtends = process.argv[3] ? Number(process.argv[3]) : 2;
  if (!sn) throw new Error("usage: node examples/07-live-stream-battery-budget.ts <serial> [maxExtends]");

  const eufy = await loginClient();
  const dev = await eufy.getDevice(sn);
  const cam = dev.camera?.();
  if (!cam?.live) throw new Error(`${sn} has no live-capable camera`);

  // Power source is derived from the resolved capabilities — battery (incl solar) vs wired.
  const battery = dev.has("battery");
  console.log(`${sn}: ${battery ? "battery/solar → budgeted stream" : "wired → unbounded stream"}`);

  let frames = 0;
  let extended = 0;

  // A short budget/grace so the demo shows the cycle quickly (omit to use the 45s/10s defaults). The
  // model already sets `powered` from the capabilities; we only tune the timings here.
  const stream = await cam.live({ batteryBudgetMs: 8000, budgetGraceMs: 5000 });

  stream.on("video", (frame) => {
    frames++;
    if (frames === 1) console.log(`streaming (${frame.width}x${frame.height} ${frame.codec})`);
    if (frames % 60 === 0) console.log(`  ${frames} frames`);
  });

  // Battery cameras only: fired when the budget elapses. Extend to keep going, or ignore to auto-stop.
  stream.on("budget", (notice) => {
    if (extended < maxExtends) {
      extended++;
      console.log(`budget elapsed — extending (${extended}/${maxExtends}); ${notice.graceMs}ms grace to decide`);
      notice.extend(); // re-push another full budget
    } else {
      console.log(`budget elapsed — NOT extending; auto-stops in ${notice.graceMs}ms to save battery`);
    }
  });

  stream.on("stop", () => console.log("stream stopped"));
  stream.on("error", (err) => console.error("stream error:", err.message));

  // Let it run through a few budget cycles, then clean up. A wired camera would just keep streaming
  // here with no budget notice.
  await new Promise((r) => setTimeout(r, 40_000));
  stream.stop();
  console.log(`done — ${frames} frames, extended ${extended}x`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
