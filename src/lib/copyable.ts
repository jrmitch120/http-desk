// The click behaviour of a `.copyable` value (src/app.css): clicking copies
// the value and says so in a toast, unless the click ended a drag that
// selected part of the text (the user copies that part themselves).

import { app } from "./store.svelte";

export interface CopyableParams {
  /** What to copy. */
  value: string;
  /** The toast after copying, e.g. "Header value copied". */
  copied: string;
}

/** `use:copyable={{ value, copied }}` on a `<button class="copyable">`. */
export function copyable(node: HTMLElement, initial: CopyableParams) {
  let params = initial;
  async function onclick() {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && node.contains(sel.anchorNode)) return;
    await navigator.clipboard.writeText(params.value);
    app.toast("success", params.copied);
  }
  node.addEventListener("click", onclick);
  return {
    update(next: CopyableParams) {
      params = next;
    },
    destroy() {
      node.removeEventListener("click", onclick);
    },
  };
}
