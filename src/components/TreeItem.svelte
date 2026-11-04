<script lang="ts">
  import { revealItemInDir } from "@tauri-apps/plugin-opener";
  import { app } from "../lib/store.svelte";
  import { menu } from "../lib/menu.svelte";
  import { basename, displayName, joinPath, methodClass } from "../lib/http";
  import type { TreeNode } from "../lib/types";
  import TreeItem from "./TreeItem.svelte";
  import Icon from "./Icon.svelte";

  let { node, depth }: { node: TreeNode; depth: number } = $props();

  const isDir = $derived(node.kind === "dir");
  const open = $derived(!!app.expanded[node.path]);
  const doc = $derived(app.docs[node.path]);
  const dirty = $derived(!isDir && app.isDocDirty(node.path));
  let dropping = $state(false);

  function toggle() {
    app.expanded[node.path] = !open;
  }

  // Load requests whenever a file is expanded (by click, import, new request, …).
  $effect(() => {
    if (open && !isDir && !app.docs[node.path]) app.loadDoc(node.path);
  });

  const reveal = () => revealItemInDir(node.path).catch((e) => app.toast("error", String(e)));

  function contextMenu(e: MouseEvent) {
    if (isDir) {
      menu.show(e, [
        { label: "New .http file", icon: "plus", action: () => app.createFile(node.path) },
        { label: "New folder", icon: "folder", action: () => app.createFolder(node.path) },
        { separator: true },
        { label: "Rename…", icon: "edit", action: () => app.renamePath(node.path) },
        { label: "Reveal in file manager", icon: "reveal", action: reveal },
        { separator: true },
        { label: "Move to trash", icon: "trash", danger: true, action: () => app.deletePath(node.path) },
      ]);
    } else {
      menu.show(e, [
        { label: "New request", icon: "plus", action: () => app.addRequest(node.path) },
        { label: "Save", icon: "save", disabled: !dirty, action: () => app.save(node.path) },
        { separator: true },
        { label: "Rename…", icon: "edit", action: () => app.renamePath(node.path) },
        { label: "Reveal in file manager", icon: "reveal", action: reveal },
        { separator: true },
        { label: "Move to trash", icon: "trash", danger: true, action: () => app.deletePath(node.path) },
      ]);
    }
  }

  function requestMenu(e: MouseEvent, key: string) {
    menu.show(e, [
      { label: "Open", icon: "send", action: () => app.openRequest(node.path, { key }) },
      { label: "Rename…", icon: "edit", action: () => app.renameRequest(node.path, key) },
      { label: "Duplicate", icon: "copy", action: () => app.duplicateRequest(node.path, key) },
      { separator: true },
      { label: "Delete", icon: "trash", danger: true, action: () => app.deleteRequest(node.path, key) },
    ]);
  }

  function onDrop(e: DragEvent) {
    dropping = false;
    const src = e.dataTransfer?.getData("text/x-httpdesk-path");
    if (!src || !isDir) return;
    e.preventDefault();
    e.stopPropagation();
    app.movePath(src, joinPath(node.path, basename(src)));
  }

  const pad = $derived(10 + depth * 14);
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="row-item"
  class:dropping
  style:padding-left="{pad}px"
  draggable="true"
  role="treeitem"
  aria-selected="false"
  aria-expanded={open}
  tabindex="0"
  title={node.path}
  onclick={toggle}
  onkeydown={(e) => e.key === "Enter" && toggle()}
  oncontextmenu={contextMenu}
  ondragstart={(e) => e.dataTransfer?.setData("text/x-httpdesk-path", node.path)}
  ondragover={(e) => {
    if (isDir) {
      e.preventDefault();
      dropping = true;
    }
  }}
  ondragleave={() => (dropping = false)}
  ondrop={onDrop}
>
  <span class="chev"><Icon name={open ? "chevron-down" : "chevron-right"} size={12} /></span>
  <span class="ico" class:file={!isDir}><Icon name={isDir ? (open ? "folder-open" : "folder") : "file"} size={14} /></span>
  <span class="label ellipsis">{node.name}</span>
  {#if dirty}<span class="dot" title="Unsaved changes"></span>{/if}
  {#if !isDir}
    <button class="icon-btn add" title="New request in this file" onclick={(e) => (e.stopPropagation(), app.addRequest(node.path))}>
      <Icon name="plus" size={13} />
    </button>
  {/if}
</div>

{#if open}
  {#if isDir}
    {#each node.children ?? [] as child (child.path)}
      <TreeItem node={child} depth={depth + 1} />
    {/each}
  {:else if doc}
    {#each doc.file.requests as req (req._key)}
      {@const active = app.activeTab?.path === node.path && app.activeTab?.key === req._key}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="row-item req"
        data-testid="req-{displayName(req)}"
        class:active
        style:padding-left="{pad + 26}px"
        role="treeitem"
        aria-selected={active}
        tabindex="0"
        onclick={() => app.openRequest(node.path, { key: req._key })}
        onkeydown={(e) => e.key === "Enter" && app.openRequest(node.path, { key: req._key })}
        oncontextmenu={(e) => requestMenu(e, req._key!)}
      >
        <span class="method-badge {methodClass(req.method)}">{req.method.slice(0, 6)}</span>
        <span class="label ellipsis">{displayName(req)}</span>
        {#if app.isRequestDirty(node.path, req._key!)}<span class="dot"></span>{/if}
      </div>
    {:else}
      <div class="row-item empty" style:padding-left="{pad + 26}px">
        <button class="link" onclick={() => app.addRequest(node.path)}>Add a request</button>
      </div>
    {/each}
  {/if}
{/if}

<style>
  .row-item {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding-right: 6px;
    cursor: pointer;
    color: var(--text-2);
    outline: none;
    border-left: 2px solid transparent;
  }
  .row-item:hover {
    background: var(--hover);
    color: var(--text);
  }
  .row-item:focus-visible {
    background: var(--hover);
  }
  .row-item.active {
    background: var(--accent-soft);
    border-left-color: var(--accent);
    color: var(--text);
  }
  .row-item.dropping {
    background: var(--accent-soft);
    outline: 1px dashed var(--accent);
  }
  .row-item.empty {
    cursor: default;
    font-size: 12px;
  }
  .row-item.empty:hover {
    background: none;
  }
  .chev {
    width: 12px;
    display: inline-flex;
    color: var(--faint);
    flex: none;
  }
  .ico {
    display: inline-flex;
    color: var(--muted);
    flex: none;
  }
  .ico.file {
    color: var(--accent);
    opacity: 0.85;
  }
  .label {
    flex: 1;
    min-width: 0;
  }
  .req .method-badge {
    min-width: 40px;
    text-align: right;
    padding-right: 4px;
  }
  .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    flex: none;
  }
  .add {
    width: 20px;
    height: 20px;
    visibility: hidden;
  }
  .row-item:hover .add {
    visibility: visible;
  }
</style>
