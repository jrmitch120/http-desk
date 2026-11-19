<!--
  The request's History view in the response pane: the entries of the tab's request
  (by file and `# @name`, else file, method and URL), newest first, listed again after
  each send. HistoryView lists, filters, opens, compares (with the tab's current
  response) and deletes them; the entry opened shows read-only in the response viewer
  (ResponseViewer). While the History switch is off it says so instead (HistoryOff).
-->
<script lang="ts">
  import { app, type Tab } from "../lib/store.svelte";
  import { historyLink } from "../lib/history.svelte";
  import HistoryOff from "./HistoryOff.svelte";
  import HistoryView from "./HistoryView.svelte";

  let { tab }: { tab: Tab } = $props();

  const req = $derived(app.requestFor(tab));
  const link = $derived(req ? historyLink(tab.path, req) : null);
</script>

{#if !app.history.enabled}
  <HistoryOff />
{:else if link}
  <HistoryView view={{ tab: tab.id }} request={link} current={app.runs[tab.id]} empty="No History for this request yet" />
{/if}
