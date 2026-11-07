<script lang="ts">
  import { onMount } from "svelte";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { app } from "./lib/store.svelte";
  import TopBar from "./components/TopBar.svelte";
  import Sidebar from "./components/Sidebar.svelte";
  import TabBar from "./components/TabBar.svelte";
  import RequestView from "./components/RequestView.svelte";
  import Welcome from "./components/Welcome.svelte";
  import Dialog from "./components/Dialog.svelte";
  import Toasts from "./components/Toasts.svelte";
  import ContextMenu from "./components/ContextMenu.svelte";
  import TooltipHost from "./components/TooltipHost.svelte";
  import EnvironmentEditor from "./components/EnvironmentEditor.svelte";
  import OpenApiImport from "./components/OpenApiImport.svelte";
  import SettingsModal from "./components/SettingsModal.svelte";
  import Icon from "./components/Icon.svelte";
  import SplitPane from "./components/SplitPane.svelte";
  import { updates } from "./lib/updates.svelte";
  import { modalOpen } from "./lib/modal";
  import { SIDEBAR } from "./lib/panes";

  onMount(() => {
    app.init().then(() => {
      // Production builds only: dev builds have no signed release to compare against.
      if (!import.meta.env.DEV && app.settings?.checkUpdates !== false) setTimeout(() => updates.check(false), 3000);
    });
  });

  // The native window's title follows the workspace and the active environment.
  $effect(() => {
    getCurrentWindow().setTitle(app.windowTitle).catch(() => {});
  });

  function onKey(e: KeyboardEvent) {
    // Already handled by an editor's keymap (CodeMirror prevents default).
    if (e.defaultPrevented) return;
    if (e.key === "F10" && e.shiftKey) return keyboardContextMenu(e);
    const action = shortcut(e);
    if (!action) return;
    e.preventDefault();
    // Under a modal or dialog only Escape acts, and Modal.svelte handles it.
    if (!modalOpen()) action();
  }

  /**
   * Shift+F10 opens the focused element's context menu (macOS keyboards have no
   * Menu key). Text fields keep the webview's own behaviour.
   */
  function keyboardContextMenu(e: KeyboardEvent) {
    const t = e.target;
    if (!(t instanceof HTMLElement) || t === document.body || t.closest("input, textarea, .cm-editor") || modalOpen()) return;
    e.preventDefault();
    t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
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
    if (switchEnvironment(e)) return root ? () => app.chooseEnvironment() : null;
    if (k === "e" && !e.altKey && root) return () => (app.modal = "env");
    if (k === ",") return () => (app.modal = "settings");
    return null;
  }

  const mac = /Mac|iPhone|iPad/.test(navigator.platform);

  /**
   * ⌘⌥E on macOS, Ctrl+Alt+E elsewhere: open the environment picker. On macOS
   * ⌥E is a dead key, so the physical E key counts. Elsewhere the key must
   * really be "e": Ctrl+Alt is how Windows reports AltGr, and AltGr+E types €
   * on many layouts.
   */
  function switchEnvironment(e: KeyboardEvent): boolean {
    if (!e.altKey || e.shiftKey) return false;
    if (mac) return e.metaKey && !e.ctrlKey && (e.key.toLowerCase() === "e" || e.code === "KeyE");
    return e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "e";
  }
</script>

<svelte:window onkeydown={onKey} oncontextmenu={(e) => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).closest?.(".cm-editor") || e.preventDefault()} />

{#if app.root}
  <div class="shell">
    <TopBar />
    <div class="main">
      <SplitPane
        size={app.settings?.sidebarWidth ?? SIDEBAR.initial}
        limits={SIDEBAR}
        label="Resize sidebar"
        onresize={(sidebarWidth) => app.updateSettings({ sidebarWidth })}
      >
        {#snippet first()}
          <aside><Sidebar /></aside>
        {/snippet}
        {#snippet second()}
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
        {/snippet}
      </SplitPane>
    </div>
  </div>
{:else if !app.starting}
  <Welcome />
{/if}

{#if app.modal === "env"}<EnvironmentEditor />{/if}
{#if app.modal === "openapi"}<OpenApiImport />{/if}
{#if app.modal === "settings"}<SettingsModal />{/if}
{#if app.dialog}
  {#key app.dialog}<Dialog />{/key}
{/if}
<ContextMenu />
<TooltipHost />
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
    flex: 1;
    min-height: 0;
    background: var(--panel);
  }
  .work {
    flex: 1;
    min-width: 0;
    min-height: 0;
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
