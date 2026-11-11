// Keeps CodeMirror's background parse in slices short enough for the 50 ms
// long-task budget (#58, #114). Import this before anything that loads
// CodeMirror: main.ts imports it first.
//
// @codemirror/language reads `navigator.scheduling.isInputPending` once, when
// its module is evaluated (6.13.1, dist/index.js:572). If the browser has it,
// the parse worker works in 100 ms slices (Work.Slice), trusting
// isInputPending to stop early for input; without it, each slice ends with
// the idle period, max(25, timeRemaining() - 5), which is at most 45 ms.
// On a large body, parsing toward a far viewport (scrolling to the end,
// selecting a match near the end) then blocks the window for 100 ms at a time.
//
// Only Chromium (so Windows' WebView2) exposes the API; WebKit, our webview on
// macOS and Linux, never did. Hiding it puts Chromium on WebKit's path.
const scheduling = (navigator as { scheduling?: object }).scheduling;
if (scheduling && "isInputPending" in scheduling) {
  Object.defineProperty(scheduling, "isInputPending", { value: undefined, configurable: true });
}
