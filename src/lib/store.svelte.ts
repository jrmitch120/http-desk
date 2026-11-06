// Global application state (Svelte 5 runes). Documents are parsed `.http`
// files; tabs point at a request inside a document by a frontend-only key.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, errorMessage } from "./api";
import { basename, dirname, displayName, fileVariables, joinPath, newRequest, uid } from "./http";
import type { AppSettings, EnvironmentSet, HttpFile, HttpResponse, Request, TreeNode } from "./types";

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
  error?: string;
}

export interface Toast {
  id: string;
  kind: "info" | "success" | "error";
  message: string;
}

export interface DialogButton {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

export interface DialogState {
  title: string;
  message?: string;
  input?: { value: string; placeholder?: string; selectStem?: boolean };
  buttons: DialogButton[];
  resolve: (r: { button: string; value: string }) => void;
}

export type ModalKind = "env" | "openapi" | "settings" | null;

function snapshot(req: Request): string {
  return JSON.stringify(req, (k, v) => (k === "_key" ? undefined : v));
}

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
  toasts = $state<Toast[]>([]);
  expanded = $state<Record<string, boolean>>({});
  modal = $state<ModalKind>(null);
  dialog = $state<DialogState | null>(null);
  /** Bumped to ask the sidebar search box to take focus. */
  focusSearch = $state(0);

  activeTab = $derived(this.tabs.find((t) => t.id === this.activeTabId) ?? null);

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
      this.settings = await api.getSettings();
    } catch (e) {
      this.toast("error", errorMessage(e));
    }
    this.applyTheme();
    await listen<{ paths: string[] }>("workspace-changed", (e) => this.onExternalChange(e.payload.paths));
    const win = getCurrentWindow();
    await win.onCloseRequested(async (e) => {
      const dirty = this.dirtyDocs();
      if (!dirty.length) return;
      e.preventDefault();
      const r = await this.choose("Unsaved changes", `${dirty.length} file${dirty.length > 1 ? "s have" : " has"} unsaved changes.`, [
        { label: "Cancel", value: "cancel" },
        { label: "Don't save", value: "discard", danger: true },
        { label: "Save all", value: "save", primary: true },
      ]);
      if (r.button === "cancel") return;
      if (r.button === "save") {
        await this.saveAll();
        if (this.dirtyDocs().length) return; // a save failed; stay open
      }
      await win.destroy();
    });
    const last = this.settings?.recentWorkspaces[0];
    if (last && (await api.pathExists(last).catch(() => false))) await this.openWorkspace(last);
  }

  applyTheme() {
    document.documentElement.dataset.theme = this.settings?.theme ?? "dark";
  }

  async updateSettings(patch: Partial<AppSettings>) {
    if (!this.settings) return;
    Object.assign(this.settings, patch);
    this.applyTheme();
    await api.saveSettings($state.snapshot(this.settings) as AppSettings);
  }

  async openWorkspace(path: string) {
    if (this.dirtyDocs().length) {
      const r = await this.choose("Unsaved changes", "Open another workspace and discard unsaved changes?", [
        { label: "Cancel", value: "cancel" },
        { label: "Discard", value: "discard", danger: true },
      ]);
      if (r.button !== "discard") return;
    }
    try {
      const info = await api.openWorkspace(path);
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
      getCurrentWindow().setTitle(`HttpDesk — ${basename(info.root)}`).catch(() => {});
    } catch (e) {
      this.toast("error", errorMessage(e));
    }
  }

  async refreshTree() {
    if (!this.root) return;
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
      const sig = (r: Request) => `${r.name}\u0000${r.method}\u0000${r.url}`;
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
      if (file.requests.length === old.file.requests.length) {
        file.requests.forEach((r, i) => {
          const o = old.file.requests[i];
          if (!r._key && unused.has(o._key!)) {
            r._key = o._key;
            unused.delete(o._key!);
          }
        });
      }
      const held = new Set(this.tabs.filter((t) => t.path === path).map((t) => t.key));
      orphans = [...unused.values()].filter((r) => held.has(r._key!));
    }
    this.docs[path] = this.makeDoc(path, file, orphans, old?.saved);
  }

  private reloadTimer: ReturnType<typeof setTimeout> | null = null;

  private async onExternalChange(paths: string[]) {
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
        doc.externalChange = true;
      } else {
        await this.reload(p);
      }
    }
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
    if (!name) return;
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
    if (!name) return;
    try {
      await api.createDir(joinPath(dir, name));
      this.expanded[dir] = true;
      await this.refreshTree();
    } catch (e) {
      this.toast("error", errorMessage(e));
    }
  }

  async renamePath(path: string) {
    const name = await this.prompt("Rename", basename(path), undefined, true);
    if (!name || name === basename(path)) return;
    await this.movePath(path, joinPath(dirname(path), name));
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
      await api.deletePath(path);
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

  async send(tabId: string) {
    const tab = this.tabs.find((t) => t.id === tabId);
    const req = this.requestFor(tab ?? null);
    const doc = tab && this.docs[tab.path];
    if (!tab || !req || !doc) return;
    if (this.runs[tabId]?.loading) return;
    const runId = uid();
    this.runs[tabId] = { runId, loading: true, startedAt: performance.now(), response: this.runs[tabId]?.response };
    try {
      const response = await api.sendRequest({
        runId,
        request: $state.snapshot(req) as Request,
        filePath: tab.path,
        fileVariables: $state.snapshot(fileVariables(doc.file)),
        environment: this.envName,
      });
      if (this.runs[tabId]?.runId === runId) this.runs[tabId] = { runId, loading: false, startedAt: 0, response };
    } catch (e) {
      if (this.runs[tabId]?.runId === runId) this.runs[tabId] = { runId, loading: false, startedAt: 0, error: errorMessage(e) };
    }
  }

  async cancel(tabId: string) {
    const run = this.runs[tabId];
    if (run?.loading) await api.cancelRequest(run.runId);
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

  // ---------------------------------------------------------------- feedback

  toast(kind: Toast["kind"], message: string) {
    const id = uid();
    this.toasts.push({ id, kind, message });
    setTimeout(() => (this.toasts = this.toasts.filter((t) => t.id !== id)), kind === "error" ? 7000 : 3500);
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
