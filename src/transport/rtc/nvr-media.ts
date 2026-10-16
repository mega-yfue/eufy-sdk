import type { AbortableCall, MediaProvider, SharedSourceHints } from "../../core/contracts.js";
import { LiveSnapshotUnavailableError } from "../../core/contracts.js";
import { captureSnapshotFromShared } from "../p2p/media.js";
import { openReadableFromConsumer } from "../p2p/readable-egress.js";
import { SharedLiveSource, attachUnlessAborted } from "../p2p/shared-live-source.js";
import type { RtcCommandRouterDeps, RtcLiveRoute } from "./command-router.js";
import { NvrLiveStream } from "./nvr-live.js";

export interface NvrMediaRoute extends RtcLiveRoute {
  defaultSensor: 0 | 1;
  sensors: readonly (0 | 1)[];
}

/** One shared pull per camera sensor, each owning its media session independently of station commands. */
export class NvrMediaRouter {
  private readonly sources = new Map<string, SharedLiveSource>();
  constructor(private readonly deps: RtcCommandRouterDeps) {}

  mediaProviderFor(route: NvrMediaRoute): MediaProvider {
    return {
      live: async (opts) => this.attach(route, opts ?? {}),
      openReadable: async (opts) => openReadableFromConsumer(this.attach(route, opts ?? {}), opts),
      snapshotLive: async (opts) => {
        try {
          return await captureSnapshotFromShared(this.source(route, opts ?? {}), {
            ...opts,
            ffmpegPath: this.deps.ffmpegPath,
          });
        } catch (error) {
          if (error instanceof LiveSnapshotUnavailableError) throw error;
          throw new LiveSnapshotUnavailableError(
            "source-failed",
            error instanceof Error ? error.message : String(error),
            { cause: error },
          );
        }
      },
      record: async () => {
        throw new Error("rtc nvr: recording is not implemented");
      },
    };
  }

  close(): void {
    for (const source of [...this.sources.values()]) source.dispose();
    this.sources.clear();
  }

  private attach(route: NvrMediaRoute, opts: SharedSourceHints & AbortableCall) {
    return attachUnlessAborted(this.source(route, opts), opts.signal);
  }

  private source(route: NvrMediaRoute, opts: SharedSourceHints & AbortableCall): SharedLiveSource {
    opts.signal?.throwIfAborted();
    const sensor = opts.sensor ?? route.defaultSensor;
    if (!route.sensors.includes(sensor)) throw new Error("rtc nvr: unsupported sensor for this camera");
    const identity = this.deps.identity();
    if (!identity) throw new Error("rtc nvr: login() first");
    const key = `${route.stationSn}:${route.cameraSn}:${route.channel}:${sensor}`;
    const current = this.sources.get(key);
    if (current) return current;
    const source: SharedLiveSource = new SharedLiveSource({
      makeStream: () =>
        new NvrLiveStream({
          channel: route.channel,
          sensor,
          createSession: this.deps.createSession,
          session: {
            ...identity,
            stationSn: route.stationSn,
            adminUserId: route.adminUserId || identity.userId,
            shard: this.deps.shard(),
            country: this.deps.country ?? "US",
            logger: this.deps.logger,
            signalingMode: route.signalingMode,
            keepPeerOnSignalingLoss: true,
            peer: { iceTransportPolicy: route.iceTransportPolicy },
          },
        }),
      powered: opts.powered,
      preBufferSeconds: opts.preBufferSeconds,
      warmTimeoutMs: 25_000,
      logger: this.deps.logger,
      label: key,
      onStopped: () => {
        if (this.sources.get(key) === source) this.sources.delete(key);
      },
    });
    this.sources.set(key, source);
    return source;
  }
}
