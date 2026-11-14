<!--
  The Session panel: what the workspace's Session holds, one section per kind
  (each a component that reads its part and clears it), and Clear session, which
  empties all of it. A new section is its component and one line below.
-->
<script lang="ts">
  import { app } from "../lib/store.svelte";
  import SessionCookies from "./SessionCookies.svelte";
  import SessionGlobals from "./SessionGlobals.svelte";
  import SessionNamedExchanges from "./SessionNamedExchanges.svelte";
</script>

<div class="session">
  <div class="toolbar">
    <span class="muted">Kept in memory for this workspace until you open another or quit. Never saved.</span>
    <button class="btn small danger" onclick={() => app.clearSession()}>Clear session</button>
  </div>
  <div class="sections">
    <SessionGlobals />
    <SessionCookies />
    <SessionNamedExchanges />
  </div>
</div>

<style>
  .session {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 10px 2px 16px;
    font-size: 12px;
    flex: none;
  }
  .sections {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
  }
  /* Sections stack and the panel scrolls, rather than each table scrolling on its own. */
  .sections > :global(section) {
    flex: none;
  }
  .sections :global(.data-table) {
    flex: none;
    overflow: visible;
    padding-top: 0;
  }
</style>
