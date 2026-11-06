// `use:popup`: an interactive floating surface (menu, Select list, suggestion
// list) in the shared popup layer. See layer.ts for the layer itself.
//
//   {#if open}
//     <div class="popup-surface my-list" role="listbox" use:popup={{ anchor: button, onclose: () => (open = false) }}>…</div>
//   {/if}
//
// The action moves the element into the layer, places it next to `anchor`
// (flipping and clamping so it stays on screen, and following the anchor on
// scroll, resize and content changes), and calls `onclose` on Escape, on a
// mousedown outside both the surface and the anchor, and when the window loses
// focus. The caller owns the element (its role, ARIA, keyboard and scoped
// styles), the open state and focus: focus doesn't move on open, and closing
// doesn't restore it. Give the element the `popup-surface` class for the
// shared look, and keep it the only top-level node of its `{#if}` block.
import { onEscape, portal } from "./layer";
import { placeElement, type AnchorRect, type PlaceOptions } from "./place";
import { hideTooltip } from "./tooltip.svelte";

export type CloseReason = "escape" | "outside" | "blur";

export interface PopupOptions extends PlaceOptions {
  /** The element it opens from (followed as it moves), or a fixed rect such as a pointer position. */
  anchor: HTMLElement | AnchorRect;
  /** Make the surface at least as wide as the anchor (a Select's list). */
  matchWidth?: boolean;
  onclose: (reason: CloseReason) => void;
}

export function popup(node: HTMLElement, options: PopupOptions) {
  let opts = options;
  hideTooltip();
  const moved = portal(node);

  const anchorRect = () => (opts.anchor instanceof HTMLElement ? opts.anchor.getBoundingClientRect() : opts.anchor);
  function position() {
    const r = anchorRect();
    if (opts.matchWidth) node.style.minWidth = `${r.right - r.left}px`;
    placeElement(node, r, opts);
  }

  const onOutside = (e: MouseEvent) => {
    const t = e.target as Node;
    if (node.contains(t) || (opts.anchor instanceof HTMLElement && opts.anchor.contains(t))) return;
    opts.onclose("outside");
  };
  const onBlur = () => opts.onclose("blur");
  const onScroll = (e: Event) => {
    if (!node.contains(e.target as Node)) position();
  };
  const offEscape = onEscape(() => opts.onclose("escape"));
  const resize = new ResizeObserver(position);

  position();
  resize.observe(node);
  window.addEventListener("mousedown", onOutside, true);
  window.addEventListener("blur", onBlur);
  window.addEventListener("resize", position);
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });

  return {
    update(next: PopupOptions) {
      opts = next;
      position();
    },
    destroy() {
      offEscape();
      resize.disconnect();
      window.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", onScroll, { capture: true });
      moved.destroy();
    },
  };
}
