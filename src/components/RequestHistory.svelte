<!--
  The request's History view in the response pane: the entries of the tab's request
  (by file and `# @name`, else file, method and URL), newest first, listed again after
  each send. Opening one shows it read-only in the response viewer (ResponseViewer).
-->
<script lang="ts">
  import { app, type Tab } from "../lib/store.svelte";
  import { historyLink } from "../lib/history.svelte";
  import HistoryView from "./HistoryView.svelte";

  let { tab }: { tab: Tab } = $props();

  const req = $derived(app.requestFor(tab));
  const link = $derived(req ? historyLink(tab.path, req) : null);
</script>

{#if link}
  <HistoryView request={link} empty="No History for this request yet" onopen={(e) => app.history.open(tab.id, e)} />
{/if}
