// The app's own context menu for text (#39, ADR-0002): the webview's menu never
// shows. A right-click, Shift+F10 or the Menu key on any text field (an
// `<input>`, a `<textarea>`, an editor: VarField, the URL bar, the body editor,
// the response viewer, the `.http` source) opens the app's Menu with Cut, Copy,
// Paste and Select all, disabled where they can't apply; read-only text gets Copy
// and Select all. Handlers nearer the target add the field's own items after
// them (`addMenuItems`: Extract to variable…, Unset in …, Copy path). Anything
// else gets no menu at all, unless such a handler added items.
//
// `openContextMenu` is the window's `contextmenu` listener (App.svelte), so it
// runs last; a handler that shows a menu of its own (`menu.show`, e.g. a tree
// row's) stops the event before it gets there.
//
// Linux's native Edit menu runs the same actions on the focused field
// (`focusedEditActions`, ADR-0005), plus Undo and Redo.
import { redo, undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { createSubscriber } from "svelte/reactivity";
import { menu, type MenuItem } from "./menu.svelte";
import { readClipboard, writeClipboard } from "./clipboard";
import { hold, unhold } from "./codemirror/holds";

const added = new WeakMap<Event, MenuItem[][]>();

/** Adds a group of items to the menu `e` opens, after the edit items (and the groups added before, nearer the target). */
export function addMenuItems(e: Event, items: MenuItem[]) {
  added.set(e, [...(added.get(e) ?? []), items]);
}

const fromKeys = new WeakSet<Event>();

/** Whether a `contextmenu` event came from the keyboard (Shift+F10, the Menu key): it's at the caret, not a pointer. */
export function fromKeyboard(e: Event): boolean {
  return fromKeys.has(e);
}

/** Input types that hold text. */
const TEXT_INPUTS = new Set(["text", "search", "url", "email", "tel", "password"]);

function textField(el: EventTarget | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (el instanceof HTMLTextAreaElement) return el;
  if (el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type)) return el;
  return null;
}

function editorAt(el: EventTarget | null): EditorView | null {
  const dom = el instanceof Element ? el.closest<HTMLElement>(".cm-editor") : null;
  return dom ? EditorView.findFromDOM(dom) : null;
}

/**
 * Opens the context menu for the focused element, as a right-click there would
 * (Shift+F10, the Menu key): at the caret in a text field, under the element
 * otherwise. False when nothing has focus.
 */
export function openFromKeyboard(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || el === document.body) return false;
  let target: HTMLElement = el;
  let at = { x: 0, y: 0 };
  const view = editorAt(el);
  if (view) {
    const sel = view.state.selection.main;
    const c = view.coordsAtPos(sel.from) ?? view.coordsAtPos(sel.head);
    if (c) at = { x: c.left, y: c.bottom };
    target = view.contentDOM;
  } else if (textField(el)) {
    const r = el.getBoundingClientRect();
    at = { x: r.left + 8, y: r.bottom };
  }
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: at.x, clientY: at.y });
  fromKeys.add(e);
  target.dispatchEvent(e);
  return true;
}

/** The window's `contextmenu` listener: the edit menu for text, the items handlers added, or nothing. Never the webview's. */
export function openContextMenu(e: MouseEvent) {
  if (e.defaultPrevented) return;
  e.preventDefault();
  const view = editorAt(e.target);
  const field = view ? null : textField(e.target);
  const groups = [...(view ? [editorItems(view, e)] : field ? [inputItems(field)] : []), ...(added.get(e) ?? [])].filter((g) => g.length);
  if (!groups.length) return;
  const items = groups.flatMap((g, i) => (i ? [{ separator: true }, ...g] : g));
  // A VarField keeps its editor while the menu has focus, so Paste lands in it.
  if (view) hold(view);
  menu.show(e, items, { label: "Edit", onclose: view ? () => unhold(view) : undefined });
}

/** What the edit items need from a text field, whatever kind it is. */
interface TextField {
  /** The selected text. */
  selected(): string;
  /** A masked field (a password, a Secret) keeps its text off the clipboard. */
  masked: boolean;
  readOnly: boolean;
  selectAll(): void;
  /** Replaces the selection with `text` (empty for Cut), as typing would. */
  replace(text: string): void;
  /** Whether the field is still in the document (a Paste waits on the clipboard). */
  connected(): boolean;
  /** Undoes or redoes the field's last edit, as its keys would. */
  history(dir: "undo" | "redo"): void;
}

/** An edit action on a text field: what its menu item does, and whether it's greyed out. */
export interface EditAction {
  disabled: boolean;
  run(): void;
}

/** The edit actions a text field offers. Read-only text has no Undo, Redo, Cut or Paste. */
export type EditActions = Partial<Record<"undo" | "redo" | "cut" | "copy" | "paste" | "select-all", EditAction>>;

/** The edit actions on `field`: the context menu's (Cut, Copy, Paste, Select all), and Undo and Redo. */
function textActions(field: TextField): EditActions {
  const cannotCopy = !field.selected() || field.masked;
  const copy: EditAction = { disabled: cannotCopy, run: () => void writeClipboard(field.selected()) };
  const selectAll: EditAction = { disabled: false, run: () => field.selectAll() };
  if (field.readOnly) return { copy, "select-all": selectAll };
  return {
    undo: { disabled: false, run: () => field.history("undo") },
    redo: { disabled: false, run: () => field.history("redo") },
    cut: {
      disabled: cannotCopy,
      run: () => {
        void writeClipboard(field.selected());
        field.replace("");
      },
    },
    copy,
    paste: {
      disabled: false,
      run: async () => {
        const text = await readClipboard();
        if (text && field.connected()) field.replace(text);
      },
    },
    "select-all": selectAll,
  };
}

/** Cut, Copy, Paste and Select all (Copy and Select all when it's read-only). */
function textItems(field: TextField): MenuItem[] {
  const actions = textActions(field);
  const items: [keyof EditActions, string, string][] = [
    ["cut", "Cut", "cut"],
    ["copy", "Copy", "copy"],
    ["paste", "Paste", "paste"],
    ["select-all", "Select all", "select-all"],
  ];
  return items.flatMap(([key, label, icon]) => {
    const a = actions[key];
    return a ? [{ label, icon, disabled: a.disabled, action: a.run }] : [];
  });
}

/**
 * Reruns a reader when focus, the selection or a field's text may have
 * changed. Once the browser's events have run their course, so an editor has
 * taken in its new selection first.
 */
const focusChanges = createSubscriber((update) => {
  const events = ["focusin", "focusout", "selectionchange", "select", "input", "keyup", "mouseup"];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(update);
  };
  for (const type of events) document.addEventListener(type, later, true);
  return () => {
    clearTimeout(timer);
    for (const type of events) document.removeEventListener(type, later, true);
  };
});

/**
 * The edit actions for the text field that has focus (or had it when the
 * window went to the background, as when the native menu opens): the same as
 * its context menu's. Empty when focus isn't in a text field. Reactive: follows
 * focus and the selection. Linux's Edit menu runs these (ADR-0005).
 */
export function focusedEditActions(): EditActions {
  focusChanges();
  const el = document.activeElement;
  const view = editorAt(el);
  if (view) return textActions(editorField(view));
  const field = textField(el);
  return field ? textActions(inputField(field)) : {};
}

/** The edit items for an editor. */
function editorItems(view: EditorView, e: MouseEvent): MenuItem[] {
  // A right-click outside the selection puts the caret there first, as in a text input.
  const sel = view.state.selection.main;
  if (!fromKeyboard(e) && (e.clientX || e.clientY)) {
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos !== null && (sel.empty || pos < sel.from || pos > sel.to)) view.dispatch({ selection: { anchor: pos } });
  }
  return textItems(editorField(view));
}

function editorField(view: EditorView): TextField {
  return {
    selected: () => {
      const { from, to } = view.state.selection.main;
      return view.state.sliceDoc(from, to);
    },
    masked: view.dom.classList.contains("cm-masked"),
    readOnly: view.state.readOnly,
    selectAll: () => {
      view.focus();
      view.dispatch({ selection: { anchor: 0, head: view.state.doc.length }, userEvent: "select" });
    },
    replace: (text) => {
      view.focus();
      view.dispatch(view.state.replaceSelection(text), { userEvent: text ? "input.paste" : "delete.cut", scrollIntoView: true });
    },
    connected: () => view.dom.isConnected,
    history: (dir) => {
      view.focus();
      (dir === "undo" ? undo : redo)(view);
    },
  };
}

/** The edit items for an `<input>` or `<textarea>`. */
function inputItems(el: HTMLInputElement | HTMLTextAreaElement): MenuItem[] {
  return textItems(inputField(el));
}

function inputField(el: HTMLInputElement | HTMLTextAreaElement): TextField {
  return {
    selected: () => el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
    masked: el.type === "password",
    readOnly: el.readOnly || el.disabled,
    selectAll: () => {
      el.focus();
      el.select();
    },
    replace: (text) => {
      el.focus();
      insert(el, text);
    },
    connected: () => el.isConnected,
    // The webview's own undo stack, which typing and `insert` add to.
    history: (dir) => {
      el.focus();
      document.execCommand(dir);
    },
  };
}

/** Replaces the field's selection with `text` as typing would: undoable, and an `input` event for its owner. */
function insert(el: HTMLInputElement | HTMLTextAreaElement, text: string) {
  if (document.execCommand(text ? "insertText" : "delete", false, text)) return;
  el.setRangeText(text, el.selectionStart ?? 0, el.selectionEnd ?? 0, "end");
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: text ? "insertFromPaste" : "deleteByCut", data: text || null }));
}
