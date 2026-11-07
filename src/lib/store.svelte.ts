// Global application state (Svelte 5 runes). Documents are parsed `.http`
// files; tabs point at a request inside a document by a frontend-only key.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, errorMessage, type RequestArgs } from "./api";
import { basename, dirname, displayName, fileVariables, joinPath, nameError, newRequest, uid } from "./http";
import { legacyPaneSizes } from "./panes";
import { toSendError } from "./sendError";
import type { AppSettings, EnvironmentSet, HttpFile, HttpResponse, Request, RequestPreview, SearchHit, SendError, TreeNode } from "./types";

export interface Doc {
  path: string;
  file: HttpFile;
  /** JSON snapshot per request key as last loaded/saved. */
  saved: Record<string, string>;
  savedOrder: string;
  savedHeader: string;
  externalChange: boolean;
  missing: boolean;
  /** Requests of Orphaned tabs: gone from the file on disk but still open, with
   *  their edits. Saving appends them back to the file (see `save`). */
  orphans: Request[];
}

export interface Tab {
  id: string;
  path: string;
  key: string;
}

export interface RunState {
  runId: string;
  loading: boolean;
  startedAt: number;
  response?: HttpResponse;
  /** Why the last send failed (Retry is `send` again). */
  error?: SendError;
  /** The last send was cancelled; `response` is still the one before it. */
  cancelled?: boolean;
  /** Body bytes received on the wire so far, while loading (`send-progress` events). */
  received?: number;
}

export interface Toast {
  id: string;
  kind: "info" | "success" | "error";
  message: string;
  /** Hovered or has selected text: not auto-dismissed (see `holdToast`). */
  held?: boolean;
}

export interface DialogButton {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
  /** Focused when the dialog opens, instead of the primary button. Set it on
   *  Cancel for irreversible confirmations, so a stray Enter destroys nothing. */
  focus?: boolean;
}

export interface DialogState {
  title: string;
  message?: string;
  input?: { value: string; placeholder?: string; selectStem?: boolean };
  buttons: DialogButton[];
  resolve: (r: { button: string; value: string }) => void;
}

export type ModalKind = "env" | "openapi" | "settings" | null;
/** A section of the Settings modal that can be opened scrolled into view. */
export type SettingsSection = "tls";

function snapshot(req: Request): string {
  return JSON.stringify(req, (k, v) => (k === "_key" ? undefined : v));
}

/** Identifies a request across reloads and searches: name + method + URL. */
const signature = (name: string, method: string, url: string) => `${name}\u0000${method}\u0000${url}`;

const ensureKey = (r: Request) => {
  if (!r._key) r._key = uid();
  return r._key;
};

class AppStore {
  root = $state<string | null>(null);
  tree = $state<TreeNode | null>(null);
  docs = $state<Record<string, Doc>>({});
  tabs = $state<Tab[]>([]);
  activeTabId = $state<string | null>(null);
  runs = $state<Record<string, RunState>>({});
  envSet = $state<EnvironmentSet | null>(null);
  envName = $state<string | null>(null);
  settings = $state<AppSettings | null>(null);
  /** Whether the OS appearance is dark, which is what the System theme follows. */
  private systemDark = $state(true);
  private stopWatchingSystem: (() => void) | null = null;
  /** The theme chosen in settings: System for new installs, and for anything
   *  unknown in a hand-edited settings file (as theme.rs and theme-boot.js do). */
  themeChoice = $derived<AppSettings["theme"]>(
    this.settings?.theme === "light" || this.settings?.theme === "dark" ? this.settings.theme : "system",
  );
  /** The theme in effect, with System resolved through the OS appearance. */
  effectiveTheme = $derived<"light" | "dark">(this.themeChoice === "system" ? (this.systemDark ? "dark" : "light") : this.themeChoice);
  /** The native window theme last asked for (`null` = follow the OS), to skip repeat calls. */
  private windowTheme: "light" | "dark" | null | undefined = undefined;
  toasts = $state<Toast[]>([]);
  expanded = $state<Record<string, boolean>>({});
  modal = $state<ModalKind>(null);
  dialog = $state<DialogState | null>(null);
  /** True until `init` has finished reopening the last workspace, so the
   *  Welcome screen doesn't flash first. */
  starting = $state(true);
  /** Bumped to ask the sidebar search box to take focus. */
  focusSearch = $state(0);
  /** Fix-it requests from the error panel, each cleared by the component that
   *  acts on it: the Settings section to scroll to when the modal opens, the tab
   *  whose request editor should show its Settings, and the environment picker. */
  settingsSection = $state<SettingsSection | null>(null);
  requestSettingsFor = $state<string | null>(null);
  envPickerWanted = $state(false);

  activeTab = $derived(this.tabs.find((t) => t.id === this.activeTabId) ?? null);

  /** "HttpDesk — my-api — staging": the workspace and the active environment, so
   *  the window always says where a send will go. App.svelte applies it. */
  windowTitle = $derived(
    this.root ? ["HttpDesk", basename(this.root), ...(this.envName ? [this.envName] : [])].join(" — ") : "HttpDesk",
  );

  /** Variables of the selected environment (for highlighting/autocomplete). */
  envVariables = $derived.by(() => {
    const out: Record<string, { value: string; secret: boolean; source: string }> = {};
    const set = this.envSet;
    if (!set) return out;
    for (const v of set.shared) out[v.name] = { value: v.value, secret: v.secret, source: "$shared" };
    const env = set.environments.find((e) => e.name === this.envName);
    for (const v of env?.variables ?? []) out[v.name] = { value: v.value, secret: v.secret, source: env!.name };
    return out;
  });

  // ---------------------------------------------------------------- lifecycle

  async init() {
    try {
      await this.start();
    } finally {
      this.starting = false;
    }
  }

  private async start() {
    try {
      this.settings = await api.getSettings();
    } catch (e) {
      this.toast("error", errorMessage(e));
    }
    this.watchSystemTheme();
    this.windowTheme = undefined;
    this.applyTheme();
    await this.migratePaneSizes();
    await listen<{ paths: string[] }>("workspace-changed", (e) => this.onExternalChange(e.payload.paths));
    await listen<{ root: string }>("workspace-missing", (e) => this.onWorkspaceMissing(e.payload.root));
    await listen<{ message: string }>("workspace-watch-error", (e) => this.onWatchError(e.payload.message));
    await listen<{ runId: string; received: number }>("send-progress", (e) =>
      this.onSendProgress(e.payload.runId, e.payload.received),
    );
    // The window's close button, and on macOS ⌘Q / Dock Quit (the shell always
    // turns those into a close request; see quit.rs). With nothing unsaved the
    // window closes at once, which quits the app.
    await getCurrentWindow().onCloseRequested(async (e) => {
      if (!(await this.confirmQuit())) e.preventDefault();
    });
    // Tells the shell whether a logout or shutdown needs to ask first.
    let unsaved = false;
    $effect.root(() => {
      $effect(() => {
        const now = this.dirtyDocs().length > 0;
        if (now !== unsaved) api.setUnsaved((unsaved = now)).catch(() => {});
      });
    });
    // Forget recent workspaces whose folders are gone, then reopen the last one.
    const recent = this.settings?.recentWorkspaces ?? [];
    const exists = await Promise.all(recent.map((p) => api.pathExists(p).catch(() => true)));
    if (exists.includes(false)) await this.updateSettings({ recentWorkspaces: recent.filter((_, i) => exists[i]) });
    if (recent.length && exists[0]) await this.openWorkspace(recent[0]);
  }

  /** Moves pane sizes older versions kept in localStorage into settings, once. */
  private async migratePaneSizes() {
    const legacy = legacyPaneSizes();
    if (!legacy || !this.settings) return;
    // Kept until the settings are saved, so a failed save can try again next start.
    if (!Object.keys(legacy.patch).length || (await this.updateSettings(legacy.patch))) legacy.remove();
  }

  /** Tracks the OS appearance, re-applying the theme when it changes while System is chosen. */
  private watchSystemTheme() {
    this.stopWatchingSystem?.();
    const query = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    this.systemDark = query.matches;
    const onChange = (e: { matches: boolean }) => {
      this.systemDark = e.matches;
      if (this.themeChoice === "system") this.applyTheme();
    };
    query.addEventListener("change", onChange);
    this.stopWatchingSystem = () => query.removeEventListener("change", onChange);
  }

  /** Applies the theme to the page and to the native window (title bar, scrollbars). */
  applyTheme() {
    document.documentElement.dataset.theme = this.effectiveTheme;
    // A fixed theme pins the window; System lets it (and so prefers-color-scheme) follow the OS.
    const windowTheme = this.themeChoice === "system" ? null : this.themeChoice;
    if (windowTheme === this.windowTheme) return;
    this.windowTheme = windowTheme;
    getCurrentWindow()
      .setTheme(windowTheme)
      .catch(() => {});
  }

  /** Applies and saves settings; a failed save shows an error toast and returns false. */
  async updateSettings(patch: Partial<AppSettings>): Promise<boolean> {
    if (!this.settings) return false;
    Object.assign(this.settings, patch);
    this.applyTheme();
    return this.saveSettings();
  }

  private settingsSave: Promise<boolean> | null = null;
  private nextSettingsSave: Promise<boolean> | null = null;

  /**
   * Saves the whole settings object. Only one save runs at a time: changes made
   * while one runs share a single follow-up save, which snapshots the settings
   * when it starts, so an older snapshot can never be written last.
   */
  private saveSettings(): Promise<boolean> {
    if (this.nextSettingsSave) return this.nextSettingsSave;
    if (!this.settingsSave) return this.startSettingsSave();
    this.nextSettingsSave = this.settingsSave.then(() => {
      this.nextSettingsSave = null;
      return this.startSettingsSave();
    });
    return this.nextSettingsSave;
  }

  private startSettingsSave(): Promise<boolean> {
    const save = this.writeSettings().finally(() => {
      if (this.settingsSave === save) this.settingsSave = null;
    });
    this.settingsSave = save;
    return save;
  }

  private async writeSettings(): Promise<boolean> {
    try {
      await api.saveSettings($state.snapshot(this.settings) as AppSettings);
      return true;
    } catch (e) {
      this.toast("error", `Could not save settings: ${errorMessage(e)}`);
      return false;
    }
  }

  /** The unsaved-changes flow for leaving the open documents behind (closing the
   *  window, quitting, switching workspace). True to go ahead: nothing was
   *  unsaved, the user chose Don't save, or Save all saved every file. */
  async confirmUnsaved(question = ""): Promise<boolean> {
    const dirty = this.dirtyDocs();
    if (!dirty.length) return true;
    const summary = `${dirty.length} file${dirty.length > 1 ? "s have" : " has"} unsaved changes.`;
    const r = await this.choose("Unsaved changes", question ? `${summary} ${question}` : summary, [
      { label: "Cancel", value: "cancel" },
      { label: "Don't save", value: "discard", danger: true },
      { label: "Save all", value: "save", primary: true },
    ]);
    if (r.button === "cancel") return false;
    if (r.button === "save") {
      await this.saveAll();
      if (this.dirtyDocs().length) return false; // a save failed; it was reported
    }
    return true;
  }

  private quitting = false;

  /** Whether the window may close (and the app quit). Asks about unsaved files;
   *  a request made while one is already asking is turned down. */
  async confirmQuit(): Promise<boolean> {
    if (this.quitting) return false;
    this.quitting = true;
    try {
      return await this.confirmUnsaved();
    } finally {
      this.quitting = false;
    }
  }

  async openWorkspace(path: string) {
    if (!(await this.confirmUnsaved("Save them before opening another workspace?"))) return;
    try {
      const info = await api.openWorkspace(path);
      this.missingRoot = null;
      if (info.gitignoreUpdated) this.toast("info", "Added http-client.private.env.json to .gitignore");
      this.root = info.root;
      this.tree = info.tree;
      this.docs = {};
      this.tabs = [];
      this.runs = {};
      this.activeTabId = null;
      this.expanded = { [info.root]: true };
      this.settings = await api.getSettings();
      await this.loadEnvironments();
      const saved = this.settings?.environments[info.root] ?? null;
      this.envName = this.envSet?.environments.some((e) => e.name === saved) ? saved : null;
    } catch (e) {
      this.toast("error", errorMessage(e));
    }
  }

  /** A workspace folder that was deleted or moved while open; the user has been told. */
  private missingRoot: string | null = null;

  async refreshTree() {
    if (!this.root || this.root === this.missingRoot) return;
    try {
      this.tree = await api.getTree();
    } catch (e) {
      this.toast("error", errorMessage(e));
    }
  }

  // ---------------------------------------------------------------- documents

  /** `orphans` keep their snapshot from `prevSaved`, so their edits still show as unsaved. */
  private makeDoc(path: string, file: HttpFile, orphans: Request[] = [], prevSaved: Record<string, string> = {}): Doc {
    file.requests.forEach(ensureKey);
    const orphanSaved = orphans.filter((r) => r._key! in prevSaved).map((r) => [r._key!, prevSaved[r._key!]]);
    return {
      path,
      file,
      saved: Object.fromEntries([...orphanSaved, ...file.requests.map((r) => [r._key!, snapshot(r)])]),
      savedOrder: file.requests.map((r) => r._key).join(","),
      savedHeader: JSON.stringify(file.header),
      externalChange: false,
      missing: false,
      orphans,
    };
  }

  private loading = new Map<string, Promise<Doc | null>>();

  /** Loads (once) and caches a document. Concurrent callers share one read so
   *  request keys stay stable; a second parse would orphan open tabs. */
  loadDoc(path: string): Promise<Doc | null> {
    if (this.docs[path]) return Promise.resolve(this.docs[path]);
    let pending = this.loading.get(path);
    if (!pending) {
      pending = (async () => {
        try {
          const file = await api.readHttpFile(path);
          this.docs[path] ??= this.makeDoc(path, file);
          return this.docs[path];
        } catch (e) {
          this.toast("error", errorMessage(e));
          return null;
        } finally {
          this.loading.delete(path);
        }
      })();
      this.loading.set(path, pending);
    }
    return pending;
  }

  /** Re-reads documents that are already open after the app itself rewrote
   *  them (e.g. OpenAPI regeneration); our own writes produce no watcher event. */
  async reloadOpen(paths: string[]) {
    for (const p of paths) if (this.docs[p]) await this.reload(p);
  }

  requestFor(tab: Tab | null): Request | undefined {
    if (!tab) return undefined;
    return this.findRequest(tab.path, tab.key);
  }

  /** A request of the document: in the file, or held by an Orphaned tab. */
  private findRequest(path: string, key: string): Request | undefined {
    const doc = this.docs[path];
    return doc?.file.requests.find((r) => r._key === key) ?? doc?.orphans.find((r) => r._key === key);
  }

  /** True for an Orphaned tab: its request is no longer in the file on disk. */
  isOrphaned(tab: Tab): boolean {
    const doc = this.docs[tab.path];
    return !!doc && (doc.missing || doc.orphans.some((r) => r._key === tab.key));
  }

  isRequestDirty(path: string, key: string): boolean {
    const doc = this.docs[path];
    const req = this.findRequest(path, key);
    if (!doc || !req) return false;
    return doc.saved[key] !== snapshot(req);
  }

  /** Edits in an Orphaned tab count too: they exist nowhere on disk. */
  isDocDirty(path: string): boolean {
    const doc = this.docs[path];
    if (!doc) return false;
    if (doc.file.requests.map((r) => r._key).join(",") !== doc.savedOrder) return true;
    if (JSON.stringify(doc.file.header) !== doc.savedHeader) return true;
    return [...doc.file.requests, ...doc.orphans].some((r) => doc.saved[r._key!] !== snapshot(r));
  }

  dirtyDocs(): string[] {
    return Object.keys(this.docs).filter((p) => this.isDocDirty(p));
  }

  /** Saves the file. Orphaned requests with edits, or listed in `revive`, are
   *  appended to it; unedited ones stay orphaned so a request another editor
   *  removed isn't silently restored. */
  async save(path: string, revive: string[] = []): Promise<boolean> {
    const doc = this.docs[path];
    if (!doc) return false;
    try {
      const file = $state.snapshot(doc.file) as HttpFile;
      const back = doc.orphans.filter((r) => revive.includes(r._key!) || doc.saved[r._key!] !== snapshot(r));
      // Text that preceded the request in the old file may still be there.
      file.requests.push(...back.map((r) => ({ ...($state.snapshot(r) as Request), leading: "" })));
      const keys = file.requests.map((r) => r._key!);
      const fresh = await api.saveHttpFile(path, file);
      // Same order and count as what we sent: carry keys over by index.
      fresh.requests.forEach((r, i) => (r._key = keys[i] ?? uid()));
      const orphans = doc.orphans.filter((r) => !back.includes(r));
      this.docs[path] = this.makeDoc(path, fresh, orphans, doc.saved);
      return true;
    } catch (e) {
      this.toast("error", `Save failed: ${errorMessage(e)}`);
      return false;
    }
  }

  /** Saves a tab's file; an Orphaned tab's request is written back into it. */
  async saveTab(tab: Tab): Promise<boolean> {
    return this.save(tab.path, [tab.key]);
  }

  async saveActive() {
    const tab = this.activeTab;
    if (tab) await this.saveTab(tab);
  }

  async saveAll() {
    for (const p of this.dirtyDocs()) await this.save(p);
  }

  /** Reloads from disk, keeping tabs attached to the same requests where possible.
   *  Tabs whose request can't be found any more become Orphaned tabs. */
  async reload(path: string) {
    const old = this.docs[path];
    let file: HttpFile;
    try {
      file = await api.readHttpFile(path);
    } catch {
      if (old) old.missing = true;
      return;
    }
    let orphans: Request[] = [];
    if (old) {
      // Earlier orphans can re-attach too, e.g. when the other editor undoes its change.
      const unused = new Map([...old.file.requests, ...old.orphans].map((r) => [r._key!, r]));
      const sig = (r: Request) => signature(r.name, r.method, r.url);
      const byName = (r: Request) => r.name;
      for (const same of [sig, byName]) {
        for (const r of file.requests) {
          if (r._key || (same === byName && !r.name)) continue;
          const match = [...unused.values()].find((o) => same(o) === same(r));
          if (match) {
            r._key = match._key;
            unused.delete(match._key!);
          }
        }
      }
      // Then by position: a still-unmatched request takes the one now at its
      // index, unless that one was already claimed.
      old.file.requests.forEach((o, i) => {
        const r = file.requests[i];
        if (r && !r._key && unused.has(o._key!)) {
          r._key = o._key;
          unused.delete(o._key!);
        }
      });
      const held = new Set(this.tabs.filter((t) => t.path === path).map((t) => t.key));
      orphans = [...unused.values()].filter((r) => held.has(r._key!));
    }
    this.docs[path] = this.makeDoc(path, file, orphans, old?.saved);
  }

  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  /** Whether `file`, fresh from disk, is still what the document was last loaded or saved as. */
  private matchesSaved(doc: Doc, file: HttpFile): boolean {
    const keys = doc.savedOrder ? doc.savedOrder.split(",") : [];
    return (
      JSON.stringify(file.header) === doc.savedHeader &&
      file.trailing === doc.file.trailing &&
      file.lineEnding === doc.file.lineEnding &&
      file.requests.length === keys.length &&
      file.requests.every((r, i) => snapshot(r) === doc.saved[keys[i]])
    );
  }

  /** Asks before OpenAPI generation overwrites `conflicts` (existing files),
   *  naming the open ones with unsaved edits, which the overwrite discards. */
  async confirmOverwrite(conflicts: string[]): Promise<boolean> {
    const names = conflicts.map(basename);
    const list = names.length > 6 ? `${names.slice(0, 6).join(", ")} and ${names.length - 6} more` : names.join(", ");
    const one = conflicts.length === 1;
    let message = `${conflicts.length} file${one ? "" : "s"} already exist${one ? "s" : ""}: ${list}. Overwriting replaces their contents.`;
    const unsaved = conflicts.filter((p) => this.isDocDirty(p)).map(basename);
    if (unsaved.length) {
      message += ` ${unsaved.join(", ")} ${unsaved.length === 1 ? "is" : "are"} open with unsaved edits, which will be lost.`;
    }
    const r = await this.choose("Overwrite existing files?", message, [
      { label: "Cancel", value: "cancel", focus: true },
      { label: "Overwrite", value: "overwrite", danger: true },
    ]);
    return r.button === "overwrite";
  }

  /** Handles a `workspace-changed` event from the watcher. */
  async onExternalChange(paths: string[]) {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.refreshTree(), 150);
    if (paths.some((p) => /http-client(\.private)?\.env\.json$/.test(p))) await this.loadEnvironments();
    for (const p of paths) {
      const doc = this.docs[p];
      if (!doc) continue;
      const exists = await api.pathExists(p).catch(() => true);
      if (!exists) {
        doc.missing = true;
      } else if (this.isDocDirty(p)) {
        doc.missing = false;
        // Our own rename or move (or a touch) leaves the content as loaded: nothing to warn about.
        const disk = await api.readHttpFile(p).catch(() => null);
        if (!disk || !this.matchesSaved(doc, disk)) doc.externalChange = true;
      } else {
        await this.reload(p);
      }
    }
  }

  /** Handles a `workspace-missing` event: the open workspace folder was deleted or moved. */
  onWorkspaceMissing(root: string) {
    if (root !== this.root || root === this.missingRoot) return;
    this.missingRoot = root;
    this.toast("error", `The workspace folder "${basename(root)}" was deleted or moved. Open it again from where it is now.`);
  }

  /** Handles a `workspace-watch-error` event. */
  onWatchError(message: string) {
    this.toast("error", `Watching the workspace for changes failed: ${message}. Changes made outside HttpDesk may not show up.`);
  }

  // ---------------------------------------------------------------- search

  /** Case-insensitive search over request names, methods, URLs and file names.
   *  Open documents are searched as they are on screen (unsaved edits
   *  included); every other file is searched on disk by the backend. */
  async searchRequests(query: string): Promise<SearchHit[]> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const onDisk = await api.searchRequests(query);
    const open = Object.values(this.docs).filter((d) => !d.missing);
    const hits = onDisk.filter((h) => !open.some((d) => d.path === h.path));
    for (const doc of open) {
      const file = basename(doc.path).toLowerCase();
      doc.file.requests.forEach((r, index) => {
        const name = displayName(r);
        if (terms.every((t) => `${name} ${r.method} ${r.url} ${file}`.toLowerCase().includes(t))) {
          hits.push({ path: doc.path, index, name, method: r.method, url: r.url });
        }
      });
    }
    // Explorer order, as the backend returns them; files not in the tree go last.
    const order = new Map<string, number>();
    const walk = (n: TreeNode) => (n.kind === "file" ? order.set(n.path, order.size) : n.children?.forEach(walk));
    if (this.tree) walk(this.tree);
    const rank = (h: SearchHit) => order.get(h.path) ?? order.size;
    return hits.sort((a, b) => rank(a) - rank(b) || (a.path === b.path ? a.index - b.index : 0));
  }

  /** Opens the request a search result points at. It is found by name + method
   *  + URL, since unsaved edits may have moved it since the search; `index`
   *  only breaks ties and is the fallback when nothing matches. */
  async openSearchHit(hit: SearchHit) {
    const doc = await this.loadDoc(hit.path);
    if (!doc) return;
    const want = signature(hit.name, hit.method, hit.url);
    const reqs = doc.file.requests;
    const same = (r: Request | undefined) => !!r && signature(displayName(r), r.method, r.url) === want;
    const req = same(reqs[hit.index]) ? reqs[hit.index] : (reqs.find(same) ?? reqs[hit.index]);
    if (req) await this.openRequest(hit.path, { key: req._key });
  }

  // ---------------------------------------------------------------- tabs

  async openRequest(path: string, which: { key?: string; index?: number }) {
    const doc = await this.loadDoc(path);
    if (!doc) return;
    const req = which.key ? doc.file.requests.find((r) => r._key === which.key) : doc.file.requests[which.index ?? 0];
    if (!req) return;
    const key = req._key!;
    let tab = this.tabs.find((t) => t.path === path && t.key === key);
    if (!tab) {
      tab = { id: uid(), path, key };
      const at = this.tabs.findIndex((t) => t.id === this.activeTabId);
      this.tabs.splice(at < 0 ? this.tabs.length : at + 1, 0, tab);
    }
    this.activeTabId = tab.id;
  }

  private removeTab(id: string) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [tab] = this.tabs.splice(idx, 1);
    delete this.runs[id];
    if (this.activeTabId === id) this.activeTabId = this.tabs[Math.min(idx, this.tabs.length - 1)]?.id ?? null;
    // An orphaned request lives only in its tab.
    const doc = this.docs[tab.path];
    if (doc && !this.tabs.some((t) => t.path === tab.path && t.key === tab.key)) {
      doc.orphans = doc.orphans.filter((r) => r._key !== tab.key);
    }
  }

  /** Closes a tab, asking first if it has unsaved edits. Returns false if it stays open
   *  (the user cancelled or the save failed). */
  async closeTab(id: string): Promise<boolean> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return true;
    const req = this.requestFor(tab);
    if (req && this.isRequestDirty(tab.path, tab.key)) {
      const r = await this.choose(`Save changes to "${displayName(req)}"?`, "Your changes will be lost if you don't save them.", [
        { label: "Cancel", value: "cancel" },
        { label: "Don't save", value: "discard", danger: true },
        { label: "Save", value: "save", primary: true },
      ]);
      if (r.button === "cancel") return false;
      if (r.button === "save" && !(await this.saveTab(tab))) return false;
      if (r.button === "discard") this.revertRequest(tab.path, tab.key);
    }
    this.removeTab(id);
    return true;
  }

  /** Closes tabs one after another (Close all / Close others), asking about each
   *  unsaved one in turn. Stops at the first tab that stays open; the rest stay too. */
  async closeTabs(ids: string[]): Promise<boolean> {
    for (const id of ids) if (!(await this.closeTab(id))) return false;
    return true;
  }

  revertRequest(path: string, key: string) {
    const doc = this.docs[path];
    if (!doc) return;
    const idx = doc.file.requests.findIndex((r) => r._key === key);
    if (idx < 0) return;
    if (doc.saved[key]) {
      doc.file.requests[idx] = { ...JSON.parse(doc.saved[key]), _key: key };
    } else {
      doc.file.requests.splice(idx, 1); // never saved
    }
  }

  // ---------------------------------------------------------------- request ops

  /** Adds a request to a file and opens it. Saves immediately if the file was clean. */
  async addRequest(path: string, req: Request = newRequest()) {
    const doc = await this.loadDoc(path);
    if (!doc) return;
    const wasClean = !this.isDocDirty(path);
    ensureKey(req);
    doc.file.requests.push(req);
    if (wasClean) await this.save(path);
    await this.openRequest(path, { key: req._key });
    this.expanded[path] = true;
  }

  async duplicateRequest(path: string, key: string) {
    const doc = await this.loadDoc(path);
    const src = doc?.file.requests.find((r) => r._key === key);
    if (!doc || !src) return;
    const copy: Request = { ...JSON.parse(snapshot(src)), name: `${displayName(src)} copy`, raw: null, leading: "", _key: uid() };
    const wasClean = !this.isDocDirty(path);
    doc.file.requests.splice(doc.file.requests.indexOf(src) + 1, 0, copy);
    if (wasClean) await this.save(path);
    await this.openRequest(path, { key: copy._key });
  }

  async deleteRequest(path: string, key: string) {
    const doc = await this.loadDoc(path);
    const req = doc?.file.requests.find((r) => r._key === key);
    if (!doc || !req) return;
    const r = await this.choose("Delete request", `Delete "${displayName(req)}" from ${basename(path)}?`, [
      { label: "Cancel", value: "cancel" },
      { label: "Delete", value: "delete", danger: true },
    ]);
    if (r.button !== "delete") return;
    const wasClean = !this.isDocDirty(path);
    // Keep verbatim text that preceded the request (section dividers, notes).
    const idx = doc.file.requests.indexOf(req);
    if (req.leading) {
      const next = doc.file.requests[idx + 1];
      if (next) next.leading = req.leading + next.leading;
      else doc.file.trailing = req.leading + doc.file.trailing;
    }
    doc.file.requests.splice(idx, 1);
    for (const t of this.tabs.filter((t) => t.path === path && t.key === key)) this.removeTab(t.id);
    if (wasClean) await this.save(path);
  }

  async renameRequest(path: string, key: string) {
    const doc = await this.loadDoc(path);
    const req = doc?.file.requests.find((r) => r._key === key);
    if (!req) return;
    const r = await this.prompt("Rename request", displayName(req));
    if (r === null || !r.trim()) return;
    const wasClean = !this.isDocDirty(path);
    req.name = r.trim();
    if (wasClean) await this.save(path);
  }

  // ---------------------------------------------------------------- files

  async createFile(dir: string) {
    const name = await this.prompt("New .http file", "requests.http", "requests.http", true);
    if (!name || !this.validName(name)) return;
    const file = name.match(/\.(http|rest)$/i) ? name : `${name}.http`;
    const path = joinPath(dir, file);
    const content = "### New request\nGET https://httpbin.org/get\nAccept: application/json\n";
    try {
      await api.createFile(path, content);
      this.expanded[dir] = true;
      this.expanded[path] = true;
      await this.refreshTree();
      await this.openRequest(path, { index: 0 });
    } catch (e) {
      this.toast("error", errorMessage(e));
    }
  }

  async createFolder(dir: string) {
    const name = await this.prompt("New folder", "", "folder name");
    if (!name || !this.validName(name)) return;
    try {
      await api.createDir(joinPath(dir, name));
      this.expanded[dir] = true;
      await this.refreshTree();
    } catch (e) {
      this.toast("error", errorMessage(e));
    }
  }

  async renamePath(path: string) {
    const old = basename(path);
    const typed = await this.prompt("Rename", old, undefined, true);
    if (!typed || !this.validName(typed)) return;
    // A request file keeps its extension when the new name leaves it out.
    const ext = old.match(/\.(http|rest)$/i)?.[0];
    const name = ext && !/\.(http|rest)$/i.test(typed) ? typed + ext : typed;
    if (name === old) return;
    await this.movePath(path, joinPath(dirname(path), name));
  }

  /** Shows why a typed file/folder name is invalid; true if it's fine. */
  private validName(name: string): boolean {
    const error = nameError(name);
    if (error) this.toast("error", error);
    return !error;
  }

  async movePath(from: string, to: string) {
    if (from === to || to.startsWith(from + "/") || to.startsWith(from + "\\")) return;
    try {
      await api.renamePath(from, to);
    } catch (e) {
      this.toast("error", errorMessage(e));
      return;
    }
    // Re-point open documents and tabs (file or anything below a folder).
    const remap = (p: string) => (p === from ? to : p.startsWith(from + "/") || p.startsWith(from + "\\") ? to + p.slice(from.length) : p);
    const docs: Record<string, Doc> = {};
    for (const [p, d] of Object.entries(this.docs)) {
      d.path = remap(p);
      docs[d.path] = d;
    }
    this.docs = docs;
    for (const t of this.tabs) t.path = remap(t.path);
    if (this.expanded[from]) this.expanded[to] = true;
    await this.refreshTree();
  }

  async deletePath(path: string) {
    const r = await this.choose("Move to trash", `Move "${basename(path)}" to the trash?`, [
      { label: "Cancel", value: "cancel" },
      { label: "Move to trash", value: "delete", danger: true },
    ]);
    if (r.button !== "delete") return;
    try {
      if ((await api.deletePath(path)) === "trashUnavailable") {
        const ok = await this.choose("Couldn't move to trash", `Delete "${basename(path)}" permanently? This can't be undone.`, [
          { label: "Cancel", value: "cancel", focus: true },
          { label: "Delete permanently", value: "delete", danger: true },
        ]);
        if (ok.button !== "delete") return;
        await api.deletePermanently(path);
      }
    } catch (e) {
      this.toast("error", errorMessage(e));
      return;
    }
    const under = (p: string) => p === path || p.startsWith(path + "/") || p.startsWith(path + "\\");
    for (const t of this.tabs.filter((t) => under(t.path))) this.removeTab(t.id);
    for (const p of Object.keys(this.docs).filter(under)) delete this.docs[p];
    await this.refreshTree();
  }

  // ---------------------------------------------------------------- execution

  /** The request with the scope it's sent in. Send and the resolved preview both use this, so they agree. */
  private requestArgs(tab: Tab, req: Request, doc: Doc): RequestArgs {
    return {
      request: $state.snapshot(req) as Request,
      filePath: tab.path,
      fileVariables: $state.snapshot(fileVariables(doc.file)),
      environment: this.envName,
    };
  }

  /** What sending the tab's request would send, without sending it (see `api.previewRequest`). */
  async preview(tab: Tab): Promise<RequestPreview | null> {
    const req = this.requestFor(tab);
    const doc = this.docs[tab.path];
    if (!req || !doc) return null;
    return api.previewRequest(this.requestArgs(tab, req, doc));
  }

  async send(tabId: string) {
    const tab = this.tabs.find((t) => t.id === tabId);
    const req = this.requestFor(tab ?? null);
    const doc = tab && this.docs[tab.path];
    if (!tab || !req || !doc) return;
    if (this.runs[tabId]?.loading) return;
    const runId = uid();
    const previous = this.runs[tabId]?.response;
    this.runs[tabId] = { runId, loading: true, startedAt: performance.now(), response: previous };
    try {
      const response = await api.sendRequest({ runId, ...this.requestArgs(tab, req, doc) });
      if (this.runs[tabId]?.runId === runId) this.runs[tabId] = { runId, loading: false, startedAt: 0, response };
    } catch (e) {
      if (this.runs[tabId]?.runId !== runId) return;
      this.runs[tabId] = this.cancelled.delete(runId)
        ? { runId, loading: false, startedAt: 0, cancelled: true, response: previous }
        : { runId, loading: false, startedAt: 0, error: toSendError(e) };
    } finally {
      this.cancelled.delete(runId);
    }
  }

  /** Records the bytes received so far for a send that is still loading; a
   *  late event for a finished or replaced run is ignored. */
  onSendProgress(runId: string, received: number) {
    const run = Object.values(this.runs).find((r) => r.runId === runId);
    if (run?.loading) run.received = received;
  }

  /** Runs the user cancelled; their failure is shown as Cancelled, not as an error. */
  private cancelled = new Set<string>();

  async cancel(tabId: string) {
    const run = this.runs[tabId];
    if (!run?.loading) return;
    this.cancelled.add(run.runId);
    await api.cancelRequest(run.runId);
  }

  // ---------------------------------------------------------------- environments

  async loadEnvironments() {
    if (!this.root) return;
    try {
      this.envSet = await api.loadEnvironments();
      if (this.envName && !this.envSet.environments.some((e) => e.name === this.envName)) this.envName = null;
    } catch (e) {
      this.envSet = { shared: [], environments: [], privateFileIgnored: null };
      this.toast("error", errorMessage(e));
    }
  }

  async selectEnvironment(name: string | null) {
    this.envName = name;
    if (this.root && this.settings) {
      const envs = { ...this.settings.environments };
      if (name) envs[this.root] = name;
      else delete envs[this.root];
      await this.updateSettings({ environments: envs });
    }
  }

  /** Opens the Settings modal, scrolled to `section` if given. */
  openSettings(section: SettingsSection | null = null) {
    this.settingsSection = section;
    this.modal = "settings";
  }

  /** Switches the tab's request editor to its Settings section (timeouts). */
  showRequestSettings(tabId: string) {
    this.requestSettingsFor = tabId;
  }

  /** Opens the environment picker in the top bar. */
  chooseEnvironment() {
    this.envPickerWanted = true;
  }

  // ---------------------------------------------------------------- feedback

  toast(kind: Toast["kind"], message: string) {
    const id = uid();
    this.toasts.push({ id, kind, message });
    const expire = () => {
      // Held toasts (hovered, or with text selected) wait until released.
      if (this.toasts.find((t) => t.id === id)?.held) setTimeout(expire, 1000);
      else this.toasts = this.toasts.filter((t) => t.id !== id);
    };
    setTimeout(expire, kind === "error" ? 7000 : 3500);
  }

  /** Keeps a toast on screen while the user hovers it or selects its text. */
  holdToast(id: string, held: boolean) {
    const t = this.toasts.find((t) => t.id === id);
    if (t) t.held = held;
  }

  /** Dialogs waiting for the one on screen (`dialog`) to be answered, oldest first. */
  private dialogQueue: DialogState[] = [];

  /** Shows the dialog, or queues it behind the one on screen. */
  private openDialog(d: Omit<DialogState, "resolve">): Promise<{ button: string; value: string }> {
    return new Promise((resolve) => {
      const next = { ...d, resolve };
      if (this.dialog) this.dialogQueue.push(next);
      else this.dialog = next;
    });
  }

  choose(title: string, message: string, buttons: DialogButton[]): Promise<{ button: string; value: string }> {
    return this.openDialog({ title, message, buttons });
  }

  async prompt(title: string, value: string, placeholder?: string, selectStem = false): Promise<string | null> {
    const r = await this.openDialog({
      title,
      input: { value, placeholder, selectStem },
      buttons: [
        { label: "Cancel", value: "cancel" },
        { label: "OK", value: "ok", primary: true },
      ],
    });
    return r.button === "ok" ? r.value : null;
  }

  /** Answers the dialog on screen and shows the next queued one, if any. */
  closeDialog(button: string, value = "") {
    const d = this.dialog;
    this.dialog = this.dialogQueue.shift() ?? null;
    d?.resolve({ button, value });
  }
}

export const app = new AppStore();
