// The clipboard, for the app's own edit menu (src/lib/editMenu.ts).
//
// Reading goes through Tauri's clipboard plugin, not `navigator.clipboard.readText()`:
// in the webviews that one is unreliable (WKWebView shows its own "Paste" callout and
// waits for a second click, WebView2 asks for a permission, WebKitGTK may refuse).
// The plugin reads the OS clipboard directly; the app grants only its
// `allow-read-text` permission. Writing stays with `navigator.clipboard.writeText()`,
// which every webview allows during a click (a menu item's), as the app's other
// Copy buttons already rely on.
import { readText } from "@tauri-apps/plugin-clipboard-manager";

/** The clipboard's text, or "" when it holds none (or can't be read). */
export async function readClipboard(): Promise<string> {
  try {
    return (await readText()) ?? "";
  } catch {
    return "";
  }
}

export function writeClipboard(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}
