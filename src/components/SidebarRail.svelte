<script lang="ts">
  // The collapsed sidebar (#218): a thin strip down the left edge with a button per
  // sidebar view. Clicking one opens the sidebar on that view, with focus in it. The
  // view the sidebar was last on is marked, and is what ⌘B / Ctrl+B reopens. Dragging
  // the strip's edge outward opens the sidebar too, at its saved width.
  import { app, type SidebarView } from "../lib/store.svelte";
  import { shortcutHint } from "../lib/commands";
  import { tooltip } from "../lib/popup/tooltip.svelte";
  import Icon from "./Icon.svelte";

  const VIEWS: { value: SidebarView; label: string; icon: string }[] = [
    { value: "explorer", label: "Explorer", icon: "explorer" },
    { value: "history", label: "History", icon: "history" },
  ];

  /** How far (px) the edge is dragged outward before the sidebar opens. */
  const OPEN_DRAG = 8;

  const buttons: Partial<Record<SidebarView, HTMLButtonElement>> = $state({});

  /** Focuses the marked view's button (collapsing with focus in the sidebar lands here). */
  export function focusMarked() {
    buttons[app.sidebarView]?.focus();
  }

  function open(view: SidebarView) {
    if (view === "explorer") app.explorerFocusWanted = true;
    else app.historyFocusWanted = true;
    app.showSidebar(view);
  }

  let grab: number | null = null;

  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    grab = e.clientX;
  }

  function onpointermove(e: PointerEvent) {
    if (grab === null || e.clientX - grab < OPEN_DRAG) return;
    grab = null;
    app.showSidebar(app.sidebarView);
  }
</script>

<nav class="rail" aria-label="Sidebar">
  {#each VIEWS as v (v.value)}
    {@const marked = v.value === app.sidebarView}
    <button
      class="icon-btn rail-btn"
      class:marked
      aria-label={v.label}
      aria-current={marked ? "true" : undefined}
      bind:this={buttons[v.value]}
      use:tooltip={marked ? `${v.label} (${shortcutHint("toggle-sidebar")})` : v.label}
      onclick={() => open(v.value)}
    >
      <Icon name={v.icon} size={18} />
    </button>
  {/each}
  <!-- Pointer only: the keyboard opens the sidebar with the buttons, or ⌘B / Ctrl+B. -->
  <div class="edge" aria-hidden="true" {onpointerdown} {onpointermove} onpointerup={() => (grab = null)} onpointercancel={() => (grab = null)}></div>
</nav>

<style>
  .rail {
    position: relative;
    flex: none;
    width: 40px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding-top: 8px;
    background: var(--panel);
    border-right: 1px solid var(--border);
  }
  .rail-btn {
    position: relative;
    width: 32px;
    height: 32px;
  }
  .rail-btn.marked {
    color: var(--text);
  }
  /* The marker: a short bar on the rail's left edge, beside the last-used view. Quiet,
     in the text colour: accent is kept for what needs attention (as the status bar's
     pressed Problems toggle). */
  .rail-btn.marked::before {
    content: "";
    position: absolute;
    left: -4px;
    top: 7px;
    bottom: 7px;
    width: 2px;
    border-radius: 1px;
    background: var(--text);
  }
  /* A grab area over the rail's right border, like the sidebar's separator. */
  .edge {
    position: absolute;
    top: 0;
    bottom: 0;
    right: -4px;
    width: 7px;
    cursor: col-resize;
    z-index: 5;
    touch-action: none;
  }
  .edge:hover {
    background: color-mix(in srgb, var(--focus) 35%, transparent);
  }
</style>
