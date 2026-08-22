export * from "./p2p-session.js";
export * from "./live-stream.js";
export * from "./video.js";
export * from "./media.js";
// `Consumer` is what `SharedLiveSource.attach` returns, so a caller has to be able to name it —
// exported under `LiveConsumer`, since `Consumer` alone is too generic to claim at the root barrel.
export {
  SharedLiveSource,
  type SharedLiveState,
  type SharedLiveSourceOptions,
  type TimedMediaFrame,
  type Consumer as LiveConsumer,
} from "./shared-live-source.js";
// `ParamSets` is what `SharedLiveSource.parameterSets` answers with, so a caller has to be able to name it.
export { type ParamSets } from "./annexb.js";
export * from "./commands.js";
export * from "./envelope.js";
export * from "./write-commands.js";
export * from "./lan-ip.js";
// Feature-command ids (P2P_CMD) + state param ids (P2P_PARAM) are the capability layer's vocabulary
// and live in model/, not here. This layer owns only the router's envelope ids (./envelope).
// codec.ts has generic decode/encode helper names → namespace to avoid flat collisions.
export * as p2pCodec from "./codec.js";
