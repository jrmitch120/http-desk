<!--
  History entries as rows, newest first: method, URL as sent, status (or Error,
  Cancelled), when it was sent, duration and size, and with `file` the request's
  file. Clicking a row opens it. Shared by the History views (HistoryView): the
  request's in the response pane, one line a row, and the workspace's in the
  sidebar, `narrow` (two lines a row).

  With `onselect`, each row has a box to select it (for Compare); with `onmenu`, a
  context menu; with `ondelete`, Delete (or Backspace) on a row deletes it. Other row actions go in the `start` and `end` snippets, rendered
  beside each row's open button (not inside it). `footer` ends the list
  (HistoryView's "Show more").
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HistorySummary } from "../lib/types";
  import { formatBytes, formatDuration } from "../lib/http";
  import { sentAt } from "../lib/history.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Badge from "./Badge.svelte";
  import Checkbox from "./Checkbox.svelte";

  interface Props {
    entries: HistorySummary[];
    onopen: (entry: HistorySummary) => void;
    /** Shows each entry's request file (for a list of every request's entries). */
    file?: boolean;
    /** Two lines a row, for a narrow pane: method and URL, then the rest. */
    narrow?: boolean;
    /** The entry shown now, marked current. */
    current?: number | null;
    /** The selected entries' ids, with `onselect`. */
    selected?: number[];
    onselect?: (entry: HistorySummary, selected: boolean) => void;
    /** Opens the row's context menu (`menu.show`). */
    onmenu?: (event: MouseEvent, entry: HistorySummary, index: number) => void;
    /** Deletes the entry (Delete or Backspace on its row). */
    ondelete?: (entry: HistorySummary) => void;
    /** Controls before an entry's row. */
    start?: Snippet<[HistorySummary]>;
    /** Controls after an entry's row. */
    end?: Snippet<[HistorySummary]>;
    /** After the last row. */
    footer?: Snippet;
  }

  let { entries, onopen, file = false, narrow = false, current = null, selected = [], onselect, onmenu, ondelete, start, end, footer }: Props = $props();

  function onRowKey(event: KeyboardEvent, entry: HistorySummary) {
    if (!ondelete || (event.key !== "Delete" && event.key !== "Backspace") || event.metaKey || event.ctrlKey || event.altKey) return;
    event.preventDefault();
    ondelete(entry);
  }
</script>

{#snippet outcome(e: HistorySummary)}
  {#if e.status !== null}
    <Badge status={e.status}>{e.status}</Badge>
  {:else if e.cancelled}
    <Badge>Cancelled</Badge>
  {:else}
    <span class="tip" use:tooltip={e.error ?? ""}><Badge tone="danger">Error</Badge></span>
  {/if}
{/snippet}

{#snippet metrics(e: HistorySummary)}
  <span class="metric muted">{sentAt(e.time)}</span>
  <span class="metric muted">{formatDuration(e.durationMs)}</span>
  {#if e.size !== null || !narrow}<span class="metric muted size">{e.size === null ? "" : formatBytes(e.size)}</span>{/if}
{/snippet}

<ul class="entries" class:narrow aria-label="History entries">
  {#each entries as e, i (e.id)}
    <li class="entry" class:selectable={!!onselect} class:current={e.id === current}>
      {#if onselect}
        <Checkbox class="select" checked={selected.includes(e.id)} label="Select for Compare" onchange={(on) => onselect(e, on)} />
      {/if}
      {@render start?.(e)}
      <button class="row" aria-current={e.id === current || undefined} onclick={() => onopen(e)} oncontextmenu={onmenu && ((ev) => onmenu(ev, e, i))} onkeydown={(ev) => onRowKey(ev, e)}>
        {#if narrow}
          <span class="line">
            <Badge method={e.method} />
            <span class="url mono" use:tooltip={e.url}>{e.url}</span>
            <span class="spacer"></span>
            {@render outcome(e)}
          </span>
          <span class="line sub">
            {#if file}<span class="file ellipsis">{e.file ?? "No file"}</span>{/if}
            <span class="spacer"></span>
            {@render metrics(e)}
          </span>
        {:else}
          <Badge method={e.method} />
          <span class="url mono">{e.url}</span>
          {#if file}<span class="file muted ellipsis">{e.file ?? "No file"}</span>{/if}
          <span class="spacer"></span>
          {@render outcome(e)}
          {@render metrics(e)}
        {/if}
      </button>
      {@render end?.(e)}
    </li>
  {/each}
  {#if footer}<li class="footer" role="none">{@render footer()}</li>{/if}
</ul>

<style>
  .entries {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow: auto;
    min-height: 0;
    flex: 1;
  }
  .entry {
    display: flex;
    align-items: center;
  }
  .entry:hover,
  .entry.current {
    background: var(--hover);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    padding: 5px 16px;
    border: 0;
    background: none;
    color: var(--text);
    font: inherit;
    font-size: 12.5px;
    text-align: left;
    cursor: pointer;
  }
  .narrow .row {
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    padding: 5px 12px;
  }
  .selectable {
    padding-left: 12px;
  }
  .selectable .row {
    padding-left: 8px;
  }
  .selectable :global(.select) {
    flex: none;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .url {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
  }
  .file {
    min-width: 0;
    font-size: 11.5px;
  }
  .narrow .file {
    color: var(--muted);
    font-size: 11px;
  }
  .spacer {
    flex: 1;
  }
  .tip {
    display: flex;
  }
  .metric {
    flex: none;
    font-size: 12px;
  }
  .narrow .metric {
    font-size: 11px;
  }
  .size {
    min-width: 56px;
    text-align: right;
  }
  .narrow .size {
    min-width: 0;
  }
  .footer {
    display: flex;
    justify-content: center;
    padding: 6px;
  }
</style>
