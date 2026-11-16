<!--
  A named request's latest exchange opened from the Session panel (`app.shownExchange`):
  the normal response viewer over the tabs, on a copy of the response with its own
  id, so the request's own tab keeps what it shows. Closing it releases the copy.
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { receivedAt, workspaceFile } from "../lib/exchanges";
  import Modal from "./Modal.svelte";
  import ResponseViewer from "./ResponseViewer.svelte";

  let { shown }: { shown: NonNullable<typeof app.shownExchange> } = $props();
</script>

<Modal title={shown.entry.name} onclose={() => app.closeExchange()} width="min(960px, calc(100vw - 48px))" height="min(720px, calc(100vh - 48px))">
  <div class="exchange">
    <div class="about muted">
      The latest exchange of <code>{shown.entry.name}</code> in <code>{workspaceFile(app.root, shown.entry.file)}</code>, received at {receivedAt(shown.entry.received)}
    </div>
    <div class="viewer"><ResponseViewer tab={shown.tab} /></div>
  </div>
</Modal>

<style>
  .exchange {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .about {
    padding: 8px 16px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
    flex: none;
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
