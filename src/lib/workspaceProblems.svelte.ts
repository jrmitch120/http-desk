// The workspace's problems, for the Problems panel: every `.http` file with problems
// or lines that behave differently in VS Code or Rider, by line in the file. The shell
// reads them off the main thread: the whole workspace when it opens (and when a folder
// changes), one file again when the watcher reports it, and an open document, as the
// app has it (unsaved edits and a file view's text included), shortly after each edit.
import { untrack } from "svelte";
import { api } from "./api";
import type { FileProblems, OpenText } from "./types";

/** How long edits to an open document pause before its problems are read again. */
export const PROBLEMS_READ_DELAY_MS = 300;

/** What the Problems panel needs from the rest of the store. */
export interface ProblemsHost {
  readonly root: string | null;
  /** The paths of the open documents. */
  readonly openPaths: string[];
  /** The open document at `path` as the app has it: its file view's text, or else its file (live state: reading it tracks it). */
  openText(path: string): OpenText | null;
}

export class WorkspaceProblems {
  constructor(private readonly host: ProblemsHost) {}

  /** Each file with something to list, by path. */
  files = $state<Record<string, FileProblems>>({});

  /** Per open document, what it was (as JSON) when last asked about. */
  private seen = new Map<string, string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Goes up per question about a file, so an older answer arriving late is dropped. */
  private asked = new Map<string, number>();
  private asks = 0;
  /** Goes up as each workspace opens, so answers about the last one are dropped. */
  private opens = 0;

  /** Forgets the last workspace's problems, for one about to open. */
  reset() {
    this.opens++;
    this.files = {};
    this.seen.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /** Reads the whole workspace, open documents as the app has them. */
  async scan(): Promise<void> {
    if (!this.host.root) return;
    const open = this.opens;
    const since = this.asks;
    const docs = untrack(() => this.host.openPaths.flatMap((p) => this.host.openText(p) ?? []).map((d) => $state.snapshot(d)));
    let all: FileProblems[];
    try {
      all = await api.workspaceProblems(docs);
    } catch {
      return; // The panel keeps what it had.
    }
    if (this.opens !== open) return;
    const files: Record<string, FileProblems> = {};
    for (const f of all) files[f.path] = f;
    // A file asked about since the scan started has a newer answer than the scan's.
    for (const [path, ask] of this.asked) {
      if (ask <= since) continue;
      if (this.files[path]) files[path] = this.files[path];
      else delete files[path];
    }
    this.files = files;
  }

  /** The watcher reported `paths`: each `.http` file is read again, and the whole workspace when a folder changed. */
  changed(paths: string[]) {
    if (paths.some((p) => !/\.(http|rest)$/i.test(p) && !/http-client(\.private)?\.env\.json$/.test(p))) {
      void this.scan();
      return;
    }
    for (const p of paths) if (/\.(http|rest)$/i.test(p)) void this.refresh(p);
  }

  /**
   * Reads each open document again once its edits pause, and a document no longer open
   * from disk. Call it from an effect, which reruns on each change to the documents.
   */
  track() {
    const now = new Map<string, string>();
    for (const path of this.host.openPaths) {
      const doc = this.host.openText(path);
      // Typed text as it is: compared, not copied into JSON on each keystroke (#168).
      if (doc) now.set(path, "text" in doc ? doc.text : JSON.stringify(doc));
    }
    untrack(() => {
      for (const [path, was] of now) if (this.seen.get(path) !== was) this.later(path);
      for (const path of this.seen.keys()) if (!now.has(path)) this.later(path);
      this.seen = now;
    });
  }

  private later(path: string) {
    clearTimeout(this.timers.get(path));
    this.timers.set(
      path,
      setTimeout(() => {
        this.timers.delete(path);
        void this.refresh(path);
      }, PROBLEMS_READ_DELAY_MS),
    );
  }

  /** Reads the file at `path` again: the open document as the app has it, or else from disk. */
  async refresh(path: string): Promise<void> {
    if (!this.host.root) return;
    const open = this.opens;
    const ask = ++this.asks;
    this.asked.set(path, ask);
    const doc = untrack(() => $state.snapshot(this.host.openText(path)));
    let found: FileProblems | null;
    try {
      found = await api.fileProblems(path, !doc ? {} : "text" in doc ? { text: doc.text } : { file: doc.file });
    } catch {
      return;
    }
    if (this.opens !== open || this.asked.get(path) !== ask) return;
    if (found && (found.problems.length || found.portability.length)) this.files[path] = found;
    else delete this.files[path];
  }
}
