# Owned controls instead of native form widgets

The app's own UI uses HttpDesk's own controls (dropdown, checkbox, segmented control, number field, tooltip, popups) instead of native `<select>`, checkbox, radio, `type="number"`, `<datalist>` and `title` tooltips. Native widgets render with each OS webview's chrome (WebView2, WKWebView, WebKitGTK), so the same screen looked different on each platform and clashed with the custom theme, and some webviews ignored option styling such as method colours. We accept the cost of rebuilding keyboard behaviour and ARIA roles ourselves so that the canvas is identical everywhere. A test in the frontend suite fails if a native widget appears anywhere in the app's sources, the shared controls included; there is no exemption.

Context menus are owned controls too: the webview's (OS) menu never shows. Text fields get the app's own edit menu (Cut, Copy, Paste, Select all, then the field's own items), other UI the app's own menus or none, and an e2e test right-clicks each kind of field to check. Cut, Copy and Paste use the clipboard through Tauri's clipboard plugin, because the webviews' clipboard API asks the user first or refuses (and, for Linux's native Edit menu, a menu click isn't an in-page click).

The focus mark is owned too. The app decides itself whether keyboard focus is drawn: a key press turns it on, a mouse press turns it off, and every control styles from that instead of the webview's `:focus-visible`. macOS's system webview doesn't match `:focus-visible` when a script moves focus after a mouse click, so arrowing through the Explorer moved focus that nothing drew, while Playwright's WebKit build drew it and the tests passed. A focused row shows a ring, separate from a selected row's fill and a hovered row's lighter fill. A frontend test fails if `:focus-visible` appears anywhere in the app's sources.

Platform differences that users expect (modifier glyphs, menu and file-manager wording, window chrome) stay native on purpose; only the canvas is unified.

## Considered options

- **Style the native widgets with CSS.** Rejected: dropdown popups, option lists, number spinners and OS tooltips can't be styled consistently across the three webviews.
- **Adopt a third-party component library.** Rejected: it would bring its own visual language and bundle weight, and the set we need is small.
