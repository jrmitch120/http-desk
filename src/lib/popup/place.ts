// Where a floating surface goes next to its anchor so it stays on screen,
// shared by every popup in the layer: `place` is the geometry (no DOM, unit
// tested), `placeElement` applies it to an element.

export type Side = "top" | "bottom";
export type Align = "start" | "center" | "end";

/** Viewport coordinates; a pointer position is a zero-size rect. */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PlaceOptions {
  /** Horizontal alignment with the anchor. Default "start". */
  align?: Align;
  /** Space between anchor and popup. Default 4. */
  gap?: number;
}

/** Minimum distance from the viewport edges. */
const MARGIN = 6;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

/**
 * Top-left corner for a popup of `size` next to `anchor`, and the side it ended
 * up on: below, or above when it only fits there.
 */
export function place(
  anchor: AnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  { align = "start", gap = 4 }: PlaceOptions = {},
): { x: number; y: number; side: Side } {
  const below = { side: "bottom" as const, y: anchor.bottom + gap, room: viewport.height - MARGIN - anchor.bottom - gap };
  const above = { side: "top" as const, y: anchor.top - gap - size.height, room: anchor.top - gap - MARGIN };
  const pick = below.room >= size.height ? below : above.room >= size.height ? above : below.room >= above.room ? below : above;

  const width = anchor.right - anchor.left;
  const x = align === "start" ? anchor.left : align === "end" ? anchor.right - size.width : anchor.left + (width - size.width) / 2;
  return {
    x: clamp(x, MARGIN, viewport.width - MARGIN - size.width),
    y: clamp(pick.y, MARGIN, viewport.height - MARGIN - size.height),
    side: pick.side,
  };
}

/**
 * Moves `el` (a `position: fixed` surface) next to `anchor` and sets its
 * `data-side`, which picks the direction of the open animation. Uses the layout
 * size, so the animation's transform doesn't skew it.
 */
export function placeElement(el: HTMLElement, anchor: AnchorRect, options?: PlaceOptions) {
  const p = place(anchor, { width: el.offsetWidth, height: el.offsetHeight }, { width: innerWidth, height: innerHeight }, options);
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y}px`;
  el.dataset.side = p.side;
}
