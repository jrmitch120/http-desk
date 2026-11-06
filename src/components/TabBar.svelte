<script lang="ts">
  import { app, type Tab } from "../lib/store.svelte";
  import { menu } from "../lib/menu.svelte";
  import { basename, displayName } from "../lib/http";
  import Badge from "./Badge.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";

  let strip: HTMLDivElement | undefined = $state();

  function tabMenu(e: MouseEvent, tab: Tab) {
    menu.show(e, [
      { label: "Close", icon: "x", action: () => app.closeTab(tab.id) },
      { label: "Close others", action: () => app.closeTabs(app.tabs.filter((t) => t.id !== tab.id).map((t) => t.id)) },
      { label: "Close all", action: () => app.closeTabs(app.tabs.map((t) => t.id)) },
      { separator: true },
      { label: "Duplicate request", icon: "copy", action: () => app.duplicateRequest(tab.path, tab.key) },
    ]);
  }

  function newRequest() {
    if (app.activeTab) app.addRequest(app.activeTab.path);
    else if (app.root) app.createFile(app.root);
  }

  /** Left/Right (wrapping), Home/End move focus between tabs; Enter/Space switch to the focused one. */
  function onTabKey(e: KeyboardEvent, tab: Tab) {
    if (e.target !== e.currentTarget) return; // keys on the close button
    const all = [...(strip?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
    const i = all.indexOf(e.currentTarget as HTMLElement);
    let to: HTMLElement | undefined;
    if (e.key === "ArrowRight") to = all[(i + 1) % all.length];
    else if (e.key === "ArrowLeft") to = all[(i - 1 + all.length) % all.length];
    else if (e.key === "Home") to = all[0];
    else if (e.key === "End") to = all[all.length - 1];
    else if (e.key === "Enter" || e.key === " ") app.activeTabId = tab.id;
    else return;
    e.preventDefault();
    to?.focus();
  }

  $effect(() => {
    const id = app.activeTabId;
    strip?.querySelector<HTMLElement>(`[data-tab="${id}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });
</script>

<div class="tabbar">
  <div class="strip" bind:this={strip} role="tablist" aria-label="Open requests" tabindex="-1" onwheel={(e) => strip && (strip.scrollLeft += e.deltaY)}>
    {#each app.tabs as tab (tab.id)}
      {@const req = app.requestFor(tab)}
      {@const dirty = app.isRequestDirty(tab.path, tab.key)}
      {@const loading = app.runs[tab.id]?.loading}
      {@const orphaned = app.isOrphaned(tab)}
      {@const active = tab.id === app.activeTabId}
      <div
        class="tab"
        class:active
        class:orphaned
        data-tab={tab.id}
        role="tab"
        aria-selected={active}
        tabindex={active ? 0 : -1}
        use:tooltip={`${req ? displayName(req) : ""} — ${orphaned ? `no longer in ${basename(tab.path)}` : basename(tab.path)}`}
        onclick={() => (app.activeTabId = tab.id)}
        onkeydown={(e) => onTabKey(e, tab)}
        onauxclick={(e) => e.button === 1 && app.closeTab(tab.id)}
        oncontextmenu={(e) => tabMenu(e, tab)}
      >
        {#if req}
          <Badge method={req.method} class="tab-method">{req.method.slice(0, 6)}</Badge>
          <span class="name ellipsis">{displayName(req)}</span>
        {/if}
        {#if orphaned}<span class="orphan-icon"><Icon name="alert" size={12} /></span>{/if}
        <span class="end">
          {#if loading}<span class="spinner"></span>{/if}
          {#if dirty}<span class="dot"></span>{/if}
          <button class="close" aria-label="Close" use:tooltip onclick={(e) => (e.stopPropagation(), app.closeTab(tab.id))}><Icon name="x" size={12} /></button>
        </span>
      </div>
    {/each}
  </div>
  <button class="icon-btn plus" aria-label="New request" use:tooltip={"New request (⌘/Ctrl T)"} onclick={newRequest}><Icon name="plus" /></button>
</div>

<style>
  .tabbar {
    height: 38px;
    flex: none;
    display: flex;
    align-items: stretch;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .strip {
    display: flex;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    min-width: 0;
  }
  .strip::-webkit-scrollbar {
    display: none;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 12px;
    min-width: 120px;
    max-width: 230px;
    border-right: 1px solid var(--border);
    cursor: pointer;
    color: var(--muted);
    position: relative;
    flex: none;
  }
  .tab:hover {
    background: var(--panel-2);
    color: var(--text-2);
  }
  .tab:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
  .tab.active {
    background: var(--bg);
    color: var(--text);
  }
  .tab.active::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 0;
    height: 2px;
    background: var(--accent);
  }
  .tab.active::after {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 1px;
    background: var(--bg);
  }
  .tab :global(.tab-method) {
    min-width: 0;
  }
  .name {
    flex: 1;
    min-width: 0;
  }
  .tab.orphaned .name {
    font-style: italic;
    text-decoration: line-through;
  }
  .orphan-icon {
    display: flex;
    flex: none;
    color: var(--danger);
  }
  .end {
    width: 22px;
    height: 22px;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .close {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: none;
    color: var(--muted);
    border-radius: 4px;
    cursor: pointer;
    opacity: 0;
  }
  .tab:hover .close,
  .tab.active .close {
    opacity: 1;
  }
  .close:hover {
    background: var(--hover);
    color: var(--text);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
  }
  .tab:hover .dot {
    display: none;
  }
  .tab .dot + .close {
    opacity: 0;
  }
  .tab:hover .dot + .close {
    opacity: 1;
  }
  .spinner {
    position: absolute;
    width: 12px;
    height: 12px;
    border: 2px solid var(--border-strong);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  .tab:hover .spinner {
    display: none;
  }
  .plus {
    margin: 6px;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
