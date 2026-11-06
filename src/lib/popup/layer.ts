// The shared popup layer (#43): one element at the end of <body> that every
// floating surface renders into: the context menu, tooltips, Select lists,
// suggestion lists and CodeMirror's tooltips. It's a zero-size fixed stacking
// context above modals and toasts, so a popup is never clipped by a panel's
// overflow or hidden under a modal. Popups inside it use `position: fixed`.

let root: HTMLElement | null = null;

/** The layer element, created on first use. */
export function popupLayer(): HTMLElement {
  if (!root?.isConnected) {
    root = document.createElement("div");
    root.className = "popup-layer";
    document.body.append(root);
  }
  return root;
}

/**
 * Moves `node` into the popup layer for as long as it's mounted.
 *
 * The node must be the only top-level node of its `{#if}` block (or component):
 * Svelte removes a block by walking from its first node to its last, and a
 * moved node's siblings are other popups.
 */
export function portal(node: HTMLElement) {
  popupLayer().append(node);
  return {
    destroy() {
      node.remove();
    },
  };
}

// ---------------------------------------------------------------- Escape

const escapeStack: (() => void)[] = [];
let listening = false;

function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape" || !escapeStack.length) return;
  // Only the topmost popup closes, and nothing underneath (a modal's window-wide
  // Escape, the global shortcuts) sees the key.
  e.preventDefault();
  e.stopPropagation();
  escapeStack[escapeStack.length - 1]();
}

/**
 * Registers `close` to run on Escape while it's the most recently registered
 * popup. Returns the unregister function. Escape is handled in the window's
 * capture phase, before any other handler, and goes no further.
 */
export function onEscape(close: () => void): () => void {
  if (!listening) {
    window.addEventListener("keydown", onKeydown, { capture: true });
    listening = true;
  }
  escapeStack.push(close);
  return () => {
    const i = escapeStack.lastIndexOf(close);
    if (i >= 0) escapeStack.splice(i, 1);
  };
}
