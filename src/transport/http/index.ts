export * from "./mega-client.js";
export { randomPhoneModel, randomUserAgent } from "./phone-model.js";
export * from "./decodeImageV1.js";
export * from "./decodeImageV2.js";
// The account/region-scoped light-effect catalogue — browse helpers a host calls with the client from
// `eufy.api`. The internal `resolveLightEffect` (used by the MQTT router) is deliberately not re-exported.
export { listLightEffects, listAiSceneRecommendations, type LightEffectSummary } from "./light-catalog.js";
// Anker Solix power-station cloud WIRE client (same-account login + device/site/MQTT reads). It puts
// bytes on the wire (fetch, signed/parsed envelopes), so it lives in the transport/http layer; building
// its records into SolixDevice models is the model layer's `discoverSolixDevices`.
export {
  SolixClient,
  type SolixClientOptions,
  type SolixLoginResult,
  type SolixSession,
  type SolixPersisted,
  type SolixSessionStore,
} from "./solix-client.js";

export { LegacyPushClient, type LegacyPushClientOptions, type LegacyPushSession } from "./legacy-push-client.js";
