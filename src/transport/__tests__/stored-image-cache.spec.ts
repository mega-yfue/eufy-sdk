import { StoredSnapshotUnavailableError } from "../../core/contracts.js";
import type { Logger } from "../../core/logger.js";
import { StoredImageCache } from "../stored-image-cache.js";

const jpeg = (body = "image") =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(body), Buffer.from([0xff, 0xd9])]);
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function logger() {
  const warnings: Array<[string, ...unknown[]]> = [];
  const log: Logger = {
    debug() {},
    info() {},
    warn: (message, ...args) => warnings.push([message, ...args]),
    error() {},
  };
  return { log, warnings };
}

/** The error a media host's 404 produces, tagged the way the SDK's own downloader tags it. */
const notFound = () => Object.assign(new Error("Media download failed"), { mediaFailure: "http-status", status: 404 });

async function reasonOf(cache: StoredImageCache, deviceKey: string) {
  try {
    await cache.snapshotStored(deviceKey);
  } catch (error) {
    expect(error).toBeInstanceOf(StoredSnapshotUnavailableError);
    return (error as StoredSnapshotUnavailableError).reason;
  }
  throw new Error("expected snapshotStored to reject");
}

describe("StoredImageCache", () => {
  it("reports whether no candidate was observed or an eager download is pending", async () => {
    const pending = deferred<Buffer>();
    let downloads = 0;
    const cache = new StoredImageCache(() => {
      downloads += 1;
      return pending.promise;
    }, logger().log);

    expect(await reasonOf(cache, "device-a")).toBe("not-observed");
    expect(downloads).toBe(0);
    cache.observe("device-a", "https://media.example/one");
    expect(downloads).toBe(1);
    expect(await reasonOf(cache, "device-a")).toBe("pending");
    expect(downloads).toBe(1);

    pending.resolve(jpeg());
    await pending.promise;
    await flush();
    await expect(cache.snapshotStored("device-a")).resolves.toEqual(jpeg());
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["too large", Buffer.alloc(10 * 1024 * 1024 + 1)],
    ["without the JPEG prefix", Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9])],
    ["without the JPEG suffix", Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xd9, 0x00])],
  ])("rejects an invalid image that is %s", async (_case, image) => {
    const cache = new StoredImageCache(async () => image, logger().log);

    cache.observe("device-a", "https://media.example/invalid");
    await flush();

    expect(await reasonOf(cache, "device-a")).toBe("invalid-image");
  });

  it("accepts a structurally valid JPEG at the 10 MiB limit", async () => {
    const image = Buffer.alloc(10 * 1024 * 1024);
    image.set([0xff, 0xd8, 0xff], 0);
    image.set([0xff, 0xd9], image.length - 2);
    const cache = new StoredImageCache(async () => image, logger().log);

    cache.observe("device-a", "https://media.example/maximum");
    await flush();

    await expect(cache.snapshotStored("device-a")).resolves.toBe(image);
  });

  it("classifies downloader rejection without retrying", async () => {
    let calls = 0;
    const cache = new StoredImageCache(async () => {
      calls += 1;
      throw new Error("request failed");
    }, logger().log);

    cache.observe("device-a", "https://media.example/failure");
    await flush();

    expect(await reasonOf(cache, "device-a")).toBe("download-failed");
    expect(calls).toBe(1);
  });

  describe("a candidate the media host has not published yet", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is retried after a 404 and retained once it is published", async () => {
      vi.useFakeTimers();
      let calls = 0;
      const cache = new StoredImageCache(async () => {
        calls += 1;
        if (calls === 1) throw notFound();
        return jpeg("late");
      }, logger().log);

      cache.observe("device-a", "https://media.example/late");
      await vi.advanceTimersByTimeAsync(0);
      expect(await reasonOf(cache, "device-a")).toBe("pending");
      expect(calls).toBe(1);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls).toBe(2);
      await expect(cache.snapshotStored("device-a")).resolves.toEqual(jpeg("late"));
    });

    it("gives up after the bounded retries, and diagnoses once", async () => {
      vi.useFakeTimers();
      const { log, warnings } = logger();
      let calls = 0;
      const cache = new StoredImageCache(async () => {
        calls += 1;
        throw notFound();
      }, log);

      cache.observe("device-a", "https://media.example/never");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await reasonOf(cache, "device-a")).toBe("pending");
      await vi.advanceTimersByTimeAsync(4_000);
      expect(calls).toBe(3);
      expect(await reasonOf(cache, "device-a")).toBe("download-failed");
      expect(warnings).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(3);
    });
  });

  it("preserves lifecycle failures instead of classifying them as stored-image absence", async () => {
    const lifecycle = new Error("session expired");
    const cache = new StoredImageCache(
      async () => {
        throw lifecycle;
      },
      logger().log,
      Date.now,
      (error) => error === lifecycle,
    );

    cache.observe("device-a", "https://media.example/failure");
    await flush();

    await expect(cache.snapshotStored("device-a")).rejects.toBe(lifecycle);
  });

  it("surfaces a lifecycle failure even when an older image is retained", async () => {
    const lifecycle = new Error("session expired");
    const cache = new StoredImageCache(
      async (url) => {
        if (url.endsWith("old")) return jpeg("old");
        throw lifecycle;
      },
      logger().log,
      Date.now,
      (error) => error === lifecycle,
    );

    cache.observe("device-a", "https://media.example/old");
    await flush();
    cache.observe("device-a", "https://media.example/new");
    await flush();

    await expect(cache.snapshotStored("device-a")).rejects.toBe(lifecycle);
  });

  it("limits downloads to two globally and one per device", async () => {
    const downloads = new Map<string, ReturnType<typeof deferred<Buffer>>>();
    const started: string[] = [];
    const cache = new StoredImageCache((url) => {
      started.push(url);
      const download = deferred<Buffer>();
      downloads.set(url, download);
      return download.promise;
    }, logger().log);

    cache.observe("device-a", "https://media.example/a1");
    cache.observe("device-a", "https://media.example/a2");
    cache.observe("device-b", "https://media.example/b1");
    cache.observe("device-c", "https://media.example/c1");
    expect(started).toEqual(["https://media.example/a1", "https://media.example/b1"]);

    downloads.get("https://media.example/b1")!.resolve(jpeg("b1"));
    await flush();
    expect(started).toEqual(["https://media.example/a1", "https://media.example/b1", "https://media.example/c1"]);

    downloads.get("https://media.example/a1")!.resolve(jpeg("a1"));
    await flush();
    expect(started.at(-1)).toBe("https://media.example/a2");
  });

  it("replaces older queued work and ignores duplicate device-and-URL observations", async () => {
    const first = deferred<Buffer>();
    const started: string[] = [];
    const cache = new StoredImageCache((url) => {
      started.push(url);
      return url.endsWith("one") ? first.promise : Promise.resolve(jpeg(url));
    }, logger().log);

    cache.observe("device-a", "https://media.example/one");
    cache.observe("device-a", "https://media.example/two");
    cache.observe("device-a", "https://media.example/two");
    cache.observe("device-a", "https://media.example/three");
    first.resolve(jpeg("one"));
    await flush();

    expect(started).toEqual(["https://media.example/one", "https://media.example/three"]);
    await expect(cache.snapshotStored("device-a")).resolves.toEqual(jpeg("https://media.example/three"));
  });

  it("keeps an older success when a newer candidate fails", async () => {
    const { log, warnings } = logger();
    const cache = new StoredImageCache(async (url) => {
      if (url.endsWith("new")) throw new Error("request failed");
      return jpeg("old");
    }, log);

    cache.observe("device-a", "https://media.example/old");
    await flush();
    cache.observe("device-a", "https://media.example/new");
    await flush();

    await expect(cache.snapshotStored("device-a")).resolves.toEqual(jpeg("old"));
    expect(warnings[0]?.[1]).toMatchObject({ class: "download-failed", retained: true });
  });

  it("never lets an older completion replace a newer retained success", async () => {
    const old = deferred<Buffer>();
    const cache = new StoredImageCache(
      (url) => (url.endsWith("old") ? old.promise : Promise.resolve(jpeg("new"))),
      logger().log,
    );

    cache.observe("device-a", "https://media.example/old");
    cache.clear();
    cache.observe("device-a", "https://media.example/new");
    old.resolve(jpeg("old"));
    await flush();

    await expect(cache.snapshotStored("device-a")).resolves.toEqual(jpeg("new"));
  });

  it("clear invalidates retained state and stale completions", async () => {
    const pending = deferred<Buffer>();
    const cache = new StoredImageCache(() => pending.promise, logger().log);

    cache.observe("device-a", "https://media.example/one");
    cache.clear();
    pending.resolve(jpeg());
    await flush();

    expect(await reasonOf(cache, "device-a")).toBe("not-observed");
  });

  it("logs only sanitized diagnostics and rate-limits identical classes per device", async () => {
    const { log, warnings } = logger();
    let now = 1234;
    const cache = new StoredImageCache(
      async (url) => {
        if (url.includes("invalid")) return Buffer.from("not a jpeg");
        throw new Error(`secret response from ${url}`);
      },
      log,
      () => now,
    );

    cache.observe("device-secret", "https://secret.example/first");
    await flush();
    now = 5678;
    cache.observe("device-secret", "https://secret.example/second");
    await flush();
    cache.observe("device-secret", "https://secret.example/invalid");
    await flush();
    cache.observe("other-secret", "https://secret.example/third");
    await flush();

    expect(warnings).toEqual([
      [
        "[stored-snapshot-cache] candidate failed",
        { class: "download-failed", errorName: "Error", observedAt: 1234, retained: false },
      ],
      ["[stored-snapshot-cache] candidate failed", { class: "invalid-image", observedAt: 5678, retained: false }],
      [
        "[stored-snapshot-cache] candidate failed",
        { class: "download-failed", errorName: "Error", observedAt: 5678, retained: false },
      ],
    ]);
    expect(JSON.stringify(warnings)).not.toMatch(/secret|response|https|device/);
  });

  it("names the download failure when the error carries this SDK's own tag", async () => {
    vi.useFakeTimers();
    const { log, warnings } = logger();
    const cache = new StoredImageCache(async () => {
      throw notFound();
    }, log);

    cache.observe("device-a", "https://media.example/missing");
    await vi.advanceTimersByTimeAsync(6_000);
    vi.useRealTimers();

    expect(warnings[0]?.[1]).toMatchObject({ class: "download-failed", cause: "http-status", status: 404 });
  });

  it("names a decode failure as a decode failure, not as a network one", async () => {
    const { log, warnings } = logger();
    const cache = new StoredImageCache(async () => {
      throw Object.assign(new Error("Push image could not be decoded"), { mediaFailure: "decode-failed" });
    }, log);

    cache.observe("device-a", "https://media.example/undecodable");
    await flush();

    expect(warnings[0]?.[1]).toMatchObject({ class: "download-failed", cause: "decode-failed" });
    expect(warnings[0]?.[1]).not.toHaveProperty("status");
  });

  it("drops a tag that is not one of this SDK's terms, however it is dressed up", async () => {
    const { log, warnings } = logger();
    const cache = new StoredImageCache(async (url) => {
      throw Object.assign(new Error("boom"), { mediaFailure: `secret response from ${url}`, status: "404" });
    }, log);

    cache.observe("device-a", "https://secret.example/first");
    await flush();

    expect(warnings[0]?.[1]).toEqual({
      class: "download-failed",
      errorName: "Error",
      observedAt: expect.any(Number),
      retained: false,
    });
    expect(JSON.stringify(warnings)).not.toMatch(/secret|response|https/);
  });

  it("names the class of an untagged failure", async () => {
    class MegaApiError extends Error {
      override name = "MegaApiError";
    }
    const { log, warnings } = logger();
    const cache = new StoredImageCache(async () => {
      throw new MegaApiError("x");
    }, log);

    cache.observe("device-a", "https://media.example/one");
    await flush();

    expect(warnings[0]?.[1]).toMatchObject({ class: "download-failed", errorName: "MegaApiError" });
  });

  it("names no error for a failure that carries this SDK's own tag", async () => {
    const { log, warnings } = logger();
    const cache = new StoredImageCache(async () => {
      throw Object.assign(new Error("x"), { mediaFailure: "network" });
    }, log);

    cache.observe("device-a", "https://media.example/one");
    await flush();

    expect(warnings[0]?.[1]).not.toHaveProperty("errorName");
  });

  it("remembers a bounded window of attempted URLs rather than every URL forever", async () => {
    const attempts: string[] = [];
    const cache = new StoredImageCache(async (url) => {
      attempts.push(url);
      return jpeg(url);
    }, logger().log);

    // One more than the window, so the first URL is the one pushed out of it.
    for (let i = 0; i < 65; i++) {
      cache.observe("device-a", `https://media.example/${i}`);
      await flush();
    }
    const beforeRepeat = attempts.length;

    // Still inside the window: a repeat is recognised and not downloaded again.
    cache.observe("device-a", "https://media.example/64");
    await flush();
    expect(attempts).toHaveLength(beforeRepeat);

    // Pushed out of it: forgotten, so it is attempted again rather than remembered forever.
    cache.observe("device-a", "https://media.example/0");
    await flush();
    expect(attempts).toHaveLength(beforeRepeat + 1);
  });

  it("emits the same failure class again after the diagnostic interval", async () => {
    const { log, warnings } = logger();
    let now = 0;
    const cache = new StoredImageCache(
      async () => Buffer.from("not a jpeg"),
      log,
      () => now,
    );

    cache.observe("device-a", "https://media.example/one");
    await flush();
    now = 60_000;
    cache.observe("device-a", "https://media.example/two");
    await flush();

    expect(warnings).toHaveLength(2);
  });
});
