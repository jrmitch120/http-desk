// The Session panel's rows (#194): one list across its sections (Named exchanges,
// Global variables, Cookies), through `use:rovingList`. Each section's table is a
// `role="list"` whose rows spread `sessionRow({ … })`, saying what the row can do:
//
//   <tr {...sessionRow({ open, remove: { label: "Forget", run } })}>…</tr>
//
// Enter opens a named exchange, or copies a Global variable's or cookie's value.
// Delete/Backspace forgets or deletes the row, and focus goes to the row now in its
// place (the next one), else the one before, else the list. Shift+F10 (and a
// right-click) opens the row's menu with those actions.
import { createAttachmentKey } from "svelte/attachments";
import { errorMessage } from "./api";
import { writeClipboard } from "./clipboard";
import { menu, type MenuItem } from "./menu.svelte";
import { rovingList } from "./rovingList";
import { app } from "./store.svelte";

export interface SessionRowActions {
  /** Shows what the row names (a named exchange's response). Enter runs it. */
  open?: () => void;
  /** The row's value, copied by Enter where there's nothing to open, with the toast `copied`. */
  copy?: { value: string; copied: string };
  /** Takes the row out of the Session: "Forget" (a named exchange) or "Delete". */
  remove: { label: string; run: () => Promise<void> };
}

const ROW = '[role="listitem"]';
const actions = new WeakMap<HTMLElement, SessionRowActions>();
const lists = new WeakSet<HTMLElement>();

/** `use:sessionList` on the element holding the sections' lists: their rows move as one. */
export function sessionList(node: HTMLElement) {
  lists.add(node);
  return rovingList(node, { activate });
}

/** A row's attributes, to spread on it: a list item that's no Tab stop of its own, and its keys and menu. */
export function sessionRow(row: SessionRowActions) {
  return {
    role: "listitem",
    tabindex: -1,
    class: "list-row",
    [createAttachmentKey()]: (node: HTMLElement) => {
      actions.set(node, row);
      const onkeydown = (e: KeyboardEvent) => {
        if (e.target !== node || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
        if (e.key !== "Delete" && e.key !== "Backspace") return;
        e.preventDefault();
        void remove(node);
      };
      const oncontextmenu = (e: MouseEvent) => menu.show(e, items(node, row));
      node.addEventListener("keydown", onkeydown);
      node.addEventListener("contextmenu", oncontextmenu);
      return () => {
        if (actions.get(node) === row) actions.delete(node);
        node.removeEventListener("keydown", onkeydown);
        node.removeEventListener("contextmenu", oncontextmenu);
      };
    },
  };
}

function activate(node: HTMLElement) {
  const row = actions.get(node);
  if (row?.open) row.open();
  else if (row?.copy) void copy(row.copy);
}

function items(node: HTMLElement, row: SessionRowActions): MenuItem[] {
  return [
    ...(row.open ? [{ label: "Open", icon: "reveal", action: row.open }] : []),
    ...(row.copy ? [{ label: "Copy value", icon: "copy", action: () => void copy(row.copy!) }] : []),
    { separator: true },
    { label: row.remove.label, icon: "trash", danger: true, action: () => void remove(node) },
  ];
}

async function copy({ value, copied }: { value: string; copied: string }) {
  try {
    await writeClipboard(value);
    app.toast("success", copied);
  } catch (e) {
    app.toast("error", `Couldn't copy the value: ${errorMessage(e)}`);
  }
}

/** Removes the row; once it's gone, focus goes to the row now in its place, else the one before, else the list. */
async function remove(node: HTMLElement) {
  const list = listOf(node);
  const before = list ? rowsOf(list) : [];
  const at = before.indexOf(node);
  await actions.get(node)?.remove.run();
  if (!list || !(await rowsChange(list, before.length))) return;
  const focused = document.activeElement;
  // Focus moved on (elsewhere, not lost with the row): leave it.
  if (focused && focused !== document.body && !list.contains(focused)) return;
  const rows = rowsOf(list);
  (rows[Math.min(at, rows.length - 1)] ?? list).focus();
}

function listOf(node: HTMLElement): HTMLElement | null {
  for (let el = node.parentElement; el; el = el.parentElement) if (lists.has(el)) return el;
  return null;
}

const rowsOf = (list: HTMLElement) => [...list.querySelectorAll<HTMLElement>(ROW)];

/** Resolves true once the list holds a different number of rows than `count` (the Session is read again after a change), false if it doesn't soon. */
function rowsChange(list: HTMLElement, count: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (changed: boolean) => {
      observer.disconnect();
      clearTimeout(timer);
      resolve(changed);
    };
    const observer = new MutationObserver(() => rowsOf(list).length !== count && done(true));
    const timer = setTimeout(() => done(false), 5000);
    observer.observe(list, { childList: true, subtree: true });
    if (rowsOf(list).length !== count) done(true);
  });
}
