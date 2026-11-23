// Focus marks (ADR-0002): HttpDesk decides itself whether keyboard focus is
// drawn, instead of each webview's :focus-visible. macOS's system webview doesn't
// match :focus-visible when a script moves focus after a mouse click, so arrowing
// through a list after a click moved focus that nothing drew.
//
// A key press turns the marks on and a mouse press turns them off. While they're
// on, the root element carries `data-focus-marks`, and every owned control styles
// its focus from that combined with :focus:
//
//   :root[data-focus-marks] .thing:focus { outline: var(--focus-ring); }
//
// (in a component: `:global(:root[data-focus-marks]) .thing:focus`). Text fields
// don't: their focus style is always on.

const ATTR = "data-focus-marks";

/** Keys that only modify another key; pressing one alone moves or does nothing. */
const MODIFIERS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "Fn", "FnLock", "Hyper", "Super", "CapsLock", "NumLock", "ScrollLock"]);

/** Whether focus marks are on: the last input was a key press, not a mouse press. */
export function focusMarksOn(): boolean {
  return document.documentElement.hasAttribute(ATTR);
}

function set(on: boolean) {
  document.documentElement.toggleAttribute(ATTR, on);
}

/**
 * Starts tracking. Marks start on, as nothing has been clicked yet. Both
 * listeners capture on the window, so they run before any handler moves focus
 * and no handler can stop them.
 */
export function trackFocusMarks(): void {
  set(true);
  window.addEventListener("keydown", (e) => !MODIFIERS.has(e.key) && set(true), true);
  window.addEventListener("pointerdown", () => set(false), true);
}
