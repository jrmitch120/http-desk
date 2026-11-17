<!--
  The request's History view in the response pane: the entries of the tab's request
  (by file and `# @name`, else file, method and URL), newest first, listed again after
  each send, filtered and paged by HistoryView. Opening one shows it read-only in the
  response viewer (ResponseViewer). An entry's context menu compares it with the tab's
  current response, else the next newer entry; two entries selected with their boxes
  compare with each other. While the History switch is off it says so instead (HistoryOff).
-->
<script lang="ts">
  import { app, type Tab } from "../lib/store.svelte";
  import { compareTarget, historyLink, sentAt } from "../lib/history.svelte";
  import { menu } from "../lib/menu.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import type { HistorySummary } from "../lib/types";
  import HistoryOff from "./HistoryOff.svelte";
  import HistoryView from "./HistoryView.svelte";

  let { tab }: { tab: Tab } = $props();

  const req = $derived(app.requestFor(tab));
  const link = $derived(req ? historyLink(tab.path, req) : null);
  // What the list depends on: a named request's URL can change under it.
  const linkKey = $derived(link && JSON.stringify(link.name ? [link.filePath, link.name] : link));
  /** The entries listed now (HistoryView's). */
  let entries = $state<HistorySummary[] | null>(null);

  // The entries selected for Compare, in the order they were selected.
  let selected = $state<number[]>([]);
  const chosen = $derived(entries?.filter((e) => selected.includes(e.id)) ?? []);
  $effect(() => {
    void linkKey;
    selected = [];
  });

  function select(entry: HistorySummary, on: boolean) {
    selected = on ? [...selected, entry.id] : selected.filter((id) => id !== entry.id);
  }

  function entryMenu(event: MouseEvent, entry: HistorySummary, index: number) {
    const target = compareTarget(entries ?? [], index, app.runs[tab.id]?.response);
    menu.show(event, [
      { label: "Open", action: () => app.history.open(tab.id, entry) },
      target
        ? {
            label: "response" in target ? "Compare with the current response" : `Compare with the next newer entry (${sentAt(target.entry.time)})`,
            icon: "columns",
            action: () => app.history.compare(entry, target),
          }
        : { label: "Compare", icon: "columns", disabled: true },
    ]);
  }
</script>

{#if !app.history.enabled}
  <HistoryOff />
{:else if link}
  {#if chosen.length}
    <div class="selection">
      <span class="muted">{chosen.length} selected</span>
      <span class="spacer"></span>
      <button class="btn small ghost" onclick={() => (selected = [])}>Clear</button>
      <button class="btn small" disabled={chosen.length !== 2} use:tooltip={chosen.length === 2 ? null : "Select two entries to compare"} onclick={() => app.history.compare(chosen[0], { entry: chosen[1] })}>Compare selected</button>
    </div>
  {/if}
  <HistoryView
    request={link}
    empty="No History for this request yet"
    bind:entries
    onopen={(e) => app.history.open(tab.id, e)}
    {selected}
    onselect={select}
    onmenu={entryMenu}
  />
{/if}

<style>
  .selection {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    flex: none;
  }
  .spacer {
    flex: 1;
  }
</style>
