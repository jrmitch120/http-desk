<!--
  What a view of a file says about the file on disk (a request tab and a file view both
  show it): deleted or moved, changed by another editor while it has unsaved edits, or,
  for an Orphaned tab's request (`orphaned`), gone from it.
-->
<script lang="ts">
  import { app, type Doc } from "../lib/store.svelte";
  import { basename } from "../lib/http";
  import Banner from "./Banner.svelte";

  let { doc, orphaned = false }: { doc: Doc; orphaned?: boolean } = $props();
</script>

{#if doc.missing}
  <Banner severity="error">{basename(doc.path)} was deleted or moved on disk. Saving will recreate it.</Banner>
{:else if orphaned}
  <Banner severity="error">
    This request no longer exists in {basename(doc.path)}; it was changed or removed on disk. Saving will add it back to the end of the file.
  </Banner>
{:else if doc.externalChange}
  <Banner severity="warning">
    {basename(doc.path)} changed on disk while you have unsaved edits.
    {#snippet actions()}
      <button class="btn small" onclick={() => app.reload(doc.path)}>Reload from disk</button>
      <button class="btn small" onclick={() => (doc.externalChange = false)}>Keep my version</button>
    {/snippet}
  </Banner>
{/if}
