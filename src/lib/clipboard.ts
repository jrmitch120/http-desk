// The clipboard, for the app's own edit menu (src/lib/editMenu.ts) and Linux's
// native Edit menu.
//
// Both directions go through Tauri's clipboard plugin, not `navigator.clipboard`.
// Reading that way is unreliable in the webviews (WKWebView shows its own "Paste"
// callout and waits for a second click, WebView2 asks for a permission, WebKitGTK
// may refuse). Writing that way works only during an in-page click, and a native
// menu click reaches the page as an IPC event. The plugin reads and writes the OS
// clipboard directly; the app grants only its `allow-read-text` and
// `allow-write-text` permissions.
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/** The clipboard's text, or "" when it holds none (or can't be read). */
export async function readClipboard(): Promise<string> {
  try {
    return (await readText()) ?? "";
  } catch {
    return "";
  }
}

/** Puts `text` on the clipboard. Rejects if it can't be written. */
export function writeClipboard(text: string): Promise<void> {
  return writeText(text);
}
