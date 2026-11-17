<!--
  The request's History view in the response pane: the entries of the tab's request
  (by file and `# @name`, else file, method and URL), newest first, listed again after
  each send. Opening one shows it read-only in the response viewer (ResponseViewer).
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { app, type Tab } from "../lib/store.svelte";
  import { api, errorMessage } from "../lib/api";
  import { historyLink } from "../lib/history.svelte";
  import type { HistorySummary } from "../lib/types";
  import HistoryList from "./HistoryList.svelte";

  let { tab }: { tab: Tab } = $props();

  const req = $derived(app.requestFor(tab));
  const link = $derived(req ? historyLink(tab.path, req) : null);
  // What the list depends on: a named request's URL can change under it.
  const linkKey = $derived(link && JSON.stringify(link.name ? [link.filePath, link.name] : link));
  let entries = $state<HistorySummary[] | null>(null);

  $effect(() => {
    void linkKey;
    void app.history.revision;
    const request = untrack(() => link && { ...link });
    if (!request) return;
    let current = true;
    api
      .listHistory({ request })
      .then((list) => current && (entries = list))
      .catch((e) => current && app.toast("error", errorMessage(e)));
    return () => (current = false);
  });
</script>

{#if entries?.length === 0}
  <div class="empty-state small">No History for this request yet</div>
{:else if entries}
  <HistoryList {entries} onopen={(e) => app.history.open(tab.id, e)} />
{/if}

<style>
  .small {
    font-size: 12px;
  }
</style>
