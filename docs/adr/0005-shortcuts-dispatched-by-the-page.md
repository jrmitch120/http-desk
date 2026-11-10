# App shortcuts are dispatched by the page, not the native menu

Every app command (Save, Send, Close Tab, New Request…) is run from the page's own `keydown` handler through the command registry, on every OS. The native menu shows the shortcuts and runs the same commands when an item is clicked, but it is never the main way a key reaches a command. We chose this because Tauri's menu accelerators behave differently on each OS while the webview has focus, and only the page sees every key the same way everywhere. That lets one code path enforce the focus and open-modal rules (#15, #74), and lets the browser tests exercise shortcuts.

## How each OS is set up

- **macOS:** menu items carry real key equivalents. WKWebView gives the page the key first, and the page calls `preventDefault()` on every key it handles, so the menu fires only for keys the page ignored. A menu activation still goes through the registry, which checks `enabled()` before running.
- **Windows:** menu items show their shortcut in the label only (`"Save\tCtrl+S"`) and bind nothing. Tauri's accelerators don't fire while WebView2 has focus (tauri-apps/wry#451, open).
- **Linux:** app commands get no menu accelerator, so the menu shows no shortcut for them. GTK runs window accelerators before the focused widget, so a bound accelerator would take the key away from the page and skip its focus rules. Edit items are the app's own (Cut, Copy, Paste and Select all reuse the edit context menu's actions), because muda's predefined Undo/Redo are unsupported on GTK and its Cut/Copy/Paste need libxdo, which doesn't work on Wayland.
- **Edit on macOS and Windows** uses muda's predefined items. On macOS they are what make ⌘C/⌘V/⌘Z work in text fields at all.

## Considered options

- **Native menu accelerators everywhere.** Rejected: they don't fire on Windows while the webview has focus, and on Linux they bypass the page's focus and modal rules.
- **Menu accelerators on macOS and Linux, the page on Windows.** Rejected: two dispatch paths with different focus behaviour, and shortcuts the browser tests can't reach.

## Consequences

- The Linux menu shows no shortcut hints for app commands. The in-app hints and tooltips still show them.
- A shortcut handled by the page must call `preventDefault()`, or on macOS the menu item runs it a second time.
