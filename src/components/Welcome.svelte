<script lang="ts">
  import { open } from "@tauri-apps/plugin-dialog";
  import { app } from "../lib/store.svelte";
  import { basename } from "../lib/http";
  import AppIcon from "./AppIcon.svelte";
  import Icon from "./Icon.svelte";
  import { tooltip } from "../lib/popup/tooltip.svelte";

  async function openFolder() {
    const dir = await open({ directory: true, title: "Open workspace folder" });
    if (typeof dir === "string") await app.openWorkspace(dir);
  }
</script>

<div class="welcome">
  <div class="card">
    <div class="logo">
      <AppIcon size={56} />
    </div>
    <h1>HttpDesk</h1>
    <p class="muted">A graphical HTTP client for plain <code>.http</code> files.<br />Your requests stay portable, readable and version-controlled.</p>
    <button class="btn primary big" onclick={openFolder}><Icon name="folder-open" />Open folder…</button>

    {#if app.settings?.recentWorkspaces.length}
      <div class="recent">
        <div class="label">Recent</div>
        {#each app.settings.recentWorkspaces as ws (ws)}
          <button class="recent-item" onclick={() => app.openWorkspace(ws)} use:tooltip={ws}>
            <Icon name="folder" />
            <span class="name">{basename(ws)}</span>
            <span class="path ellipsis">{ws}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .welcome {
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: radial-gradient(1200px 600px at 50% -10%, var(--accent-soft), transparent), var(--bg);
  }
  .card {
    width: 440px;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 12px;
  }
  h1 {
    margin: 4px 0 0;
    font-size: 26px;
    font-weight: 650;
    letter-spacing: -0.01em;
  }
  p {
    margin: 0 0 10px;
    line-height: 1.6;
  }
  code {
    font-family: var(--mono);
    color: var(--text);
  }
  .big {
    height: 36px;
    padding: 0 18px;
    font-size: 13.5px;
  }
  .recent {
    width: 100%;
    margin-top: 22px;
    text-align: left;
  }
  .label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
    margin: 0 0 6px 8px;
  }
  .recent-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 7px 8px;
    border: none;
    background: none;
    border-radius: 6px;
    cursor: pointer;
    color: var(--text);
    text-align: left;
  }
  .recent-item:hover {
    background: var(--hover);
  }
  .recent-item :global(svg) {
    color: var(--muted);
    flex: none;
  }
  .name {
    font-weight: 500;
    flex: none;
  }
  .path {
    color: var(--faint);
    font-size: 12px;
    min-width: 0;
  }
</style>
