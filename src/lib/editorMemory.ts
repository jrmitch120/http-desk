// What a text editor was like when its view was last on screen: a tab's view is
// taken down when another tab shows (App.svelte keys the view by tab), and an editor
// given a `memory` key comes back as it was left: its cursor and selection, its
// folds, how far it was scrolled, and (while its text is still the same) its undo
// history. Kept per tab, in memory, and forgotten when the tab closes.

/** An editor as it was left: opaque to all but Editor.svelte, which makes and reads it. */
export interface EditorMemory {
  /** The text it held. */
  text: string;
  /** Its state as JSON (CodeMirror's `EditorState.toJSON`, with its history and folds). */
  state: unknown;
  /** Its scroll position (CodeMirror's `scrollSnapshot` effect). */
  scroll: unknown;
}

const memories = new Map<string, EditorMemory>();

/** The memory key of tab `tabId`'s editor `which` (its file view's text, its request's source). */
export const editorMemoryKey = (tabId: string, which: "file" | "source") => `${tabId}\n${which}`;

export const rememberEditor = (key: string, memory: EditorMemory) => void memories.set(key, memory);
export const recallEditor = (key: string): EditorMemory | undefined => memories.get(key);

/** Forgets the editors of tab `tabId` (it closed). */
export function forgetEditors(tabId: string) {
  for (const key of [...memories.keys()]) if (key.startsWith(`${tabId}\n`)) memories.delete(key);
}
