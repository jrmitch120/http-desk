// Focus marks (ADR-0002): HttpDesk decides itself whether keyboard focus is
// drawn, instead of each webview's :focus-visible. macOS's system webview doesn't
// match :focus-visible when a script moves focus after a mouse click, so arrowing
// through a list after a click moved focus that nothing drew.
//
// A key that moves or acts turns the marks on (an arrow, Tab, Enter, Space, Home/End,
// Escape and the like, Shift allowed), and a mouse press turns them off. A modifier
// alone, a typed letter or a ⌘/Ctrl/Alt shortcut leaves them as they are, so a
// shortcut pressed on a row just clicked (⌘C, ⌘S) draws no ring there. A shortcut
// that moves focus somewhere (Focus Explorer, ⌘J) turns them on itself
// (`showFocusMarks`), so where it lands is drawn. While they're
// on, the root element carries `data-focus-marks`, and every owned control styles
// its focus from that combined with :focus:
//
//   :root[data-focus-marks] .thing:focus { outline: var(--focus-ring); }
//
// (in a component: `:global(:root[data-focus-marks]) .thing:focus`). Text fields
// don't: their focus style is always on.

const ATTR = "data-focus-marks";

/** Keys that move focus or act on what has it. */
const NAVIGATION = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Tab",
  "Enter",
  " ",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Escape",
  "Delete",
  "Backspace",
  "F10",
  "ContextMenu",
]);

/** Whether `e` moves focus or acts on it from the keyboard: a navigation key, with Shift at most. */
const navigates = (e: KeyboardEvent) => NAVIGATION.has(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey;

/** Whether focus marks are on: the last input was a key press, not a mouse press. */
export function focusMarksOn(): boolean {
  return document.documentElement.hasAttribute(ATTR);
}

function set(on: boolean) {
  document.documentElement.toggleAttribute(ATTR, on);
}

/** Turns the marks on, for a keyboard command that moves focus (Focus Explorer, ⌘J): its key alone doesn't. */
export function showFocusMarks(): void {
  set(true);
}

/**
 * Starts tracking. Marks start on, as nothing has been clicked yet. Both
 * listeners capture on the window, so they run before any handler moves focus
 * and no handler can stop them.
 */
export function trackFocusMarks(): void {
  set(true);
  window.addEventListener("keydown", (e) => navigates(e) && set(true), true);
  window.addEventListener("pointerdown", () => set(false), true);
}
