<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "./lib/store.svelte";
  import TopBar from "./components/TopBar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import TabBar from "./components/TabBar.svelte";
  import RequestView from "./components/RequestView.svelte";
  import Welcome from "./components/Welcome.svelte";
  import Dialog from "./components/Dialog.svelte";
  import Toasts from "./components/Toasts.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";
  import EnvironmentEditor from "./components/EnvironmentEditor.svelte";
  import OpenApiImport from "./components/OpenApiImport.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import Icon from "./components/Icon.svelte";
  import { updates } from "./lib/updates.svelte";
  import { modalOpen } from "./lib/modal";

  let sidebarWidth = $state(Number(localStorage.getItem("sidebarWidth")) || 280);

  onMount(() => {
    app.init().then(() => {
      // Production builds only: dev builds have no signed release to compare against.
      if (!import.meta.env.DEV && app.settings?.checkUpdates !== false) setTimeout(() => updates.check(false), 3000);
    });
  });

  function onKey(e: KeyboardEvent) {
    // Already handled by an editor's keymap (CodeMirror prevents default).
    if (e.defaultPrevented) return;
    const action = shortcut(e);
    if (!action) return;
    e.preventDefault();
    // Under a modal or dialog only Escape acts, and Modal.svelte handles it.
    if (!modalOpen()) action();
  }

  /** The global shortcut `e` triggers, if any. */
  function shortcut(e: KeyboardEvent): (() => void) | null {
    if (!(e.metaKey || e.ctrlKey)) return null;
    const k = e.key.toLowerCase();
    const root = app.root;
    if (k === "s") return () => (e.shiftKey ? app.saveAll() : app.saveActive());
    if (k === "enter" && app.activeTabId) return () => app.activeTabId && app.send(app.activeTabId);
    if ((k === "p" || k === "k") && root) return () => app.focusSearch++;
    if (k === "t" && root) return () => (app.activeTab ? app.addRequest(app.activeTab.path) : app.createFile(root));
    if (k === "e" && root) return () => (app.modal = "env");
    if (k === ",") return () => (app.modal = "settings");
    return null;
  }

  function startResize(e: PointerEvent) {
    const startX = e.clientX;
    const start = sidebarWidth;
    const move = (ev: PointerEvent) => (sidebarWidth = Math.min(560, Math.max(200, start + ev.clientX - startX)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem("sidebarWidth", String(sidebarWidth));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

</script>

<svelte:window onkeydown={onKey} oncontextmenu={(e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).closest?.(".cm-editor") || e.preventDefault()} />

{#if app.root}
  <div class="shell">
    <TopBar />
    <div class="main">
      <aside style:width="{sidebarWidth}px">
        <Sidebar />
      </aside>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="resizer" onpointerdown={startResize}></div>
      <section class="work">
        <TabBar />
        {#if app.activeTab}
          {#key app.activeTab.id}
            <RequestView tab={app.activeTab} />
          {/key}
        {:else}
          <div class="empty-state">
            <Icon name="send" size={34} stroke={1.3} />
            <div>Open a request from the explorer, or create a new one.</div>
            <div class="row">
              <button class="btn" onclick={() => app.createFile(app.root!)}><Icon name="plus" />New .http file</button>
              <button class="btn" onclick={() => (app.modal = "openapi")}><Icon name="import" />Import OpenAPI</button>
            </div>
            <div class="hints muted">
              <span><kbd>⌘/Ctrl</kbd> <kbd>Enter</kbd> send</span>
              <span><kbd>⌘/Ctrl</kbd> <kbd>S</kbd> save</span>
              <span><kbd>⌘/Ctrl</kbd> <kbd>P</kbd> search</span>
              <span><kbd>⌘/Ctrl</kbd> <kbd>E</kbd> environments</span>
            </div>
          </div>
        {/if}
      </section>
    </div>
  </div>
{:else}
  <Welcome />
{/if}

{#if app.modal === "env"}<EnvironmentEditor />{/if}
{#if app.modal === "openapi"}<OpenApiImport />{/if}
{#if app.modal === "settings"}<SettingsModal />{/if}
{#if app.dialog}
  {#key app.dialog}<Dialog />{/key}
{/if}
<ContextMenu />
<Toasts />

<style>
  .shell {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .main {
    flex: 1;
    display: flex;
    min-height: 0;
  }
  aside {
    flex: none;
    background: var(--panel);
    border-right: 1px solid var(--border);
    min-width: 0;
  }
  .resizer {
    width: 5px;
    margin-left: -3px;
    margin-right: -2px;
    cursor: col-resize;
    z-index: 5;
    flex: none;
  }
  .resizer:hover {
    background: var(--focus);
    opacity: 0.4;
  }
  .work {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .hints {
    display: flex;
    gap: 18px;
    margin-top: 14px;
    font-size: 12px;
  }
</style>
