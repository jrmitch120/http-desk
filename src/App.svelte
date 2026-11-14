<script lang="ts">
  import { onMount, untrack } from "svelte";
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
  import AboutModal from "./components/AboutModal.svelte";
  import RenameVariable from "./components/RenameVariable.svelte";
  import ExtractVariable from "./components/ExtractVariable.svelte";
  import ExchangeView from "./components/ExchangeView.svelte";
  import Icon from "./components/Icon.svelte";
  import SplitPane from "./components/SplitPane.svelte";
  import PanelArea from "./components/PanelArea.svelte";
  import { updates } from "./lib/updates.svelte";
  import { handleCommandKey, shortcutHint } from "./lib/commands";
  import { startNativeMenu } from "./lib/nativeMenu.svelte";
  import { PANEL, SIDEBAR } from "./lib/panes";
  import { openContextMenu, openFromKeyboard } from "./lib/editMenu";

  onMount(() => {
    startNativeMenu().catch((e) => console.warn("native menu unavailable", e));
    app.init().then(() => {
      // Production builds only: dev builds have no signed release to compare against.
      if (!import.meta.env.DEV && app.settings?.checkUpdates !== false) setTimeout(() => updates.check(false), 3000);
    });
  });

  // The native window's title follows the active request, the workspace and the environment.
  $effect(() => {
    getCurrentWindow().setTitle(app.windowTitle).catch(() => {});
  });

  let main: HTMLElement | undefined = $state();
  let work: HTMLElement | undefined = $state();

  // Hiding the sidebar while it or its separator has focus hands focus to the
  // work area before they go, never to <body>: the active tab, else the tab
  // bar's New request button.
  $effect.pre(() => {
    if (app.sidebarShown) return;
    untrack(() => {
      const focused = document.activeElement;
      if (!main?.contains(focused) || work?.contains(focused)) return;
      focusRequests();
    });
  });

  // Likewise hiding the panel area while it or its separator has focus.
  $effect.pre(() => {
    if (app.panel) return;
    untrack(() => {
      const focused = document.activeElement;
      if (focused?.closest(".panel-area") || focused?.matches('[role="separator"][aria-label="Resize panel"]')) focusRequests();
    });
  });

  function focusRequests() {
    (work?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? work?.querySelector<HTMLElement>(".tabbar .plus"))?.focus();
  }

  function onKey(e: KeyboardEvent) {
    // Already handled by an editor's keymap (CodeMirror prevents default).
    if (e.defaultPrevented) return;
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") return keyboardContextMenu(e);
    handleCommandKey(e);
  }

  /**
   * Shift+F10 (macOS keyboards have no Menu key) and the Menu key open the
   * focused element's context menu: a text field's edit menu at its caret.
   */
  function keyboardContextMenu(e: KeyboardEvent) {
    if (openFromKeyboard()) e.preventDefault();
  }
</script>

<!-- The app's own context menus only, never the webview's (src/lib/editMenu.ts). -->
<svelte:window onkeydown={onKey} oncontextmenu={openContextMenu} />

{#if app.root}
  <div class="shell">
    <TopBar />
    <div class="main" bind:this={main}>
      <SplitPane
        collapsed={!app.sidebarShown}
        size={app.settings?.sidebarWidth ?? SIDEBAR.initial}
        limits={SIDEBAR}
        label="Resize sidebar"
        onresize={(sidebarWidth) => app.updateSettings({ sidebarWidth })}
      >
        {#snippet first()}
          <aside><Sidebar /></aside>
        {/snippet}
        {#snippet second()}
          <section class="work" bind:this={work}>
            <SplitPane
              stacked
              end
              collapsed={!app.panel}
              size={app.settings?.panelHeight ?? PANEL.initial}
              limits={PANEL}
              label="Resize panel"
              onresize={(panelHeight) => app.updateSettings({ panelHeight })}
            >
              {#snippet first()}
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
                      <span><kbd>{shortcutHint("send")}</kbd> send</span>
                      <span><kbd>{shortcutHint("save")}</kbd> save</span>
                      <span><kbd>{shortcutHint("search")}</kbd> search</span>
                      <span><kbd>{shortcutHint("manage-environments")}</kbd> environments</span>
                    </div>
                  </div>
                {/if}
              {/snippet}
              {#snippet second()}
                {#if app.panel}<PanelArea />{/if}
              {/snippet}
            </SplitPane>
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
{#if app.modal === "about"}<AboutModal />{/if}
{#if app.renaming}<RenameVariable />{/if}
{#if app.extraction}<ExtractVariable />{/if}
{#if app.shownExchange}
  {#key app.shownExchange.tab.id}<ExchangeView shown={app.shownExchange} />{/key}
{/if}
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
