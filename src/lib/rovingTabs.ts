// A vertical tablist's keyboard (the Settings rail, #240): one Tab stop, the arrow
// keys to move, and selection following focus.
//
//   <div role="tablist" aria-label="Settings categories" aria-orientation="vertical" use:rovingTabs>
//     <button role="tab" class="list-row" class:current={sel} aria-selected={sel} tabindex={sel ? 0 : -1} onclick={…}>…</button>
//   </div>
//
// Tabs are the `role="tab"` elements inside the element it's on, in document order.
// The markup keeps the Tab stop: the selected tab at `tabindex="0"`, the rest at -1.
// Keys, on a focused tab, without ⌘/Ctrl/Alt (app shortcuts, ADR-0005): Up/Down move
// to the previous or next tab, stopping at the ends, and Home/End to the first and
// last. The tab moved to is clicked (its click selects it) and focused, so the page
// changes as the user arrows through. Every key it handles is `preventDefault`ed.

/** A tab of the tablist. */
const TAB = '[role="tab"]';

export function rovingTabs(tablist: HTMLElement) {
  function onkeydown(e: KeyboardEvent) {
    const tab = e.target;
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!(tab instanceof HTMLElement) || !tab.matches(TAB)) return;
    const all = [...tablist.querySelectorAll<HTMLElement>(TAB)];
    const i = all.indexOf(tab);
    let to: HTMLElement;
    if (e.key === "ArrowDown") to = all[Math.min(i + 1, all.length - 1)];
    else if (e.key === "ArrowUp") to = all[Math.max(i - 1, 0)];
    else if (e.key === "Home") to = all[0];
    else if (e.key === "End") to = all[all.length - 1];
    else return;
    e.preventDefault();
    to.click();
    to.focus();
  }

  tablist.addEventListener("keydown", onkeydown);
  return {
    destroy() {
      tablist.removeEventListener("keydown", onkeydown);
    },
  };
}
