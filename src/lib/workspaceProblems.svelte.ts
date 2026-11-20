// The workspace's problems, for the Problems panel: every `.http` file with problems
// or lines that behave differently in VS Code or Rider, by line in the file. The shell
// reads them off the main thread: the whole workspace when it opens (and when a folder
// changes), one file again when the watcher reports it, and an open document, as the
// app has it (unsaved edits and a file view's text included), shortly after each edit.
// The page adds each file's Undefined variables and shared `# @name`s, from what the
// shell says its text reads as (problemsList.ts), knowing the environments and the
// Session's Global variables; the panel's list and the toggle's count are read here.
import { untrack } from "svelte";
import { api } from "./api";
import { ReferenceChecks, type OutsideScope, type PortabilityLevel } from "./checks";
import { problemCount, problemFiles, type ProblemFile, type ProblemFilesMemo } from "./problemsList";
import type { EnvironmentSet, FileProblems, OpenText } from "./types";
import { envVariables } from "./vars";

/** How long edits to an open document pause before its problems are read again. */
export const PROBLEMS_READ_DELAY_MS = 300;

/** What the Problems panel needs from the rest of the store. */
export interface ProblemsHost {
  readonly root: string | null;
  /** The paths of the open documents. */
  readonly openPaths: string[];
  /**
   * The open document at `path` as the app has it: its file view's text, or else its
   * file, each request whose Source view holds text that doesn't parse as written there.
   */
  openText(path: string): OpenText | null;
  /** What `openText(path)` follows, as strings that stay the same while it's unchanged (live state: reading it tracks it). */
  openVersion(path: string): string[];
  /** The level portability notes show at (Settings → Portability). */
  readonly portabilityLevel: PortabilityLevel;
  /** The environments the file at `path`'s requests use: its folder's (ADR-0004; live state). */
  environmentsOf(path: string): EnvironmentSet | null;
  /** The selected environment. */
  readonly envName: string | null;
  /** Goes up whenever the Session may have changed (its Global variables among it). */
  readonly sessionVersion: number;
}

export class WorkspaceProblems {
  constructor(private readonly host: ProblemsHost) {}

  /** Each file the shell found something in (or references to look at), by path. Raw: a file comes with what its text reads as. */
  files = $state.raw<Record<string, FileProblems>>({});

  /** The Session's Global variables, which every request can use: read again whenever the Session changes (`track`). */
  private globals = $state.raw<Record<string, string>>({});
  private globalsRead = -1;

  /** Per folder's environments, what its files' requests see: the same object until the environments, the selection or the Global variables change. */
  private scopes = new Map<EnvironmentSet | null, OutsideScope>();
  /** Per file, its requests' reference checks, kept between readings of it. */
  private kept = new Map<string, ReferenceChecks>();

  /** The panel's files, by path, each with its entries by line. */
  readonly list: ProblemFile[] = $derived.by(() => {
    const { globals } = this;
    const envName = this.host.envName;
    const scopeOf = (path: string) => {
      const set = this.host.environmentsOf(path);
      let scope = this.scopes.get(set);
      if (!scope || scope.envName !== envName || scope.globals !== globals) this.scopes.set(set, (scope = { env: envVariables(set, envName), envName, globals }));
      return scope;
    };
    const kept = (path: string) => {
      let checks = this.kept.get(path);
      if (!checks) this.kept.set(path, (checks = new ReferenceChecks()));
      return checks;
    };
    return problemFiles(Object.values(this.files), this.host.portabilityLevel, scopeOf, kept, this.listed);
  });
  /** Each file's entry as last listed (`problemFiles`' memo): an edit to one open document lists only that one again. */
  private listed: ProblemFilesMemo = new WeakMap();

  /** The count on the panel's toggle. */
  get count(): number {
    return problemCount(this.list);
  }

  /** Per open document, what it was (`openVersion`) when last asked about. */
  private seen = new Map<string, string[]>();
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
    this.scopes.clear();
    this.kept.clear();
    this.seen.clear();
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    clearTimeout(this.scanTimer);
  }

  /** A scan under way, and whether another was asked for meanwhile (it runs once this one ends). */
  private scanning: Promise<void> | null = null;
  private scanAgain = false;
  private scanTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * Reads the whole workspace, open documents as the app has them. One at a time: asked
   * for while one runs (a checkout reports folder after folder), it runs once more when
   * that one ends, however often it was asked for.
   */
  scan(): Promise<void> {
    if (this.scanning) {
      this.scanAgain = true;
      return this.scanning;
    }
    const run = async () => {
      do {
        this.scanAgain = false;
        await this.scanOnce();
      } while (this.scanAgain);
    };
    const scanning = run().finally(() => {
      if (this.scanning === scanning) this.scanning = null;
    });
    return (this.scanning = scanning);
  }

  /** `scan`, once the watcher has been quiet for a moment. */
  private scanSoon() {
    clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => void this.scan(), PROBLEMS_READ_DELAY_MS);
  }

  /** The app moved the file or folder at `from` to `to` (no watcher event follows): what was found in it is at its new path. */
  moved(from: string, to: string) {
    const remap = (p: string) => (p === from ? to : p.startsWith(from + "/") || p.startsWith(from + "\\") ? to + p.slice(from.length) : p);
    const files: Record<string, FileProblems> = {};
    for (const f of Object.values(this.files)) {
      const path = remap(f.path);
      files[path] = path === f.path ? f : { ...f, path };
      if (path !== f.path) this.kept.delete(f.path);
    }
    this.files = files;
  }

  /** The app deleted the file or folder at `path` (no watcher event follows): nothing is listed for it. */
  removed(path: string) {
    const under = (p: string) => p === path || p.startsWith(path + "/") || p.startsWith(path + "\\");
    if (!Object.keys(this.files).some(under)) return;
    this.files = Object.fromEntries(Object.entries(this.files).filter(([p]) => !under(p)));
    for (const p of [...this.kept.keys()]) if (under(p)) this.kept.delete(p);
  }

  private async scanOnce(): Promise<void> {
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
      this.scanSoon();
      return;
    }
    for (const p of paths) if (/\.(http|rest)$/i.test(p)) void this.refresh(p);
  }

  /**
   * Reads each open document again once its edits pause, and a document no longer open
   * from disk. Call it from an effect, which reruns on each change to the documents.
   */
  track() {
    // Read here, so a change to the Session runs it again.
    const session = this.host.sessionVersion;
    untrack(() => this.readGlobals(session));
    const now = new Map<string, string[]>();
    // Compared, not copied into JSON on each edit (#168).
    for (const path of this.host.openPaths) now.set(path, this.host.openVersion(path));
    const same = (a: string[] | undefined, b: string[]) => !!a && a.length === b.length && a.every((v, i) => v === b[i]);
    untrack(() => {
      for (const [path, was] of now) if (!same(this.seen.get(path), was)) this.later(path);
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
    const { [path]: _, ...others } = this.files;
    this.files = found && (found.problems.length || found.portability.length || found.file) ? { ...others, [path]: found } : others;
  }

  /** Reads the Session's Global variables again if the Session changed (it's at `version`) since they were read. */
  private readGlobals(version: number) {
    if (version === this.globalsRead) return;
    this.globalsRead = version;
    // Never throws: Global variables it can't read are none.
    Promise.resolve().then(() => api.sessionGlobals()).then(
      (all) => version === this.globalsRead && (this.globals = Object.fromEntries(all.map((g) => [g.name, g.value]))),
      () => {},
    );
  }
}
