<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { errorMessage } from "../lib/api";
  import { basename, joinPath, methodClass } from "../lib/http";
  import type { SearchHit } from "../lib/types";
  import TreeItem from "./TreeItem.svelte";
  import Icon from "./Icon.svelte";

  let query = $state("");
  let hits = $state<SearchHit[]>([]);
  /** Index of the result Enter opens; Up/Down move it. */
  let selected = $state(0);
  let searching = $state(false);
  let searchInput: HTMLInputElement | undefined = $state();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;

  $effect(() => {
    if (app.focusSearch) searchInput?.focus();
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
    } else if (e.key === "Enter" && hits[selected]) app.openSearchHit(hits[selected]);
  }

  let rootDrop = $state(false);
</script>

<div class="sidebar">
  <div class="head">
    <span class="title">Explorer</span>
    <div class="spacer"></div>
    <button class="icon-btn" title="New .http file" onclick={() => app.createFile(app.root!)}><Icon name="plus" /></button>
    <button class="icon-btn" title="New folder" onclick={() => app.createFolder(app.root!)}><Icon name="folder" /></button>
    <button class="icon-btn" title="Import OpenAPI" onclick={() => (app.modal = "openapi")}><Icon name="import" /></button>
    <button class="icon-btn" title="Refresh" onclick={() => app.refreshTree()}><Icon name="refresh" /></button>
    <button class="icon-btn" title="Collapse all" onclick={collapseAll}><Icon name="fold" /></button>
  </div>

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
    {#if query}<button class="icon-btn" onclick={() => (query = "")}><Icon name="x" size={12} /></button>{/if}
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
            <span class="method-badge {methodClass(h.method)}">{h.method.slice(0, 6)}</span>
            <span class="hit-text">
              <span class="ellipsis">{h.name}</span>
              <span class="file ellipsis">{basename(h.path)} · {h.url}</span>
            </span>
          </button>
        {/each}
      </div>
    {:else if app.tree}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="tree"
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
</div>

<style>
  .sidebar {
    height: 100%;
    display: flex;
    flex-direction: column;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 1px;
    padding: 8px 8px 4px 14px;
  }
  .title {
    font-size: 11px;
    font-weight: 650;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
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
</style>
