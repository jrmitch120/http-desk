// Keeps CodeMirror's background syntax parse in short slices. Its parse worker
// (@codemirror/language) runs up to 100 ms at a time, ending a slice early only
// when `navigator.scheduling.isInputPending()` says input is waiting (or, where
// that doesn't exist, at the browser's idle deadline, which WebKit has none of).
// On a large body, scrolling far ahead of the parse sets off a run of 100 ms
// tasks, each holding up paint and scrolling. This gives CodeMirror an
// `isInputPending` that also answers yes once the current task has run for
// PARSE_SLICE_MS, so every slice ends in time; the parse just takes more of
// them. CodeMirror looks for it when its module loads, so main.ts imports this
// module before anything else.

/** The longest a background parse slice runs, well under the 50 ms that counts as a long task. */
export const PARSE_SLICE_MS = 20;

interface Scheduling {
  isInputPending?: () => boolean;
}

/** When the current task first asked, or -1 if it hasn't. */
let taskStart = -1;

/**
 * Installs the slice limit on `nav`, keeping the browser's own input check
 * where there is one. `now` and `afterTask` stand in for the clock and a new
 * task in tests.
 */
export function limitParseSlices(
  nav: { scheduling?: Scheduling },
  now: () => number = () => performance.now(),
  afterTask: (f: () => void) => void = (f) => setTimeout(f),
): void {
  const scheduling = nav.scheduling;
  const native = scheduling?.isInputPending?.bind(scheduling);
  const isInputPending = () => {
    const t = now();
    if (taskStart < 0) {
      taskStart = t;
      afterTask(() => (taskStart = -1));
    }
    return t - taskStart >= PARSE_SLICE_MS || !!native?.();
  };
  Object.defineProperty(nav, "scheduling", { value: { isInputPending }, configurable: true });
}

if (typeof navigator !== "undefined") limitParseSlices(navigator as { scheduling?: Scheduling });
