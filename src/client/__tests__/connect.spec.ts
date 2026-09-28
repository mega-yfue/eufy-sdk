import { EventEmitter } from "node:events";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EufyMega } from "../eufy-mega.js";
import { LoginStatus, SessionExpiredError } from "../../transport/http/mega-client.js";
import { PushClient } from "../../transport/push/push-client.js";
import type { EufyDevice } from "../../core/types.js";

/**
 * Connectivity is SDK-managed: a successful login auto-starts realtime via the private
 * `ensureRealtime()`. These specs assert it starts the always-on channels (push always, MQTT only when
 * appliances are present, wired P2P warm-up) once and reports per-channel failures via `error` — no
 * live sockets: every underlying start method is spied and auth is faked.
 */
function makeClient(subsets: { mqtt: number; category?: string }, opts: Record<string, unknown> = {}) {
  const eufy = new EufyMega({ email: "t@example.com", password: "x", ...opts });

  // Satisfy the `if (!this.mega.auth) throw` guard without a real login.
  Object.defineProperty((eufy as any).mega, "auth", {
    configurable: true,
    get: () => ({ userId: "u", authToken: "t" }),
  });

  const dev = (sn: string): EufyDevice => ({ sn, category: subsets.category ?? "eufy_mega" }) as unknown as EufyDevice;
  vi.spyOn((eufy as any).registry, "list").mockReturnValue([dev("a")]);
  vi.spyOn(eufy, "getMqttDevices").mockReturnValue(Array.from({ length: subsets.mqtt }, (_, i) => dev(`m${i}`)));

  // startMqtt returns a connected transport (non-optional); ensureMqttStarted installs + subscribes it.
  const fakeTransport = { subscribeDevice: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
  const mqtt = vi.spyOn(eufy as any, "startMqtt").mockResolvedValue(fakeTransport);
  const push = vi.spyOn(eufy as any, "startPush").mockResolvedValue(undefined);
  const wired = vi
    .spyOn(eufy as any, "warmWiredP2P")
    .mockResolvedValue({ required: 0, ready: 0, failed: 0, pending: 0 });
  const getDevices = vi.spyOn(eufy, "getDevices").mockResolvedValue([]);

  return { eufy, mqtt, push, wired, getDevices };
}

describe("EufyMega auto-realtime", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("rejects readiness waits before login", async () => {
    const c = makeClient({ mqtt: 0 });

    await expect(c.eufy.waitForRealtime()).rejects.toThrow("login() first");
    expect(c.push).not.toHaveBeenCalled();
  });

  it("reports disabled after login without starting transports", async () => {
    const c = makeClient({ mqtt: 0 }, { autoRealtime: false });
    Object.defineProperty((c.eufy as any).mega, "loggedIn", { configurable: true, get: () => true });

    await expect(c.eufy.waitForRealtime()).resolves.toEqual({
      state: "disabled",
      push: { required: 0, ready: 0, failed: 0, pending: 0 },
      mqtt: { required: 0, ready: 0, failed: 0, pending: 0 },
      wiredP2p: { required: 0, ready: 0, failed: 0, pending: 0 },
    });
    expect(c.push).not.toHaveBeenCalled();
    expect(c.mqtt).not.toHaveBeenCalled();
    expect(c.wired).not.toHaveBeenCalled();
  });

  it("joins the auto-started bring-up and reuses its settled readiness", async () => {
    const c = makeClient({ mqtt: 0 });
    let releasePush!: () => void;
    c.push.mockReturnValue(new Promise((resolve) => (releasePush = () => resolve(undefined))));
    Object.defineProperty((c.eufy as any).mega, "loggedIn", { configurable: true, get: () => true });
    vi.spyOn((c.eufy as any).mega, "login").mockResolvedValue({
      status: LoginStatus.Ok,
      session: { userId: "user-a", authToken: "token", raw: {} },
    });

    await c.eufy.login();
    const first = c.eufy.waitForRealtime();
    const concurrent = c.eufy.waitForRealtime();
    expect(c.push).toHaveBeenCalledOnce();
    releasePush();

    const expected = {
      state: "ready",
      push: { required: 1, ready: 1, failed: 0, pending: 0 },
      mqtt: { required: 0, ready: 0, failed: 0, pending: 0 },
      wiredP2p: { required: 0, ready: 0, failed: 0, pending: 0 },
    };
    const result = await first;
    expect(result).toEqual(expected);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.push)).toBe(true);
    expect(() => ((result.push as { ready: number }).ready = 9)).toThrow();
    await expect(concurrent).resolves.toEqual(expected);
    await expect(c.eufy.waitForRealtime()).resolves.toEqual(expected);
    expect(c.push).toHaveBeenCalledOnce();
    expect(c.getDevices).not.toHaveBeenCalled();
  });

  it("times out one waiter without cancelling background startup", async () => {
    const c = makeClient({ mqtt: 0 });
    let releasePush!: () => void;
    c.push.mockReturnValue(new Promise((resolve) => (releasePush = () => resolve(undefined))));
    Object.defineProperty((c.eufy as any).mega, "loggedIn", { configurable: true, get: () => true });
    vi.spyOn((c.eufy as any).mega, "login").mockResolvedValue({
      status: LoginStatus.Ok,
      session: { userId: "user-a", authToken: "token", raw: {} },
    });
    await c.eufy.login();

    await expect(c.eufy.waitForRealtime({ timeoutMs: 1 })).resolves.toEqual({
      state: "timed-out",
      push: { required: 1, ready: 0, failed: 0, pending: 1 },
      mqtt: { required: 0, ready: 0, failed: 0, pending: 0 },
      wiredP2p: { required: 0, ready: 0, failed: 0, pending: 0 },
    });
    expect(c.push).toHaveBeenCalledOnce();

    releasePush();
    await expect(c.eufy.waitForRealtime()).resolves.toMatchObject({
      state: "ready",
      push: { required: 1, ready: 1, failed: 0, pending: 0 },
    });
    expect(c.push).toHaveBeenCalledOnce();
  });

  it("keeps production push pending until the MCS client authenticates", async () => {
    const pushStore = {
      load: () => ({
        creds: {
          fid: "synthetic-fid",
          androidId: "1",
          securityToken: "synthetic-token",
          fcmToken: "synthetic-fcm-token",
          createdAt: 0,
        },
        persistentIds: [],
      }),
      save: vi.fn(),
      clear: vi.fn(),
    };
    const c = makeClient({ mqtt: 0 }, { pushStore });
    c.push.mockRestore();
    let client!: PushClient;
    vi.spyOn(PushClient.prototype, "connect").mockImplementation(function (this: PushClient) {
      client = this;
    });
    vi.spyOn((c.eufy as any).mega, "registerPushToken").mockResolvedValue(undefined);
    Object.defineProperty((c.eufy as any).mega, "loggedIn", { configurable: true, get: () => true });
    vi.spyOn((c.eufy as any).mega, "login").mockResolvedValue({
      status: LoginStatus.Ok,
      session: { userId: "user-a", authToken: "token", raw: {} },
    });
    await c.eufy.login();

    await expect(c.eufy.waitForRealtime({ timeoutMs: 1 })).resolves.toMatchObject({
      state: "timed-out",
      push: { required: 1, ready: 0, failed: 0, pending: 1 },
    });

    client.emit("connect");
    await expect(c.eufy.waitForRealtime()).resolves.toMatchObject({
      state: "ready",
      push: { required: 1, ready: 1, failed: 0, pending: 0 },
    });
    await c.eufy.disconnect();
  });

  it("keeps wired P2P pending until the station handshake completes", async () => {
    const c = makeClient({ mqtt: 0 });
    c.wired.mockRestore();
    const session = Object.assign(new EventEmitter(), {
      isConnected: false,
      close: vi.fn(async () => {}),
    });
    vi.spyOn((c.eufy as any).registry, "p2pDevices").mockReturnValue([{ sn: "wired" }]);
    vi.spyOn(c.eufy as any, "stationPower").mockReturnValue("wired");
    (c.eufy as any).p2p.manager.register("wired", session);
    Object.defineProperty((c.eufy as any).mega, "loggedIn", { configurable: true, get: () => true });
    vi.spyOn((c.eufy as any).mega, "login").mockResolvedValue({
      status: LoginStatus.Ok,
      session: { userId: "user-a", authToken: "token", raw: {} },
    });
    await c.eufy.login();

    await expect(c.eufy.waitForRealtime({ timeoutMs: 1 })).resolves.toMatchObject({
      state: "timed-out",
      wiredP2p: { required: 1, ready: 0, failed: 0, pending: 1 },
    });

    session.isConnected = true;
    session.emit("connect");
    await expect(c.eufy.waitForRealtime()).resolves.toMatchObject({
      state: "ready",
      wiredP2p: { required: 1, ready: 1, failed: 0, pending: 0 },
    });
  });

  it("supersedes a disconnected startup and gives relogin a fresh generation", async () => {
    const c = makeClient({ mqtt: 0 });
    const staleClient = { close: vi.fn() };
    const freshClient = { close: vi.fn() };
    let releaseStale!: () => void;
    c.push
      .mockReturnValueOnce(new Promise((resolve) => (releaseStale = () => resolve(staleClient))))
      .mockResolvedValueOnce(freshClient);
    Object.defineProperty((c.eufy as any).mega, "loggedIn", { configurable: true, get: () => true });
    vi.spyOn((c.eufy as any).mega, "login").mockResolvedValue({
      status: LoginStatus.Ok,
      session: { userId: "user-a", authToken: "token", raw: {} },
    });

    await c.eufy.login();
    const staleWait = c.eufy.waitForRealtime();
    await c.eufy.disconnect();
    await expect(staleWait).resolves.toMatchObject({ state: "superseded" });
    await expect(c.eufy.waitForRealtime()).resolves.toMatchObject({ state: "superseded" });
    expect(c.push).toHaveBeenCalledOnce();

    await c.eufy.login();
    await expect(c.eufy.waitForRealtime()).resolves.toMatchObject({ state: "ready" });
    expect((c.eufy as any).pushClient).toBe(freshClient);

    releaseStale();
    await vi.waitFor(() => expect(staleClient.close).toHaveBeenCalledOnce());
    expect(freshClient.close).not.toHaveBeenCalled();
    expect((c.eufy as any).pushClient).toBe(freshClient);
    expect(c.push).toHaveBeenCalledTimes(2);
  });

  it("reports a settled generation as superseded after disconnect", async () => {
    const c = makeClient({ mqtt: 0 });
    Object.defineProperty((c.eufy as any).mega, "loggedIn", { configurable: true, get: () => true });
    await (c.eufy as any).ensureRealtime();

    await c.eufy.disconnect();

    await expect(c.eufy.waitForRealtime()).resolves.toMatchObject({ state: "superseded" });
    expect(c.push).toHaveBeenCalledOnce();
  });

  it("always starts push + warms wired P2P; skips MQTT with no appliances", async () => {
    const c = makeClient({ mqtt: 0 });
    await (c.eufy as any).ensureRealtime();
    expect(c.push).toHaveBeenCalledOnce();
    expect(c.wired).toHaveBeenCalledOnce();
    expect(c.mqtt).not.toHaveBeenCalled();
  });

  it("starts MQTT when the account has appliances", async () => {
    const c = makeClient({ mqtt: 2 });
    await (c.eufy as any).ensureRealtime();
    expect(c.mqtt).toHaveBeenCalledOnce();
    expect(c.push).toHaveBeenCalledOnce();
  });

  it("is idempotent — a second call starts nothing again", async () => {
    const c = makeClient({ mqtt: 1 });
    await (c.eufy as any).ensureRealtime();
    await (c.eufy as any).ensureRealtime();
    expect(c.push).toHaveBeenCalledOnce();
    expect(c.mqtt).toHaveBeenCalledOnce();
  });

  it("loads devices first when the registry is empty", async () => {
    const c = makeClient({ mqtt: 0 });
    (c.eufy as any).registry.list.mockReturnValue([]); // force the empty branch
    await (c.eufy as any).ensureRealtime();
    expect(c.getDevices).toHaveBeenCalledOnce();
  });

  it("one channel failing is reported via error, the rest still run", async () => {
    const c = makeClient({ mqtt: 1 });
    const boom = new Error("push down");
    c.push.mockRejectedValue(boom);
    const errors: unknown[] = [];
    c.eufy.on("error", (e) => errors.push(e));

    await (c.eufy as any).ensureRealtime();

    expect(c.mqtt).toHaveBeenCalledOnce(); // sibling still ran
    expect(errors).toContain(boom); // failure surfaced, not thrown
  });

  it("reports count-only partial readiness across all selected planes", async () => {
    const c = makeClient({ mqtt: 0 });
    const life = { sn: "life", category: "eufy_life" } as unknown as EufyDevice;
    const mega = { sn: "mega", category: "eufy_mega" } as unknown as EufyDevice;
    (c.eufy as any).getMqttDevices.mockReturnValue([life, mega]);
    const pushError = new Error("push down");
    const mqttError = new Error("mqtt down");
    const p2pError = new Error("station down");
    c.push.mockRejectedValue(pushError);
    c.mqtt.mockImplementation(async (...args: unknown[]) => {
      const scope = args[0];
      if (scope === "default") throw mqttError;
      return { subscribeDevice: vi.fn(async () => {}), disconnect: vi.fn(async () => {}) };
    });
    c.wired.mockRestore();
    vi.spyOn((c.eufy as any).registry, "p2pDevices").mockReturnValue([
      { sn: "wired-a" },
      { sn: "wired-a-child" },
      { sn: "wired-b" },
      { sn: "battery" },
    ]);
    vi.spyOn((c.eufy as any).p2p, "stationKeyOf").mockImplementation((...args: unknown[]) => {
      const sn = args[0] as string;
      return sn === "wired-a-child" ? "wired-a" : sn;
    });
    vi.spyOn(c.eufy as any, "stationPower").mockImplementation((...args: unknown[]) =>
      args[0] === "battery" ? "battery" : "wired",
    );
    vi.spyOn((c.eufy as any).p2p, "ensureStation").mockImplementation(async (...args: unknown[]) => {
      const sn = args[0];
      if (sn === "wired-b") {
        (c.eufy as any).reportError(p2pError);
        throw p2pError;
      }
    });
    const errors: Error[] = [];
    c.eufy.on("error", (error) => errors.push(error));
    Object.defineProperty((c.eufy as any).mega, "loggedIn", { configurable: true, get: () => true });
    vi.spyOn((c.eufy as any).mega, "login").mockResolvedValue({
      status: LoginStatus.Ok,
      session: { userId: "user-a", authToken: "token", raw: {} },
    });
    await c.eufy.login();

    await expect(c.eufy.waitForRealtime()).resolves.toEqual({
      state: "partial",
      push: { required: 1, ready: 0, failed: 1, pending: 0 },
      mqtt: { required: 2, ready: 1, failed: 1, pending: 0 },
      wiredP2p: { required: 2, ready: 1, failed: 1, pending: 0 },
    });
    expect(errors).toEqual(expect.arrayContaining([pushError, mqttError, p2pError]));
    expect((c.eufy as any).p2p.ensureStation).toHaveBeenCalledTimes(2);
  });

  it("warms persistent stations and leaves timed stations on demand", async () => {
    const c = makeClient({ mqtt: 0 }, { p2pIdleMsByStation: { battery: null, wiredTimed: 1000 } });
    c.wired.mockRestore();
    vi.spyOn((c.eufy as any).registry, "p2pDevices").mockReturnValue([
      { sn: "battery" },
      { sn: "wiredTimed" },
      { sn: "wiredDefault" },
    ]);
    vi.spyOn((c.eufy as any).p2p, "stationKeyOf").mockImplementation((...args: unknown[]) => args[0]);
    vi.spyOn(c.eufy as any, "stationPower").mockImplementation((...args: unknown[]) =>
      args[0] === "battery" ? "battery" : "wired",
    );
    const ensure = vi.spyOn((c.eufy as any).p2p, "ensureStation").mockResolvedValue(undefined);

    const readiness = await (c.eufy as any).warmWiredP2P();

    expect(readiness).toEqual({ required: 2, ready: 2, failed: 0, pending: 0 });
    expect(ensure.mock.calls.map(([sn]) => sn).sort()).toEqual(["battery", "wiredDefault"]);
  });

  it("a successful login triggers auto-realtime", async () => {
    const c = makeClient({ mqtt: 0 });
    const ensure = vi.spyOn(c.eufy as any, "ensureRealtime").mockResolvedValue(undefined);
    vi.spyOn((c.eufy as any).mega, "login").mockResolvedValue({
      status: LoginStatus.Ok,
      session: { userId: "user-a", authToken: "token", raw: {} },
    });
    await c.eufy.login();
    expect(ensure).toHaveBeenCalledOnce();
  });

  it("autoRealtime:false → login does not auto-start", async () => {
    const c = makeClient({ mqtt: 0 }, { autoRealtime: false });
    const ensure = vi.spyOn(c.eufy as any, "ensureRealtime").mockResolvedValue(undefined);
    vi.spyOn((c.eufy as any).mega, "login").mockResolvedValue({
      status: LoginStatus.Ok,
      session: { userId: "user-a", authToken: "token", raw: {} },
    });
    await c.eufy.login();
    expect(ensure).not.toHaveBeenCalled();
  });

  it("opens one transport per credential scope, and only for scopes that have devices", async () => {
    const c = makeClient({ mqtt: 0 });
    const life = { sn: "L1", category: "eufy_life" } as unknown as EufyDevice;
    const mega = { sn: "M1", category: "eufy_mega" } as unknown as EufyDevice;
    (c.eufy as any).getMqttDevices.mockReturnValue([life, mega]);

    await (c.eufy as any).ensureRealtime();

    expect(c.mqtt.mock.calls.map((a) => a[0]).sort()).toEqual(["default", "eufy_life"]);
  });

  it("does not open a second transport when every MQTT device is on one scope", async () => {
    const c = makeClient({ mqtt: 2, category: "eufy_life" });
    await (c.eufy as any).ensureRealtime();
    expect(c.mqtt.mock.calls.map((a) => a[0])).toEqual(["eufy_life"]);
  });

  it("a publish issued while its own scope is coming up does not deadlock", async () => {
    // Bringing a scope up subscribes its devices and sends their realtime-init commands, which publish
    // back on that same scope. If publishSecure awaited the bring-up memo it would wait on the bring-up
    // that is waiting on it — a hang, not a failure, so this is guarded explicitly.
    const c = makeClient({ mqtt: 1, category: "eufy_life" });
    const published: string[] = [];
    const transport = {
      subscribeDevice: vi.fn(async () => {
        await (c.eufy as any).mqtt.deps.publishSecure({ category: "eufy_life" }, "cmd/x/req", "{}");
      }),
      publish: vi.fn(async (t: string) => void published.push(t)),
      disconnect: vi.fn(async () => {}),
    };
    c.mqtt.mockResolvedValue(transport);

    await expect(
      Promise.race([
        (c.eufy as any).ensureRealtime(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("deadlocked")), 2000)),
      ]),
    ).resolves.toMatchObject({ state: "ready" });
    expect(published).toEqual(["cmd/x/req"]);
    expect(c.mqtt).toHaveBeenCalledOnce(); // reused the in-flight transport, didn't open a second
  });

  it("a disconnect racing the bring-up leaves no MQTT transport behind", async () => {
    // The disconnect has to land while ensureRealtime is suspended BEFORE it starts any scope: the
    // per-scope guard then captures the already-bumped epoch, so it happily installs its transport, and
    // only ensureRealtime's own stale-epoch check is left to release it. Without that release a resolved
    // disconnect() leaves a live, subscribed client that nothing owns.
    const c = makeClient({ mqtt: 1, category: "eufy_life" });
    (c.eufy as any).registry.list.mockReturnValue([]); // force ensureRealtime through its getDevices await
    const transport = {
      subscribeDevice: vi.fn(async () => {}),
      publish: vi.fn(async () => {}),
      disconnect: vi.fn(async () => {}),
    };
    c.mqtt.mockResolvedValue(transport);
    c.getDevices.mockImplementation(async () => {
      (c.eufy as any).registry.list.mockReturnValue([{ sn: "m0", category: "eufy_life" }]);
      await (c.eufy as any).disconnect();
      return [];
    });

    await (c.eufy as any).ensureRealtime();

    expect((c.eufy as any).transports.size).toBe(0);
    expect((c.eufy as any).mqttReady.size).toBe(0);
    expect(c.mqtt).not.toHaveBeenCalled();
    expect(transport.disconnect).not.toHaveBeenCalled();
  });

  it("a captcha/2FA login result does NOT auto-start realtime", async () => {
    const c = makeClient({ mqtt: 0 });
    const ensure = vi.spyOn(c.eufy as any, "ensureRealtime").mockResolvedValue(undefined);
    vi.spyOn((c.eufy as any).mega, "login").mockResolvedValue({ status: LoginStatus.Captcha, image: "x" });
    await c.eufy.login();
    expect(ensure).not.toHaveBeenCalled();
  });
});

describe("EufyMega sessionExpired event", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("routes a SessionExpiredError to sessionExpired ONLY, and a plain error to error ONLY", () => {
    const c = makeClient({ mqtt: 0 });
    const errors: Error[] = [];
    const expired: Error[] = [];
    c.eufy.on("error", (e) => errors.push(e));
    c.eufy.on("sessionExpired", (e) => expired.push(e));

    (c.eufy as any).reportError(new SessionExpiredError("token kicked out"));
    (c.eufy as any).reportError(new Error("transient boom"));

    // Auth loss goes to the dedicated event, NOT the generic error bus.
    expect(expired).toHaveLength(1);
    expect(expired[0]).toBeInstanceOf(SessionExpiredError);
    // Only the plain error reaches `error`.
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toBe("transient boom");
  });
});
