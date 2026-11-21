export * from "./secure-mqtt.js";
export * from "./topics.js";
export * from "./app-client-id.js";
export * from "./biz-stream.js";
// Solix telemetry — enumerated (not `export *`) so the public surface is the consumer-facing set: the
// stream class + the shapes its `reading` event carries. The lower-level ff09 decoders
// (decodeSolixParamFrame / solixReadings / readSolixChannel / extractFf09Payload / buildFf09Request) and
// SOLIX_METER_FIELD_NAMES stay module-internal; their specs import them from the module directly.
export { SolixMqtt } from "./solix-mqtt.js";
export type { SolixMqttOptions, SolixMqttDevice, SolixReading, SolixParamFrame, SolixChannel } from "./solix-mqtt.js";
// Anker's vendor Modbus-TCP `operating_mode` enumeration, exported as a reference table. It is NOT the
// decoder for this SDK's ff09 `mode` (state_info 0xa9), whose AE103 numbering differs on every value — the
// name says which hardware rev it belongs to so a caller can't mistake it for the ff09 decode.
export { SOLIX_MODBUS_EMS_MODES } from "./solix-mqtt.js";
