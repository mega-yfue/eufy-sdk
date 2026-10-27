import { openReadableFromConsumer } from "../readable-egress.js";
import { SharedLiveSource } from "../shared-live-source.js";
import type { LiveStreamHandle, LiveVideoFrame, ReceivedVideoFrame } from "../../../core/contracts.js";
import { EventEmitter } from "node:events";

class FakeStream extends EventEmitter implements LiveStreamHandle {
  stopped = 0;
  start(): this {
    return this;
  }
  stop(): void {
    this.stopped++;
  }
  video(f: LiveVideoFrame) {
    this.emit("video", f);
  }
}

function frame(keyframe: boolean): LiveVideoFrame {
  return { keyframe, width: 8, height: 8, codec: "h264", data: Buffer.from([0, 0, 0, 1, keyframe ? 0x67 : 0x21]) };
}

function mk() {
  let stream!: FakeStream;
  const source = new SharedLiveSource({
    makeStream: () => (stream = new FakeStream()),
  });
  return { source, stream: () => stream };
}

describe("openReadableFromConsumer", () => {
  it("skips the cached keyframe and preserves the live frame arrival time across queued delivery", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { source, stream } = mk();
    let reader: ReturnType<typeof openReadableFromConsumer> | undefined;
    try {
      const first = source.attach();
      const original = frame(true);
      stream().video(original);
      first.detach();
      now.mockReturnValue(6_000);
      const consumer = source.attach();
      reader = openReadableFromConsumer(consumer, { objectMode: true, arrivalTime: true });
      const received: ReceivedVideoFrame[] = [];
      reader.on("data", (value) => received.push(value));
      await new Promise((resolve) => setImmediate(resolve));
      expect(received).toHaveLength(0);
      stream().video(frame(false));
      consumer.pause();
      const live = frame(true);
      stream().video(live);
      now.mockReturnValue(7_000);
      consumer.resume();
      await new Promise((resolve) => setImmediate(resolve));
      expect(received).toHaveLength(1);
      expect(received[0].frame).toBe(live);
      expect(received[0].timestampMs).toBe(6_000);
      expect(Object.hasOwn(live, "timestampMs")).toBe(false);
    } finally {
      reader?.destroy();
      source.dispose();
      now.mockRestore();
    }
  });

  it("streams raw Annex-B bytes by default", async () => {
    const { source, stream } = mk();
    const consumer = source.attach();
    const r = openReadableFromConsumer(consumer);
    const chunks: Buffer[] = [];
    r.on("data", (c) => chunks.push(c));
    stream().video(frame(true));
    stream().video(frame(false));
    await new Promise((res) => setImmediate(res));
    expect(Buffer.isBuffer(chunks[0])).toBe(true);
    expect(chunks[0][4]).toBe(0x67);
    expect(chunks).toHaveLength(2);
  });

  it("emits LiveVideoFrame objects in objectMode", async () => {
    const { source, stream } = mk();
    const consumer = source.attach();
    const r = openReadableFromConsumer(consumer, { objectMode: true });
    const frames: LiveVideoFrame[] = [];
    r.on("data", (f) => frames.push(f));
    stream().video(frame(true));
    await new Promise((res) => setImmediate(res));
    expect(frames[0].codec).toBe("h264");
    expect(frames[0].keyframe).toBe(true);
  });

  it("detaches the consumer when destroyed", () => {
    const { source } = mk();
    const consumer = source.attach();
    const r = openReadableFromConsumer(consumer);
    expect(source.consumerCount).toBe(1);
    r.destroy();
    expect(source.consumerCount).toBe(0);
    expect(source.state).toBe("lingering");
    source.dispose();
  });

  it("ends (EOF) when the upstream stops", async () => {
    const { source, stream } = mk();
    const consumer = source.attach();
    const r = openReadableFromConsumer(consumer);
    r.resume();
    let ended = false;
    r.on("end", () => (ended = true));
    stream().video(frame(true));
    stream().emit("stop");
    await new Promise((res) => setImmediate(res));
    expect(ended).toBe(true);
    expect(r.destroyed).toBe(true);
    expect(source.consumerCount).toBe(0);
    expect(source.state).toBe("stopped");
    source.dispose();
  });
});

type ReadableOptions = NonNullable<Parameters<typeof openReadableFromConsumer>[1]>;

/**
 * Audio is a separate egress, so it is not an option on the video Readable — asserted in the type
 * system, where the mistake would be made.
 */
describe("the Readable option set", () => {
  it("does not offer audio", () => {
    const audioIsNotAnOption: "audio" extends keyof ReadableOptions ? never : true = true;
    expect(audioIsNotAnOption).toBe(true);
  });
});
