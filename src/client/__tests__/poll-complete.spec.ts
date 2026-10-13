import { describe, expect, it, vi } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { DeviceRegistry, type PollDiff } from "../device-registry.js";

/** A real registry over a fake cloud, preserving unchanged-device and tolerated-partial fetch behavior. */
function cloudClient(partial = false, pollMs = 1000) {
  const client = new EufyMega({ email: "test@example.com", password: "synthetic", pollMs });
  const post = vi.fn(async (_service: string, path: string) => {
    if (path.endsWith("get_house_list")) {
      if (partial) throw new Error("synthetic partial house-query failure");
      return { house_infos: [] };
    }
    return {
      devices: [
        {
          device_sn: "SENSOR",
          device_model: "T8410",
          category: "eufy_security",
          device_type: 30,
          params: [{ param_type: 1101, param_value: "88", update_time: 9000 }],
        },
      ],
    };
  });
  const errors = vi.fn();
  client.on("error", errors);
  const registry = new DeviceRegistry({ mega: { post } as never, onError: errors });
  const target = client as unknown as { registry: DeviceRegistry; pollOnce(): Promise<void>; schedulePoll(): void };
  target.registry = registry;
  return { client, target, registry, post, errors };
}

const emptyComplete: PollDiff = { params: [], added: [], removed: [], reported: [], complete: true };

describe("pollComplete reports settled loop progress independently of device changes", () => {
  it("emits ok once per complete unchanged poll without inventing deviceState transitions", async () => {
    const { client, target } = cloudClient();
    const completed = vi.fn();
    const state = vi.fn();
    client.on("pollComplete", completed);
    client.on("deviceState", state);
    await target.pollOnce();
    await target.pollOnce();
    expect(completed.mock.calls).toEqual([[{ status: "ok" }], [{ status: "ok" }]]);
    expect(state).not.toHaveBeenCalled();
  });

  it("emits partial for a tolerated failed query rather than mislabeling the resolved pass ok", async () => {
    const { client, target, errors } = cloudClient(true);
    const completed = vi.fn();
    client.on("pollComplete", completed);
    await target.pollOnce();
    expect(errors).toHaveBeenCalledOnce();
    expect(completed.mock.calls).toEqual([[{ status: "partial" }]]);
  });

  it("reports an exception and emits error once, then permits a later complete pass", async () => {
    const { client, target, registry, errors } = cloudClient();
    const boom = new Error("synthetic poll failure");
    vi.spyOn(registry, "pollChanges").mockRejectedValueOnce(boom).mockResolvedValueOnce(emptyComplete);
    const completed = vi.fn();
    client.on("pollComplete", completed);
    await target.pollOnce();
    expect(errors).toHaveBeenCalledWith(boom);
    expect(completed.mock.calls).toEqual([[{ status: "error" }]]);
    await target.pollOnce();
    expect(completed.mock.calls).toEqual([[{ status: "error" }], [{ status: "ok" }]]);
  });

  it("does not announce progress while a poll promise is hung, and announces once when it settles", async () => {
    const { client, target, registry } = cloudClient();
    let resolve!: (diff: PollDiff) => void;
    vi.spyOn(registry, "pollChanges").mockImplementation(
      () =>
        new Promise<PollDiff>((done) => {
          resolve = done;
        }),
    );
    const completed = vi.fn();
    client.on("pollComplete", completed);
    const pending = target.pollOnce();
    await Promise.resolve();
    expect(completed).not.toHaveBeenCalled();
    resolve(emptyComplete);
    await pending;
    expect(completed.mock.calls).toEqual([[{ status: "ok" }]]);
  });

  it("emits no completion when the periodic poll loop is disabled", async () => {
    vi.useFakeTimers();
    const { client, target, post } = cloudClient(false, 0);
    const completed = vi.fn();
    client.on("pollComplete", completed);
    try {
      target.schedulePoll();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(post).not.toHaveBeenCalled();
      expect(completed).not.toHaveBeenCalled();
    } finally {
      client.setPollInterval(0);
      vi.useRealTimers();
    }
  });
});
