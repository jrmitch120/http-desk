// The one place that decides "is a modal or dialog open?". Every modal and
// dialog renders through Modal.svelte, which marks its box `aria-modal="true"`,
// so this reads the DOM rather than store state: it stays right however the
// store tracks open modals and queued dialogs.

/** True while any modal or dialog is on screen. */
export function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}
