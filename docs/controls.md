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
| A single-line value that can hold `{{variables}}` | [VarField](#varfield) |
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

- Props: `options` (`{ value, label, color?, note? }[]`), `value`, `onchange(value)`, `label`
  (accessible name of the trigger and the list, required), `create?`, `size?`, `mono?`,
  `tooltip?`, `class?`.
- Variants:
  - `size="md"` (default, `--control-h`) for toolbars and forms; `size="sm"`
    (`--control-h-sm`) inside grid cells (multipart part type).
  - `mono` for code-like values (HTTP methods).
  - `color` per option colours the option and the trigger value (methods pass
    `var(--m-get)` and so on).
  - `note` per option adds a short muted remark after it in the list (not on the
    trigger). The environment picker marks names the active request's folder doesn't
    define with "not defined for api/".
  - `create(query)` offers a `Use <value>` item when the typed text matches no option
    (the method dropdown's custom methods); return `null` to offer nothing.
  - Borderless (the top bar's environment picker): the caller sets `border-color` and
    `background` to `transparent` through `class`.
- Width belongs to the caller: pass `class="x"` and style `.parent :global(.x)`. Don't
  target Select's internal class names.
- `openList()` (through `bind:this`) opens the list from code, focusing the trigger as a
  click would. The send error panel's "Choose environment" and the ⌘⌥E (macOS) /
  Ctrl+Alt+E (Windows, Linux) shortcut use it, through the store's
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
  disabled?, separator?, checked? }`. `options.onclose` runs when the menu closes,
  before a picked item's action.
- Variants:
  - Context menu: call `menu.show(e, items)` from `oncontextmenu`; it opens at the
    pointer, or under the element when opened from the keyboard (Shift+F10).
    Editors keep the webview's own menu, except the response body editor for JSON
    bodies (Copy, Select all, Copy path), and a right-click on selected text in a
    variable-aware editor (Cut, Copy, Extract to variable…; see
    [VarField](#varfield)). The body editor uses the Editor's `caretForMenu(e)`, and
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

### VarField

`src/lib/codemirror/VarField.svelte`. A single-line, variable-aware text field: `{{name}}`
is marked by state, hovering one shows the variable's card (value, Secrets masked, and
where it is defined), and typing `{{` offers the names in scope. It is the URL bar's
editor generalised (both build on `singleLineExtensions` in
`src/lib/codemirror/setup.ts`). Every field that can hold a variable uses it: param and
header values, the Authorization fields, form and multipart values (and file part
paths), File variable values and environment values.

- Props: `value`, `onchange(value)` (every edit, with the whole text), `variables?` (a
  `VarProvider`; without one the field is plain text), `placeholder?`, `label?`
  (accessible name), `onenter?`, `masked?`, `invalid?` (sets `aria-invalid`; the owner
  shows the error and the red border), `class?`. Through `bind:this`, `focus()`.
- `masked` is password mode (an auth password or token, a Secret in the Environments
  modal): the text is drawn as discs (`-webkit-text-security` in the editor, `•`
  characters in the static rendering), nothing is marked and no hover card opens, so
  neither gives the text away, and copy, cut and drag are blocked. `{{` autocomplete
  still works. The owner's reveal button turns it off.
- On a field styled as an `.input` (the Authorization fields), app.css gives it the
  input's focus border; a press on its padding focuses it, as in an input.
- Cheap enough for hundreds of rows: without focus it is a static rendering of the text
  (a focusable `textbox` with the same marks and hover cards), and the CodeMirror editor
  exists only while it has focus. The two line up to the pixel, so focusing doesn't
  shift the text.
- Keyboard: like a text input. Tab and Shift+Tab move focus on (Tab into it selects the
  text), arrows move the caret, Enter runs `onenter` or does nothing, ⌘/Ctrl+Enter
  reaches the app's Send shortcut unless `onenter` takes it. When the `{{` list is open,
  Up/Down, Enter and Escape go to the list; otherwise Escape reaches the owner, so a
  [Modal](#modal-and-dialog) closes as it would from an input.
- A click puts the caret, or starts a drag selection, where it lands.
- It never holds a line break: typed or pasted line breaks are removed with the
  whitespace around them, so a pasted wrapped token joins up (the save-time
  single-line safeguard in ARCHITECTURE §2 never sees one).
- While it has focus the editor owns the text; a `value` change from elsewhere shows
  once focus leaves.
- It sets no padding, font or border: the owner gives those through `class` (a grid
  passes `cell`). The text colour is inherited too, so a grid's disabled row dims it.
- Marks are the editors' `cm-var` classes: `cm-var-ok` (defined), `cm-var-bad`
  (Undefined variable, red with a wavy underline), `cm-var-dyn` (dynamic), `cm-var-circular` (a circular
  reference), `cm-var-prompt` (an unanswered Prompt variable), plus `cm-var-secret` on a defined value with a Secret in it. The hover card is `varCard` in `setup.ts`, shared with the URL bar and the
  body editor, so change it there.
- The hover card shows the resolved value and where it comes from ("this file",
  "this request", `environment "staging"`, "shared variables", or a prompt). An
  unanswered Prompt variable shows "Asked when sent". A Secret, a masked prompted
  value, or a value either went into, is masked until **Reveal**, in that card only. **Edit** opens the
  definition's row when the app has one: a File variable at the top of the file in
  the request's Settings section, one declared in a request block at its line in that
  request's `.http` source (the request's own, else the last request declaring it; its
  tab comes forward), an environment's variable in the Environments modal
  on that environment (or the shared variables), in the folder whose env files supply
  the value (`Definition.dir`; the modal switches folders for an inherited value). It comes from the provider's `edit`
  (the request editor wires it to `app.editDefinition`; the Environments modal sets
  `app.definitionWanted`, so Edit switches to the supplying environment or the shared
  variables in place), and the info's `definition`;
  a dynamic or an Undefined variable has none. **Find usages**
  (any name not starting with `$`, defined or not) comes from the provider's
  `findUsages` (the request editor wires it to `app.findUsages`; the Environments modal
  has none): it lists every reference in the workspace in the sidebar, see
  [ARCHITECTURE.md](ARCHITECTURE.md#find-usages). A press in the
  card keeps focus where it was, so an editor (and its card) stays open.
- Autocomplete lists the names in scope, each with its source (file, environment,
  shared, prompt; a Prompt variable takes the entry of a name it overrides) and a short preview of its resolved value ("secret" instead of a Secret's),
  then every dynamic variable with its argument hint and a description. The list is
  `crates/httpdesk-core/dynamic-variables.json`, which a core test keeps equal to what
  the core generates. One that needs its argument (`$processEnv`, `$dotenv`, `$env.`)
  leaves the caret before `}}`.
- **Extract to variable**: with text selected, ⌘⌥V (macOS) / Ctrl+Alt+V (Windows,
  Linux, as in JetBrains), or a right-click on the selection (a menu of Cut, Copy and
  Extract to variable…; Shift+F10 opens it under the selection), opens the Extract to
  variable form (`ExtractVariable.svelte`, from `app.extractVariable`). It asks for a
  name (the File variable name rule, and no leading `$`) and where it goes: a File
  variable (`@name = value` at the top of the file, or a new value for the File
  variable of that name the request uses), the selected environment, or all
  environments (same value in each; a same-named variable gets the new value and a
  Secret stays a Secret). It warns when the destination already has the name. Env
  files are written at once; the field then puts `{{name}}` in place of the selection,
  an ordinary edit that shows as unsaved. It comes from the provider's `extract` (the
  request editor wires it; the Environments modal has none, so it isn't offered there),
  the URL bar and the body editor get it too (one-line selections only), and a
  `masked` field never offers it. Without a selection, or on a right-click outside it,
  the webview's own menu stays. While the menu or form is open a VarField keeps its
  editor, so the answer lands in the same selection (`extractHolds` in
  `src/lib/codemirror/extract.ts`).
- In a [KeyValueGrid](#keyvaluegrid), pass `variables` and the built-in value cells
  become VarFields. In a custom value cell, render `<VarField class="cell" …>` and write
  through `set`.
- In e2e tests, `fill()` and `toHaveValue()` don't work on it: click the cell, type with
  `page.keyboard`, and assert `toHaveText()` on the cell (static or editing).

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
panel shows: the Headers tab's name filter and the Body tab's JSONPath filter bar. With
`icon="search"` it is the Find field of the editors' find bar
(`src/lib/codemirror/FindBar.svelte`), which replaces CodeMirror's default search panel
because that one builds native checkboxes at runtime. An invalid regular expression there
gets `invalid` plus an inline message named by `describedby`, like the JSONPath bar.

- Props: `value`, `oninput(value)` (the owner keeps the value and decides what typing
  does), `label` (accessible name), `placeholder?`, `icon?` (`filter`, the default, or
  `search`), `mono?` (for expressions),
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
  `.glyph` shows a short monospace text glyph in place of the icon, for toggles that are
  conventionally text (the find bar's `Aa`, `.*`, `ab`); the `aria-label` still names it.
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
- `.input`: a single-line text field or a `<textarea>`; `.mono` for code-like values,
  `.small` (`--control-h-sm`) beside `.btn.small` buttons and in bars (FilterField uses it).
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
  `{ row, index, ghost, set, column }` (`column` is the column's id, so one snippet
  can serve several columns). Write through `set(patch)`, unless the rows are a view
  of other state that the cell edits directly (the Environments matrix). Inputs given
  `class="cell"` look like the built-in cells. A custom column with `id: "value"`
  replaces the value input, and one with `id: "name"` replaces the name input.
- Other props: `items` (bindable), `blank` (a new empty row), `carry` (fields bulk text
  can't show, kept by name), `label` (the grid's `group` name), `sectionEnabled`,
  `namePlaceholder`, `valuePlaceholder`, `suggestions`, `nameError`, `visible` (a row
  filter), `bulkEdit` (default on), `addRows` (the ghost row, default on),
  `showDescriptions` (default on), `onchange(items)`,
  `variables` (makes the built-in value cells [VarFields](#varfield)). Through
  `bind:this`, `focusValue(row)` puts focus in a row's value cell (a hover card's Edit
  lands there).
- How it's configured today:
  - Params and headers: enable, name, value, description, delete. Headers add
    name suggestions. Values are VarFields.
  - File variables: name, value, delete. Values are VarFields with the request's
    variables, so `{{host}}/api` resolves in the hover card.
  - Form fields and multipart parts: enable, name, value, delete. A disabled field is
    kept as `#~` lines in the body text (ARCHITECTURE §5). Multipart adds a part type
    Select and a content type column. Values (and file part paths) are VarFields.
  - Environment variables: a custom value column (a VarField, masked for a Secret,
    with a reveal button), a Secret lock column, and a search filter (`visible`). The
    VarFields see the environment being edited, as edited, plus the shared variables
    (not the environment selected in the top bar). Bulk edit is off, because it would
    show Secret values as plain text.
  - The Environments matrix (`EnvironmentMatrix.svelte`): one row per variable name,
    a read-only name column, one VarField column per environment plus Shared (built
    from the set, with positional ids `m0`, `m1`…), and a row actions button.
    No ghost row (`addRows={false}`) and no bulk edit. Each cell has its own Secret
    lock (and a reveal button when it's a Secret), and a gap is tinted. Rows are
    stable objects per name, so an edit doesn't remount the row and drop focus.
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
`footer?`. Escape closes it (unless a field inside it took the key, e.g. to close its
`{{` list), Tab stays inside it, and focus returns to where it was.
Closing it (Escape, the backdrop, the close button) blurs the focused field first, so a
field that applies on blur keeps what was typed.
Popups opened inside a modal close first on Escape.

For a question or a confirmation, don't build a modal: call `app.choose(title, message,
buttons)` or `app.prompt(title, value, placeholder?)`, which render `Dialog.svelte`.
A dialog can also hold a short form (`DialogState.fields`: label, help text, masked):
each field has a reveal button, Enter in any field picks the primary button, and the
values come back in order as `values`. The Prompt variables form uses it.
A form that needs a choice or checks its input as you type (Extract to variable:
a name, a [SegmentedControl](#segmentedcontrol) for where it goes, an inline error and a
warning Banner) is its own small `Modal` with Cancel and a primary button that stays
disabled until the input is valid; Enter in its text field picks the primary button.

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

### CheckStrip

`CheckStrip.svelte`. The pre-send checks above a request's sections: one entry per
problem the request would be sent with, each with its quick fixes as `.btn.small.ghost`
buttons under the message. Today every entry is an Undefined variable ("`{{token}}` is
undefined, used in Headers and Authorization"; ARCHITECTURE §10).

- Props: `checks` (`Check[]` from `src/lib/checks.ts`; empty renders nothing) and
  `onfix(check, fix)`. It is a `region` named "Pre-send checks", with a list item per
  entry. It never blocks sending.
- Warning-toned and boxed like an inline [Banner](#banner), but a list: a Banner is one
  message with one set of actions. More than three entries scroll inside it.
- A new kind of check is a new `Check` variant, rendered in its own `{#if check.kind}`
  branch, with its own fixes.

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
Toggle's track); `--bar-pad-y`, `--bar-pad-start` and `--bar-pad-end` for the inset shared
by the bars above the response body (its toolbar, the JSONPath filter row, the editor's
find bar), so their edges line up; `--radius` and `--radius-sm`;
`outline: var(--focus-ring); outline-offset: var(--focus-ring-offset)` on
`:focus-visible` for focus (a control flush against an edge that clips, such as a tab
in the scrolling tab strip, uses `outline-offset: var(--focus-ring-inset)` so none of
the ring is cut off); and the `--popup-*` tokens for floating surfaces. Colours
come from the theme tokens (`--panel`, `--border`, `--text`, `--accent`, `--danger` and
so on; `--on-accent` for text and marks on a solid accent or danger fill), so a control
works in the light and dark themes without its own rules.
