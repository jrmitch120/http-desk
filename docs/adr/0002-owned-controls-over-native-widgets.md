# Owned controls instead of native form widgets

The app's own UI uses HttpDesk's own controls (dropdown, checkbox, segmented control, number field, tooltip, popups) instead of native `<select>`, checkbox, radio, `type="number"`, `<datalist>` and `title` tooltips. Native widgets render with each OS webview's chrome (WebView2, WKWebView, WebKitGTK), so the same screen looked different on each platform and clashed with the custom theme, and some webviews ignored option styling such as method colours. We accept the cost of rebuilding keyboard behaviour and ARIA roles ourselves so that the canvas is identical everywhere. A test in the frontend suite fails if a native widget appears anywhere in the app's sources, the shared controls included; there is no exemption.

Platform differences that users expect (modifier glyphs, menu and file-manager wording, window chrome) stay native on purpose; only the canvas is unified.

## Considered options

- **Style the native widgets with CSS.** Rejected: dropdown popups, option lists, number spinners and OS tooltips can't be styled consistently across the three webviews.
- **Adopt a third-party component library.** Rejected: it would bring its own visual language and bundle weight, and the set we need is small.
