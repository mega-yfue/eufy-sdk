// Facade surface: the EufyMega client, its options/event types, and the
// freshestLanIp helper. The class + its declaration-merged event interface
// live together in eufy-mega.ts (declaration merging requires one module).
export * from "./eufy-mega.js";
export { NOTIFY_TRACE_MESSAGE, type NotifyTrace } from "./notify-trace.js";
