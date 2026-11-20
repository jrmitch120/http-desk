// A read-only region: every CodeMirror field and editor in it reads as read-only while it
// holds, without each component between passing a prop down. A request tab is one while
// a view of its file holds text that doesn't parse (`app.texts.lock`, #174). Native
// controls in the region are disabled by a `<fieldset disabled>` around them.
import { getContext, setContext } from "svelte";

const KEY = Symbol("read-only region");

/** Makes the CodeMirror fields and editors below the calling component read-only while `when()` holds. */
export function setReadOnlyRegion(when: () => boolean): void {
  setContext(KEY, when);
}

/** Whether the calling component is in a read-only region now (call it in a reactive context to follow it). */
export function inReadOnlyRegion(): () => boolean {
  return getContext<(() => boolean) | undefined>(KEY) ?? (() => false);
}
