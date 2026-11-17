<!--
  The sidebar's History view: every entry in the open workspace, newest first,
  whatever request it came from (renamed and deleted ones too), with its file.
  Opening one shows it read-only in the response viewer, in HistoryEntryView; its
  context menu opens or deletes it. While the History switch is off it says so
  instead (HistoryOff).
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { WORKSPACE_HISTORY } from "../lib/history.svelte";
  import { menu } from "../lib/menu.svelte";
  import type { HistorySummary } from "../lib/types";
  import HistoryOff from "./HistoryOff.svelte";
  import HistoryView from "./HistoryView.svelte";

  const opened = $derived(app.history.openedIn(WORKSPACE_HISTORY));

  function entryMenu(event: MouseEvent, entry: HistorySummary) {
    menu.show(event, [
      { label: "Open", action: () => app.history.open(WORKSPACE_HISTORY, entry) },
      { separator: true },
      { label: "Delete…", icon: "trash", danger: true, action: () => app.history.delete(entry) },
    ]);
  }
</script>

<section class="workspace-history" aria-label="Workspace History">
  {#if !app.history.enabled}
    <HistoryOff />
  {:else}
    <HistoryView
      empty="No History in this workspace yet"
      file
      narrow
      current={opened?.entry.id}
      onopen={(e) => app.history.open(WORKSPACE_HISTORY, e)}
      onmenu={entryMenu}
    />
  {/if}
</section>

<style>
  .workspace-history {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
