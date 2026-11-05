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
    /** Show per-row documentation (ⓘ with the description on hover; click to edit). */
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

  async function editDoc(i: number) {
    const item = items[i];
    const label = item.name || namePlaceholder.toLowerCase();
    const next = await app.prompt(`Description for ${label}`, (item.description ?? "").replace(/\n/g, " "), "Shown on hover; saved in the .http file");
    if (next !== null) items[i].description = next.trim();
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
      <div class="kv-row" class:off={!ghost && toggles && !row.enabled} class:ghost>
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
        {#if docs}
          <span class="c-doc">
            {#if !ghost}
              <button
                class="icon-btn"
                class:has-doc={!!row.description}
                title={row.description ? row.description : "Add a description"}
                aria-label={row.description ? `Description: ${row.description}` : "Add a description"}
                onclick={() => editDoc(i)}
              >
                <Icon name="info" size={13} />
              </button>
            {/if}
          </span>
        {/if}
        <span class="c-del">
          {#if !ghost}
            <button class="icon-btn" title="Delete" onclick={() => items.splice(i, 1)}><Icon name="trash" size={13} /></button>
          {/if}
        </span>
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
  .kv-head,
  .kv-row {
    display: flex;
    align-items: stretch;
    min-height: 31px;
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
  .c-del .icon-btn,
  .c-doc .icon-btn {
    opacity: 0;
    width: 24px;
    height: 24px;
  }
  .kv-row:hover .c-del .icon-btn,
  .kv-row:hover .c-doc .icon-btn,
  .c-doc .icon-btn.has-doc {
    opacity: 1;
  }
  .c-doc {
    width: 28px;
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .c-doc .icon-btn.has-doc {
    color: var(--info);
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
