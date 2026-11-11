// First, so CodeMirror finds it when its modules load.
import "./lib/codemirror/parseSlices";
import { mount } from "svelte";
import "./fonts/fonts.css";
import "./app.css";
import App from "./App.svelte";

// Browser-only dev mode with a mocked backend (see src/dev/mock.ts).
if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) await import("./dev/mock");

const app = mount(App, { target: document.getElementById("app")! });

export default app;
