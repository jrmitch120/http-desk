<!--
  A History entry opened from the sidebar's History (WORKSPACE_HISTORY): the normal
  response viewer, read-only, over the tabs, on the entry's response under a pseudo
  tab, like ExchangeView. Closing it releases that response (ADR-0006).
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { sentAt, WORKSPACE_HISTORY, type OpenedEntry } from "../lib/history.svelte";
  import Modal from "./Modal.svelte";
  import ResponseViewer from "./ResponseViewer.svelte";

  let { opened }: { opened: OpenedEntry } = $props();
  const entry = $derived(opened.entry);
</script>

<Modal title="History entry" onclose={() => app.history.close(WORKSPACE_HISTORY)} width="min(960px, calc(100vw - 48px))" height="min(720px, calc(100vh - 48px))">
  <div class="opened">
    <div class="about muted">
      <code>{entry.method} {entry.url}</code>{#if entry.file}&nbsp;from <code>{entry.file}</code>{/if}, sent {sentAt(entry.time)} · read-only
    </div>
    <section class="viewer" aria-label="History entry">{#key opened.tab.id}<ResponseViewer tab={opened.tab} />{/key}</section>
  </div>
</Modal>

<style>
  .opened {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .about {
    padding: 8px 16px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
    flex: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .about code {
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .viewer {
    flex: 1;
    min-height: 0;
  }
</style>
