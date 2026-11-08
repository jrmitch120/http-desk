// The one place that decides "is a modal or dialog open?". Every modal and
// dialog renders through Modal.svelte, which counts itself in here while it is
// on screen, so the answer stays right however the store tracks open modals
// and queued dialogs. It's reactive: the native menu greys out app commands
// while it's true.
import { untrack } from "svelte";

let open = $state(0);

/** True while any modal or dialog is on screen. */
export function modalOpen(): boolean {
  return open > 0;
}

/**
 * Counts a modal as on screen until the returned function is called
 * (Modal.svelte, from an effect: the count isn't one of its dependencies).
 */
export function trackModal(): () => void {
  untrack(() => open++);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    untrack(() => open--);
  };
}
