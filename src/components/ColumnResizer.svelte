<script lang="ts">
  // The resize handle at a grid header cell's right edge (KeyValueGrid's
  // `resize` columns): drag it, or focus it and use the arrow keys (Home/End for
  // the limits); double-click or Enter fits the column to its widest value. Like
  // SplitPane's separator, the width is the caller's: `onresize` reports a new one.

  interface Props {
    /** Accessible name, e.g. "Resize local column". */
    label: string;
    /** The column's width now, px. */
    width: number;
    min: number;
    max: number;
    /** One arrow-key press, px. */
    step: number;
    /** A new width: `done` is false while a drag is under way, true once it's settled (save it then). */
    onresize: (width: number, done: boolean) => void;
    /** Fit the column to its widest value. */
    onfit: () => void;
  }
  let { label, width, min, max, step, onresize, onfit }: Props = $props();

  let grab: { pointer: number; start: number; moved: boolean } | null = null;
  let dragging = $state(false);

  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)));

  function onpointerdown(e: PointerEvent) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    (e.currentTarget as HTMLElement).focus();
    grab = { pointer: e.clientX, start: width, moved: false };
  }

  function onpointermove(e: PointerEvent) {
    if (!grab) return;
    const next = clamp(grab.start + e.clientX - grab.pointer);
    if (!grab.moved && next === clamp(grab.start)) return;
    grab.moved = true;
    dragging = true;
    onresize(next, false);
  }

  // A press without a move changes nothing (a double-click's first click must not pin the width).
  function onpointerup(e: PointerEvent) {
    if (!grab) return;
    const { moved, start, pointer } = grab;
    grab = null;
    dragging = false;
    if (moved) onresize(clamp(start + e.clientX - pointer), true);
  }

  function onkeydown(e: KeyboardEvent) {
    let next: number;
    if (e.key === "ArrowLeft") next = width - step;
    else if (e.key === "ArrowRight") next = width + step;
    else if (e.key === "Home") next = min;
    else if (e.key === "End") next = max;
    else if (e.key === "Enter") {
      e.preventDefault();
      onfit();
      return;
    } else return;
    e.preventDefault();
    onresize(clamp(next), true);
  }
</script>

<!-- A focusable separator with a value is a widget in ARIA (the window splitter
     pattern); Svelte's checker only knows the static kind. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  class="col-resizer"
  class:dragging
  role="separator"
  tabindex="0"
  aria-label={label}
  aria-orientation="vertical"
  aria-valuenow={Math.round(width)}
  aria-valuemin={min}
  aria-valuemax={max}
  {onpointerdown}
  {onpointermove}
  {onpointerup}
  onpointercancel={onpointerup}
  ondblclick={onfit}
  {onkeydown}
></div>

<style>
  /* A grab area at the header cell's right edge (inside it, since header cells clip);
     hover and drag show a line on the edge, keyboard focus rings it. */
  .col-resizer {
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 7px;
    z-index: 2;
    cursor: col-resize;
    touch-action: none;
    outline: none;
  }
  .col-resizer::after {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    right: 0;
    width: 2px;
  }
  .col-resizer:hover::after,
  .col-resizer.dragging::after,
  .col-resizer:focus-visible::after {
    background: var(--focus);
  }
  .col-resizer:focus-visible {
    outline: var(--focus-ring);
    outline-offset: var(--focus-ring-inset);
  }
</style>
