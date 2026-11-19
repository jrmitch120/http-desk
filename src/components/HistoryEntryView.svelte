<!--
  A History entry opened from the sidebar's History (WORKSPACE_HISTORY): the normal
  response viewer, read-only, over the tabs, on the entry's response under a pseudo
  tab, like ExchangeView. Closing it releases that response (ADR-0006). Restore
  request brings its request back, as a tab's History view does: into the request it
  was sent from, if its file still has it, else as a new unsaved request there.
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { sentAt, WORKSPACE_HISTORY, type OpenedEntry } from "../lib/history.svelte";
  import { fromWorkspace } from "../lib/layout";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Modal from "./Modal.svelte";
  import ResponseViewer from "./ResponseViewer.svelte";

  let { opened }: { opened: OpenedEntry } = $props();
  const entry = $derived(opened.entry);
  /** The entry's request file; none for a request in no file, which can't be restored. */
  const path = $derived(app.root && entry.link.file !== null ? fromWorkspace(app.root, entry.link.file) : null);

  async function restore(path: string) {
    const source = opened.source;
    app.history.close(WORKSPACE_HISTORY);
    await app.restoreRequest(path, null, source);
  }
</script>

<Modal title="History entry" onclose={() => app.history.close(WORKSPACE_HISTORY)} width="min(960px, calc(100vw - 48px))" height="min(720px, calc(100vh - 48px))">
  <div class="opened">
    <div class="about muted">
      <span class="what"><code>{entry.method} {entry.url}</code>{#if entry.link.file}&nbsp;from <code>{entry.link.file}</code>{/if}, sent {sentAt(entry.time)} · read-only</span>
      {#if path}
        <button class="btn small ghost" use:tooltip={"Edit the request as it was written when sent, unsaved"} onclick={() => restore(path)}>Restore request</button>
      {/if}
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
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .what {
    flex: 1;
    min-width: 0;
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
