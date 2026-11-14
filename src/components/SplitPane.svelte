<script lang="ts">
  // Two panes and a separator between them. The first pane has the size (the
  // second with `end`); the other takes the rest. Drag the separator, or focus it
  // and use the arrow keys (Home/End for the limits); double-click resets to the
  // default. The size is the caller's: `onresize` reports a new one, and the
  // caller stores it and passes it back as `size`. `collapsed` hides the sized
  // pane and the separator, so the other takes the whole; the sized one stays
  // mounted, keeping its state for when it's shown again, at the same size.
  import type { Snippet } from "svelte";
  import { clampPane, type PaneLimits } from "../lib/panes";

  interface Props {
    /** The first pane's size: px, or with `ratio` its share (0..1) of the whole. */
    size: number;
    limits: PaneLimits;
    ratio?: boolean;
    /** Panes one above the other (a horizontal separator) instead of side by side. */
    stacked?: boolean;
    /** The second pane has the size, and the first takes the rest (a panel docked at the end). */
    end?: boolean;
    /** Hides the sized pane and the separator (not rendered, not focusable). */
    collapsed?: boolean;
    /** Accessible name of the separator. */
    label: string;
    /** Called with the new size after a drag, a key press or a double-click. */
    onresize: (size: number) => void;
    first: Snippet;
    second: Snippet;
  }

  let { size, limits, ratio = false, stacked = false, end = false, collapsed = false, label, onresize, first, second }: Props = $props();

  const id = $props.id();
  let root: HTMLDivElement;
  /** The size while a drag is under way; committed on release. */
  let dragging = $state<number | null>(null);
  let grab: { pointer: number; start: number; span: number } | null = null;

  const current = $derived(dragging ?? clampPane(size, limits));
  const basis = $derived(ratio ? `${current * 100}%` : `${current}px`);
  // The value assistive tech announces: px, or a ratio as a percentage.
  const announced = (v: number) => Math.round(ratio ? v * 100 : v);

  function roundAndClamp(v: number): number {
    return clampPane(ratio ? Math.round(v * 1000) / 1000 : Math.round(v), limits);
  }

  function commit(v: number) {
    const next = roundAndClamp(v);
    if (next !== clampPane(size, limits)) onresize(next);
  }

  /** The pointer's position along the drag axis, growing towards the sized pane's far side. */
  const pointerAt = (e: PointerEvent) => (stacked ? e.clientY : e.clientX) * (end ? -1 : 1);

  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const rect = root.getBoundingClientRect();
    grab = { pointer: pointerAt(e), start: current, span: ratio ? (stacked ? rect.height : rect.width) : 1 };
  }

  function onpointermove(e: PointerEvent) {
    if (!grab || !grab.span) return;
    dragging = roundAndClamp(grab.start + (pointerAt(e) - grab.pointer) / grab.span);
  }

  function onpointerup() {
    if (!grab) return;
    grab = null;
    const v = dragging;
    dragging = null;
    if (v !== null) commit(v);
  }

  function onkeydown(e: KeyboardEvent) {
    const keys = stacked ? ["ArrowUp", "ArrowDown"] : ["ArrowLeft", "ArrowRight"];
    // The separator moves with the arrow; the sized pane grows when it moves away from it.
    const [back, forward] = end ? keys.reverse() : keys;
    let next: number;
    if (e.key === back) next = current - limits.step;
    else if (e.key === forward) next = current + limits.step;
    else if (e.key === "Home") next = limits.min;
    else if (e.key === "End") next = limits.max;
    else return;
    e.preventDefault();
    commit(next);
  }
</script>

{#snippet sized(content: Snippet)}
  <div class="pane" class:collapsed id="{id}-sized" style:flex-basis={basis}>
    {@render content()}
  </div>
{/snippet}

<div class="split-pane" class:stacked bind:this={root}>
  {#if end}
    <div class="pane rest">
      {@render first()}
    </div>
  {:else}
    {@render sized(first)}
  {/if}
  {#if !collapsed}
    <!-- A focusable separator with a value is a widget in ARIA (the window
         splitter pattern); Svelte's checker only knows the static kind. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      class="separator"
      class:dragging={dragging !== null}
      role="separator"
      tabindex="0"
      aria-label={label}
      aria-controls="{id}-sized"
      aria-orientation={stacked ? "horizontal" : "vertical"}
      aria-valuenow={announced(current)}
      aria-valuemin={announced(limits.min)}
      aria-valuemax={announced(limits.max)}
      {onpointerdown}
      {onpointermove}
      {onpointerup}
      onpointercancel={onpointerup}
      ondblclick={() => commit(limits.initial)}
      {onkeydown}
    ></div>
  {/if}
  {#if end}
    {@render sized(second)}
  {:else}
    <div class="pane rest">
      {@render second()}
    </div>
  {/if}
</div>

<style>
  .split-pane {
    flex: 1;
    display: flex;
    min-width: 0;
    min-height: 0;
  }
  .split-pane.stacked {
    flex-direction: column;
  }
  .pane {
    flex-grow: 0;
    flex-shrink: 0;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .rest {
    flex: 1 1 0;
  }
  .pane.collapsed {
    display: none;
  }
  /* A 1px line with a wider grab area; hover and drag light it up, keyboard focus rings it. */
  .separator {
    flex: none;
    width: 1px;
    background: var(--border);
    cursor: col-resize;
    position: relative;
    z-index: 5;
    touch-action: none;
  }
  .separator::after {
    content: "";
    position: absolute;
    inset: 0 -3px;
  }
  .stacked > .separator {
    width: auto;
    height: 1px;
    cursor: row-resize;
  }
  .stacked > .separator::after {
    inset: -3px 0;
  }
  .separator:hover,
  .separator.dragging {
    background: var(--focus);
  }
  .separator:hover::after,
  .separator.dragging::after {
    background: color-mix(in srgb, var(--focus) 35%, transparent);
  }
  .separator:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }
</style>
