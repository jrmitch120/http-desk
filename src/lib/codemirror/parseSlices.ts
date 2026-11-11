// Keeps CodeMirror's background parse in slices short enough for the 50 ms
// long-task budget (#58, #113, #114). Import this before anything that loads
// CodeMirror: main.ts imports it first.
//
// @codemirror/language sizes each slice of its parse worker from what it finds
// (6.13.1, dist/index.js:561-619), and only one path keeps it short: with
// `requestIdleCallback` and without `navigator.scheduling.isInputPending`, a
// slice ends with the idle period, max(25, timeRemaining() - 5) ms. Otherwise
// it is 100 ms (Work.Slice): with isInputPending it trusts that to stop early
// for input, and without requestIdleCallback it falls back to setTimeout,
// which has no deadline at all and pauses 500 ms between slices. On a large
// body, parsing toward a far viewport (scrolling to the end, selecting a match
// near the end) then blocks the window for 100 ms at a time.
//
// Chromium (so Windows' WebView2) has both APIs, so we hide isInputPending.
// WebKit, our webview on macOS and Linux, has neither, so we give it a
// requestIdleCallback that runs the callback on the next turn with the longest
// idle period the spec allows (50 ms), as polyfills commonly do.
//
// A full 50 ms idle period still makes a 45 ms slice, and the task that runs it
// also applies the new tree (and lets the view redraw), which can push it past
// 50 ms. So the deadline every idle callback gets, the browser's own or ours,
// reports at most IDLE_DEADLINE_MS left, which makes each slice 25 ms
// (CodeMirror's minimum) and leaves the rest of the task its headroom.
const scheduling = typeof navigator !== "undefined" ? (navigator as { scheduling?: object }).scheduling : undefined;
if (scheduling && "isInputPending" in scheduling) {
  Object.defineProperty(scheduling, "isInputPending", { value: undefined, configurable: true });
}

/** The longest idle period a browser grants (HTML's requestIdleCallback model). */
export const IDLE_PERIOD_MS = 50;

/** The most time an idle deadline reports left: CodeMirror's slice is this less 5 ms, and at least 25. */
export const IDLE_DEADLINE_MS = 30;

interface IdleWindow {
  requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  cancelIdleCallback?: (handle: number) => void;
}

/**
 * Makes `win.requestIdleCallback` hand its callbacks a deadline capped at
 * IDLE_DEADLINE_MS, wrapping the browser's own where there is one and a
 * setTimeout polyfill (with IDLE_PERIOD_MS idle periods) otherwise. `now`
 * stands in for the clock in tests.
 */
export function shortenIdleDeadlines(win: IdleWindow, now: () => number = () => performance.now()): void {
  let request: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
  if (typeof win.requestIdleCallback === "function") {
    request = win.requestIdleCallback.bind(win);
  } else {
    request = (callback) => {
      const handle = setTimeout(() => {
        const start = now();
        callback({ didTimeout: false, timeRemaining: () => Math.max(0, IDLE_PERIOD_MS - (now() - start)) });
      }, 1);
      return handle as unknown as number;
    };
    win.cancelIdleCallback = (handle) => clearTimeout(handle);
  }
  win.requestIdleCallback = (callback, options) =>
    request(
      (deadline) =>
        callback({
          didTimeout: deadline.didTimeout,
          timeRemaining: () => Math.min(IDLE_DEADLINE_MS, deadline.timeRemaining()),
        }),
      options,
    );
}

if (typeof window !== "undefined") shortenIdleDeadlines(window);
