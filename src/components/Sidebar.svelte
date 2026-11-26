<script module lang="ts">
  /** The Explorer row last focused (`rowId`), kept while the Explorer isn't shown
   *  (the History view in its place), for Focus Explorer to go back to. */
  let lastRow: string | null = null;
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { app } from "../lib/store.svelte";
  import { usageRows } from "../lib/usages";
  import { runCommand, shortcutHint } from "../lib/commands";
  import { plainEnter } from "../lib/platform";
  import { errorMessage } from "../lib/api";
  import { basename, joinPath } from "../lib/http";
  import type { SearchHit } from "../lib/types";
  import TreeItem from "./TreeItem.svelte";
  import Badge from "./Badge.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { focusList, rovingList } from "../lib/rovingList";
  import SegmentedControl, { type SegmentedOption } from "./SegmentedControl.svelte";
  import WorkspaceHistory from "./WorkspaceHistory.svelte";
  import type { SidebarView } from "../lib/store.svelte";

  // Each hints the command that shows it and focuses its list.
  const VIEWS: SegmentedOption<SidebarView>[] = [
    { value: "explorer", label: "Explorer", tooltip: `Explorer (${shortcutHint("focus-explorer")})` },
    { value: "history", label: "History", tooltip: `History (${shortcutHint("focus-history")})` },
  ];

  let query = $state("");
  let hits = $state<SearchHit[]>([]);
  /** Index of the result Enter opens; Up/Down move it. */
  let selected = $state(0);
  let searching = $state(false);
  let searchInput: HTMLInputElement | undefined = $state();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  // Each ask once, even when the box only appears later (the sidebar shown, or the
  // Explorer view picked, for it), and not again when the Explorer comes back.
  $effect(() => {
    if (app.searchFocusWanted && searchInput) {
      app.searchFocusWanted = false;
      searchInput.focus();
    }
  });

  // Find usages takes the place of search results.
  $effect(() => {
    if (app.usages) untrack(() => (query = ""));
  });

  $effect(() => {
    const q = query.trim();
    clearTimeout(timer);
    const run = ++seq;
    if (!q) {
      hits = [];
      searching = false;
      return;
    }
    searching = true;
    timer = setTimeout(async () => {
      try {
        const found = await app.searchRequests(q);
        if (run !== seq) return; // a newer query is on its way
        hits = found;
        selected = 0;
      } catch (e) {
        app.toast("error", errorMessage(e));
      } finally {
        if (run === seq) searching = false;
      }
    }, 150);
  });

  $effect(() => {
    if (hits.length) document.getElementById(`search-hit-${selected}`)?.scrollIntoView({ block: "nearest" });
  });

  function collapseAll() {
    app.expanded = { [app.root!]: true };
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === "Escape") query = "";
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (hits.length) selected = Math.max(0, Math.min(hits.length - 1, selected + (e.key === "ArrowDown" ? 1 : -1)));
    } else if (plainEnter(e) && hits[selected]) app.openSearchHit(hits[selected]);
  }

  let rootDrop = $state(false);

  // Explorer keyboard: one row is in the Tab order at a time (the last one
  // focused, else the active request, else the first), and the arrow keys move
  // between rows. TreeItem renders rows with tabindex -1; this sets the one at 0.
  let treeEl: HTMLDivElement | undefined = $state();
  let usagesEl: HTMLElement | undefined = $state();
  let closeUsages: HTMLButtonElement | undefined = $state();
  const rows = () => [...(treeEl?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
  const level = (row: HTMLElement | undefined) => Number(row?.getAttribute("aria-level") ?? 0);
  const isRow = (t: EventTarget | null): t is HTMLElement => t instanceof HTMLElement && t.getAttribute("role") === "treeitem";

  function makeCurrent(row: HTMLElement) {
    for (const r of rows()) r.tabIndex = r === row ? 0 : -1;
  }

  /** What identifies a row across the tree being rebuilt: its request, else its path. */
  const rowId = (row: HTMLElement) => (row.dataset.key ? `${row.dataset.file}#${row.dataset.key}` : (row.dataset.path ?? ""));

  /**
   * Focus Explorer: the row last focused, else the Tab stop (the open request's row,
   * else the first), else the empty tree. A search or Find usages in the tree's place
   * takes focus instead: the search box, or the usages list's Tab stop (its Close
   * button while there are none). False while there's nothing to focus yet (the tree
   * still loading).
   */
  function focusExplorer(): boolean {
    if (query.trim() && searchInput) {
      searchInput.focus();
      return true;
    }
    if (usagesEl) {
      if (!focusList(usagesEl)) closeUsages?.focus();
      return true;
    }
    if (!treeEl) return false;
    const all = rows();
    (all.find((r) => rowId(r) === lastRow) ?? all.find((r) => r.tabIndex === 0) ?? treeEl.querySelector<HTMLElement>('[role="treeitem"].active') ?? all[0] ?? treeEl).focus();
    return true;
  }

  // Each ask once, when the Explorer is on screen (the sidebar shown, the tree listed).
  $effect(() => {
    if (!app.explorerFocusWanted || !app.sidebarShown || app.sidebarView !== "explorer") return;
    // Again as the tree, search results or usages come and go, until one takes focus.
    void [treeEl, usagesEl, searchInput, query];
    if (untrack(focusExplorer)) app.explorerFocusWanted = false;
  });

  $effect(() => {
    const el = treeEl;
    if (!el) return;
    const ensureCurrent = () => {
      const all = rows();
      if (all.length && !all.some((r) => r.tabIndex === 0)) makeCurrent(el.querySelector<HTMLElement>('[role="treeitem"].active') ?? all[0]);
    };
    ensureCurrent();
    const observer = new MutationObserver(ensureCurrent);
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  });

  /** The request a row shows, if it's a request row. */
  const requestOf = (row: HTMLElement | undefined) =>
    row?.dataset.file && row.dataset.key ? { path: row.dataset.file, key: row.dataset.key } : undefined;

  /**
   * Up/Down/Home/End move; Right expands, then enters; Left collapses, then goes to the
   * parent. On requests, Space toggles one in the selection, Shift+Up/Down extend it,
   * and Escape goes back to just the open request.
   */
  function onTreeKey(e: KeyboardEvent) {
    const row = e.target;
    if (!isRow(row)) return;
    const all = rows();
    const i = all.indexOf(row);
    const expanded = row.getAttribute("aria-expanded");
    const path = row.dataset.path;
    const request = requestOf(row);
    let to: HTMLElement | undefined;
    if (e.key === " " && request) {
      app.selectRequest(request.path, request.key, "toggle");
    } else if (e.key === "Escape" && app.treeSelection.length) {
      app.clearTreeSelection();
    } else if (e.shiftKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      to = all[i + (e.key === "ArrowDown" ? 1 : -1)];
      const next = requestOf(to);
      if (next) app.selectRequest(next.path, next.key, "range", request);
    } else if (e.key === "ArrowDown") to = all[i + 1];
    else if (e.key === "ArrowUp") to = all[i - 1];
    else if (e.key === "Home") to = all[0];
    else if (e.key === "End") to = all[all.length - 1];
    else if (e.key === "ArrowRight") {
      if (expanded === "false" && path) app.expanded[path] = true;
      else if (expanded === "true" && level(all[i + 1]) > level(row)) to = all[i + 1];
    } else if (e.key === "ArrowLeft") {
      if (expanded === "true" && path) app.expanded[path] = false;
      else to = all.slice(0, i).reverse().find((r) => level(r) === level(row) - 1);
    } else return;
    e.preventDefault();
    to?.focus();
  }
</script>

<div class="sidebar">
  <div class="head">
    <!-- The view's own controls and Collapse sidebar (after a divider) are one group
         that wraps onto a second row together when the pane is too narrow. -->
    <div class="views"><SegmentedControl label="Sidebar" options={VIEWS} value={app.sidebarView} onchange={(v) => (app.sidebarView = v)} /></div>
    <div class="tools">
      {#if app.sidebarView === "explorer"}
        <!-- Beside the switch (small icon buttons): they fit there at the default width (280 px) and wider. -->
        <div class="actions">
          <button class="icon-btn small" aria-label="New .http file" use:tooltip onclick={() => app.createFile(app.root!)}><Icon name="plus" /></button>
          <button class="icon-btn small" aria-label="New folder" use:tooltip onclick={() => app.createFolder(app.root!)}><Icon name="folder" /></button>
          <button class="icon-btn small" aria-label="Import OpenAPI" use:tooltip onclick={() => (app.modal = "openapi")}><Icon name="import" /></button>
          <button class="icon-btn small" aria-label="Refresh" use:tooltip onclick={() => app.refreshTree()}><Icon name="refresh" /></button>
          <button class="icon-btn small" aria-label="Collapse all" use:tooltip onclick={collapseAll}><Icon name="fold" /></button>
        </div>
      {/if}
      <span class="divider" aria-hidden="true"></span>
      <button
        class="icon-btn small"
        aria-label="Collapse sidebar"
        use:tooltip={`Collapse sidebar (${shortcutHint("toggle-sidebar")})`}
        onclick={() => runCommand("toggle-sidebar")}><Icon name="sidebar-collapse" /></button
      >
    </div>
  </div>

  {#if app.sidebarView === "history"}
    <WorkspaceHistory />
  {:else}
  <div class="search">
    <Icon name="search" size={13} />
    <input
      bind:this={searchInput}
      bind:value={query}
      placeholder="Search requests"
      onkeydown={onSearchKey}
      spellcheck="false"
      role="combobox"
      aria-expanded={!!query.trim() && hits.length > 0}
      aria-controls="search-results"
      aria-activedescendant={hits.length ? `search-hit-${selected}` : undefined}
    />
    {#if query}<button class="icon-btn" aria-label="Clear search" use:tooltip onclick={() => (query = "")}><Icon name="x" size={12} /></button>{/if}
  </div>

  <div class="scroll">
    {#if query.trim()}
      {#if !hits.length && !searching}
        <div class="none muted">No requests match “{query}”.</div>
      {/if}
      <div id="search-results" role="listbox" aria-label="Search results">
        {#each hits as h, i (h.path + h.index)}
          <button
            id="search-hit-{i}"
            class="hit"
            class:selected={i === selected}
            role="option"
            aria-selected={i === selected}
            tabindex="-1"
            onclick={() => app.openSearchHit(h)}
          >
            <Badge method={h.method} />
            <span class="hit-text">
              <span class="ellipsis">{h.name}</span>
              <span class="file ellipsis">{basename(h.path)} · {h.url}</span>
            </span>
          </button>
        {/each}
      </div>
    {:else if app.usages}
      {@const rows = app.usages.usages && usageRows(app.usages.usages, app.root ?? "")}
      <section class="usages" bind:this={usagesEl} aria-label="Usages of {app.usages.name}">
        <div class="usages-head">
          <span class="usages-title ellipsis">Usages of <code>{`{{${app.usages.name}}}`}</code></span>
          <button class="icon-btn" bind:this={closeUsages} aria-label="Close usages" use:tooltip onclick={() => app.closeUsages()}><Icon name="x" size={12} /></button>
        </div>
        {#if !rows}
          <div class="none muted">Searching…</div>
        {:else if !rows.length}
          <div class="none muted">Nothing in the workspace uses <code>{`{{${app.usages.name}}}`}</code>.</div>
        {:else}
          <div class="usages-count muted">{rows.length} {rows.length === 1 ? "place" : "places"}</div>
          <!-- One Tab stop, the arrow keys move (rovingList); Enter clicks the row. -->
          <div role="list" aria-label="Usages" use:rovingList>
            {#each rows as row (row.key)}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
              <div role="listitem" tabindex="-1" class="list-row hit usage" class:disabled={row.disabled} onclick={() => app.openUsage(row.usage)}>
                {#if row.method}<Badge method={row.method} />{:else}<span class="usage-icon"><Icon name={row.usage.kind === "environment" ? "globe" : "code"} size={13} /></span>{/if}
                <span class="hit-text">
                  <span class="ellipsis">{row.title}</span>
                  <span class="file ellipsis">{row.where}{row.disabled ? " · disabled" : ""}</span>
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {:else if app.tree}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="tree"
        bind:this={treeEl}
        role="tree"
        aria-label="Explorer"
        aria-multiselectable="true"
        tabindex="-1"
        onkeydown={onTreeKey}
        onfocusin={(e) => {
          if (!isRow(e.target)) return;
          makeCurrent(e.target);
          lastRow = rowId(e.target);
        }}
        class:drop={rootDrop}
        ondragover={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            rootDrop = true;
          }
        }}
        ondragleave={() => (rootDrop = false)}
        ondrop={(e) => {
          rootDrop = false;
          const src = e.dataTransfer?.getData("text/x-httpdesk-path");
          if (src && e.target === e.currentTarget) app.movePath(src, joinPath(app.root!, basename(src)));
        }}
      >
        {#each app.tree.children ?? [] as node (node.path)}
          <TreeItem {node} depth={0} />
        {/each}
        {#if !app.tree.children?.length}
          <div class="none muted">
            No .http files yet.<br />
            <button class="link" onclick={() => app.createFile(app.root!)}>Create one</button> or
            <button class="link" onclick={() => (app.modal = "openapi")}>import OpenAPI</button>.
          </div>
        {/if}
      </div>
    {/if}
  </div>
  {/if}
</div>

<style>
  .sidebar {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  /* At the default width (280 px) the switch, the Explorer's buttons and Collapse
     sidebar share one row, so each is a little tighter here than elsewhere. */
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 8px 4px 4px 8px;
  }
  .views {
    flex: none;
  }
  .views :global(.segmented button) {
    padding: 0 var(--space-2);
  }
  /* At the row's end, or wrapped whole onto the next row, still at the end. As tall
     as the view switch, so it centres on the switch's row. */
  .tools {
    display: flex;
    align-items: center;
    gap: 3px;
    height: 28px;
    margin-left: auto;
  }
  .actions {
    display: flex;
  }
  /* A notch under .small, so the five fit beside the switch at 280 px; square, so a
     hover's background sits evenly around the icon. (Collapse sidebar stays .small:
     History's Clear button lines up under it.) */
  .actions .icon-btn {
    width: 20px;
    height: 20px;
  }
  .divider {
    width: 1px;
    height: 16px;
    background: var(--border);
  }
  .search {
    margin: 4px 10px 8px;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 4px 0 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--panel-2);
    color: var(--muted);
  }
  .search:focus-within {
    border-color: var(--focus);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: none;
    font-size: 12.5px;
  }
  .search .icon-btn {
    width: 20px;
    height: 20px;
  }
  .scroll {
    flex: 1;
    overflow: auto;
    padding-bottom: 20px;
  }
  .tree {
    min-height: 100%;
  }
  .tree.drop {
    background: var(--accent-soft);
  }
  .none {
    padding: 16px;
    line-height: 1.7;
    font-size: 12.5px;
  }
  .hit {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 12px;
    border: none;
    background: none;
    text-align: left;
    cursor: pointer;
    color: var(--text);
  }
  .hit:hover {
    background: var(--hover);
  }
  .hit.selected {
    background: var(--accent-soft);
  }
  .hit-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .file {
    font-size: 11px;
    color: var(--muted);
  }
  .usages-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px 2px 14px;
  }
  .usages-title {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    font-weight: 600;
  }
  .usages-head .icon-btn {
    width: 20px;
    height: 20px;
  }
  code {
    font-family: var(--mono);
    font-size: 11.5px;
  }
  .usages-count {
    padding: 0 14px 4px;
    font-size: 11px;
  }
  .usage-icon {
    display: inline-flex;
    justify-content: center;
    width: 38px;
    flex: none;
    color: var(--muted);
  }
  .usage.disabled .hit-text > :first-child {
    color: var(--muted);
  }
</style>
