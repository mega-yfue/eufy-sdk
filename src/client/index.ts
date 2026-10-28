// Facade surface: the EufyMega client, its options/event types, and the
// freshestLanIp helper. The class + its declaration-merged event interface
// live together in eufy-mega.ts (declaration merging requires one module).
export * from "./eufy-mega.js";
export {
  NOTIFY_TRACE_MESSAGE,
  POLL_CHANGE_TRACE_MESSAGE,
  type NotifyTrace,
  type PollChangeTrace,
} from "./notify-trace.js";
