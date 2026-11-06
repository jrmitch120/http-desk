<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { app } from "../lib/store.svelte";
  import { menu } from "../lib/menu.svelte";
  import { basename } from "../lib/http";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { updates } from "../lib/updates.svelte";

  async function openFolder() {
    const dir = await open({ directory: true, title: "Open workspace folder" });
    if (typeof dir === "string") await app.openWorkspace(dir);
  }

  function workspaceMenu(e: MouseEvent) {
    const recent = (app.settings?.recentWorkspaces ?? []).filter((w) => w !== app.root).slice(0, 8);
    menu.show(e, [
      { label: "Open folder…", icon: "folder-open", action: openFolder },
      ...(recent.length ? [{ separator: true }, ...recent.map((w) => ({ label: basename(w), icon: "folder", action: () => app.openWorkspace(w) }))] : []),
    ]);
  }

  const envNames = $derived(app.envSet?.environments.map((e) => e.name) ?? []);
  const layout = $derived(app.settings?.layout ?? "horizontal");
  const theme = $derived(app.settings?.theme ?? "dark");
</script>

<header class="topbar">
  <button class="ws" onclick={workspaceMenu} use:tooltip={app.root}>
    <svg viewBox="0 0 1024 1024" width="18" height="18" aria-hidden="true">
      <rect x="64" y="64" width="896" height="896" rx="200" fill="var(--accent)" />
      <path d="M300 330 L460 512 L300 694" fill="none" stroke="#fff" stroke-width="96" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M540 694 H730" fill="none" stroke="#fff" stroke-width="96" stroke-linecap="round" />
    </svg>
    <span class="name">{basename(app.root ?? "")}</span>
    <Icon name="chevron-down" size={13} />
  </button>

  <div class="spacer"></div>

  <button class="btn small ghost" onclick={() => (app.modal = "openapi")} use:tooltip={"Generate .http files from an OpenAPI specification"}>
    <Icon name="import" size={14} />Import OpenAPI
  </button>

  <div class="env" class:none={!app.envName}>
    <Icon name="globe" size={14} />
    <select
      class="env-select"
      value={app.envName ?? ""}
      onchange={(e) => app.selectEnvironment((e.currentTarget as HTMLSelectElement).value || null)}
      aria-label="Active environment"
      use:tooltip
    >
      <option value="">No environment</option>
      {#each envNames as n (n)}<option value={n}>{n}</option>{/each}
    </select>
    <button class="icon-btn" onclick={() => (app.modal = "env")} aria-label="Manage environments" use:tooltip={"Manage environments (⌘/Ctrl E)"}><Icon name="layers" size={14} /></button>
  </div>

  {#if updates.progress !== null}
    <span class="update-pill" use:tooltip={"Downloading the update; HttpDesk restarts when it's done"}>
      <Icon name="download" size={13} />Updating… {Math.round(updates.progress * 100)}%
    </span>
  {/if}
  <button
    class="icon-btn"
    aria-label={layout === "horizontal" ? "Show response below" : "Show response on the right"}
    use:tooltip
    onclick={() => app.updateSettings({ layout: layout === "horizontal" ? "vertical" : "horizontal" })}
  >
    <Icon name={layout === "horizontal" ? "rows" : "columns"} />
  </button>
  <button class="icon-btn" aria-label="Toggle theme" use:tooltip onclick={() => app.updateSettings({ theme: theme === "dark" ? "light" : "dark" })}>
    <Icon name={theme === "dark" ? "sun" : "moon"} />
  </button>
  <button class="icon-btn" aria-label="Settings" use:tooltip={"Settings (⌘/Ctrl ,)"} onclick={() => (app.modal = "settings")}><Icon name="settings" /></button>
</header>

<style>
  .update-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 24px;
    padding: 0 10px;
    border-radius: 12px;
    font-size: 12px;
    color: var(--accent);
    background: var(--accent-soft);
    margin-right: 6px;
  }
  .topbar {
    height: 42px;
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
  }
  .ws {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 8px;
    border: none;
    background: none;
    border-radius: var(--radius-sm);
    cursor: pointer;
    color: var(--text);
    font-weight: 600;
  }
  .ws:hover {
    background: var(--hover);
  }
  .ws :global(svg:last-child) {
    color: var(--muted);
  }
  .env {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 30px;
    padding-left: 9px;
    margin: 0 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--panel-2);
    color: var(--success);
  }
  .env.none {
    color: var(--muted);
  }
  .env-select {
    height: 28px;
    border: none;
    background: transparent;
    color: var(--text);
    outline: none;
    padding: 0 6px;
    min-width: 150px;
    max-width: 220px;
    cursor: pointer;
  }
</style>
