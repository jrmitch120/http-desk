# Controls

HttpDesk draws its own controls instead of using native form widgets, so every screen
looks and behaves the same in WebView2, WKWebView and WebKitGTK
([ADR-0002](adr/0002-owned-controls-over-native-widgets.md)). This page lists them: what
each one is for, its variants, and which one to pick. Build new screens from these. If
none fits, add a control here rather than styling a one-off in a screen.

Components live in `src/components/`, actions in `src/lib/popup/`. The props below are
the ones that matter when choosing; each component's `Props` interface has the rest.

## The rule, and the test that enforces it

Never use a native `<select>`, `<input type="checkbox">`, `<input type="radio">`,
`<input type="number">`, `<datalist>`, or a `title=` tooltip. That includes building
them from TypeScript (`createElement("select")`, `el.title = …`, a CodeMirror decoration
with a `title` attribute). `src/guardrail/native-widgets.test.ts` scans every app source
file and fails on any of them. There is no allowlist and no exemption, not even inside
the owned controls themselves.

What it doesn't flag: component props named `title` (`<Modal title=…>`), an
`<iframe title>` (its accessible name), SVG `<title>` elements, and CSS selectors.
`<input type={expr}>` isn't checked, because the type isn't constant; use it only for
text/password switches, never to slip a checkbox or number past the test.

Also not native: confirmation and text prompts go through `app.choose(...)` and
`app.prompt(...)` (rendered by `Dialog.svelte`), never `window.confirm` or `window.prompt`.

## Picking a control

| You need | Use |
|---|---|
| One of 2–8 short, fixed options, all visible | [SegmentedControl](#segmentedcontrol) |
| One value from a longer, dynamic or custom list, or a choice in a grid cell | [Select](#select) |
| Commands, or a button that opens a list of choices applied at once | [Menu](#menu) |
| Turning a setting or a whole request section on or off | [Toggle](#toggle) |
| Including rows or items in a set (enable a row, pick operations), or an option sentence in a form | [Checkbox](#checkbox) |
| A number with limits and a unit | [NumberField](#numberfield) |
| Free text, paths, or values with their own syntax (`30s`) | [`.input`](#buttons-inputs-and-links) |
| Text with suggested values from a fixed list | [`use:suggestions`](#usesuggestions) |
| A box that narrows what a panel shows | [FilterField](#filterfield) |
| A list of name/value rows | [KeyValueGrid](#keyvaluegrid) |
| Two panes the user can resize | [SplitPane](#splitpane) |
| A short label next to an item (method, status, OFF, version) | [Badge](#badge) |
| A message about the state of a screen | [Banner](#banner) |
| The outcome of something the user just did | toast (`app.toast(kind, message)`) |
| Extra text on hover or focus, or the label of an icon-only button | [Tooltip](#tooltip) |
| A window over the app | [Modal](#modal-and-dialog), or `app.choose` / `app.prompt` |
| Anything else that floats | [`use:popup`](#popup-layer) |

## Selection

### SegmentedControl

`SegmentedControl.svelte`, with `type SegmentedOption` from its module script. A row of
pill buttons for one exclusive choice; an ARIA `radiogroup` of `radio` buttons.

- Props: `options` (`{ value, label, icon?, count? }[]`), `value`, `onchange(value)`,
  `label` (the group's accessible name, required), `disabled?`.
- `count` shows a number after the label and is part of the option's name ("Headers 4").
  Leave it out and nothing shows; pass `0` only where an empty option says something
  (a response with no headers), so empty tabs don't fill up with zeros.
- One look and one size, on purpose: every switch in the app (body type, the response
  viewer's tabs, response view, Settings theme and layout, OpenAPI source and grouping)
  must match.
  `e2e/segmented-control.spec.ts` compares their computed styles, so don't restyle one
  from its parent.
- Keyboard: Tab reaches the checked option; arrows and Home/End move and select (wrapping).
- Controlled: it never changes `value`; set it in `onchange`.
- `disabled` shows the choice but doesn't let it change: the options are dimmed and
  skip clicks and keys. The response view uses it while filter matches are showing,
  since they're always pretty-printed. Put a tooltip on a wrapper to say why.
- It wraps onto a second row when narrow. Past about eight options, or with long labels,
  use a Select.

### Select

`Select.svelte`, with `type SelectOption` from its module script. A dropdown: the trigger
is a select-only `combobox` button, and the `listbox` opens in the popup layer.

- Props: `options` (`{ value, label, color? }[]`), `value`, `onchange(value)`, `label`
  (accessible name of the trigger and the list, required), `create?`, `size?`, `mono?`,
  `tooltip?`, `class?`.
- Variants:
  - `size="md"` (default, `--control-h`) for toolbars and forms; `size="sm"`
    (`--control-h-sm`) inside grid cells (multipart part type).
  - `mono` for code-like values (HTTP methods).
  - `color` per option colours the option and the trigger value (methods pass
    `var(--m-get)` and so on).
  - `create(query)` offers a `Use <value>` item when the typed text matches no option
    (the method dropdown's custom methods); return `null` to offer nothing.
  - Borderless (the top bar's environment picker): the caller sets `border-color` and
    `background` to `transparent` through `class`.
- Width belongs to the caller: pass `class="x"` and style `.parent :global(.x)`. Don't
  target Select's internal class names.
- `openList()` (through `bind:this`) opens the list from code, focusing the trigger as a
  click would. The send error panel's "Choose environment" uses it, through the store's
  `app.chooseEnvironment()`.
- Keyboard: Enter, Space or the arrows open it; typing filters (case-insensitive, anywhere
  in the label); arrows, Home/End and PageUp/PageDown move; Enter picks; Escape and Tab
  close without a change. Focus stays on the trigger throughout.
- A value that matches no option still shows (as its raw text), so a stale or custom
  value is visible.

### Menu

`ContextMenu.svelte`, driven by `menu` in `src/lib/menu.svelte.ts`. A `menu` of
`menuitem`s for commands; it is mounted once in `App.svelte`.

- `menu.show(event, items, options?)`. `MenuItem` is `{ label, icon?, action, danger?,
  disabled?, separator?, checked? }`.
- Variants:
  - Context menu: call `menu.show(e, items)` from `oncontextmenu`; it opens at the
    pointer, or under the element when opened from the keyboard (Shift+F10).
    Editors keep the webview's own menu, except the response body editor for JSON
    bodies (Copy, Select all, Copy path). It uses the Editor's `caretForMenu(e)`, and
    Shift+F10 there opens the menu at the caret (`openMenuAtCaret()`).
  - Menu button: pass `{ anchor: button, label }`. It opens under the button, a click on
    the button isn't "outside", and focus returns to it. Set `aria-haspopup="menu"` and
    `aria-expanded={menu.isOpenFrom(button)}` on the button, and close a second click
    with `menu.close(false)` (the top bar's theme button).
  - Choice items: give every item a `checked` boolean. They become `menuitemradio`s with a
    check on the current one, and the menu opens focused on it.
  - `danger` for destructive commands.
- Use a menu when picking an item does something now. For a value in a form, use a
  Select.

### Toggle

`Toggle.svelte`. An on/off `switch`.

- Props: `checked`, `onchange(next)`, `label?` (visible text after the switch),
  `ariaLabel?` (the name when there's no visible label), `title?` (tooltip text; by
  default it says what a click does).
- Use for a setting that applies at once (Settings, request settings) and for a whole
  request section (`SectionBar.svelte` wraps it in the Params / Headers / Auth / Body
  header bar).

### Checkbox

`Checkbox.svelte`. A tri-state `checkbox` button.

- Props: `checked`, `onchange(next)`, `indeterminate?` (mixed state; wins over
  `checked`), `label?` (accessible name for a bare box), `children?` (a visible label
  inside the button, part of the click target), `tooltip?`, `class?`.
- Variants: a bare box with `label` (grid rows: `Enable <name>`, `Enable all`); a labelled
  row with children (OpenAPI operations, "Substitute {{variables}} inside the file"); a
  mixed "all" box with `indeterminate`. Clicking a mixed box checks it.
- Keyboard: Space toggles; Enter does nothing, as natively.
- Use for membership in a set. For a setting that applies at once, use a Toggle.

## Text and numbers

### NumberField

`NumberField.svelte`. A number in a text field (`inputmode` numeric or decimal), with no
spinners.

- Props: `value`, `onchange(n)`, `label` (accessible name), `unit?` (suffix such as `s` or
  `MB`), `min?`, `integer?`, `disabled?`.
- Applies on blur or Enter, never per keystroke. An invalid value shows an inline error
  (`role="alert"`, linked by `aria-describedby`) and isn't applied; leaving the field
  puts back the last valid value.
- Use for numeric settings. A value with its own syntax, such as a per-request `@timeout`
  (`500 ms`, `2m`), is a plain `.input`.

### use:suggestions

`src/lib/popup/suggestions.svelte.ts`. An action that makes a text `<input>` a
`combobox` with a list of suggested values (header names). It replaces `<datalist>`.

- `use:suggestions={{ options, label }}` on the input itself, so the input keeps its own
  classes, value and `oninput`. With `options: []` it does nothing.
- The list (`SuggestionList.svelte`) looks exactly like CodeMirror's `{{variable}}`
  autocomplete; `e2e/header-suggestions.spec.ts` compares the two, so restyle both or
  neither.
- Keyboard: typing opens it; Up/Down move; Enter or Tab accept (Tab still moves focus on);
  Escape dismisses; Ctrl+Space opens it on demand. Accepting fires an `input` event, so
  the owner sees it as typing.
- For text with structure, pass `source(value, caret)` instead of `options`. It returns
  `{ from, matches }` (or null), each match `{ value, from, to, insert }`; accepting one
  replaces the text from `from` up to the caret with its `insert`. The filter bar's key
  completion uses it (`keyCompletion` in `src/lib/jsonpath.ts`). With a source, the
  input is always a combobox; when a new source arrives while the input is focused, the
  list opens for what's already typed.
- Suggestions are free text: the user can type anything. If only listed values are
  allowed, use a Select.

### FilterField

`FilterField.svelte`. A text field with a filter icon inside it, for narrowing what a
panel shows: the Headers tab's name filter and the Body tab's JSONPath filter bar.

- Props: `value`, `oninput(value)` (the owner keeps the value and decides what typing
  does), `label` (accessible name), `placeholder?`, `mono?` (for expressions),
  `invalid?` with `describedby?` (a danger border, and the id of the inline error),
  `suggest?` (`use:suggestions` options, making it a combobox), `onfocus?`, `onkeydown?`.
- Height `--control-h-sm`. It fills the space its owner gives it (`flex: 1`), so the
  owner sets the width by layout, not a literal size.
- Escape doesn't clear it by itself; an owner that wants that (the JSONPath bar) does it
  in `onkeydown`.

### Buttons, inputs and links

Global classes in `src/app.css`, not components:

- `.btn`: a text button. Variants: `.primary` (the main action of a dialog or form; one
  per footer), `.danger` (red text), `.danger.solid` (confirming something
  irreversible), `.ghost` (no border or background, for toolbars), `.small`
  (`--control-h-sm`, for rows and banners).
- `.icon-btn`: an icon-only button. It needs an `aria-label` and gets its tooltip from it
  (`use:tooltip`). `.active` marks a pressed state; pair it with `aria-pressed`.
- `.link`: a button that reads as a link.
- `.copyable`: a `<button>` showing a value as plain text that copies it on click, with a
  toast and a `use:tooltip={"Click to copy"}` (response header and cookie values). Its
  accessible name is the value. The click is the `use:copyable={{ value, copied }}`
  action (`src/lib/copyable.ts`; `copied` is the toast). The text stays selectable; the
  action skips the copy when the click ended a drag that selected part of it.
- `.data-table`: the scrolling wrapper of a table of rows in a response tab (headers,
  cookies, the sent request). Inside it, `td.k` is a bold name column sized to its
  content, `td.v` a monospace value column, and `th` heads columns where a table has
  them.
- `.input`: a single-line text field or a `<textarea>`; `.mono` for code-like values.
  Focus shows `--focus-ring`.
- `Icon.svelte`: stroke icons by name; the names are the keys of `paths` in that file.
  Icons are `aria-hidden`, so the button around them carries the name.

## Lists and layout

### KeyValueGrid

`KeyValueGrid.svelte`, with types `Column`, `CustomColumn` and `GridCell` from its
module script. The one editor for name/value rows: query params, headers, File
variables, form-urlencoded fields, multipart parts and environment variables.

- A trailing ghost row becomes a real row when you type in it. The `"delete"` column
  gives each row a delete button with a tooltip. Bulk edit shows the rows as text
  (`name: value` by default, `name=value` with `separator="="`; a `//` prefix disables
  a row when rows have `enabled`).
- `columns` picks columns left to right: `"enable"`, `"name"`, `"value"`,
  `"description"`, `"delete"`, a built-in with a width (`{ id: "name", width: "34%" }`),
  or a custom column `{ id, header, width, cell }`, whose `cell` snippet gets
  `{ row, index, ghost, set }`. Always write through `set(patch)`. Inputs given
  `class="cell"` look like the built-in cells. A custom column with `id: "value"`
  replaces the value input.
- Other props: `items` (bindable), `blank` (a new empty row), `carry` (fields bulk text
  can't show, kept by name), `label` (the grid's `group` name), `sectionEnabled`,
  `namePlaceholder`, `valuePlaceholder`, `suggestions`, `nameError`, `visible` (a row
  filter), `bulkEdit` (default on), `showDescriptions` (default on), `onchange(items)`.
- How it's configured today:
  - Params and headers: enable, name, value, description, delete. Headers add
    name suggestions.
  - File variables: name, value, delete.
  - Form fields and multipart parts: enable, name, value, delete. A disabled field is
    kept as `#~` lines in the body text (ARCHITECTURE §5). Multipart adds a part type
    Select and a content type column.
  - Environment variables: a custom value column (a password input with a reveal button
    for Secrets), a Secret lock column, and a search filter (`visible`). Bulk edit is
    off, because it would show Secret values as plain text.
- The description sub-row only shows with `showDescriptions`; the request editor passes
  Settings' "Show parameter descriptions".

### SplitPane

`SplitPane.svelte`. Two panes and a `separator` between them: the sidebar, and the
request/response split.

- Props: `size`, `limits` (`PaneLimits` from `src/lib/panes.ts`: `min`, `max`, `initial`,
  `step`), `ratio?` (size is a 0–1 share instead of px), `stacked?` (one pane above the
  other), `label` (the separator's accessible name), `onresize(size)`, and `first` /
  `second` snippets.
- Drag it, or focus it and use the arrow keys (Home/End go to the limits).
  Double-clicking resets it to `initial`.
- Controlled: store the size (both splits keep theirs in AppSettings) and pass it back.

### Modal and Dialog

`Modal.svelte` is the window for Settings, Environments and OpenAPI import: props
`title` (also its accessible name), `onclose`, `width?`, `height?`, `children`,
`footer?`. Escape closes it, Tab stays inside it, and focus returns to where it was.
Closing it (Escape, the backdrop, the close button) blurs the focused field first, so a
field that applies on blur keeps what was typed.
Popups opened inside a modal close first on Escape.

For a question or a confirmation, don't build a modal: call `app.choose(title, message,
buttons)` or `app.prompt(title, value, placeholder?)`, which render `Dialog.svelte`.

## Status

### Badge

`Badge.svelte`. A small pill; every badge shares one font, radius and padding per size,
and only the colour changes.

- Props: `method?` (colour from the method; the text unless children are given),
  `status?` (colour from the status class; pass the text as children), `tone?` (`neutral`
  by default, `success`, `danger`), `size?` (`sm` by default, `md`),
  `class?`.
- `sm` sits in lists and tabs (method badges, OFF on a section tab); `md` sits in headers
  (response status, Cancelled, spec version). Method badges are six letters wide, and
  Badge cuts longer methods to six, so lists line up. To show a method in full, pass it
  as children too (`<Badge method={m}>{m}</Badge>`): the colour still comes from
  `method`, the text is not cut, and the badge grows past six letters. The OpenAPI
  importer does this, since a spec can hold any method name.
- Badge takes no tooltip. To explain one, wrap it in a `<span use:tooltip={text}>`.

### Banner

`Banner.svelte`. A message about the screen's current state: a file changed on disk, a
private env file isn't git-ignored, TLS checks are off, a send failed.

- Props: `severity` (`warning`, `error`, `info`), `inline?`, `heading?` (a bold first
  line), `actions?` (a snippet of `.btn.small` buttons at the end), `class?`, `children`.
- Default is a full-width strip under a toolbar; `inline` is a boxed banner inside
  content (modals, panels). Margins belong to the caller (`class` plus `:global`).
- Errors are `role="alert"`; warnings and info are `role="status"`.
- For the outcome of an action ("Saved", "Could not save settings"), use a toast
  instead.

## Floating UI

### Popup layer

`src/lib/popup/`. Everything that floats renders into one layer at the end of `<body>`
(z-index 400, above modals and toasts) with one surface style (`.popup-surface` and the
`--popup-*` tokens in `app.css`). Select lists, menus, header suggestions, tooltips and
CodeMirror's tooltips and autocomplete all use it.

To build a new popup, use the `use:popup` action (`popup.ts`) on an element with
`class="popup-surface"`, inside an `{#if open}` block where it is the only top-level node.
Options: `anchor` (an element, or a fixed rect such as a pointer position), `align`,
`gap`, `matchWidth`, `onclose(reason)` with `"escape"`, `"outside"` or `"blur"`.
It places the element below the anchor (above when only that fits), keeps it on
screen, follows the anchor, and closes on Escape (only the most recently opened popup,
and the modal underneath doesn't see the key), on a click outside, and when the window
loses focus. The caller owns roles, ARIA,
keyboard handling, the open flag and focus. See the comments in `popup.ts` and
`layer.ts`.

### Tooltip

`use:tooltip` (`src/lib/popup/tooltip.svelte.ts`), shown by the one
`TooltipHost.svelte` mounted in `App.svelte`. It replaces `title=`.

- `<button class="icon-btn" aria-label="Refresh" use:tooltip>`: the text is the
  aria-label.
- `<span use:tooltip={text}>`: explicit text, linked as the element's description.
  A `\n` in the text starts a new line (e.g. the status pill: explanation, then version
  and final URL).
- `use:tooltip={null}` or `""`: none. A component forwarding an optional tooltip prop
  passes `prop ?? null`, because `undefined` means "use the aria-label".
- Components can't take `use:`, so owned controls that wrap a button expose a prop
  (`Select tooltip=`, `Checkbox tooltip=`, `Toggle title=`).
- It shows after 400 ms on hover or keyboard focus. Any key, a scroll or leaving the
  window hides it; Escape hides it without being consumed.
- A tooltip on an element that can't take focus (a span) is only reachable with a
  pointer, so don't put anything essential only there.

## Tokens

New controls use the tokens in `src/app.css` `:root` rather than literal sizes:
`--control-h` (30px), `--control-h-sm` (24px) and `--control-h-icon` (26px) for heights;
`--space-1` to `--space-6` and `--space-8` (4px to 32px on a 4px grid) for spacing, and
also for the size of small fixed elements that are not controls (a badge's height, a
Toggle's track); `--radius` and `--radius-sm`;
`outline: var(--focus-ring); outline-offset: var(--focus-ring-offset)` on
`:focus-visible` for focus (a control flush against an edge that clips, such as a tab
in the scrolling tab strip, uses `outline-offset: var(--focus-ring-inset)` so none of
the ring is cut off); and the `--popup-*` tokens for floating surfaces. Colours
come from the theme tokens (`--panel`, `--border`, `--text`, `--accent`, `--danger` and
so on; `--on-accent` for text and marks on a solid accent or danger fill), so a control
works in the light and dark themes without its own rules.
