// Extract to variable in an editor (#85): with text selected, ⌘⌥V / Ctrl+Alt+V
// or the context menu asks the provider's `extract` for a name and puts
// `{{name}}` in place of the selection. The owner of the field sees an
// ordinary edit, so the change shows (and saves) like typing would.
import type { Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { menu } from "../menu.svelte";
import type { VarProvider } from "./setup";

/** Editors waiting for an extraction's answer (its form has focus meanwhile). */
const pending = new WeakSet<EditorView>();
/** Editors whose context menu is open (it has focus meanwhile). */
const menuOpen = new WeakSet<EditorView>();

/**
 * Whether the editor's Extract to variable menu or form is open. VarField keeps
 * its editor meanwhile, though focus has moved away, so the answer lands in the
 * same selection.
 */
export function extractHolds(view: EditorView): boolean {
  return pending.has(view) || menuOpen.has(view);
}

/** After a hold ends with focus elsewhere: lets the owner see focus has left. */
function released(view: EditorView) {
  if (!extractHolds(view) && view.dom.isConnected && !view.hasFocus) view.dom.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
}

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
  void provider.extract(sel.text).then(
    (name) => finish(view, sel, name),
    () => finish(view, sel, null),
  );
  return true;
}

function finish(view: EditorView, { from, to, text }: { from: number; to: number; text: string }, name: string | null) {
  pending.delete(view);
  // The field may be gone (its row deleted, the tab closed) while the form was open.
  if (!view.dom.isConnected) return;
  if (name && view.state.sliceDoc(from, to) === text) {
    const insert = `{{${name}}}`;
    view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: "input.extract" });
  }
  view.focus();
  released(view);
}

/** The context menu's position for Shift+F10: under the selection. */
function menuAtSelection(view: EditorView) {
  const at = view.coordsAtPos(view.state.selection.main.from);
  const x = at ? at.left : 0;
  const y = at ? at.bottom : 0;
  view.contentDOM.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }));
}

/**
 * ⌘⌥V / Ctrl+Alt+V (JetBrains' Extract Variable) and, on a selection, a context
 * menu of Cut, Copy and Extract to variable…. Without a selection, or a
 * right-click outside it, the webview's own menu stays.
 */
export function extractExtension(provider: VarProvider): Extension {
  if (!provider.extract) return [];
  return [
    keymap.of([
      { key: "Mod-Alt-v", run: (view) => extract(view, provider) },
      { key: "Shift-F10", run: (view) => (extractable(view) ? (menuAtSelection(view), true) : false) },
    ]),
    EditorView.domEventHandlers({
      contextmenu(e, view) {
        const sel = extractable(view);
        if (!sel) return false;
        const { from, to } = view.state.selection.main;
        const pos = e.clientX || e.clientY ? view.posAtCoords({ x: e.clientX, y: e.clientY }) : from;
        if (pos === null || pos < from || pos > to) return false;
        menu.show(
          e,
          [
            {
              label: "Cut",
              action: () => {
                void navigator.clipboard.writeText(view.state.sliceDoc(from, to));
                view.dispatch({ changes: { from, to }, userEvent: "delete.cut" });
              },
            },
            { label: "Copy", icon: "copy", action: () => void navigator.clipboard.writeText(view.state.sliceDoc(from, to)) },
            { separator: true },
            { label: "Extract to variable…", icon: "code", action: () => extract(view, provider) },
          ],
          {
            label: "Text",
            // Runs before a picked item's action, which may hold the editor again.
            onclose: () => {
              menuOpen.delete(view);
              setTimeout(() => released(view));
            },
          },
        );
        menuOpen.add(view);
        return true;
      },
    }),
  ];
}
