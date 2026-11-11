import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { PushRepeats } from "../push-repeats.js";
import { PushClient } from "../../transport/push/push-client.js";
import type { PushEvent } from "../../transport/push/types.js";

const DOORBELL_SN = "T8000P0000000000";
const OTHER_SN = "T8000P0000000001";
const PRESS_DOORBELL = 3103;
const MOTION = 3101;
const DOOR_SENSOR = 3;

function push(over: Partial<PushEvent> & { uniqueId?: string } = {}): PushEvent {
  const { uniqueId = "0000000000000000", ...rest } = over;
  return {
    deviceSn: DOORBELL_SN,
    eventType: PRESS_DOORBELL,
    payload: uniqueId ? { unique_id: uniqueId } : {},
    raw: {} as PushEvent["raw"],
    ...rest,
  };
}

/**
 * One detection reaches the FCM socket more than once: a doorbell press arrives as two pushes a fraction
 * of a second apart, both naming the same `unique_id`. The filter holds back the second, and only the
 * second — anything that does not name the same device, event and `unique_id` is a detection of its own.
 */
describe("PushRepeats", () => {
  it("answers the second delivery of one detection as a repeat", () => {
    const repeats = new PushRepeats();
    expect(repeats.repeat(push())).toBe(false);
    expect(repeats.repeat(push())).toBe(true);
  });

  it("keeps detections with a different unique_id, event or device apart", () => {
    const repeats = new PushRepeats();
    expect(repeats.repeat(push())).toBe(false);
    expect(repeats.repeat(push({ uniqueId: "0000000000000001" }))).toBe(false);
    expect(repeats.repeat(push({ eventType: MOTION }))).toBe(false);
    expect(repeats.repeat(push({ deviceSn: OTHER_SN }))).toBe(false);
  });

  it("never pairs a push that carries no unique_id, device or event", () => {
    const repeats = new PushRepeats();
    for (const p of [push({ uniqueId: "" }), push({ deviceSn: undefined }), push({ eventType: undefined })]) {
      expect(repeats.repeat(p)).toBe(false);
      expect(repeats.repeat(p)).toBe(false);
    }
  });

  it("forgets a detection once the window has passed", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const repeats = new PushRepeats();
      expect(repeats.repeat(push())).toBe(false);
      vi.setSystemTime(30_001);
      expect(repeats.repeat(push())).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The filter is worth nothing unless the push handler consults it before the semantic decode, so this
 * pins the wiring: two deliveries of one press announce `doorbellPress` once, while the raw `push` event
 * still reports both. The FCM socket is not opened — the store supplies persisted credentials and
 * `connect` is answered locally.
 */
describe("push handler announces one detection once", () => {
  beforeEach(() => vi.restoreAllMocks());

  async function startedPush(capabilities = ["doorbell"]) {
    const eufy = new EufyMega({
      email: "t@example.com",
      password: "x",
      pushStore: {
        load: () => ({
          creds: { fid: "f", androidId: "0", securityToken: "0", fcmToken: "t", createdAt: 0 },
          persistentIds: [],
        }),
        save: () => {},
        clear: () => {},
      },
    });
    Object.defineProperty((eufy as any).mega, "auth", {
      configurable: true,
      get: () => ({ userId: "u", authToken: "t" }),
    });
    vi.spyOn((eufy as any).mega, "registerPushToken").mockResolvedValue(undefined);
    vi.spyOn((eufy as any).registry, "capabilitiesForDevice").mockReturnValue(new Set(capabilities) as never);
    vi.spyOn(PushClient.prototype, "connect").mockImplementation(function (this: PushClient) {
      this.emit("connect");
    });
    const client: PushClient = await (eufy as any).startPush();
    return { eufy, client };
  }

  it("emits doorbellPress once for two pushes of one press, and both raw pushes", async () => {
    const { eufy, client } = await startedPush();
    const presses = vi.fn();
    const raws = vi.fn();
    eufy.on("doorbellPress", presses);
    eufy.on("push", raws);

    client.emit("push", push());
    client.emit("push", push());

    expect(presses).toHaveBeenCalledTimes(1);
    expect(raws).toHaveBeenCalledTimes(2);
  });

  /**
   * State-carrying events are edge-triggered on their value already, so the filter never applies to
   * them: a contact change is announced even when its push shares a `unique_id` with an earlier one.
   */
  it("leaves state-carrying events to the edge trigger", async () => {
    const { eufy, client } = await startedPush(["contact"]);
    const states = vi.fn();
    eufy.on("contactState", states);

    client.emit("push", push({ eventType: DOOR_SENSOR, payload: { unique_id: "0000000000000000", e: "1" } }));
    client.emit("push", push({ eventType: DOOR_SENSOR, payload: { unique_id: "0000000000000000", e: "0" } }));

    expect(states).toHaveBeenCalledTimes(2);
  });

  it("emits doorbellPress for each of two presses", async () => {
    const { eufy, client } = await startedPush();
    const presses = vi.fn();
    eufy.on("doorbellPress", presses);

    client.emit("push", push());
    client.emit("push", push({ uniqueId: "0000000000000001" }));

    expect(presses).toHaveBeenCalledTimes(2);
  });
});
