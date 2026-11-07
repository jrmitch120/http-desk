// Extract to variable in an editor (#85): with text selected, ⌘⌥V / Ctrl+Alt+V
// or the edit menu's "Extract to variable…" asks the provider's `extract` for a
// name and puts `{{name}}` in place of the selection. The owner of the field sees
// an ordinary edit, so the change shows (and saves) like typing would.
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { addMenuItems, fromKeyboard } from "../editMenu";
import { hold, unhold } from "./holds";
import type { VarProvider } from "./setup";

/** Editors waiting for an extraction's answer (its form has focus meanwhile; the editor is held). */
const pending = new WeakSet<EditorView>();

/** The selection to extract: on one line, without the whitespace around it. Null if there's none. */
function extractable(view: EditorView): { from: number; to: number; text: string } | null {
  if (view.state.readOnly || pending.has(view)) return null;
  let { from, to } = view.state.selection.main;
  const raw = view.state.sliceDoc(from, to);
  if (raw.includes("\n")) return null;
  from += raw.length - raw.trimStart().length;
  to -= raw.length - raw.trimEnd().length;
  return from < to ? { from, to, text: view.state.sliceDoc(from, to) } : null;
}

function extract(view: EditorView, provider: VarProvider): boolean {
  const sel = extractable(view);
  if (!sel || !provider.extract) return false;
  pending.add(view);
  hold(view);
  void provider.extract(sel.text).then(
    (name) => finish(view, sel, name),
    () => finish(view, sel, null),
  );
  return true;
}

function finish(view: EditorView, { from, to, text }: { from: number; to: number; text: string }, name: string | null) {
  pending.delete(view);
  unhold(view);
  // The field may be gone (its row deleted, the tab closed) while the form was open.
  if (!view.dom.isConnected) return;
  if (name && view.state.sliceDoc(from, to) === text) {
    const insert = `{{${name}}}`;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.extract" });
  }
  view.focus();
}

/**
 * ⌘⌥V / Ctrl+Alt+V (JetBrains' Extract Variable) and, on a selection, "Extract to
 * variable…" in the edit menu (src/lib/editMenu.ts), after Cut, Copy, Paste and
 * Select all. Not on a right-click outside the selection.
 */
export function extractExtension(provider: VarProvider): Extension {
  if (!provider.extract) return [];
  return [
    keymap.of([{ key: "Mod-Alt-v", run: (view) => extract(view, provider) }]),
    EditorView.domEventHandlers({
      contextmenu(e, view) {
        if (!extractable(view)) return false;
        const { from, to } = view.state.selection.main;
        const pos = fromKeyboard(e) || !(e.clientX || e.clientY) ? from : view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos !== null && pos >= from && pos <= to) addMenuItems(e, [{ label: "Extract to variable…", icon: "code", action: () => extract(view, provider) }]);
        // The window's listener opens the menu.
        return false;
      },
    }),
  ];
}
