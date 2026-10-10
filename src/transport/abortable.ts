/**
 * Settle `work` as it settles, or reject the moment `signal` aborts, whichever comes first.
 *
 * The underlying wait is left to finish on its own: it may be shared work other callers are waiting on, so a
 * caller abandoning its own call does not cancel the work itself. This abandons WAITING, which is the only
 * part that belonged to the caller.
 */
export function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  signal.throwIfAborted();
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  ]);
}
