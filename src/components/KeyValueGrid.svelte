<script module lang="ts">
  import type { Snippet } from "svelte";
  import type { BulkRow } from "../lib/http";

  /** What every grid row has. `enabled` is needed for the "enable" column, `description` for "description". */
  export interface GridRow extends BulkRow {
    description?: string;
  }

  /** What a custom cell snippet gets. `set` patches the row; on the ghost row it adds the row first. */
  export interface GridCell<R> {
    row: R;
    index: number;
    ghost: boolean;
    set: (patch: Partial<R>) => void;
  }

  /** The built-in columns. "description" isn't a track: it's a line under the row, wherever it's listed. */
  export type BuiltinColumn = "enable" | "name" | "value" | "description" | "delete";

  /** A column the caller renders. Inputs in it should have `class="cell"` to look like the built-in cells. */
  export interface CustomColumn<R> {
    /** Also the cell wrapper's class, `c-<id>`. */
    id: string;
    header: string;
    /** A CSS grid track size, e.g. `80px` or `1fr`. */
    width: string;
    cell: Snippet<[GridCell<R>]>;
  }

  /** A built-in column by name, a built-in with its own width, or a custom column. */
  export type Column<R> = BuiltinColumn | { id: BuiltinColumn; width: string } | CustomColumn<R>;

  const WIDTHS: Record<BuiltinColumn, string> = { enable: "34px", name: "38%", value: "1fr", description: "", delete: "34px" };
</script>

<script lang="ts" generics="R extends GridRow">
  // The one key/value grid (#36): params, headers, File variables, form fields,
  // multipart parts and environment variables. Columns are opt-in (`columns`),
  // a trailing ghost row turns into a real row as you type, and bulk edit shows
  // the rows as text. Rows are keyed by object, and the ghost row object itself
  // becomes the new row, so its inputs (and focus) survive the change.
  import { untrack } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { formatBulk, KEY_VALUE_ROWS, parseBulk } from "../lib/http";
  import Checkbox from "./Checkbox.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { suggestions as suggest } from "../lib/popup/suggestions.svelte";

  interface Props {
    items: R[];
    /** Left to right. Default: enable, name, value, delete. */
    columns?: Column<R>[];
    /** A new empty row, for the ghost row and bulk edit. Default: an enabled `KeyValue`. */
    blank?: () => R;
    /** Fields bulk-edit text can't show, carried over by name. Default: the description. */
    carry?: (keyof R)[];
    /** Accessible name of the grid (a `group`). */
    label?: string;
    /** Section-level enabled state (rows render dimmed when off). */
    sectionEnabled?: boolean;
    namePlaceholder?: string;
    valuePlaceholder?: string;
    suggestions?: string[];
    separator?: string;
    /** Why a name can't be saved (shown under the row), or null. */
    nameError?: (name: string) => string | null;
    /** Which rows to show (e.g. a search filter). The ghost row and rows added here always show. */
    visible?: (row: R) => boolean;
    /** Offer bulk edit (the rows as text). */
    bulkEdit?: boolean;
    /** Show the "description" column's line under each row (Settings' "Show parameter descriptions"). */
    showDescriptions?: boolean;
    /** Called after every edit made in the grid, with the rows. */
    onchange?: (items: R[]) => void;
  }
  let {
    items = $bindable(),
    columns = ["enable", "name", "value", "delete"],
    blank = KEY_VALUE_ROWS.blank as unknown as () => R,
    carry = KEY_VALUE_ROWS.carry as (keyof R)[],
    label,
    sectionEnabled = true,
    namePlaceholder = "Key",
    valuePlaceholder = "Value",
    suggestions = [],
    separator = ":",
    nameError = () => null,
    visible = () => true,
    bulkEdit = true,
    showDescriptions = true,
    onchange,
  }: Props = $props();

  type Track = { id: string; width: string; header: string; cell?: Snippet<[GridCell<R>]> };

  const tracks: Track[] = $derived(
    columns.flatMap((c): Track[] => {
      const col = typeof c === "string" ? { id: c, width: WIDTHS[c] } : c;
      if (col.id === "description") return [];
      const header = "header" in col ? col.header : col.id === "name" ? namePlaceholder : col.id === "value" ? valuePlaceholder : "";
      return [{ id: col.id, width: col.width || WIDTHS[col.id as BuiltinColumn], header, cell: "cell" in col ? col.cell : undefined }];
    }),
  );
  const hasColumn = (id: BuiltinColumn) => columns.some((c) => (typeof c === "string" ? c : c.id) === id);
  /** Rows have an enable checkbox (and bulk text a `//` prefix). */
  const hasEnable = $derived(hasColumn("enable"));
  const descriptionColumnShown = $derived(hasColumn("description") && showDescriptions);
  const template = $derived(tracks.map((t) => t.width).join(" "));
  /** Where the description and error lines start: under the first column after the checkbox. */
  const subStart = $derived(hasEnable ? 2 : 1);
  /** A cell gets a right border unless only the delete column follows it. */
  const divider = (i: number) => tracks.slice(i + 1).some((t) => t.id !== "delete");

  const newRow = () => blank();
  let ghost = $state(newRow());
  /** Rows typed into the ghost row since `visible` last changed: they stay visible while you type. */
  const added = new SvelteSet<R>();
  let addedUnder = $state.raw<Props["visible"]>();
  const shown = (row: R) => (addedUnder === visible && added.has(row)) || visible(row);
  /** Each shown row with its position in `items`, so hidden rows don't shift indexes. */
  const rows = $derived([...items.map((row, i) => ({ row, i })).filter(({ row }) => shown(row)), { row: ghost, i: items.length }]);

  function changed() {
    onchange?.(items);
  }

  function set(row: R, patch: Partial<R>) {
    if (row === ghost) {
      if (addedUnder !== visible) {
        added.clear();
        addedUnder = visible;
      }
      added.add(row);
    }
    Object.assign(row, patch);
    if (row === ghost) {
      items.push(row);
      ghost = newRow();
    }
    changed();
  }

  function remove(i: number) {
    items.splice(i, 1);
    changed();
  }

  let bulk = $state(false);
  let bulkText = $state("");
  /** Rows as they were when bulk editing started; fields the text can't show are carried over from them. */
  let bulkStart: R[] = [];
  const parse = (text: string, previous: R[]) => parseBulk(text, separator, previous, { blank, carry });

  function toggleBulk() {
    if (!bulk) {
      bulkStart = $state.snapshot(items) as R[];
      bulkText = formatBulk(items, separator, hasEnable);
    }
    bulk = !bulk;
  }

  // Applied on every keystroke, so switching tabs or saving never loses the text.
  function applyBulk() {
    items = parse(bulkText, bulkStart);
    changed();
  }

  // Rows changed elsewhere while bulk editing (e.g. query params typed in the URL bar).
  $effect(() => {
    if (!bulk) return;
    const current = formatBulk(items, separator, hasEnable);
    if (current !== untrack(() => formatBulk(parse(bulkText, []), separator, hasEnable))) {
      bulkStart = $state.snapshot(items) as R[];
      bulkText = current;
    }
  });

  let editing = $state<R | null>(null);
  let draft = $state("");

  function startEdit(row: R) {
    draft = row.description ?? "";
    editing = row;
  }
  function commitEdit() {
    if (editing === null) return;
    const text = draft.replace(/\s+$/, "").replace(/^\s+/, "");
    if (items.includes(editing)) {
      if (text) editing.description = text;
      else delete editing.description;
    }
    editing = null;
    changed();
  }
  function onDescKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      editing = null;
    }
  }
  /** Grows the textarea with its content; focuses with the caret at the end. */
  function autosize(el: HTMLTextAreaElement) {
    const fit = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    fit();
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    el.addEventListener("input", fit);
    return { destroy: () => el.removeEventListener("input", fit) };
  }

  const allOn = $derived(items.length > 0 && items.every((r) => r.enabled));
  function enableAll(on: boolean) {
    items.forEach((r) => (r.enabled = on));
    changed();
  }
</script>

<div class="kv" class:section-off={!sectionEnabled} role={label ? "group" : undefined} aria-label={label}>
  <div class="kv-head" style:grid-template-columns={template}>
    {#if bulk}
      {#if hasEnable}<span class="c-check"></span>{/if}
      <span class="c-hint muted">{hasEnable ? `Bulk edit — one per line, "name${separator} value"; prefix with // to disable` : `One per line, "name${separator} value"`}</span>
    {:else}
      {#each tracks as t (t.id)}
        {#if t.id === "enable"}
          <span class="c-check">
            {#if items.length}
              <Checkbox checked={allOn} indeterminate={!allOn && items.some((r) => r.enabled)} onchange={enableAll} label="Enable all" tooltip="Enable/disable all" />
            {/if}
          </span>
        {:else}
          <span class="c-{t.id}">{t.header}</span>
        {/if}
      {/each}
    {/if}
    {#if bulkEdit}<button class="link bulk" onclick={toggleBulk}>{bulk ? "Key-value edit" : "Bulk edit"}</button>{/if}
  </div>

  {#if bulk}
    <textarea class="bulk-text mono" bind:value={bulkText} oninput={applyBulk} spellcheck="false" rows={Math.max(6, bulkText.split("\n").length + 1)}></textarea>
  {:else}
    {#each rows as { row, i } (row)}
      {@const isGhost = row === ghost}
      {@const error = isGhost ? null : nameError(row.name)}
      <div class="kv-row" class:off={!isGhost && hasEnable && !row.enabled} class:ghost={isGhost} style:grid-template-columns={template}>
        {#each tracks as t, c (t.id)}
          {#if t.id === "enable"}
            <span class="c-check">
              {#if !isGhost}
                <Checkbox checked={!!row.enabled} onchange={(on) => set(row, { enabled: on } as Partial<R>)} label="Enable {row.name || namePlaceholder.toLowerCase()}" tooltip={row.enabled ? "Enabled — will be sent" : "Disabled — kept but not sent"} />
              {/if}
            </span>
          {:else if t.cell}
            <div class="c-extra c-{t.id}" class:divider={divider(c)}>
              {@render t.cell({ row, index: i, ghost: isGhost, set: (patch) => set(row, patch) })}
            </div>
          {:else if t.id === "name"}
            <input
              class="cell c-name"
              class:divider={divider(c)}
              value={row.name}
              placeholder={isGhost ? `Add ${namePlaceholder.toLowerCase()}` : namePlaceholder}
              spellcheck="false"
              aria-invalid={error ? "true" : undefined}
              oninput={(e) => set(row, { name: e.currentTarget.value } as Partial<R>)}
              use:suggest={{ options: suggestions, label: `${namePlaceholder} suggestions` }}
            />
          {:else if t.id === "value"}
            <input class="cell c-value" class:divider={divider(c)} value={row.value} placeholder={valuePlaceholder} spellcheck="false" oninput={(e) => set(row, { value: e.currentTarget.value } as Partial<R>)} />
          {:else if t.id === "delete"}
            <span class="c-del">
              {#if !isGhost}
                <button class="icon-btn" aria-label="Delete" use:tooltip onclick={() => remove(i)}><Icon name="trash" size={13} /></button>
              {/if}
            </span>
          {/if}
        {/each}
        {#if descriptionColumnShown && !isGhost}
          {#if editing === row}
            <textarea
              class="desc desc-edit"
              style:grid-column="{subStart} / -1"
              rows="1"
              bind:value={draft}
              use:autosize
              placeholder="Describe this {namePlaceholder.toLowerCase()} — Enter to save, Shift+Enter for a new line, Esc to cancel"
              onkeydown={onDescKey}
              onblur={commitEdit}
            ></textarea>
          {:else if row.description}
            <button class="desc" style:grid-column="{subStart} / -1" use:tooltip={row.description} onclick={() => startEdit(row)}>{row.description}</button>
          {:else}
            <!-- Only while the row is focused; mousedown keeps focus so the click lands. -->
            <button class="desc add" style:grid-column="{subStart} / -1" onmousedown={(e) => e.preventDefault()} onclick={() => startEdit(row)}>Add description</button>
          {/if}
        {/if}
        {#if error}
          <div class="row-error" style:grid-column="{subStart} / -1" role="alert">{error}</div>
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .kv {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--panel);
  }
  /* Head and rows share one column template (set inline from `columns`). */
  .kv-head {
    position: relative;
    display: grid;
    align-items: center;
    min-height: 31px;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--muted);
    background: var(--panel-2);
    border-bottom: 1px solid var(--border);
  }
  .kv-head > span:not(.c-check) {
    min-width: 0;
    padding-left: 11px;
    overflow: hidden;
    white-space: nowrap;
  }
  .kv-head > span.c-hint {
    grid-column: 1 / -1;
    padding-right: 110px;
    white-space: normal;
  }
  .kv-head > .c-check + span.c-hint {
    grid-column: 2 / -1;
  }
  /* Row: the columns, then an optional description line and an error line
     under name onwards. */
  .kv-row {
    display: grid;
    grid-template-rows: 31px auto auto;
  }
  .kv-row > .c-check {
    grid-row: 1 / span 2;
    align-items: flex-start;
    padding-top: var(--space-2);
  }
  .kv-row > .c-name,
  .kv-row > .c-value,
  .kv-row > .c-extra,
  .kv-row > .c-del {
    grid-row: 1;
    min-width: 0;
  }
  .c-extra {
    display: flex;
    align-items: stretch;
  }
  .c-extra > :global(.cell) {
    flex: 1;
  }
  /* Description sub-row: spans to the right edge on a faint tint, with a
     hairline that closes off the key/value divider above it. */
  .desc {
    grid-row: 2;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin: 0;
    padding: 5px 10px 6px;
    border: none;
    border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
    background: color-mix(in srgb, var(--panel-2) 55%, transparent);
    text-align: left;
    font: inherit;
    font-size: 11.5px;
    line-height: 1.45;
    color: var(--muted);
    cursor: text;
    user-select: text;
    -webkit-user-select: text;
    white-space: pre-line;
  }
  .row-error {
    grid-row: 3;
    padding: 4px 10px 5px;
    font-size: 11.5px;
    color: var(--danger);
    border-top: 1px solid color-mix(in srgb, var(--border) 70%, transparent);
  }
  .kv :global(.cell[aria-invalid="true"]) {
    box-shadow: inset 0 0 0 1px var(--danger);
  }
  .desc:hover {
    color: var(--text-2);
  }
  .desc.add {
    display: none;
    color: var(--faint);
    font-style: italic;
  }
  .kv-row:focus-within .desc.add {
    display: block;
  }
  .desc-edit {
    display: block;
    -webkit-line-clamp: unset;
    line-clamp: unset;
    background: var(--panel-2);
    color: var(--text);
    resize: none;
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
    overflow: hidden;
    white-space: pre-wrap;
  }
  .desc-edit::placeholder {
    color: var(--faint);
    font-style: italic;
  }
  .kv-row.off .desc {
    color: var(--faint);
  }
  .kv-row .desc.desc-edit {
    color: var(--text);
  }
  .kv-row + .kv-row {
    border-top: 1px solid var(--border);
  }
  .c-check {
    display: flex;
    align-items: center;
    justify-content: center;
    border-right: 1px solid var(--border);
    align-self: stretch;
  }
  .kv-head .c-check {
    border-right-color: transparent;
  }
  .c-del {
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .c-del .icon-btn {
    opacity: 0;
    width: 24px;
    height: 24px;
  }
  .kv-row:hover .c-del .icon-btn {
    opacity: 1;
  }

  /* Cells, built-in and custom (`class="cell"` in a custom column's snippet). */
  .kv :global(.cell) {
    min-width: 0;
    border: none;
    background: transparent;
    outline: none;
    font-family: var(--mono);
    font-size: 12.5px;
    padding: 0 var(--space-2) 0 10px;
  }
  .kv .divider {
    border-right: 1px solid var(--border);
  }
  .kv :global(.cell:focus) {
    background: var(--panel-2);
  }
  /* Text cells match :focus-visible on a click too, so they keep the ring then. */
  .kv :global(.cell:focus-visible) {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  .kv :global(.cell::placeholder) {
    color: var(--faint);
  }
  .kv-row.off :global(.cell) {
    color: var(--faint);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--faint) 60%, transparent);
  }
  .section-off .kv-row :global(.cell) {
    color: var(--faint);
  }
  .section-off .kv-row:not(.ghost) {
    background: repeating-linear-gradient(-45deg, transparent 0 6px, color-mix(in srgb, var(--panel-3) 35%, transparent) 6px 7px);
  }
  .bulk {
    position: absolute;
    right: 10px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 11.5px;
    font-weight: 500;
  }
  .bulk-text {
    width: 100%;
    border: none;
    outline: none;
    background: var(--panel);
    padding: 10px 12px;
    font-size: 12.5px;
    line-height: 1.6;
    resize: vertical;
    display: block;
  }
</style>
