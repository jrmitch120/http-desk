// Long work on the main thread (building a large body's document, Find, Fold
// all, Copy path) runs in short slices, giving the browser a new task in
// between so input and paint get a turn and no task passes the 50 ms budget
// (#58). This is the one yield and slice budget they share.

/**
 * How long a slice of work runs before it gives the browser a turn. Short
 * enough that a slice plus its last step (a 256 KB piece of a document, a
 * piece of a search) stays well under 50 ms, long enough that the pauses cost
 * little.
 */
export const SLICE_MS = 8;

let channel: MessageChannel | undefined;
const waiting: (() => void)[] = [];

/**
 * Waits for a new task. A message to ourselves rather than `setTimeout(0)`:
 * browsers hold a chain of nested timeouts back 4 ms each after the fifth,
 * which would cost a slice of work half its time.
 */
export function nextTask(): Promise<void> {
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => waiting.shift()?.();
  }
  const c = channel;
  return new Promise((resolve) => {
    waiting.push(resolve);
    c.port2.postMessage(null);
  });
}

/** A slice of work that started now, `budget` ms long. */
export interface Slice {
  /** Whether the slice has used up its time. */
  due(): boolean;
  /** Once the slice is due, waits for a new task and starts the next slice; until then, returns at once. */
  pause(): Promise<void>;
}

/** Starts timing slices of work, `budget` ms each. */
export function slices(budget = SLICE_MS): Slice {
  let start = performance.now();
  const due = () => performance.now() - start >= budget;
  return {
    due,
    async pause() {
      if (!due()) return;
      await nextTask();
      start = performance.now();
    },
  };
}
