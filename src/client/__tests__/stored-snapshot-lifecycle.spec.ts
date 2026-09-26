import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistedSession, SessionStore } from "../../core/store.js";
import type { EufyDevice } from "../../core/types.js";
import type { ThumbnailCandidate } from "../../transport/push/types.js";
import { LoginStatus, type LoginResult } from "../../transport/http/mega-client.js";
import { PushClient } from "../../transport/push/push-client.js";
import { EufyMega } from "../eufy-mega.js";
import { LiveSnapshotUnavailableError } from "../../core/contracts.js";

const CAMERA_SN = "T8000P0000000001";
const UNKNOWN_SN = "T8000P0000000002";
const NO_SNAPSHOT_SN = "T8000P0000000003";
const IMAGE_URL = "https://security-app.eufylife.com/media/thumbnail.jpg";

function session(userId = "synthetic-user"): PersistedSession {
  return {
    userId,
    accountUserId: userId,
    authToken: "synthetic-token",
    region: "us-pr",
    openudid: "0000000000000000",
    shareKey: "00000000000000000000000000000000",
    keyIdent: "synthetic-key",
    tokenExpiresAt: 0,
    savedAt: 0,
  };
}

function sessionStore(userId = "synthetic-user"): SessionStore {
  let retained: PersistedSession | null = session(userId);
  return {
    load: () => retained,
    save: (next) => (retained = next),
    clear: () => (retained = null),
  };
}

function jpeg(body = "image"): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, ...Buffer.from(body), 0xff, 0xd9]);
}

/** A baseline JPEG whose SOF0 declares the geometry a reader has to answer with. */
function jpegOf(width: number, height: number): Buffer {
  const sof0 = Buffer.alloc(12);
  sof0.writeUInt16BE(0xffc0, 0);
  sof0.writeUInt16BE(11, 2);
  sof0.writeUInt8(8, 4);
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0.writeUInt8(1, 9);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof0, Buffer.from([0xff, 0xd9])]);
}

function cameraRecord(sn = CAMERA_SN): EufyDevice {
  return {
    sn,
    model: "T8170",
    category: "eufy_security",
    realtime: "p2p",
    p2pDid: "XXXXXXX-000000-XXXXX",
    params: {},
    paramUpdatedAt: {},
    raw: {
      device_sn: sn,
      device_model: "T8170",
      device_type: 30,
      station_sn: sn,
      p2p_did: "XXXXXXX-000000-XXXXX",
    },
  } as EufyDevice;
}

type ClientInternals = {
  mega: {
    downloadImage(url: string, p2pDid?: string): Promise<Buffer>;
    login(): Promise<LoginResult>;
  };
  registry: {
    list(): EufyDevice[];
    record(sn: string): Promise<{
      deviceType: number;
      model: string;
      category: string;
      params: Record<number, string>;
      paramUpdatedAt: Record<number, number>;
    }>;
    require(sn: string): EufyDevice;
    capabilitiesForDevice(sn: string): ReadonlySet<string> | undefined;
  };
  observeStoredImage(candidate: ThumbnailCandidate, eventDeviceSn?: string): Promise<void>;
  p2p: { mediaProviderFor(sn: string): { snapshotLive(opts?: unknown): Promise<unknown> } };
  mediaProviderFor(sn: string): {
    snapshotLive(opts?: unknown): Promise<{ jpeg: Buffer; width: number; height: number; retained?: true }>;
    snapshotStored?(): Promise<Buffer>;
  };
};

function makeClient(storedSnapshotCache?: boolean) {
  const eufy = new EufyMega({
    email: "user@example.invalid",
    password: "unused",
    store: sessionStore(),
    autoRealtime: false,
    ...(storedSnapshotCache === undefined ? {} : { storedSnapshotCache }),
  });
  const internals = eufy as unknown as ClientInternals;
  const camera = cameraRecord();
  const noSnapshot = cameraRecord(NO_SNAPSHOT_SN);

  const list = vi.spyOn(internals.registry, "list").mockReturnValue([camera, noSnapshot]);
  vi.spyOn(internals.registry, "record").mockResolvedValue({
    deviceType: 30,
    model: "T8170",
    category: "eufy_security",
    params: {},
    paramUpdatedAt: {},
  });
  vi.spyOn(internals.registry, "require").mockImplementation((sn) => {
    if (sn === CAMERA_SN) return camera;
    if (sn === NO_SNAPSHOT_SN) return noSnapshot;
    throw new Error(`unknown test device ${sn}`);
  });
  vi.spyOn(internals.registry, "capabilitiesForDevice").mockImplementation((sn) => {
    if (sn === CAMERA_SN) return new Set(["camera", "snapshot"]);
    if (sn === NO_SNAPSHOT_SN) return new Set(["camera"]);
    return undefined;
  });
  const download = vi.spyOn(internals.mega, "downloadImage");
  return { eufy, internals, download, list };
}

function exactCandidate(deviceSn = CAMERA_SN): ThumbnailCandidate {
  return { url: IMAGE_URL, attribution: { kind: "device", deviceSn } };
}

async function storedSnapshotAction(eufy: EufyMega) {
  const camera = (await eufy.getDevice(CAMERA_SN)).camera?.();
  expect(camera?.snapshotStored).toBeTypeOf("function");
  return camera!.snapshotStored!;
}

async function retainImage(client: ReturnType<typeof makeClient>, image = jpeg()) {
  client.download.mockResolvedValue(image);
  const action = await storedSnapshotAction(client.eufy);
  await client.internals.observeStoredImage(exactCandidate());
  await vi.waitFor(async () => expect(action()).resolves.toEqual(image));
  return action;
}

describe("stored snapshot client lifecycle", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("binds snapshotStored by default on a camera with snapshot evidence", async () => {
    const { eufy } = makeClient();

    const camera = (await eufy.getDevice(CAMERA_SN)).camera?.();

    expect(camera?.snapshotStored).toBeTypeOf("function");
  });

  it("storedSnapshotCache:false omits snapshotStored and ignores push candidates", async () => {
    const { eufy, internals, download } = makeClient(false);

    const camera = (await eufy.getDevice(CAMERA_SN)).camera?.();
    await internals.observeStoredImage(exactCandidate());

    expect(camera?.snapshotStored).toBeUndefined();
    expect(download).not.toHaveBeenCalled();
  });

  it("eagerly downloads an exact eligible candidate while snapshotStored remains passive", async () => {
    const client = makeClient();
    const image = jpeg("eager");
    client.download.mockResolvedValue(image);
    const action = await storedSnapshotAction(client.eufy);

    await client.internals.observeStoredImage(exactCandidate());

    expect(client.download).toHaveBeenCalledOnce();
    expect(client.download).toHaveBeenCalledWith(IMAGE_URL, "XXXXXXX-000000-XXXXX");
    await vi.waitFor(async () => expect(action()).resolves.toEqual(image));
    await expect(action()).resolves.toBe(image);
    expect(client.download).toHaveBeenCalledOnce();
  });

  it("uses the parent station key input for an attached camera image", async () => {
    const client = makeClient();
    const stationSn = "T8000P0000000004";
    const child = { ...cameraRecord(CAMERA_SN), stationSn, p2pDid: undefined };
    const station = { ...cameraRecord(stationSn), p2pDid: "XXXXXXX-000001-XXXXX" };
    client.list.mockReturnValue([child, station]);
    client.download.mockResolvedValue(jpeg());

    await client.internals.observeStoredImage(exactCandidate());

    expect(client.download).toHaveBeenCalledWith(IMAGE_URL, "XXXXXXX-000001-XXXXX");
  });

  it("admits a station-only candidate under the event's device serial, keyed by its parent station", async () => {
    const client = makeClient();
    const stationSn = "T8000P0000000004";
    const child = { ...cameraRecord(CAMERA_SN), stationSn, p2pDid: undefined };
    const station = { ...cameraRecord(stationSn), p2pDid: "XXXXXXX-000001-XXXXX" };
    client.list.mockReturnValue([child, station]);
    const image = jpeg("station-only");
    client.download.mockResolvedValue(image);
    const action = await storedSnapshotAction(client.eufy);

    await client.internals.observeStoredImage({ url: IMAGE_URL, attribution: { kind: "station" } }, CAMERA_SN);

    expect(client.download).toHaveBeenCalledWith(IMAGE_URL, "XXXXXXX-000001-XXXXX");
    await vi.waitFor(async () => expect(action()).resolves.toEqual(image));
  });

  const stationOnly: ThumbnailCandidate = { url: IMAGE_URL, attribution: { kind: "station", stationSn: CAMERA_SN } };

  it.each([
    ["ambiguous", { url: IMAGE_URL, attribution: { kind: "ambiguous" } }, CAMERA_SN],
    ["station-attributed without an event device serial", stationOnly, undefined],
    ["unknown-device", exactCandidate(UNKNOWN_SN), undefined],
    ["device without snapshot evidence", exactCandidate(NO_SNAPSHOT_SN), undefined],
  ] satisfies Array<[string, ThumbnailCandidate, string | undefined]>)(
    "discards a %s candidate",
    async (_label, candidate, eventDeviceSn) => {
      const { internals, download } = makeClient();

      await internals.observeStoredImage(candidate, eventDeviceSn);

      expect(download).not.toHaveBeenCalled();
    },
  );

  it("clearSession clears retained bytes and makes a stale bound action require login", async () => {
    const client = makeClient();
    const action = await retainImage(client);

    client.eufy.clearSession();

    await expect(action()).rejects.toThrow("login() first");
  });

  it("logout clears retained bytes and makes a stale bound action require login", async () => {
    const client = makeClient();
    const action = await retainImage(client);

    await client.eufy.logout();

    await expect(action()).rejects.toThrow("login() first");
  });

  it("a successful login for a replacement account clears retained bytes", async () => {
    const client = makeClient();
    await client.eufy.login();
    const action = await retainImage(client, jpeg("first-account"));
    vi.spyOn(client.internals.mega, "login").mockResolvedValue({
      status: LoginStatus.Ok,
      session: { userId: "replacement-user", authToken: "replacement-token", raw: {} },
    });

    await client.eufy.login();

    await expect(action()).rejects.toMatchObject({ reason: "not-observed" });
  });
});

describe("a push thumbnail reaches the stored-image admission", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("with the push's device serial, so a station-only candidate can be admitted", async () => {
    const eufy = new EufyMega({
      email: "user@example.invalid",
      password: "unused",
      autoRealtime: false,
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
    vi.spyOn(PushClient.prototype, "connect").mockImplementation(function (this: PushClient) {
      this.emit("connect");
    });
    const observe = vi.spyOn(eufy as any, "observeStoredImage").mockResolvedValue(undefined);
    const candidate: ThumbnailCandidate = { url: IMAGE_URL, attribution: { kind: "station" } };

    const client = await (eufy as any).startPush();
    client.emit("push", { deviceSn: CAMERA_SN, payload: {}, thumbnailCandidate: candidate });

    expect(observe).toHaveBeenCalledWith(candidate, CAMERA_SN);
  });
});

/**
 * A live still refused because a sibling is being watched answers with the retained one.
 *
 * One session serves one camera at a time, a still does not open a connection of its own, and a live view
 * outranks a tile — so the still is genuinely unavailable rather than broken. Failing there empties a caller's tile; answering the retained bytes keeps
 * it populated, and `retained` says they are not current so nothing mistakes them for a fresh capture.
 */
describe("a live still that could not be captured", () => {
  const refuse = (internals: ClientInternals) =>
    vi.spyOn(internals.p2p, "mediaProviderFor").mockReturnValue({
      snapshotLive: () => Promise.reject(new LiveSnapshotUnavailableError("no-keyframe", "no-keyframe")),
    } as never);

  it("answers the retained bytes, marked as retained, with the geometry the image declares", async () => {
    const { eufy, internals, download } = makeClient();
    download.mockResolvedValue(jpegOf(1920, 1080));
    await eufy.login();
    await internals.observeStoredImage(exactCandidate());
    await vi.waitFor(() => expect(internals.mediaProviderFor(CAMERA_SN).snapshotStored!()).resolves.toBeDefined());
    refuse(internals);

    const still = await internals.mediaProviderFor(CAMERA_SN).snapshotLive();

    expect(still).toMatchObject({ width: 1920, height: 1080, retained: true });
    expect(still.jpeg.equals(jpegOf(1920, 1080))).toBe(true);
  });

  it("lets the refusal stand when nothing is retained", async () => {
    const { eufy, internals } = makeClient();
    await eufy.login();
    refuse(internals);

    await expect(internals.mediaProviderFor(CAMERA_SN).snapshotLive()).rejects.toBeInstanceOf(
      LiveSnapshotUnavailableError,
    );
  });

  it("never marks a fresh capture as retained, even with bytes in hand", async () => {
    const { eufy, internals, download } = makeClient();
    download.mockResolvedValue(jpegOf(640, 480));
    await eufy.login();
    await internals.observeStoredImage(exactCandidate());
    await vi.waitFor(() => expect(internals.mediaProviderFor(CAMERA_SN).snapshotStored!()).resolves.toBeDefined());
    vi.spyOn(internals.p2p, "mediaProviderFor").mockReturnValue({
      snapshotLive: () => Promise.resolve({ jpeg: jpegOf(2560, 1440), width: 2560, height: 1440 }),
    } as never);

    const still = await internals.mediaProviderFor(CAMERA_SN).snapshotLive();

    expect(still.width).toBe(2560);
    expect(still.retained).toBeUndefined();
  });
});
