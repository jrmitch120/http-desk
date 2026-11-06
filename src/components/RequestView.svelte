<script lang="ts">
  // Request editor + response viewer in a resizable split; each layout keeps its own ratio.
  import { app, type Tab } from "../lib/store.svelte";
  import { SPLIT } from "../lib/panes";
  import RequestEditor from "./RequestEditor.svelte";
  import ResponseViewer from "./ResponseViewer.svelte";
  import SplitPane from "./SplitPane.svelte";

  let { tab }: { tab: Tab } = $props();

  const layout = $derived(app.settings?.layout ?? "horizontal");
  const ratio = $derived(app.settings?.splitRatio?.[layout] ?? SPLIT.initial);

  function resize(r: number) {
    const s = app.settings;
    if (!s) return;
    app.updateSettings({ splitRatio: { ...{ horizontal: SPLIT.initial, vertical: SPLIT.initial }, ...s.splitRatio, [layout]: r } });
  }
</script>

<SplitPane size={ratio} limits={SPLIT} ratio stacked={layout === "vertical"} label="Resize request and response" onresize={resize}>
  {#snippet first()}
    <RequestEditor {tab} />
  {/snippet}
  {#snippet second()}
    <div class="response"><ResponseViewer {tab} /></div>
  {/snippet}
</SplitPane>

<style>
  .response {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--panel);
  }
</style>
