<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { app } from "../lib/store.svelte";
  import { menu } from "../lib/menu.svelte";
  import { basename } from "../lib/http";
  import { folderLabel } from "../lib/envFolders";
  import { THEMES, themeLabel } from "../lib/themes";
  import { envColorShade } from "../lib/envColors";
  import Icon from "./Icon.svelte";
  import Select, { type SelectOption } from "./Select.svelte";
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

  // Every environment in the workspace (ADR-0004). With a request open, names its folder
  // doesn't define are marked: picking one sends that request with no environment.
  const envOptions: SelectOption[] = $derived.by(() => {
    const tab = app.activeTab;
    const own = tab ? app.envSetFor(tab.path) : null;
    const note = tab && app.root ? `not defined for ${folderLabel(app.folderOf(tab.path))}` : "";
    return [
      { value: "", label: "No environment" },
      ...app.envNames.map((name) => ({ value: name, label: name, note: tab && !own?.environments.some((e) => e.name === name) ? note : undefined })),
    ];
  });
  const layout = $derived(app.settings?.layout ?? "horizontal");

  // ⌘⌥E / Ctrl+Alt+E, and "Choose environment" on an Undefined-variable send error, open the picker.
  let envSelect: { openList: () => void } | undefined = $state();
  $effect(() => {
    if (app.envPickerWanted && envSelect) {
      envSelect.openList();
      app.envPickerWanted = false;
    }
  });

  // The theme menu: System / Light / Dark, the current choice checked.
  let themeButton: HTMLButtonElement | undefined = $state();
  // "Theme: Light", or with System what it resolves to: "Theme: System (Dark)".
  const themeTip = $derived(
    `Theme: ${themeLabel(app.themeChoice)}${app.themeChoice === "system" ? ` (${themeLabel(app.effectiveTheme)})` : ""}`,
  );

  function themeMenu(e: MouseEvent) {
    if (menu.isOpenFrom(themeButton)) return menu.close(false);
    menu.show(
      e,
      THEMES.map((t) => ({ label: t.label, icon: t.icon, checked: app.themeChoice === t.value, action: () => app.updateSettings({ theme: t.value }) })),
      { anchor: themeButton, align: "end", label: "Theme" },
    );
  }
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

  <div class="env" class:none={!app.envName} class:tinted={!!app.envColor} style:--env-color={app.envColor ? envColorShade(app.envColor, app.effectiveTheme) : null}>
    <Icon name="globe" size={14} />
    <Select
      bind:this={envSelect}
      class="env-select"
      options={envOptions}
      value={app.envName ?? ""}
      onchange={(v) => app.selectEnvironment(v || null)}
      label="Active environment"
      tooltip="Active environment (⌘⌥E / Ctrl Alt E)"
    />
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
  <button
    class="icon-btn theme-btn"
    bind:this={themeButton}
    aria-label="Theme"
    aria-haspopup="menu"
    aria-expanded={menu.isOpenFrom(themeButton)}
    use:tooltip={themeTip}
    onclick={themeMenu}
  >
    <Icon name={app.effectiveTheme === "dark" ? "moon" : "sun"} />
    {#if app.themeChoice === "system"}<span class="auto" aria-hidden="true">A</span>{/if}
  </button>
  <button class="icon-btn" aria-label="Settings" use:tooltip={"Settings (⌘/Ctrl ,)"} onclick={() => (app.modal = "settings")}><Icon name="settings" /></button>
</header>

<style>
  .theme-btn {
    position: relative;
  }
  /* "Automatic": System is chosen, so the icon follows the OS. */
  .auto {
    position: absolute;
    right: 1px;
    bottom: 1px;
    min-width: 11px;
    height: 11px;
    padding: 0 2px;
    border-radius: 6px;
    font-size: 8px;
    font-weight: 700;
    line-height: 11px;
    text-align: center;
    color: var(--panel);
    background: var(--muted);
    pointer-events: none;
  }
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
