/**
 * A queue that runs its tasks strictly one at a time, in the order they were pushed.
 *
 * Extracted from the admin upload page so the ordering and non-overlap guarantees are
 * unit-testable rather than asserted in a comment — the page's own failure mode was
 * precisely that it *looked* like it uploaded a batch fine and only came apart at 80
 * files. No DOM and no network here: the caller supplies the work.
 */

export interface SequentialQueue<T> {
  /** Appends an item and starts the worker if it isn't already running. */
  push(item: T): void;
  /** Items still waiting their turn, in order. The one currently running is not among
   *  them — it has already been taken off. */
  readonly pending: readonly T[];
  /** Whether the worker is currently working through the queue. */
  readonly isRunning: boolean;
}

/**
 * @param run Invoked once per item, awaited to completion before the next item is
 *   taken. It owns its own error reporting; a rejection is caught here purely so one bad
 *   item cannot halt the rest of the batch.
 */
export function createSequentialQueue<T>(run: (item: T) => Promise<void>): SequentialQueue<T> {
  const pending: T[] = [];
  let running = false;

  async function drain(): Promise<void> {
    // The whole of the sequential guarantee: a second caller returns immediately rather
    // than starting a parallel worker, and the loop already turning picks up whatever
    // that caller pushed. Safe because JavaScript runs this function's synchronous
    // stretches to completion — `running` cannot be observed mid-update.
    if (running) return;
    running = true;
    try {
      while (pending.length > 0) {
        const item = pending.shift()!;
        try {
          await run(item);
        } catch {
          // `run` is expected to record its own failures; swallowing here keeps one
          // rejected item from ending the batch.
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    push(item: T) {
      pending.push(item);
      void drain();
    },
    get pending() {
      return pending;
    },
    get isRunning() {
      return running;
    },
  };
}
