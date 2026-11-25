<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { menu } from "../lib/menu.svelte";
  import { basename } from "../lib/http";
  import { folderLabel } from "../lib/envFolders";
  import { envColorShade } from "../lib/envColors";
  import Icon from "./Icon.svelte";
  import Select, { type SelectOption } from "./Select.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import { runCommand, shortcutHint } from "../lib/commands";
  import { updates } from "../lib/updates.svelte";

  function workspaceMenu(e: MouseEvent) {
    const recent = app.otherRecentWorkspaces;
    menu.show(e, [
      { label: "Open folder…", icon: "folder-open", action: () => runCommand("open-folder") },
      ...(recent.length ? [{ separator: true }, ...recent.map((w) => ({ label: basename(w), icon: "folder", action: () => app.openWorkspace(w) }))] : []),
    ]);
  }

  const PRODUCTION_BADGE = { text: "Prod", tone: "danger" } as const;

  // Every environment in the workspace (ADR-0004). With a request open, names its folder
  // doesn't define are marked: picking one sends that request with no environment.
  const envOptions: SelectOption[] = $derived.by(() => {
    const tab = app.activeTab;
    const own = tab ? app.envSetFor(tab.path) : null;
    const note = tab && app.root ? `not defined for ${folderLabel(app.folderOf(tab.path))}` : "";
    return [
      { value: "", label: "No environment" },
      ...app.envNames.map((name) => ({
        value: name,
        label: name,
        note: tab && !own?.environments.some((e) => e.name === name) ? note : undefined,
        // Production comes from the app settings, as for the production send guard.
        badge: app.environmentSettings(name).production ? PRODUCTION_BADGE : undefined,
      })),
    ];
  });
  // ⌘⌥E / Ctrl+Alt+E, and "Choose environment" on an Undefined-variable send error, open the picker.
  let envSelect: { openList: () => void } | undefined = $state();
  $effect(() => {
    if (app.envPickerWanted && envSelect) {
      envSelect.openList();
      app.envPickerWanted = false;
    }
  });
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

  <!-- Three groups, set apart by spacing: environment; status; view and app (Settings).
       The sidebar collapses from its own header (Sidebar.svelte). -->
  <div class="group">
    <div class="env" class:none={!app.envName} class:tinted={!!app.envColor} style:--env-color={app.envColor ? envColorShade(app.envColor, app.effectiveTheme) : null}>
      <Icon name="globe" size={14} />
      <Select
        bind:this={envSelect}
        class="env-select"
        options={envOptions}
        value={app.envName ?? ""}
        onchange={(v) => app.selectEnvironment(v || null)}
        label="Active environment"
        tooltip={`Active environment (${shortcutHint("choose-environment")})`}
      />
      <button class="icon-btn" onclick={() => (app.modal = "env")} aria-label="Manage environments" use:tooltip={`Manage environments (${shortcutHint("manage-environments")})`}><Icon name="layers" size={14} /></button>
    </div>
  </div>

  {#if updates.progress !== null}
    <div class="group">
      <span class="update-pill" use:tooltip={"Downloading the update; HttpDesk restarts when it's done"}>
        <Icon name="download" size={13} />Updating… {Math.round(updates.progress * 100)}%
      </span>
    </div>
  {/if}

  <div class="group">
    <button class="icon-btn" aria-label="Settings" use:tooltip={`Settings (${shortcutHint("settings")})`} onclick={() => (app.modal = "settings")}><Icon name="settings" /></button>
  </div>
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
  .group {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* A little extra space between groups, no divider lines. */
  .group + .group {
    margin-left: var(--space-3);
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
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--panel-2);
    /* Neutral unless the user gave the environment a colour (.tinted). */
    color: var(--text);
  }
  .env.none {
    color: var(--muted);
  }
  /* The environment's own colour (Environments modal) on the icon and border,
     with a faint wash behind; the name keeps --text, so it reads in both themes. */
  .env.tinted {
    color: var(--env-color);
    border-color: var(--env-color);
    background: color-mix(in srgb, var(--env-color) 12%, var(--panel-2));
  }
  .env :global(.env-select) {
    height: 28px;
    border-color: transparent;
    background: transparent;
    padding: 0 6px;
    min-width: 150px;
    max-width: 220px;
  }
</style>
