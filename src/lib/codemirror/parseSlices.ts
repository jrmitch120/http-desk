// Keeps CodeMirror's background parse in slices short enough for the 50 ms
// long-task budget (#58, #114). Import this before anything that loads
// CodeMirror: main.ts imports it first.
//
// @codemirror/language sizes each slice of its parse worker when its module is
// evaluated (6.13.1, dist/index.js:561-619), and only one path keeps it short:
// with `requestIdleCallback` and without `navigator.scheduling.isInputPending`,
// a slice ends with the idle period, max(25, timeRemaining() - 5), which is at
// most 45 ms. Otherwise it is 100 ms (Work.Slice): with isInputPending it
// trusts that to stop early for input, and without requestIdleCallback it
// falls back to setTimeout and has no deadline at all. On a large body,
// parsing toward a far viewport (scrolling to the end, selecting a match near
// the end) then blocks the window for 100 ms at a time.
//
// Chromium (so Windows' WebView2) has both APIs, so we hide isInputPending.
// WebKit, our webview on macOS and Linux, has neither, so we give it a
// requestIdleCallback that runs the callback on the next turn with the longest
// idle period the spec allows (50 ms), as polyfills commonly do.
const scheduling = (navigator as { scheduling?: object }).scheduling;
if (scheduling && "isInputPending" in scheduling) {
  Object.defineProperty(scheduling, "isInputPending", { value: undefined, configurable: true });
}

/** The longest idle period a browser grants (HTML's requestIdleCallback model). */
const IDLE_PERIOD_MS = 50;

if (typeof window.requestIdleCallback !== "function") {
  window.requestIdleCallback = (callback) =>
    window.setTimeout(() => {
      const start = performance.now();
      callback({ didTimeout: false, timeRemaining: () => Math.max(0, IDLE_PERIOD_MS - (performance.now() - start)) });
    }, 1);
  window.cancelIdleCallback = (handle) => window.clearTimeout(handle);
}
