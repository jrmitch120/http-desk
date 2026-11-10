# Manual OS rendering check

Playwright runs the UI tests in Chromium only, but HttpDesk ships in three webviews:
WebView2 (Windows, Chromium-based), WKWebView (macOS, WebKit) and WebKitGTK (Linux,
WebKit, usually the furthest behind). This checklist covers what the automated tests
can't: that each screen looks and behaves the same in all three. See
[controls.md](controls.md) for the controls it refers to.

Run it before a release, and after a change to `src/app.css`, the fonts, an owned
control or the popup layer.

## How to run it

1. On each OS, run the app (`pnpm tauri dev`, or the release bundle). The browser dev
   server (`pnpm dev`) is Chromium or whatever browser you open it in, so it doesn't
   count.
2. Open a workspace with a few `.http` files: a request with query params, headers,
   Bearer auth and a JSON body; one with a form body; one with a multipart body that
   includes a file part. An environment file with a Secret, and an OpenAPI spec to
   import.
3. Go through the screens below in the dark theme, then the light theme, side by side
   with the same screen on another OS (or screenshots of it). Note anything that
   differs, beyond the window chrome and the platform wording that's meant to differ
   (ADR-0002).

## Everywhere

- [ ] Text is Inter and code (URL bar, editors, methods) is JetBrains Mono, at the same
      size and weight on all three. Arrows, ⌘ and other symbols outside the bundled
      Latin subsets come from system fonts; that's expected.
- [ ] Tabbing shows the same 2px blue focus ring on buttons, inputs, switches, checkboxes,
      segmented options and the split separators.
- [ ] Scrollbars (sidebar tree, long response, Settings) are the thin themed ones, not
      the OS default.
- [ ] Hovering an icon-only button shows the styled tooltip after a short delay, never
      an OS tooltip.

## Main window

- [ ] Welcome screen (no workspace open): recent workspaces list and buttons.
- [ ] Top bar: environment Select (open it: themed list, check on the current one; ⌘⌥E /
      Ctrl+Alt+E opens it, also from inside an editor, and on a layout where AltGr+E types
      € it still types €; the window title ends with the chosen environment) and
      the theme menu button (System / Light / Dark with a check; the "A" badge on
      System).
- [ ] Sidebar: tree with method badges lined up, search box with its results list, and
      the context menu on a request (right-click, and Shift+F10).
- [ ] Edit menu: right-click a text input, the URL bar, a value field and the response
      body: the app's menu (Cut, Copy, Paste, Select all), never the OS one. Paste
      something copied in another app into each (no permission prompt or "Paste"
      callout), and Copy from the app into another app.
- [ ] Tab bar: method badges, the unsaved dot, overflow when many tabs are open.
- [ ] Sidebar separator and request/response separator: drag, arrow keys,
      double-click to reset. Same hover highlight on both. Check the vertical layout too.
- [ ] Hide and show the sidebar with ⌘B / Ctrl+B, View → Show Sidebar and the top bar's
      sidebar button: the request area takes the full width, the sidebar comes back at its
      width, and the menu item's tick follows. View → Show Sidebar shows ⌘B on macOS
      (pressing ⌘B toggles once, not twice), Ctrl+B in the label on Windows, and no
      shortcut on Linux. Hidden, it stays hidden after a restart; ⌘P / Ctrl+P shows it
      with the search box focused.

## Request editor

- [ ] Method Select: coloured methods in the list and on the trigger; type `purge` to
      see "Use PURGE"; Escape closes it.
- [ ] URL bar: `{{variable}}` highlighting, the hover tooltip on a variable, and the
      `{{` autocomplete list.
- [ ] Params and Headers: section switch in the header bar, the grid's enable
      checkboxes (including the mixed "Enable all" box), ghost row, delete button,
      descriptions, bulk edit. The header-name suggestions list looks like the URL bar's
      autocomplete.
- [ ] Section tabs: counts, and the OFF badge on a disabled section.
- [ ] Auth: "Authorization type" and "Add to" Selects, the password field.
- [ ] Body: the body type segmented control (and its wrap onto two rows when the pane is
      narrow), the JSON editor with the syntax warning banner, the form grid, the
      multipart grid with its small part type Select, and a file body with its
      "Substitute {{variables}}" checkbox.
- [ ] Request settings: switches, the per-request timeout fields, File variables grid.
- [ ] Banners: change the open file on disk (external change banner with buttons), and
      delete it (orphaned tab banner).

## Response viewer

- [ ] Status badge colours (2xx, 4xx, 5xx), time and size metrics.
- [ ] Body / Headers / Cookies / Timing / Request segmented control: the header count on
      Headers, a cookie count on Cookies only when the response set cookies (and its
      "This response set no cookies" empty state when it didn't), the Timing waterfall,
      and the Request tab's reconstruction note.
- [ ] Pretty / Raw / Preview segmented control (Pretty only for JSON and XML; no switch for plain text); folding, and the find bar (⌘/Ctrl F) in Pretty.
- [ ] An HTML preview, an image preview, and the hex view of a binary response.
- [ ] A failed send (stop the server): the inline error banner.
- [ ] Toasts: copy the response body, save it to a file.

## Modals

- [ ] Settings: Theme and Layout segmented controls apply live; switches; the number
      fields with a unit (clear one to see the inline error); the TLS-off warning banner;
      Browse… for a certificate path. The theme switch also changes the title bar.
- [ ] Theme: with System chosen, switch the OS between light and dark; the app, the title
      bar and the scrollbars follow.
- [ ] Environments: the variables grid with the Secret lock and show/hide value, the
      search filter, the private-file warning banner, the "Active" badge.
- [ ] OpenAPI import: File / URL switch, the operation list with group checkboxes in the
      mixed state, deprecated operations, the grouping switch, the warnings banner.
- [ ] A confirm dialog (delete a request) and a prompt (rename one).
- [ ] About HttpDesk (app menu on macOS, Help elsewhere), in the light and dark themes:
      the icon, name, version and copyright; Documentation and Release Notes open in
      the browser; Copy copies "HttpDesk <version> (<os> <arch>)" and shows a toast.
      Help → Report an Issue opens a new GitHub issue with the version filled in.
