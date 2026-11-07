// Holding an editor while something it started has focus: its edit menu, or the
// Extract to variable form. A VarField keeps its editor meanwhile (though focus
// has moved away), so a Paste or the extracted `{{name}}` lands in the same
// selection. Released, it lets the field see that focus has left.
import type { EditorView } from "@codemirror/view";

const holds = new WeakMap<EditorView, number>();

export function hold(view: EditorView) {
  holds.set(view, (holds.get(view) ?? 0) + 1);
}

/** Ends one hold. Once none is left, and focus is elsewhere, the editor's owner gets a `focusout`. */
export function unhold(view: EditorView) {
  const n = (holds.get(view) ?? 1) - 1;
  if (n > 0) holds.set(view, n);
  else holds.delete(view);
  // After whatever the hold was for has moved focus (a picked item's action, the form closing).
  setTimeout(() => {
    if (!isHeld(view) && view.dom.isConnected && !view.hasFocus) view.dom.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

export function isHeld(view: EditorView): boolean {
  return holds.has(view);
}
