// Every list's keyboard (#188): one Tab stop, the arrow keys to move, Enter to act.
//
//   <div role="list" aria-label="Requests" use:rovingList={{ activate: (row) => open(row) }}>
//     <div role="listitem" tabindex="-1" class="list-row" onclick={…}>…</div>
//   </div>
//
// Rows are the `role="listitem"` elements inside the element it's on, in document
// order. That element is the list, or holds several (one per section, with headings
// between) that move as one. Rows are written with `tabindex="-1"`; this keeps exactly
// one at 0 (the Tab stop): the last one focused, else the list's current row (the one
// marked `aria-current`), else the first. When the current row changes while focus is
// outside the list, the Tab stop goes to it. When the Tab stop's row goes, the row now
// in its place takes it.
//
// Keys, on a focused row, without ⌘/Ctrl/Alt (those are app shortcuts, ADR-0005):
// Up/Down and Home/End move, stopping at the ends; Enter activates the row, and so
// does Space unless the list gives `space`. Rows marked `aria-disabled="true"` are
// skipped. Every key it handles is `preventDefault`ed. Any other key (Delete,
// Shift+F10, the ContextMenu key) is the list's own: handle it on the rows or the
// list, or leave it to the window's context-menu path.
//
// Focus draws its ring from the focus marks (`.list-row` does, see focusMarks.ts).

export interface RovingListOptions {
  /** A row's action: Enter, and Space unless `space` is given. What a click does. */
  activate(row: HTMLElement): void;
  /** Space on a row, in place of `activate` (History ticks the row's Compare box). */
  space?(row: HTMLElement): void;
}

const ROW = '[role="listitem"]';

export function rovingList(list: HTMLElement, options: RovingListOptions) {
  let opts = options;
  /** The row in the Tab order, and the index it was at (where its replacement comes from). */
  let stop: HTMLElement | null = null;
  let stopIndex = 0;
  /** The current row as last seen, to notice it changing. */
  let current: HTMLElement | null = null;

  /** The rows focus can land on. */
  const rows = () => [...list.querySelectorAll<HTMLElement>(ROW)].filter((r) => r.getAttribute("aria-disabled") !== "true");
  const isRow = (t: EventTarget | null): t is HTMLElement => t instanceof HTMLElement && t.matches(ROW) && list.contains(t);
  const currentRow = (all: HTMLElement[]) => all.find((r) => (r.getAttribute("aria-current") ?? "false") !== "false") ?? null;

  function setStop(row: HTMLElement | null, all = rows()) {
    stop = row;
    if (row) stopIndex = all.indexOf(row);
    for (const r of list.querySelectorAll<HTMLElement>(ROW)) r.tabIndex = r === row ? 0 : -1;
  }

  /** Puts the Tab stop on a real row after rows, or the current one, change. */
  function settle() {
    const all = rows();
    const now = currentRow(all);
    const currentMoved = now !== current;
    current = now;
    if (currentMoved && now && !list.contains(document.activeElement)) return setStop(now, all);
    if (stop && all.includes(stop)) return setStop(stop, all);
    // Nothing focused yet, or its row went: the current row, else the row now in its place.
    setStop(stop ? (all[Math.min(stopIndex, all.length - 1)] ?? null) : (now ?? all[0] ?? null), all);
  }

  function onkeydown(e: KeyboardEvent) {
    const row = e.target;
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || !isRow(row)) return;
    const all = rows();
    const i = all.indexOf(row);
    let to: HTMLElement | undefined;
    if (e.key === "ArrowDown") to = all[Math.min(i + 1, all.length - 1)];
    else if (e.key === "ArrowUp") to = all[Math.max(i - 1, 0)];
    else if (e.key === "Home") to = all[0];
    else if (e.key === "End") to = all[all.length - 1];
    else if (e.key === "Enter") opts.activate(row);
    else if (e.key === " ") (opts.space ?? opts.activate)(row);
    else return;
    e.preventDefault();
    if (to && to !== row) to.focus();
  }

  function onfocusin(e: FocusEvent) {
    if (!isRow(e.target)) return;
    setStop(e.target);
    e.target.scrollIntoView({ block: "nearest" });
  }

  if (!list.hasAttribute("tabindex")) list.tabIndex = -1;
  list.addEventListener("keydown", onkeydown);
  list.addEventListener("focusin", onfocusin);
  const observer = new MutationObserver(settle);
  observer.observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-current", "aria-disabled"] });
  settle();

  return {
    update(next: RovingListOptions) {
      opts = next;
    },
    destroy() {
      observer.disconnect();
      list.removeEventListener("keydown", onkeydown);
      list.removeEventListener("focusin", onfocusin);
    },
  };
}
