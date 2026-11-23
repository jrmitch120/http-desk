<!--
  History entries as rows, newest first: method, URL as sent, status (or Error,
  Cancelled), when it was sent, duration and size, and with `file` the request's
  file. Clicking a row opens it. Shared by the History views (HistoryView): the
  request's in the response pane, one line a row, and the workspace's in the
  sidebar, `narrow` (two lines a row).

  A list (`use:rovingList`): one Tab stop, the arrow keys move, Enter opens. With
  `onselect`, each row has a box to select it (for Compare), which Space ticks; with
  `onmenu`, a context menu (Shift+F10 too); with `ondelete`, Delete (or Backspace) on a
  row deletes it. `footer` ends the list (HistoryView's "Show more"), and `onlast` runs
  as the keyboard reaches the last row, so it can list more.
-->
<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HistorySummary } from "../lib/types";
  import { formatBytes, formatDuration } from "../lib/http";
  import { sentAt } from "../lib/history.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Badge from "./Badge.svelte";
  import Checkbox from "./Checkbox.svelte";
  import { rovingList } from "../lib/rovingList";

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
    /** After the last row. */
    footer?: Snippet;
    /** Focus reached the last row, or Down or End was pressed on it (to list more). */
    onlast?: () => void;
  }

  let { entries, onopen, file = false, narrow = false, current = null, selected = [], onselect, onmenu, ondelete, footer, onlast }: Props = $props();

  const entryOf = (row: HTMLElement) => entries.find((e) => String(e.id) === row.dataset.id);
  const isLast = (row: EventTarget | null) => row instanceof HTMLElement && row.dataset.id === String(entries.at(-1)?.id);

  function onRowKey(event: KeyboardEvent, entry: HistorySummary) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if ((event.key === "ArrowDown" || event.key === "End") && isLast(event.currentTarget)) onlast?.();
    if (!ondelete || (event.key !== "Delete" && event.key !== "Backspace")) return;
    event.preventDefault();
    ondelete(entry);
  }

  /** A click on the row opens it; one on its Compare box only ticks the box. */
  function onRowClick(event: MouseEvent, entry: HistorySummary) {
    if (!(event.target as Element).closest('[role="checkbox"]')) onopen(entry);
  }

  const keys = $derived({
    activate: (row: HTMLElement) => {
      const entry = entryOf(row);
      if (entry) onopen(entry);
    },
    space: onselect
      ? (row: HTMLElement) => {
          const entry = entryOf(row);
          if (entry) onselect(entry, !selected.includes(entry.id));
        }
      : undefined,
  });
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

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="entries" class:narrow role="list" aria-label="History entries" use:rovingList={keys} onfocusin={(ev) => isLast(ev.target) && onlast?.()}>
  {#each entries as e, i (e.id)}
    <!-- The list's keys are rovingList's (Enter opens, Space ticks Compare); Delete and the menu are the row's. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
    <div
      role="listitem"
      tabindex="-1"
      class="list-row entry"
      class:selectable={!!onselect}
      class:current={e.id === current}
      aria-current={e.id === current || undefined}
      data-id={e.id}
      onclick={(ev) => onRowClick(ev, e)}
      oncontextmenu={onmenu && ((ev) => onmenu(ev, e, i))}
      onkeydown={(ev) => onRowKey(ev, e)}
    >
      {#if onselect}
        <Checkbox class="select" tabindex={-1} checked={selected.includes(e.id)} label="Select for Compare" onchange={(on) => onselect(e, on)} />
      {/if}
      <div class="row">
        {#if narrow}
          <span class="line">
            <Badge method={e.method} />
            <span class="url mono" use:tooltip={e.url}>{e.url}</span>
            <span class="spacer"></span>
            {@render outcome(e)}
          </span>
          <span class="line sub">
            {#if file}<span class="file ellipsis">{e.link.file ?? "No file"}</span>{/if}
            <span class="spacer"></span>
            {@render metrics(e)}
          </span>
        {:else}
          <Badge method={e.method} />
          <span class="url mono">{e.url}</span>
          {#if file}<span class="file muted ellipsis">{e.link.file ?? "No file"}</span>{/if}
          <span class="spacer"></span>
          {@render outcome(e)}
          {@render metrics(e)}
        {/if}
      </div>
    </div>
  {/each}
  {#if footer}<div class="footer" role="none">{@render footer()}</div>{/if}
</div>

<style>
  .entries {
    list-style: none;
    margin: 0;
    padding: 4px 0;
    overflow: auto;
    min-height: 0;
    flex: 1;
  }
  /* A `.list-row` (hover, current and focus), laid out here. */
  .entry {
    gap: 0;
    padding: 0;
    color: var(--text);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    padding: 5px 16px;
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
