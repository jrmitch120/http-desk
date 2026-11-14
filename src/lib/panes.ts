// Sizes of the split panes (sidebar, request/response, panel area), stored in
// AppSettings. The defaults must match `AppSettings::default()` in src-tauri/src/lib.rs
// (panes.test.ts checks).
import type { AppSettings } from "./types";

export interface PaneLimits {
  min: number;
  max: number;
  /** Restored by double-clicking the separator. */
  initial: number;
  /** One arrow-key press. */
  step: number;
}

/** Sidebar width, px. */
export const SIDEBAR: PaneLimits = { min: 200, max: 560, initial: 280, step: 16 };
/** Request pane's share of the request/response split. */
export const SPLIT: PaneLimits = { min: 0.2, max: 0.8, initial: 0.5, step: 0.05 };
/** Height of the panel area below the requests (the Session panel), px. */
export const PANEL: PaneLimits = { min: 120, max: 640, initial: 260, step: 16 };

/** `v` kept within `limits`; anything that isn't a finite number gives the default. */
export function clampPane(v: unknown, limits: PaneLimits): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return limits.initial;
  return Math.min(limits.max, Math.max(limits.min, v));
}

// Versions up to 0.1.3 kept the sizes in localStorage; one ratio served both layouts.
const LEGACY_SIDEBAR = "sidebarWidth";
const LEGACY_SPLIT = "splitRatio";

/**
 * Reads the pane sizes older versions left in localStorage. Returns null when
 * there are none, otherwise the settings patch they amount to (empty if the
 * values were unusable) and a `remove` that deletes the old keys.
 */
export function legacyPaneSizes(): { patch: Partial<AppSettings>; remove: () => void } | null {
  let store: Storage;
  try {
    store = globalThis.localStorage;
    if (!store) return null;
    const width = store.getItem(LEGACY_SIDEBAR);
    const ratio = store.getItem(LEGACY_SPLIT);
    if (width === null && ratio === null) return null;
    const patch: Partial<AppSettings> = {};
    const w = Number(width);
    if (width !== null && Number.isFinite(w) && w > 0) patch.sidebarWidth = clampPane(w, SIDEBAR);
    const r = Number(ratio);
    if (ratio !== null && Number.isFinite(r) && r > 0) {
      const split = clampPane(r, SPLIT);
      patch.splitRatio = { horizontal: split, vertical: split };
    }
    const remove = () => {
      try {
        store.removeItem(LEGACY_SIDEBAR);
        store.removeItem(LEGACY_SPLIT);
      } catch {
        // Storage unavailable: nothing more to clean up.
      }
    };
    return { patch, remove };
  } catch {
    return null; // localStorage blocked (e.g. a SecurityError)
  }
}
