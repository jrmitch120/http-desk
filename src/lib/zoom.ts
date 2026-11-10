// The zoom of the whole interface (View → Zoom In / Zoom Out / Actual Size, #94):
// the levels those commands step through, and how a saved `zoom` setting is read.
// The shell reads the same setting before the first paint (theme.rs), accepting
// the same range (MIN_ZOOM / MAX_ZOOM in src-tauri/src/lib.rs, checked by zoom.test.ts).

/**
 * The zoom levels, `1` being 100%. They stop at 150%: at the minimum window size
 * (960×600) 175% already pushes the TopBar's buttons off the window.
 */
export const ZOOM_LEVELS: readonly number[] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5];
export const MIN_ZOOM = ZOOM_LEVELS[0];
export const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
/** 100%: what Actual Size returns to, and the zoom of a new install. */
export const ACTUAL_SIZE = 1;

/** How far from a level a zoom can be and still count as that level (float noise). */
const EPSILON = 1e-6;

/** The zoom a saved setting stands for: as written within the levels' range, else 100%. */
export function zoomOf(saved: unknown): number {
  return typeof saved === "number" && saved >= MIN_ZOOM && saved <= MAX_ZOOM ? saved : ACTUAL_SIZE;
}

/** The next level above `zoom`, or null at the top. */
export function zoomIn(zoom: number): number | null {
  return ZOOM_LEVELS.find((level) => level > zoom + EPSILON) ?? null;
}

/** The next level below `zoom`, or null at the bottom. */
export function zoomOut(zoom: number): number | null {
  return [...ZOOM_LEVELS].reverse().find((level) => level < zoom - EPSILON) ?? null;
}
