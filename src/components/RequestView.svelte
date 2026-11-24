<script lang="ts">
  // Request editor + response viewer in a resizable split; each Response position keeps its own ratio.
  import { app, type RequestTab } from "../lib/store.svelte";
  import { SPLIT } from "../lib/panes";
  import RequestEditor from "./RequestEditor.svelte";
  import ResponseViewer from "./ResponseViewer.svelte";
  import SplitPane from "./SplitPane.svelte";

  let { tab }: { tab: RequestTab } = $props();

  const position = $derived(app.responsePosition);
  const ratio = $derived(app.settings?.splitRatio?.[position] ?? SPLIT.initial);

  function resize(r: number) {
    const s = app.settings;
    if (!s) return;
    app.updateSettings({ splitRatio: { ...{ horizontal: SPLIT.initial, vertical: SPLIT.initial }, ...s.splitRatio, [position]: r } });
  }
</script>

{#if tab.restoring}
  <!-- A restored tab whose file is still being read: its editor is built once it re-attaches. -->
  <div class="empty-state" aria-busy="true">Opening {tab.restoring.name}…</div>
{:else}
<SplitPane size={ratio} limits={SPLIT} ratio stacked={position === "vertical"} label="Resize request and response" onresize={resize}>
  {#snippet first()}
    <RequestEditor {tab} />
  {/snippet}
  {#snippet second()}
    <div class="response"><ResponseViewer {tab} /></div>
  {/snippet}
</SplitPane>
{/if}

<style>
  .response {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--panel);
  }
</style>
