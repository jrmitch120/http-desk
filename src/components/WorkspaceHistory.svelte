<!--
  The sidebar's History view: every entry in the open workspace, newest first,
  whatever request it came from (renamed and deleted ones too), with its file.
  HistoryView lists, filters, opens, compares and deletes them, and clears the
  workspace's History; the entry opened shows read-only in HistoryEntryView. While
  the History switch is off it says so instead (HistoryOff).
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { WORKSPACE_HISTORY } from "../lib/history.svelte";
  import HistoryOff from "./HistoryOff.svelte";
  import HistoryView from "./HistoryView.svelte";
</script>

<section class="workspace-history" aria-label="Workspace History">
  {#if !app.history.enabled}
    <HistoryOff />
  {:else}
    <HistoryView view={WORKSPACE_HISTORY} empty="No History in this workspace yet" />
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
