// First, before any module that loads CodeMirror is evaluated (see the file).
import "./lib/codemirror/parseSlices";
import { mount } from "svelte";
import "./fonts/fonts.css";
import "./app.css";
import App from "./App.svelte";
import { trackFocusMarks } from "./lib/focusMarks";

// Browser-only dev mode with a mocked backend (see src/dev/mock.ts).
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) await import("./dev/mock");

// Every bundled face (src/fonts/fonts.css) is loaded before the UI draws. A face
// first used later, as the monospace italic of a Source view's comments is, loads
// only once an editor has drawn and measured that text in a fallback font, which
// on Linux makes those lines taller; CodeMirror keeps the heights it measured, so
// its gutter drifted below the text and a click landed on the line above. The
// files are local, so this takes a few milliseconds.
await Promise.allSettled([...document.fonts].map((face) => face.load()));

trackFocusMarks();
const app = mount(App, { target: document.getElementById("app")! });

export default app;
