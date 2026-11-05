<script lang="ts">
  // Editable key/value list with per-row enable checkboxes, a trailing blank
  // row that turns into a real row as you type, and a bulk-edit mode.
  import type { KeyValue } from "../lib/types";
  import { app } from "../lib/store.svelte";
  import Icon from "./Icon.svelte";

  interface Props {
    items: KeyValue[];
    /** Section-level enabled state (rows render dimmed when off). */
    sectionEnabled?: boolean;
    toggles?: boolean;
    namePlaceholder?: string;
    valuePlaceholder?: string;
    suggestions?: string[];
    separator?: string;
    /** Per-row descriptions shown under the key, editable in place. */
    docs?: boolean;
  }
  let {
    items = $bindable(),
    sectionEnabled = true,
    toggles = true,
    namePlaceholder = "Key",
    valuePlaceholder = "Value",
    suggestions = [],
    separator = ":",
    docs = false,
  }: Props = $props();

  const listId = `kv-${Math.random().toString(36).slice(2)}`;
  let bulk = $state(false);
  let bulkText = $state("");

  const rows = $derived([...items, { enabled: true, name: "", value: "" }]);

  function set(i: number, field: "name" | "value", v: string) {
    if (i === items.length) items.push({ enabled: true, name: "", value: "", [field]: v });
    else items[i][field] = v;
  }

  function toggleBulk() {
    if (!bulk) {
      bulkText = items
        .filter((r) => r.name || r.value)
        .map((r) => `${toggles && !r.enabled ? "//" : ""}${r.name}${separator}${separator === ":" ? " " : ""}${r.value}`)
        .join("\n");
    } else {
      const previous = [...items];
      items = bulkText
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          const disabled = l.trimStart().startsWith("//");
          const line = disabled ? l.trimStart().slice(2) : l;
          const idx = line.indexOf(separator);
          const name = (idx < 0 ? line : line.slice(0, idx)).trim();
          const value = idx < 0 ? "" : line.slice(idx + 1).trim();
          const at = previous.findIndex((p) => p.name === name);
          const description = at < 0 ? undefined : previous.splice(at, 1)[0].description;
          return description ? { enabled: !disabled, name, value, description } : { enabled: !disabled, name, value };
        });
    }
    bulk = !bulk;
  }

  const showDesc = $derived(docs && app.settings?.showDescriptions !== false);
  let editing = $state<number | null>(null);
  let draft = $state("");

  function startEdit(i: number) {
    draft = items[i].description ?? "";
    editing = i;
  }
  function commitEdit() {
    if (editing === null) return;
    const text = draft.replace(/\s+$/, "").replace(/^\s+/, "");
    if (items[editing]) {
      if (text) items[editing].description = text;
      else delete items[editing].description;
    }
    editing = null;
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

  export function isBulk() {
    return bulk;
  }

  const allOn = $derived(items.length > 0 && items.every((r) => r.enabled));
</script>

<div class="kv" class:section-off={!sectionEnabled}>
  <div class="kv-head">
    {#if toggles}
      <span class="c-check">
        {#if !bulk && items.length}
          <input
            type="checkbox"
            checked={allOn}
            indeterminate={!allOn && items.some((r) => r.enabled)}
            onchange={(e) => items.forEach((r) => (r.enabled = e.currentTarget.checked))}
            title="Enable/disable all"
          />
        {/if}
      </span>
    {/if}
    {#if bulk}
      <span class="c-name muted">{toggles ? `Bulk edit — one per line, "name${separator} value"; prefix with // to disable` : `One per line, "name${separator} value"`}</span>
    {:else}
      <span class="c-name">{namePlaceholder}</span>
      <span class="c-value">{valuePlaceholder}</span>
    {/if}
    <button class="link bulk" onclick={toggleBulk}>{bulk ? "Key-value edit" : "Bulk edit"}</button>
  </div>

  {#if bulk}
    <textarea class="bulk-text mono" bind:value={bulkText} spellcheck="false" rows={Math.max(6, bulkText.split("\n").length + 1)}></textarea>
  {:else}
    {#each rows as row, i (i)}
      {@const ghost = i === items.length}
      <div class="kv-row" class:off={!ghost && toggles && !row.enabled} class:ghost class:no-check={!toggles}>
        {#if toggles}
          <span class="c-check">
            {#if !ghost}
              <input type="checkbox" checked={row.enabled} onchange={(e) => (items[i].enabled = e.currentTarget.checked)} title={row.enabled ? "Enabled — will be sent" : "Disabled — kept but not sent"} />
            {/if}
          </span>
        {/if}
        <input
          class="cell c-name"
          value={row.name}
          placeholder={ghost ? `Add ${namePlaceholder.toLowerCase()}` : namePlaceholder}
          list={suggestions.length ? listId : undefined}
          spellcheck="false"
          oninput={(e) => set(i, "name", e.currentTarget.value)}
        />
        <input class="cell c-value" value={row.value} placeholder={valuePlaceholder} spellcheck="false" oninput={(e) => set(i, "value", e.currentTarget.value)} />
        <span class="c-del">
          {#if !ghost}
            <button class="icon-btn" title="Delete" onclick={() => items.splice(i, 1)}><Icon name="trash" size={13} /></button>
          {/if}
        </span>
        {#if showDesc && !ghost}
          {#if editing === i}
            <textarea
              class="desc desc-edit"
              rows="1"
              bind:value={draft}
              use:autosize
              placeholder="Describe this {namePlaceholder.toLowerCase()} — Enter to save, Shift+Enter for a new line, Esc to cancel"
              onkeydown={onDescKey}
              onblur={commitEdit}
            ></textarea>
          {:else if row.description}
            <button class="desc" title={row.description} onclick={() => startEdit(i)}>{row.description}</button>
          {:else}
            <!-- Only while the row is focused; mousedown keeps focus so the click lands. -->
            <button class="desc add" onmousedown={(e) => e.preventDefault()} onclick={() => startEdit(i)}>Add description</button>
          {/if}
        {/if}
      </div>
    {/each}
  {/if}

  {#if suggestions.length}
    <datalist id={listId}>
      {#each suggestions as s (s)}<option value={s}></option>{/each}
    </datalist>
  {/if}
</div>

<style>
  .kv {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    background: var(--panel);
  }
  .kv-head {
    display: flex;
    align-items: stretch;
    min-height: 31px;
  }
  /* Row: [check][name][value][delete], with an optional description line
     under name+value. Column widths match the header's flex layout. */
  .kv-row {
    display: grid;
    grid-template-columns: 34px 38% 1fr 34px;
    grid-template-rows: 31px auto;
  }
  .kv-row.no-check {
    grid-template-columns: 38% 1fr 34px;
  }
  .kv-row > .c-check {
    grid-row: 1 / span 2;
    align-items: flex-start;
    padding-top: 8px;
  }
  .kv-row > .c-name,
  .kv-row > .c-value,
  .kv-row > .c-del {
    grid-row: 1;
    min-width: 0;
  }
  .desc {
    grid-row: 2;
    grid-column: 2 / 4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin: 0;
    padding: 0 10px 7px;
    border: none;
    background: none;
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
  .kv-row.no-check .desc {
    grid-column: 1 / 3;
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
    margin: 0 6px 6px;
    padding: 4px 6px;
    border-radius: var(--radius-sm);
    background: var(--panel-2);
    box-shadow: inset 0 0 0 1px var(--focus);
    color: var(--text);
    resize: none;
    outline: none;
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
  .kv-head {
    font-size: 11.5px;
    font-weight: 600;
    color: var(--muted);
    background: var(--panel-2);
    border-bottom: 1px solid var(--border);
    align-items: center;
  }
  .kv-row + .kv-row {
    border-top: 1px solid var(--border);
  }
  .c-check {
    width: 34px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    border-right: 1px solid var(--border);
    align-self: stretch;
  }
  .kv-head .c-check {
    border-right-color: transparent;
  }
  .c-name {
    flex: 0 0 38%;
    min-width: 0;
    padding-left: 10px;
  }
  .c-value {
    flex: 1;
    min-width: 0;
    padding-left: 10px;
  }
  .kv-head .c-name,
  .kv-head .c-value {
    padding-left: 11px;
  }
  .c-del {
    width: 34px;
    flex: none;
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

  .cell {
    border: none;
    background: transparent;
    outline: none;
    font-family: var(--mono);
    font-size: 12.5px;
    padding-right: 8px;
  }
  .cell.c-name {
    border-right: 1px solid var(--border);
  }
  .cell:focus {
    background: var(--panel-2);
    box-shadow: inset 0 0 0 1px var(--focus);
  }
  .cell::placeholder {
    color: var(--faint);
  }
  .kv-row.off .cell {
    color: var(--faint);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--faint) 60%, transparent);
  }
  .section-off .kv-row .cell {
    color: var(--faint);
  }
  .section-off .kv-row:not(.ghost) {
    background: repeating-linear-gradient(-45deg, transparent 0 6px, color-mix(in srgb, var(--panel-3) 35%, transparent) 6px 7px);
  }
  input[type="checkbox"] {
    accent-color: var(--accent);
    width: 14px;
    height: 14px;
    margin: 0;
    cursor: pointer;
  }
  .kv-head .c-value {
    overflow: hidden;
    white-space: nowrap;
  }
  .bulk {
    margin-left: auto;
    margin-right: 10px;
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
