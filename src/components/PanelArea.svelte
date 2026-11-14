<!--
  The panel area below the requests: one panel at a time (`app.panel`), picked
  from a switcher, with a button hiding the area. App.svelte docks it in a
  resizable split. A new panel is a `PanelId`, a line in PANELS and a command
  that shows it (src/lib/commands.ts).
-->
<script lang="ts">
  import type { Component } from "svelte";
  import { app, type PanelId } from "../lib/store.svelte";
  import { shortcutHint, type CommandId } from "../lib/commands";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Icon from "./Icon.svelte";
  import SegmentedControl from "./SegmentedControl.svelte";
  import SessionPanel from "./SessionPanel.svelte";
  import RunnerPanel from "./RunnerPanel.svelte";

  const PANELS: { value: PanelId; label: string; component: Component; command: CommandId }[] = [
    { value: "session", label: "Session", component: SessionPanel, command: "toggle-session" },
    { value: "runner", label: "Runner", component: RunnerPanel, command: "toggle-runner" },
  ];

  const shown = $derived(PANELS.find((p) => p.value === app.panel) ?? PANELS[0]);
</script>

<div class="panel-area">
  <div class="head">
    <SegmentedControl options={PANELS} value={shown.value} label="Panels" onchange={(p) => (app.panel = p)} />
    <span class="spacer"></span>
    <button class="icon-btn" aria-label="Hide panel ({shortcutHint(shown.command)})" use:tooltip onclick={() => (app.panel = null)}>
      <Icon name="x" size={12} />
    </button>
  </div>
  <section class="body" aria-label={shown.label}>
    <shown.component />
  </section>
</div>

<style>
  .panel-area {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    background: var(--panel);
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px 0 12px;
    flex: none;
  }
  .spacer {
    flex: 1;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
</style>
