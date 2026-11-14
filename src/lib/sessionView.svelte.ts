// What a view shows of the workspace's Session (a Session panel section): read
// from the shell, and read again whenever the store says the Session changed
// (`app.sessionVersion`: after a send, a delete or clear, or another workspace).
import { app } from "./store.svelte";

/**
 * `read()`'s latest answer, kept current: `null` until the shell first answers,
 * and `empty` if it fails. Call while a component initializes: it reads from an effect.
 */
export function sessionView<T>(read: () => Promise<T>, empty: T): { readonly current: T | null } {
  let current = $state<T | null>(null);
  $effect(() => {
    void app.sessionVersion;
    let live = true;
    read().then(
      (v) => live && (current = v),
      () => live && (current = empty),
    );
    return () => (live = false);
  });
  return {
    get current() {
      return current;
    },
  };
}
