// Global application state (Svelte 5 runes). Documents are parsed `.http`
// files; tabs point at a request inside a document by a frontend-only key.
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, errorMessage, type RequestArgs } from "./api";
import { basename, dirname, displayName, fileVariables, getDirective, hasScripts, joinAnd, joinPath, nameError, newRequest, promptMasked, requestNames, requestPrompts, uid } from "./http";
import { envColor, type EnvColor } from "./envColors";
import { legacyPaneSizes } from "./panes";
import { zoomOf } from "./zoom";
import { toSendError } from "./sendError";
import { dropDocs } from "./responseDocs";
import { definesVariable, renameInEnvironments, renameInFile, renameScope } from "./rename";
import { environmentNames, environmentsFor, folderLabel, folderOf, nearestEnvFolder, within, writeFolder } from "./envFolders";
import { extractToEnvironments, extractToFile, targetEnvironments, type ExtractTarget } from "./extract";
import type { Definition } from "./codemirror/setup";
import type { MatrixSort } from "./envMatrix";
import { SHARED } from "./vars";
import { wording, type ButtonRole } from "./platform";
import type {
  AppSettings,
  EnvironmentSet,
  ExchangeShape,
  EnvironmentSettings,
  MatrixWidths,
  RunnerOptions,
  FolderEnvironments,
  HttpFile,
  HttpResponse,
  Request,
  RequestPreview,
  RunProgress,
  SearchHit,
  SendError,
  StoredCookie,
  TestResult,
  TreeNode,
  Usage,
  UsageField,
} from "./types";

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

/**
 * Where one request of a run is: waiting its turn, being sent, done (`passed`, or
 * `failed` per GLOSSARY "Run": a failed test, script error, blocked send or network
 * error, never an error status alone), stopped while sending (`cancelled`), or never
 * reached because the run stopped first (`notRun`).
 */
export type RunItemState = "queued" | "sending" | "passed" | "failed" | "cancelled" | "notRun";

/** One request of a run, as the Runner panel lists it. */
export interface RunItem {
  path: string;
  /** The request's key (`_key`), for its test marker and prompt answers. */
  key: string;
  name: string;
  method: string;
  /** Sent from its open tab's unsaved edits rather than the file on disk. */
  unsaved: boolean;
  state: RunItemState;
  /** Its response, kept for the viewer until the run is replaced. */
  response?: HttpResponse;
  /** Why it got no response. */
  error?: SendError;
}

/** A run (GLOSSARY "Run") and its results, shown in the Runner panel. */
export interface Runner {
  runId: string;
  /** What was run: the file's name. */
  title: string;
  items: RunItem[];
  running: boolean;
}

/** A request a run sends: where it's from, and what `run_requests` gets for it. */
interface RunEntry {
  path: string;
  key: string;
  unsaved: boolean;
  args: Omit<RequestArgs, "environment">;
}

/** Stands in for a tab id in `confirmingSend` while a run asks its questions. */
const RUN_ASKING = "\u0000run";

/** A workspace's Runner options until they're changed: no delay, and failures don't stop a run. */
const DEFAULT_RUNNER_OPTIONS: RunnerOptions = { delayMs: 0, stopOnFailure: false };

/** Ends the title of a run of the last run's failed requests (Re-run failed). */
const FAILED_SUFFIX = " (failed)";


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
  /** Decides where the button sits on each OS (`arrangeDialogButtons`), and
   *  which one Enter (primary) and Escape (cancel) stand for. */
  role?: ButtonRole;
  /** Drawn in the danger colour: a primary that destroys something, or a destructive alternative. */
  danger?: boolean;
  /** Focused when the dialog opens, instead of the primary button. Set it on
   *  Cancel for irreversible confirmations, so a stray Enter destroys nothing. */
  focus?: boolean;
}

/** A dialog's Cancel button, which Escape stands for (answers "cancel"). */
export const CANCEL: DialogButton = { label: "Cancel", value: "cancel", role: "cancel" };

/** A definition's row to open; with `add`, one with an empty value is added if there's none. */
export type WantedDefinition = Definition & { add?: boolean };

/** One field of a dialog form: a labelled text input, masked (with a reveal button) if asked. */
export interface DialogField {
  label: string;
  /** Shown under the label; empty for none. */
  help: string;
  masked: boolean;
  value: string;
}

export interface DialogState {
  title: string;
  message?: string;
  input?: { value: string; placeholder?: string; selectStem?: boolean };
  /** A form of several fields; their values come back in `values`, in order. */
  fields?: DialogField[];
  buttons: DialogButton[];
  resolve: (r: { button: string; value: string; values: string[] }) => void;
}

/** The user's answer to the Rename variable form: the new name, and the usages
 *  whose references to update (null: rename it in the environments only). */
export interface RenameChoice {
  name: string;
  usages: Usage[] | null;
}

/** A Rename variable form, for environment variable `name` of folder `dir`'s env files. */
export interface Renaming {
  name: string;
  dir: string;
}

/** The user's answer to the Extract to variable form. */
export interface ExtractChoice {
  name: string;
  target: ExtractTarget;
}

/** An Extract to variable form: the selected text, for the request in tab `tabId`. */
export interface Extraction {
  tabId: string;
  value: string;
}

/**
 * A form on screen that the store waits on (Rename variable, Extract to variable):
 * `shown` is what it shows, null when there is none; `answer` closes it with the
 * user's choice (null: cancelled). Asking again cancels one still showing.
 */
class PendingForm<S, C> {
  shown = $state<S | null>(null);
  private resolve: ((choice: C | null) => void) | null = null;

  /** Shows the form and waits for its answer. */
  ask(shown: S): Promise<C | null> {
    this.answer(null);
    return new Promise((resolve) => {
      this.shown = shown;
      this.resolve = resolve;
    });
  }

  answer(choice: C | null) {
    const resolve = this.resolve;
    this.shown = null;
    this.resolve = null;
    resolve?.(choice);
  }
}

export type ModalKind = "env" | "openapi" | "settings" | "about" | null;
/** A panel in the panel area below the requests (`PanelArea.svelte`). */
export type PanelId = "session" | "runner";
/** A section of the Settings modal that can be opened scrolled into view. */
export type SettingsSection = "tls";

/** Methods that don't change data, so the production guard lets them through. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** The method as sent: upper-cased, GET when blank. */
const verbOf = (method: string) => method.trim().toUpperCase() || "GET";

function snapshot(req: Request): string {
  return JSON.stringify(req, (k, v) => (k === "_key" ? undefined : v));
}

/** Identifies a request across reloads and searches: name + method + URL. */
const signature = (name: string, method: string, url: string) => `${name}\u0000${method}\u0000${url}`;

const ensureKey = (r: Request) => {
  if (!r._key) r._key = uid();
  return r._key;
};

/** The files under `node` (itself, if it's a file), in the order the explorer shows them. */
function treeFiles(node: TreeNode): string[] {
  return node.kind === "file" ? [node.path] : (node.children ?? []).flatMap(treeFiles);
}

function findNode(node: TreeNode, path: string): TreeNode | undefined {
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, path);
    if (found) return found;
  }
}

/** A request in the explorer: its file and its key (`_key`). */
export interface RequestRef {
  path: string;
  key: string;
}

class AppStore {
  root = $state<string | null>(null);
  tree = $state<TreeNode | null>(null);
  docs = $state<Record<string, Doc>>({});
  tabs = $state<Tab[]>([]);
  activeTabId = $state<string | null>(null);
  runs = $state<Record<string, RunState>>({});
  /** The last run and its results (the Runner panel), until the next run or workspace. */
  runner = $state<Runner | null>(null);
  /** The workspace root's own environments (what the Environments modal edits). */
  envSet = $state<EnvironmentSet | null>(null);
  /** The environments of each folder below the root with env files (ADR-0004); see `envSetFor`. */
  envFolders = $state<FolderEnvironments[]>([]);
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
  /** Whether the sidebar is on screen. Only a saved `sidebarHidden: true` hides
   *  it; anything else in a hand-edited settings file shows it (as lib.rs reads it). */
  sidebarShown = $derived(this.settings?.sidebarHidden !== true);
  /** The zoom of the whole interface. A missing, non-numeric or out-of-range
   *  `zoom` in a hand-edited settings file is 100% (as lib.rs reads it). */
  zoom = $derived(zoomOf(this.settings?.zoom));
  /** The webview zoom last asked for, to skip repeat calls. */
  private webviewZoom: number | undefined = undefined;
  /** The theme in effect, with System resolved through the OS appearance. */
  effectiveTheme = $derived<"light" | "dark">(this.themeChoice === "system" ? (this.systemDark ? "dark" : "light") : this.themeChoice);
  /** The native window theme last asked for (`null` = follow the OS), to skip repeat calls. */
  private windowTheme: "light" | "dark" | null | undefined = undefined;
  toasts = $state<Toast[]>([]);
  expanded = $state<Record<string, boolean>>({});
  /** The requests picked in the explorer with ⌘/Ctrl- or Shift-click, Space or
   *  Shift+arrows; none means the explorer's selection is the active request. */
  treeSelection = $state<RequestRef[]>([]);
  /** Where a Shift-click range starts: the request last clicked or toggled. */
  private selectionAnchor: RequestRef | null = null;
  modal = $state<ModalKind>(null);
  /** The panel shown below the requests, if any. */
  panel = $state<PanelId | null>(null);
  dialog = $state<DialogState | null>(null);
  private extractForm = new PendingForm<Extraction, ExtractChoice>();
  /** The Extract to variable form on screen (`ExtractVariable.svelte`), if any. */
  get extraction(): Extraction | null {
    return this.extractForm.shown;
  }
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
  /** A variable definition whose row a hover card's Edit asked for: the request's
   *  Settings or the Environments modal focuses it and clears this. With `add`
   *  (an Undefined variable's quick fix), an empty row is added first if there's none. */
  definitionWanted = $state<WantedDefinition | null>(null);
  envPickerWanted = $state(false);
  /** How the Environments matrix sorts its rows (its Variable header): for this app session only, never saved. */
  envMatrixSort = $state<MatrixSort>("asc");
  /** Find usages results shown in the sidebar (`usages` null while searching); null when closed. */
  usages = $state<{ name: string; usages: Usage[] | null } | null>(null);
  private usagesSeq = 0;
  /** A Find usages result asked to show this field of the tab's request: its
   *  request editor switches to it and clears this. */
  fieldWanted = $state<{ tabId: string; field: UsageField } | null>(null);
  /** The tab whose request editor shows its request's `.http` source instead of
   *  its sections (the editor's .http button, Request → Show .http Source). */
  sourceShownFor = $state<string | null>(null);
  private renameForm = new PendingForm<Renaming, RenameChoice>();
  /** The Rename variable form on screen (`RenameVariable.svelte`), if any. */
  get renaming(): Renaming | null {
    return this.renameForm.shown;
  }

  activeTab = $derived(this.tabs.find((t) => t.id === this.activeTabId) ?? null);

  /** "Get users — my-api — staging": the active request (as its tab names it), the
   *  workspace and the active environment, dropping what doesn't apply; "HttpDesk"
   *  with no workspace. The request leads because the Dock, taskbar and window
   *  switcher cut long titles off at the end. App.svelte applies it. */
  windowTitle = $derived.by(() => {
    if (!this.root) return "HttpDesk";
    const req = this.requestFor(this.activeTab);
    return [req && displayName(req), basename(this.root), this.envName].filter(Boolean).join(" — ");
  });

  /** Every environment name in the workspace (the picker lists them all). */
  envNames = $derived(environmentNames(this.envSet, this.envFolders));

  /** The environments a request in the file at `path` is sent with: its nearest folder's (ADR-0004). */
  envSetFor(path: string): EnvironmentSet | null {
    return environmentsFor(this.envSet, this.envFolders, this.folderOf(path));
  }

  /** The folder holding the file at `path`, relative to the workspace root ("" at the root, or with no workspace). */
  folderOf(path: string): string {
    return this.root ? folderOf(this.root, path) : "";
  }

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
    // The shell already applied the saved zoom before the first paint (theme.rs); this agrees with it.
    this.webviewZoom = undefined;
    this.applyZoom();
    await this.migratePaneSizes();
    await listen<{ paths: string[] }>("workspace-changed", (e) => this.onExternalChange(e.payload.paths));
    await listen<{ root: string }>("workspace-missing", (e) => this.onWorkspaceMissing(e.payload.root));
    await listen<{ message: string }>("workspace-watch-error", (e) => this.onWatchError(e.payload.message));
    await listen<{ runId: string; received: number }>("send-progress", (e) =>
      this.onSendProgress(e.payload.runId, e.payload.received),
    );
    await listen<RunProgress>("run-progress", (e) => this.onRunProgress(e.payload));
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

  /** Applies the zoom to the whole webview: the sidebar, editors, previews and modals together. */
  applyZoom() {
    if (this.zoom === this.webviewZoom) return;
    this.webviewZoom = this.zoom;
    getCurrentWebview()
      .setZoom(this.zoom)
      .catch(() => {});
  }

  /** Shows the sidebar if it's hidden, for what puts its results there (Search Requests, Find usages). */
  showSidebar() {
    if (!this.sidebarShown) void this.updateSettings({ sidebarHidden: false });
  }

  /** Applies and saves settings; a failed save shows an error toast and returns false. */
  async updateSettings(patch: Partial<AppSettings>): Promise<boolean> {
    if (!this.settings) return false;
    Object.assign(this.settings, patch);
    this.applyTheme();
    this.applyZoom();
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
      CANCEL,
      { label: "Don't save", value: "discard", role: "destructive", danger: true },
      { label: "Save all", value: "save", role: "primary" },
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

  /** The recent workspaces other than the open one, as many as the workspace menus list (the top bar's, Open Recent). */
  get otherRecentWorkspaces(): string[] {
    return (this.settings?.recentWorkspaces ?? []).filter((w) => w !== this.root).slice(0, 8);
  }

  async openWorkspace(path: string) {
    if (!(await this.confirmUnsaved("Save them before opening another workspace?"))) return;
    try {
      const info = await api.openWorkspace(path);
      // The shell started a new Session for it, so nothing from the last one shows.
      this.sessionVersion++;
      this.clearTestMarks();
      this.missingRoot = null;
      if (info.gitignoreUpdated) this.gitignoreUpdated("");
      this.root = info.root;
      this.scriptsSkippedIn = null;
      this.tree = info.tree;
      this.docs = {};
      this.tabs = [];
      for (const run of Object.values(this.runs)) this.releaseResponse(run.response);
      this.runs = {};
      this.releaseRunner();
      this.runner = null;
      if (this.panel === "runner") this.panel = null;
      this.activeTabId = null;
      this.expanded = { [info.root]: true };
      this.clearTreeSelection();
      this.settings = await api.getSettings();
      await this.loadEnvironments();
      const saved = this.settings?.environments[info.root] ?? null;
      this.envName = saved && this.envNames.includes(saved) ? saved : null;
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
      { ...CANCEL, focus: true },
      { label: "Overwrite", value: "overwrite", role: "primary", danger: true },
    ]);
    return r.button === "overwrite";
  }

  /** Handles a `workspace-changed` event from the watcher. */
  async onExternalChange(paths: string[]) {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => this.refreshTree(), 150);
    // An env file anywhere, or a folder (which may hold env files: moved in, renamed, deleted).
    if (paths.some((p) => /http-client(\.private)?\.env\.json$/.test(p) || !/\.(http|rest)$/i.test(p))) await this.loadEnvironments();
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
    const order = new Map((this.tree ? treeFiles(this.tree) : []).map((path, i) => [path, i]));
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

  /** Find usages of `{{name}}` across the workspace, shown in the sidebar (shown
   *  first if it's hidden). Open documents are searched as they are on screen
   *  (unsaved edits included); the backend reads every other file, and the env
   *  files, from disk. */
  async findUsages(name: string) {
    this.showSidebar();
    const seq = ++this.usagesSeq;
    this.usages = { name, usages: null };
    try {
      const usages = await this.searchUsages(name);
      if (seq === this.usagesSeq) this.usages = { name, usages };
    } catch (e) {
      if (seq === this.usagesSeq) this.usages = null;
      this.toast("error", errorMessage(e));
    }
  }

  /** Usages of `{{name}}`: open documents as they are on screen, everything else from disk. */
  searchUsages(name: string): Promise<Usage[]> {
    const open = Object.values(this.docs)
      .filter((d) => !d.missing)
      .map((d) => ({ path: d.path, file: $state.snapshot(d.file) as HttpFile }));
    return api.findUsages(name, open);
  }

  closeUsages() {
    this.usagesSeq++;
    this.usages = null;
  }

  /** Shows where a Find usages result is: the request on the field holding it
   *  (found as `openSearchHit` finds it), a File variable's row in its file's
   *  request Settings, or an environment value's row in the Environments modal (on
   *  the folder of the env file holding it). */
  async openUsage(usage: Usage) {
    if (usage.kind === "environment") {
      this.definitionWanted = { kind: "env", env: usage.env, name: usage.name, dir: this.folderOf(usage.path) };
      this.modal = "env";
      return;
    }
    if (usage.kind === "fileVariable") {
      const open = this.tabs.find((t) => t.path === usage.path && t.id === this.activeTabId) ?? this.tabs.find((t) => t.path === usage.path);
      if (open) this.activeTabId = open.id;
      else await this.openRequest(usage.path, { index: 0 });
      if (this.activeTab?.path === usage.path) this.editDefinition(this.activeTab.id, { kind: "file", name: usage.name });
      return;
    }
    await this.openSearchHit(usage);
    if (this.activeTab?.path === usage.path) this.fieldWanted = { tabId: this.activeTab.id, field: usage.field };
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
    this.releaseResponse(this.runs[id]?.response);
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
        CANCEL,
        { label: "Don't save", value: "discard", role: "destructive", danger: true },
        { label: "Save", value: "save", role: "primary" },
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
      CANCEL,
      { label: "Delete", value: "delete", role: "primary", danger: true },
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
    await this.reloadFolderEnvironments(from);
  }

  /** After the app moved or deleted `path` (no watcher event follows): a folder may have held env files. */
  private async reloadFolderEnvironments(path: string) {
    if (!/\.(http|rest)$/i.test(path)) await this.loadEnvironments();
  }

  async deletePath(path: string) {
    const words = wording();
    const r = await this.choose(words.moveToTrash, words.trashQuestion(basename(path)), [
      CANCEL,
      { label: words.moveToTrash, value: "delete", role: "primary", danger: true },
    ]);
    if (r.button !== "delete") return;
    try {
      if ((await api.deletePath(path)) === "trashUnavailable") {
        const ok = await this.choose(words.trashUnavailable, `Delete "${basename(path)}" permanently? This can't be undone.`, [
          { ...CANCEL, focus: true },
          { label: "Delete permanently", value: "delete", role: "primary", danger: true },
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
    await this.reloadFolderEnvironments(path);
  }

  // ---------------------------------------------------------------- execution

  /** The request with the scope it's sent in. Send and the resolved preview both use this, so they agree. */
  private requestArgs(tab: Tab, req: Request, doc: Doc): RequestArgs {
    return {
      request: $state.snapshot(req) as Request,
      filePath: tab.path,
      fileVariables: $state.snapshot(fileVariables(doc.file)),
      environment: this.envName,
      requestKey: tab.key,
      requestNames: requestNames(doc.file),
    };
  }

  /**
   * Goes up whenever the workspace's Session changes (answers given or forgotten, a
   * named request's exchange recorded, or a new workspace opened), so views showing
   * what it holds read it again.
   */
  sessionVersion = $state(0);

  /**
   * The values the Session remembers for the tab's request's Prompt variables, by
   * name. The Session (in the shell) holds them, never the webview.
   */
  promptAnswers(tab: Tab): Promise<Record<string, string>> {
    return api.promptAnswers(tab.key);
  }

  /** Exchange shapes read for `shapesVersion` of the Session, by `path\0name`. */
  private exchangeShapes = new Map<string, Promise<ExchangeShape | null>>();
  private shapesVersion = -1;

  /**
   * The shape of the latest exchange of the request named `name` in file `path`, in
   * the Session (null if it hasn't been sent, or can't be read): what its Request
   * variables' paths complete from. Read once, then again after the Session changes.
   */
  exchangeShape(path: string, name: string): Promise<ExchangeShape | null> {
    if (this.shapesVersion !== this.sessionVersion) {
      this.exchangeShapes.clear();
      this.shapesVersion = this.sessionVersion;
    }
    const key = `${path}\0${name}`;
    let shape = this.exchangeShapes.get(key);
    if (!shape) {
      shape = api.exchangeShape(path, name).catch(() => null);
      this.exchangeShapes.set(key, shape);
    }
    return shape;
  }

  /** Forgets the tab's request's prompted values, so its next send asks again. */
  async forgetPrompts(tab: Tab) {
    await api.forgetPromptAnswers(tab.key);
    this.sessionVersion++;
  }

  /** Shows `panel` below the requests, or hides it if it's the one shown. */
  togglePanel(panel: PanelId) {
    this.panel = this.panel === panel ? null : panel;
  }

  /** The cookies in the Session's jar, for the Session panel. */
  sessionCookies(): Promise<StoredCookie[]> {
    return api.sessionCookies();
  }

  /** Deletes one cookie from the Session's jar, so later sends don't carry it. */
  async deleteCookie(c: Pick<StoredCookie, "domain" | "path" | "name">) {
    await this.changeSession(() => api.deleteCookie(c.domain, c.path, c.name));
  }

  /** Deletes every cookie in the Session's jar. */
  async clearCookies() {
    await this.changeSession(() => api.clearCookies());
  }

  /**
   * Empties the whole Session, every section of it, once the user confirms (Clear
   * session in the Session panel).
   */
  async clearSession() {
    const r = await this.choose(
      "Clear the session?",
      "HttpDesk forgets what it remembers for this workspace between sends: cookies, prompt answers, the latest exchange of each named request and test results. Files and environments aren't changed.",
      [
        { ...CANCEL, focus: true },
        { label: "Clear session", value: "clear", role: "primary", danger: true },
      ],
    );
    if (r.button !== "clear") return;
    await this.changeSession(() => api.clearSession());
    this.clearTestMarks();
  }

  /** Runs a change to the Session in the shell, then has views showing it read it again. */
  private async changeSession(change: () => Promise<unknown>) {
    try {
      await change();
    } catch (e) {
      this.toast("error", errorMessage(e));
    } finally {
      this.sessionVersion++;
    }
  }

  /**
   * Asks for the request's Prompt variables that the Session has no value for, all in
   * one form, and has the Session remember the answers. False if the user cancelled.
   */
  private async askPrompts(tab: Tab, req: Request): Promise<boolean> {
    const remembered = await this.promptAnswers(tab);
    const asked = requestPrompts(req).filter((p) => !Object.hasOwn(remembered, p.name));
    if (!asked.length) return true;
    const r = await this.openDialog({
      title: asked.length === 1 ? `Value for "${asked[0].name}"` : "Values for this request",
      message: "Asked once, then remembered for this request until you open another workspace or quit. Never saved.",
      fields: asked.map((p) => ({ label: p.name, help: p.description, masked: promptMasked(p.name), value: "" })),
      buttons: [
        CANCEL,
        { label: "Send", value: "send", role: "primary" },
      ],
    });
    if (r.button !== "send") return false;
    await api.answerPrompts(tab.key, Object.fromEntries(asked.map((p, i) => [p.name, r.values[i] ?? ""])));
    this.sessionVersion++;
    return true;
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
    if (this.runs[tabId]?.loading || this.confirmingSend.has(tabId)) return;
    // Only awaited for a request with prompts, so an ordinary send starts loading at once.
    if (requestPrompts(req).length) {
      this.confirmingSend.add(tabId);
      try {
        if (!(await this.askPrompts(tab, req))) return;
      } finally {
        this.confirmingSend.delete(tabId);
      }
    }
    const env = this.sentEnvironment(tab.path);
    if (env && this.guardsMethod(env, req.method) && !(await this.confirmProductionSend(tabId, env, req.method))) return;
    const scripts = hasScripts(req) ? await this.scriptsAllowed(tabId) : "none";
    if (scripts === "cancel") return;
    const runId = uid();
    const previous = this.runs[tabId]?.response;
    this.runs[tabId] = { runId, loading: true, startedAt: performance.now(), response: previous };
    try {
      const response = await api.sendRequest({ runId, ...this.requestArgs(tab, req, doc), skipScripts: scripts === "skip" });
      // The Session changed if the jar kept cookies the response set, or if the request is
      // named (its exchange is now the latest, which Request variables read): views
      // showing the Session read it again, even if the tab has closed.
      if (response.cookies?.length || getDirective(req, "name")?.trim()) this.sessionVersion++;
      // A tab that closed (or a workspace that changed) meanwhile never shows it.
      if (this.runs[tabId]?.runId !== runId) {
        this.releaseResponse(response);
        return;
      }
      this.runs[tabId] = { runId, loading: false, startedAt: 0, response };
      if (previous?.id !== response.id) this.releaseResponse(previous);
      this.markTests(tab.key, response.tests);
    } catch (e) {
      if (this.runs[tabId]?.runId !== runId) return;
      if (this.cancelled.delete(runId)) {
        this.runs[tabId] = { runId, loading: false, startedAt: 0, cancelled: true, response: previous };
      } else {
        const error = toSendError(e);
        this.runs[tabId] = { runId, loading: false, startedAt: 0, error };
        this.releaseResponse(previous);
        this.clearTestMark(tab.key);
        // The shell knows best: trust revoked elsewhere asks again on the next send.
        if (error.kind === "untrustedWorkspace" && this.settings) {
          this.settings.trustedWorkspaces = (this.settings.trustedWorkspaces ?? []).filter((p) => p !== this.root);
        }
      }
    } finally {
      this.cancelled.delete(runId);
    }
  }

  /**
   * "Send `name` first": opens the request named `name` (`# @name`) in the file of tab
   * `tabId`, whose Request variables read its latest exchange, and sends it the
   * normal way (prompts, the production confirmation and the trust question included). Never resends
   * the request that asked: the user does that.
   */
  async sendFirst(tabId: string, name: string) {
    const tab = this.tabs.find((t) => t.id === tabId);
    const doc = tab && this.docs[tab.path];
    const req = doc?.file.requests.find((r) => getDirective(r, "name")?.trim() === name);
    if (!tab || !req) return;
    await this.openRequest(tab.path, { key: req._key });
    if (this.activeTabId) await this.send(this.activeTabId);
  }

  /**
   * The test marker of each request whose latest send ran tests, by request key:
   * "passed" when every test passed, "failed" when any failed (a handler error
   * included). They belong to the Session, not the tab: a closed tab's request keeps
   * its marker, and they all go when the Session is cleared (`clearTestMarks`).
   */
  private testMarks = $state<Record<string, "passed" | "failed">>({});

  /** The tab strip's and the tree's marker for the request with this key, if its latest send ran tests. */
  testMark(key: string): "passed" | "failed" | undefined {
    return this.testMarks[key];
  }

  /** Records the latest send's tests as the request's marker; no tests, no marker. */
  markTests(key: string, tests: TestResult[] | undefined) {
    if (tests?.length) this.testMarks[key] = tests.every((t) => t.passed) ? "passed" : "failed";
    else this.clearTestMark(key);
  }

  /** Drops one request's marker, for when its latest result is cleared. */
  clearTestMark(key: string) {
    delete this.testMarks[key];
  }

  /** Drops every marker, for when the Session is cleared (a workspace opened, or Clear session). */
  clearTestMarks() {
    this.testMarks = {};
  }

  /** The workspace whose scripts the user chose to skip ("Send without scripts"), until it's opened again. */
  private scriptsSkippedIn: string | null = null;

  /** Whether the open workspace is a Trusted workspace (its scripts run). */
  get trusted(): boolean {
    return !!this.root && (this.settings?.trustedWorkspaces ?? []).includes(this.root);
  }

  /**
   * Whether a send that would run a script runs it ("run"), sends without it
   * ("skip"), or doesn't send ("cancel"). Asks the first time in a workspace
   * that isn't trusted; "Trust and run" is stored by the shell, in the app settings.
   */
  private async scriptsAllowed(tabId: string, what: "send" | "run" = "send"): Promise<"run" | "skip" | "cancel"> {
    if (this.trusted) return "run";
    if (this.root && this.scriptsSkippedIn === this.root) return "skip";
    this.confirmingSend.add(tabId);
    try {
      const r = await this.choose(
        "Run this workspace's scripts?",
        `${what === "run" ? "Requests in this run have scripts" : "This request has a script"}. Scripts in ${this.root} run only if you trust this workspace. Trust it only if you trust whoever wrote its files. It's remembered in HttpDesk's settings, never in the workspace, and can be revoked in Settings.`,
        [
          { ...CANCEL, focus: true },
          { label: what === "run" ? "Run without scripts" : "Send without scripts", value: "skip" },
          { label: "Trust and run", value: "trust", role: "primary" },
        ],
      );
      if (r.button === "skip") {
        this.scriptsSkippedIn = this.root;
        return "skip";
      }
      if (r.button !== "trust") return "cancel";
      try {
        const trusted = await api.trustWorkspace();
        if (this.settings) this.settings.trustedWorkspaces = trusted;
        return "run";
      } catch (e) {
        this.toast("error", errorMessage(e));
        return "cancel";
      }
    } finally {
      this.confirmingSend.delete(tabId);
    }
  }

  /** Stops trusting the workspace at `path` (Settings → Trusted workspaces). */
  async revokeTrust(path: string) {
    try {
      const trusted = await api.revokeWorkspaceTrust(path);
      if (this.settings) this.settings.trustedWorkspaces = trusted;
    } catch (e) {
      this.toast("error", errorMessage(e));
    }
  }

  /** Tabs whose send is waiting on the prompt form, the production confirmation or the trust question. */
  private confirmingSend = new Set<string>();

  /** The environment a request in the file at `path` is sent with: the selected one if
   *  the request's folders define it, else none (ADR-0004; the send warns about it). */
  sentEnvironment(path: string): string | null {
    const name = this.envName;
    return name && this.envSetFor(path)?.environments.some((e) => e.name === name) ? name : null;
  }

  /** Whether sending `method` with environment `env` needs confirming: `env` is a
   *  production environment and the method isn't GET, HEAD or OPTIONS. */
  private guardsMethod(env: string, method: string): boolean {
    return !!this.environmentSettings(env).production && !SAFE_METHODS.has(verbOf(method));
  }

  /** Asks before sending with production environment `env`. True to go ahead. */
  private async confirmProductionSend(tabId: string, env: string, method: string): Promise<boolean> {
    const verb = verbOf(method);
    this.confirmingSend.add(tabId);
    try {
      const r = await this.choose("Send to production?", `"${env}" is a production environment. Send this ${verb} request anyway?`, [
        { ...CANCEL, focus: true },
        { label: `Send ${verb}`, value: "send", role: "primary", danger: true },
      ]);
      return r.button === "send";
    } finally {
      this.confirmingSend.delete(tabId);
    }
  }

  /** Records the bytes received so far for a send that is still loading; a
   *  late event for a finished or replaced run is ignored. */
  onSendProgress(runId: string, received: number) {
    const run = Object.values(this.runs).find((r) => r.runId === runId);
    if (run?.loading) run.received = received;
  }

  /** Lets the shell drop a response no tab shows any more (closed, replaced or
   *  gone with the workspace); until then it keeps the body for Save, Hex,
   *  Pretty and the filter. A failure only means it was already gone. The
   *  editor documents and the preview made from it go too. */
  private releaseResponse(response: HttpResponse | undefined) {
    if (!response) return;
    dropDocs(response.id);
    api.releaseResponse(response.id).catch(() => {});
  }

  /** Runs the user cancelled; their failure is shown as Cancelled, not as an error. */
  private cancelled = new Set<string>();

  async cancel(tabId: string) {
    const run = this.runs[tabId];
    if (!run?.loading) return;
    this.cancelled.add(run.runId);
    await api.cancelRequest(run.runId);
  }

  // ---------------------------------------------------------------- runs

  /**
   * Runs every request of the file at `path` in order (GLOSSARY "Run"), following it
   * in the Runner panel. Asks first, once each: unanswered Prompt variables, the
   * Production confirmation, and whether to run scripts in an untrusted workspace.
   */
  async runFile(path: string) {
    const doc = await this.loadDoc(path);
    if (!doc) return;
    await this.run(basename(path), this.runEntries(path, doc));
  }

  /**
   * Runs every request of every `.http` file under the folder at `path`, subfolders
   * included, in the order the explorer shows them; each file's requests in file
   * order. Global variables and cookies carry from file to file; Request variables
   * don't, since they belong to their file. Asks first as `runFile` does.
   */
  async runFolder(path: string) {
    const folder = this.tree && findNode(this.tree, path);
    if (!folder) return;
    await this.run(basename(path), await this.entriesOf(treeFiles(folder)));
  }

  /**
   * Runs the requests selected in the explorer (`selectedRequests`), across files if
   * need be, in the order the explorer shows them. Asks first as `runFile` does.
   */
  async runSelection() {
    const picked = this.selectedRequests;
    const order = new Map((this.tree ? treeFiles(this.tree) : []).map((path, i) => [path, i]));
    const rank = (path: string) => order.get(path) ?? order.size;
    const paths = [...new Set(picked.map((r) => r.path))].sort((a, b) => rank(a) - rank(b));
    const entries = await this.entriesOf(paths, (path, key) => picked.some((r) => r.path === path && r.key === key));
    await this.run(`${entries.length} selected ${entries.length === 1 ? "request" : "requests"}`, entries);
  }

  /** The run entries of each file of `paths` in turn, loading the ones not loaded yet;
   *  `keep` picks which requests of a file go in. A file that won't load is left out. */
  private async entriesOf(paths: string[], keep: (path: string, key: string) => boolean = () => true): Promise<RunEntry[]> {
    const docs = await Promise.all(paths.map((p) => this.loadDoc(p)));
    return paths.flatMap((p, i) => {
      const doc = docs[i];
      return doc ? this.runEntries(p, doc).filter((e) => keep(p, e.key)) : [];
    });
  }

  /** The requests selected in the explorer: those picked, else the active request. */
  get selectedRequests(): RequestRef[] {
    if (this.treeSelection.length) return this.treeSelection;
    const tab = this.activeTab;
    return tab ? [{ path: tab.path, key: tab.key }] : [];
  }

  /** Whether the explorer shows the request as selected. */
  isTreeSelected(path: string, key: string): boolean {
    return this.selectedRequests.some((r) => r.path === path && r.key === key);
  }

  /**
   * Selects a request in the explorer. `only`: a plain click, which goes back to
   * selecting just the active request. `toggle` (⌘/Ctrl-click, Space): adds or removes
   * it, keeping what's selected, the active request included. `range` (Shift-click,
   * Shift+arrows): selects the requests the explorer shows from the last one clicked
   * or toggled (else `start`, else the active request) to this one.
   */
  selectRequest(path: string, key: string, how: "only" | "toggle" | "range", start?: RequestRef) {
    const ref = { path, key };
    if (how === "only") {
      this.treeSelection = [];
    } else if (how === "range") {
      const anchor = this.selectionAnchor ?? start ?? this.selectedRequests[0] ?? ref;
      const rows = this.shownRequests();
      const at = (r: RequestRef) => rows.findIndex((x) => x.path === r.path && x.key === r.key);
      const [from, to] = [at(anchor), at(ref)];
      this.treeSelection = from < 0 || to < 0 ? [ref] : rows.slice(Math.min(from, to), Math.max(from, to) + 1);
      this.selectionAnchor = from < 0 ? ref : anchor;
      return;
    } else {
      const picked = this.selectedRequests;
      this.treeSelection = this.isTreeSelected(path, key) ? picked.filter((r) => r.path !== path || r.key !== key) : [...picked, ref];
    }
    this.selectionAnchor = ref;
  }

  /** The request rows the explorer shows, top to bottom: those of expanded files in expanded folders. */
  private shownRequests(): RequestRef[] {
    const walk = (n: TreeNode): RequestRef[] => {
      if (!this.expanded[n.path]) return [];
      if (n.kind === "dir") return (n.children ?? []).flatMap(walk);
      return (this.docs[n.path]?.file.requests ?? []).map((r) => ({ path: n.path, key: r._key! }));
    };
    return (this.tree?.children ?? []).flatMap(walk);
  }

  /** Goes back to the explorer selecting just the active request. */
  clearTreeSelection() {
    this.treeSelection = [];
    this.selectionAnchor = null;
  }

  /** Whether a run is under way. */
  get running(): boolean {
    return !!this.runner?.running;
  }

  /** Stops the run, its request in flight included. */
  async stopRun() {
    if (this.runner?.running) await api.cancelRequest(this.runner.runId);
  }

  /** The open workspace's Runner options (the delay, stop on first failure). */
  get runnerOptions(): RunnerOptions {
    return { ...DEFAULT_RUNNER_OPTIONS, ...(this.root ? this.settings?.runnerOptions?.[this.root] : undefined) };
  }

  /** Changes the open workspace's Runner options, remembered for its next runs. */
  async setRunnerOptions(patch: Partial<RunnerOptions>): Promise<boolean> {
    if (!this.root || !this.settings) return false;
    return this.updateSettings({ runnerOptions: { ...this.settings.runnerOptions, [this.root]: { ...this.runnerOptions, ...patch } } });
  }

  /** Whether the last run has finished with failed requests to re-run. */
  get canRerunFailed(): boolean {
    return !!this.runner && !this.runner.running && this.runner.items.some((i) => i.state === "failed");
  }

  /**
   * Re-runs the last run's failed requests, in order, as a new run with the Session as
   * it is now (nothing is rolled back). Each is read again, from its open tab or its
   * file, as any run reads it, so a fix made since is what's sent.
   */
  async rerunFailed() {
    const runner = this.runner;
    if (!runner || !this.canRerunFailed) return;
    const failed = runner.items.filter((i) => i.state === "failed");
    const entries: RunEntry[] = [];
    for (const item of failed) {
      const doc = await this.loadDoc(item.path);
      const entry = doc && this.runEntries(item.path, doc).find((e) => e.key === item.key);
      if (entry) entries.push(entry);
    }
    await this.run(runner.title.endsWith(FAILED_SUFFIX) ? runner.title : `${runner.title}${FAILED_SUFFIX}`, entries);
  }

  /**
   * The requests of `doc` a run sends, in order: from the open tab's edits when the
   * request is open, otherwise as in the file on disk (its saved snapshot). A request
   * that isn't open and was never saved isn't in the file, so it isn't sent.
   */
  private runEntries(path: string, doc: Doc): RunEntry[] {
    const args = { filePath: path, fileVariables: $state.snapshot(fileVariables(doc.file)), requestNames: requestNames(doc.file) };
    return doc.file.requests.flatMap((req) => {
      const key = req._key!;
      const open = this.tabs.some((t) => t.path === path && t.key === key);
      const saved = doc.saved[key];
      if (!open && saved === undefined) return [];
      const request = open ? ($state.snapshot(req) as Request) : (JSON.parse(saved) as Request);
      return [{ path, key, unsaved: open && this.isRequestDirty(path, key), args: { ...args, request, requestKey: key } }];
    });
  }

  /** Asks what a run needs to know up front, then runs `entries` (see `runFile`). */
  private async run(title: string, entries: RunEntry[]) {
    if (this.runner?.running || this.confirmingSend.has(RUN_ASKING)) return;
    if (!entries.length) {
      this.toast("info", `${title} has no requests to run`);
      return;
    }
    let scripts: "run" | "skip" | "cancel" | "none";
    this.confirmingSend.add(RUN_ASKING);
    try {
      if (!(await this.askRunPrompts(entries))) return;
      if (!(await this.confirmProductionRun(entries))) return;
      scripts = entries.some((e) => hasScripts(e.args.request)) ? await this.scriptsAllowed(RUN_ASKING, "run") : "none";
      if (scripts === "cancel") return;
    } finally {
      this.confirmingSend.delete(RUN_ASKING);
    }

    this.releaseRunner();
    const runId = uid();
    this.runner = {
      runId,
      title,
      running: true,
      items: entries.map((e) => ({
        path: e.path,
        key: e.key,
        name: displayName(e.args.request),
        method: verbOf(e.args.request.method),
        unsaved: e.unsaved,
        state: "queued",
      })),
    };
    this.panel = "runner";
    try {
      await api.runRequests({
        runId,
        selection: { requests: entries.map((e) => e.args), environment: this.envName },
        options: { skipScripts: scripts === "skip", ...this.runnerOptions },
      });
    } catch (e) {
      this.toast("error", errorMessage(e));
    } finally {
      const runner = this.runner;
      if (runner?.runId === runId) {
        runner.running = false;
        for (const item of runner.items) {
          if (item.state === "queued") item.state = "notRun";
          else if (item.state === "sending") item.state = "cancelled";
        }
      }
    }
  }

  /**
   * Asks, in one form, for every Prompt variable of the run's requests that the Session
   * has no answer for, each name once, and has the Session remember the answers for
   * each request that asks for it. False if the user cancelled.
   */
  private async askRunPrompts(entries: RunEntry[]): Promise<boolean> {
    const unanswered: { entry: RunEntry; names: string[] }[] = [];
    const fields = new Map<string, DialogField>();
    for (const entry of entries) {
      const prompts = requestPrompts(entry.args.request);
      if (!prompts.length) continue;
      const remembered = await api.promptAnswers(entry.key);
      const asked = prompts.filter((p) => !Object.hasOwn(remembered, p.name));
      if (!asked.length) continue;
      unanswered.push({ entry, names: asked.map((p) => p.name) });
      for (const p of asked) {
        const field = fields.get(p.name);
        if (!field) fields.set(p.name, { label: p.name, help: p.description, masked: promptMasked(p.name), value: "" });
        else if (!field.help) field.help = p.description;
      }
    }
    if (!fields.size) return true;
    const asked = [...fields.values()];
    const r = await this.openDialog({
      title: asked.length === 1 ? `Value for "${asked[0].label}"` : "Values for this run",
      message: "Asked once for the whole run, then remembered for each request that asks for it until you open another workspace or quit. Never saved.",
      fields: asked,
      buttons: [CANCEL, { label: "Run", value: "run", role: "primary" }],
    });
    if (r.button !== "run") return false;
    const values = Object.fromEntries(asked.map((f, i) => [f.label, r.values[i] ?? ""]));
    for (const { entry, names } of unanswered) {
      await api.answerPrompts(entry.key, Object.fromEntries(names.map((n) => [n, values[n]])));
    }
    this.sessionVersion++;
    return true;
  }

  /**
   * With a Production environment selected, asks once before a run that sends anything
   * but GET, HEAD or OPTIONS with it, listing those requests. True to go ahead.
   */
  private async confirmProductionRun(entries: RunEntry[]): Promise<boolean> {
    const guarded = entries.flatMap((e) => {
      const env = this.sentEnvironment(e.path);
      return env && this.guardsMethod(env, e.args.request.method) ? [{ env, line: `${verbOf(e.args.request.method)} ${displayName(e.args.request)}` }] : [];
    });
    if (!guarded.length) return true;
    const envs = joinAnd([...new Set(guarded.map((g) => `"${g.env}"`))]);
    const r = await this.choose(
      "Run against production?",
      `${envs} ${guarded.length > 1 && envs.includes(" and ") ? "are production environments" : "is a production environment"}. This run sends:\n${guarded.map((g) => `• ${g.line}`).join("\n")}`,
      [
        { ...CANCEL, focus: true },
        { label: "Run", value: "run", role: "primary", danger: true },
      ],
    );
    return r.button === "run";
  }

  /** Applies a `run-progress` event to the run it belongs to; one for a replaced run only lets go of its response. */
  onRunProgress(p: RunProgress) {
    const item = this.runner?.runId === p.runId ? this.runner.items[p.index] : undefined;
    if (!item) {
      if (p.state === "sent") this.releaseResponse(p.response);
      return;
    }
    switch (p.state) {
      case "sending":
        item.state = "sending";
        break;
      case "sent":
        item.state = p.failed ? "failed" : "passed";
        item.response = p.response;
        this.markTests(item.key, p.response.tests);
        // Its exchange, Global variables and cookies are now the Session's latest.
        this.sessionVersion++;
        break;
      case "failed":
        item.state = "failed";
        item.error = toSendError(p.error);
        this.clearTestMark(item.key);
        break;
      case "cancelled":
        item.state = "cancelled";
        break;
    }
  }

  /** Lets the shell drop the last run's responses (a new run, or another workspace). */
  private releaseRunner() {
    for (const item of this.runner?.items ?? []) this.releaseResponse(item.response);
  }

  // ---------------------------------------------------------------- environments

  async loadEnvironments() {
    if (!this.root) return;
    try {
      this.envSet = await api.loadEnvironments();
    } catch (e) {
      this.envSet = { shared: [], environments: [], privateFileIgnored: null };
      this.toast("error", errorMessage(e));
    }
    try {
      this.envFolders = await api.loadFolderEnvironments();
    } catch (e) {
      this.envFolders = [];
      this.toast("error", errorMessage(e));
    }
    if (this.envName && !this.envNames.includes(this.envName)) this.envName = null;
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

  /** The settings of an environment of the open workspace (production, colour). */
  environmentSettings(name: string): EnvironmentSettings {
    return (this.root && this.settings?.environmentSettings?.[this.root]?.[name]) || {};
  }

  /** The open workspace's Environments matrix column widths (empty: every column at its default). */
  matrixWidths(): MatrixWidths {
    return (this.root && this.settings?.envMatrixWidths?.[this.root]) || { columns: {} };
  }

  /** Remembers a matrix column's width for the open workspace: `column` is `$shared` or an environment's name, null for the Variable column. */
  async saveMatrixWidth(column: string | null, width: number): Promise<boolean> {
    if (!this.root || !this.settings) return false;
    const current = this.matrixWidths();
    const next: MatrixWidths = column === null ? { ...current, variable: width } : { ...current, columns: { ...current.columns, [column]: width } };
    return this.updateSettings({ envMatrixWidths: { ...this.settings.envMatrixWidths, [this.root]: next } });
  }

  /** A renamed environment's matrix column keeps its width: environment `to` gets `from`'s.
   *  `from` keeps it too, as another folder may still have an environment of that name;
   *  `keepMatrixWidths` drops it when saved if none does. */
  async carryMatrixWidth(from: string, to: string): Promise<boolean> {
    const width = this.matrixWidths().columns[from];
    return width === undefined || this.saveMatrixWidth(to, width);
  }

  /** Drops the open workspace's matrix widths of environments not in `names` (as production
   *  and colour are dropped when saved); Shared's and the Variable column's stay. */
  async keepMatrixWidths(names: string[]): Promise<boolean> {
    if (!this.root || !this.settings) return false;
    const current = this.matrixWidths();
    const keep = new Set([SHARED, ...names]);
    const columns = Object.fromEntries(Object.entries(current.columns).filter(([column]) => keep.has(column)));
    if (Object.keys(columns).length === Object.keys(current.columns).length) return true;
    return this.updateSettings({ envMatrixWidths: { ...this.settings.envMatrixWidths, [this.root]: { ...current, columns } } });
  }

  /** The selected environment's colour, if it has one. */
  envColor = $derived<EnvColor | null>(this.envName ? envColor(this.environmentSettings(this.envName).color) : null);

  /** Replaces the open workspace's environment settings, leaving out
   *  environments with nothing set. False if the save failed (it was reported). */
  async saveEnvironmentSettings(byName: Record<string, EnvironmentSettings>): Promise<boolean> {
    if (!this.root || !this.settings) return false;
    const kept: Record<string, EnvironmentSettings> = {};
    for (const [name, s] of Object.entries(byName)) {
      const color = envColor(s.color);
      if (s.production || color) kept[name] = { ...(s.production ? { production: true } : {}), ...(color ? { color } : {}) };
    }
    const all = { ...this.settings.environmentSettings };
    if (Object.keys(kept).length) all[this.root] = kept;
    else delete all[this.root];
    return this.updateSettings({ environmentSettings: all });
  }

  /** Opens the Settings modal, scrolled to `section` if given. */
  openSettings(section: SettingsSection | null = null) {
    this.settingsSection = section;
    this.modal = "settings";
  }

  /** Opens the row of a variable's definition (a hover card's Edit): a File
   *  variable at the top of the file in the tab's Settings section, one declared in a
   *  request at its line in that request's `.http` source (`showDeclaration`), or an
   *  environment's variable in the Environments modal, on that environment. With `add`
   *  (the Undefined-variable strip's "Add …" fixes), an empty one is added there first. */
  async editDefinition(tabId: string, definition: WantedDefinition) {
    if (definition.kind === "request") return this.showDeclaration(tabId, definition.name);
    this.definitionWanted = definition;
    if (definition.kind === "file") this.showRequestSettings(tabId);
    else this.modal = "env";
  }

  /** Shows the `@name` line in use for the tab's request in its request's `.http` source:
   *  the request's own (the last, if repeated), else the last request in the file declaring it. */
  private async showDeclaration(tabId: string, name: string) {
    const tab = this.tabs.find((t) => t.id === tabId);
    const doc = tab && this.docs[tab.path];
    const own = this.requestFor(tab ?? null);
    if (!tab || !doc || !own) return;
    const declares = (r: Request) => r.variables.some((v) => v.name === name);
    const req = declares(own) ? own : doc.file.requests.filter(declares).at(-1);
    if (!req) return;
    if (req !== own) await this.openRequest(tab.path, { key: req._key });
    const index = req.variables.map((v) => v.name).lastIndexOf(name);
    if (this.activeTab) this.fieldWanted = { tabId: this.activeTab.id, field: { kind: "variable", index, name } };
  }

  /** Shows or hides the `.http` source in the tab's request editor. */
  toggleSource(tabId: string) {
    this.sourceShownFor = this.sourceShownFor === tabId ? null : tabId;
  }

  /** Switches the tab's request editor to its Settings section (timeouts). */
  showRequestSettings(tabId: string) {
    this.requestSettingsFor = tabId;
  }

  /** Opens the environment picker in the top bar. */
  chooseEnvironment() {
    this.envPickerWanted = true;
  }

  /** Tells the user that folder `dir`'s private env file was added to `.gitignore` (a save or an import did it). */
  gitignoreUpdated(dir: string) {
    this.toast("info", `Added ${dir ? `${dir}/` : ""}http-client.private.env.json to .gitignore`);
  }

  /** Saves an environment set as folder `dir`'s own pair (the Environments modal's Save, and
   *  the store's own changes: env files have no unsaved state of their own) and reloads the
   *  environments. False if the save failed (it was reported). */
  async writeEnvironments(set: EnvironmentSet, dir = ""): Promise<boolean> {
    try {
      const report = await api.saveEnvironments(set, dir);
      if (report.gitignoreUpdated) this.gitignoreUpdated(dir);
    } catch (e) {
      this.toast("error", `Could not save environments: ${errorMessage(e)}`);
      return false;
    }
    await this.loadEnvironments();
    return true;
  }

  /** A copy of folder `dir`'s own pair of env files to change (the root's as loaded, a
   *  nested folder's read from disk). Null if it can't be read (that's reported). */
  private async folderPair(dir: string): Promise<EnvironmentSet | null> {
    if (!dir && this.envSet) return $state.snapshot(this.envSet) as EnvironmentSet;
    try {
      return await api.loadEnvironments(dir);
    } catch (e) {
      this.toast("error", `Could not read the environments of ${folderLabel(dir)}: ${errorMessage(e)}`);
      return null;
    }
  }

  // ---------------------------------------------------------------- rename variable

  /**
   * Rename variable on environment variable `name` of folder `dir`'s env files (the
   * Environments modal's folder; the root's by default): asks for the new name and
   * whether to update references (`RenameVariable.svelte`), then renames it in
   * every environment of that folder's pair through the normal environment save,
   * and rewrites the references the rename covers (`renameTargets`): values in that
   * pair, and `.http` files in or below `dir` that don't get the name from a nearer
   * folder's env files (ADR-0004). A file with no unsaved edits is saved at once; one
   * with unsaved edits gets the rename in memory only and stays unsaved, so the
   * user's pending work isn't saved without them. The env files are saved first; if
   * that fails, nothing else changes. False if cancelled or the env files couldn't be saved.
   */
  async renameVariable(name: string, dir = ""): Promise<boolean> {
    const choice = await this.renameForm.ask({ name, dir });
    if (!choice) return false;
    const { name: next } = choice;
    const usages = choice.usages ? await this.renameTargets(name, dir, choice.usages) : [];
    const set = await this.folderPair(dir);
    if (!set) return false;
    renameInEnvironments(set, usages, name, next);
    if (!(await this.writeEnvironments(set, dir))) return false;

    const byFile = new Map<string, Usage[]>();
    for (const u of usages) if (u.kind !== "environment") byFile.set(u.path, [...(byFile.get(u.path) ?? []), u]);
    let edited = 0;
    const unsaved: string[] = [];
    for (const [path, list] of byFile) {
      const doc = await this.loadDoc(path);
      if (!doc || doc.missing) continue;
      const wasClean = !this.isDocDirty(path);
      renameInFile(doc.file, list, name, next);
      edited++;
      if (!wasClean) unsaved.push(basename(path));
      else await this.save(path); // a failure is reported; the rename stays on screen, unsaved
    }
    if (this.usages?.name === name) this.closeUsages();

    let message = `Renamed ${name} to ${next} in every environment${dir ? ` of ${dir}/` : ""}`;
    if (edited) message += ` and ${edited} file${edited === 1 ? "" : "s"}`;
    message += ".";
    if (unsaved.length) message += ` ${joinAnd(unsaved)} had unsaved edits, so ${unsaved.length === 1 ? "it was" : "they were"} left unsaved.`;
    this.toast("success", message);
    return true;
  }

  /** What the Rename variable form shows for `name` in folder `dir`'s env files: that pair
   *  (for the name check) and the usages renaming it would rewrite (`renameTargets`). */
  async renamePlan(name: string, dir: string): Promise<{ pair: EnvironmentSet; usages: Usage[] }> {
    const [pair, usages] = await Promise.all([this.folderPair(dir), this.searchUsages(name)]);
    if (!pair) throw new Error(`Could not read the environments of ${folderLabel(dir)}`);
    return { pair, usages: await this.renameTargets(name, dir, usages) };
  }

  /** The usages of `name` a rename in folder `dir`'s env files rewrites (`renameScope`):
   *  folders below `dir` whose own env files define `name` too keep theirs. */
  private async renameTargets(name: string, dir: string, usages: Usage[]): Promise<Usage[]> {
    const shadowing: string[] = [];
    for (const { dir: below } of this.envFolders) {
      if (below === dir || !within(below, dir)) continue;
      const pair = await this.folderPair(below);
      if (pair && definesVariable(pair, name)) shadowing.push(below);
    }
    return renameScope(usages, { root: this.root ?? "", dir, shadowing });
  }

  /** Answers the Rename variable form on screen (null: cancelled). */
  closeRenaming(choice: RenameChoice | null) {
    this.renameForm.answer(choice);
  }

  // ---------------------------------------------------------------- extract to variable

  /**
   * Extract to variable on `value`, text selected in a field of the tab's
   * request: asks for a name and where it goes, and defines it there. Returns the
   * name for the field to put `{{name}}` in place of its selection, or null if
   * the user cancelled or the definition couldn't be written.
   */
  async extractVariable(tabId: string, value: string): Promise<string | null> {
    const choice = await this.extractForm.ask({ tabId, value });
    if (!choice) return null;
    const { name, target } = choice;
    const tab = this.tabs.find((t) => t.id === tabId);
    if (target.kind !== "file") return tab && (await this.extractToEnvironments(tab.path, target, name, value)) ? name : null;
    const doc = tab && this.docs[tab.path];
    if (!tab || !doc) return null;
    extractToFile(doc.file, this.requestFor(tab), name, value);
    return name;
  }

  /** Writes an extracted variable to the env files right away (they have no unsaved state):
   *  for each target environment of the request in the file at `path`, the pair of
   *  files of the folder that supplies it to that request (`writeFolder`). */
  private async extractToEnvironments(path: string, target: ExtractTarget, name: string, value: string): Promise<boolean> {
    const effective = this.envSetFor(path);
    if (!effective) return false;
    const envs = targetEnvironments(target, effective);
    const byFolder = new Map<string, string[]>();
    for (const env of envs) {
      const dir = this.envWriteFolder(path, env, name);
      byFolder.set(dir, [...(byFolder.get(dir) ?? []), env]);
    }
    for (const [dir, names] of byFolder) {
      const set = await this.folderPair(dir);
      if (!set) return false;
      // An environment the folder's own files don't have yet is added there.
      for (const env of names) if (!set.environments.some((e) => e.name === env)) set.environments.push({ name: env, variables: [] });
      extractToEnvironments(set, names, name, value);
      if (!(await this.writeEnvironments(set, dir))) return false;
    }
    this.toast("success", target.kind === "all" ? `Added ${name} to every environment` : `Added ${name} to ${envs[0]}`);
    return true;
  }

  /** The folder whose own env files a value of `name` in `env` goes to, for the request in
   *  the file at `path`: where its environments say (`writeFolder`), else the nearest folder
   *  with env files at or above the request's (where the Environments modal opens for it). */
  envWriteFolder(path: string, env: string, name: string): string {
    return writeFolder(this.envSetFor(path), env, name) ?? this.envFolderFor(path);
  }

  /** The nearest folder with env files at or above the file at `path`'s ("" for the root). */
  envFolderFor(path: string): string {
    return nearestEnvFolder(this.envFolders, this.folderOf(path));
  }

  /** Answers the Extract to variable form on screen (null: cancelled). */
  closeExtraction(choice: ExtractChoice | null) {
    this.extractForm.answer(choice);
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
  private openDialog(d: Omit<DialogState, "resolve">): Promise<{ button: string; value: string; values: string[] }> {
    return new Promise((resolve) => {
      const next = { ...d, resolve };
      if (this.dialog) this.dialogQueue.push(next);
      else this.dialog = next;
    });
  }

  async choose(title: string, message: string, buttons: DialogButton[]): Promise<{ button: string; value: string }> {
    const { button, value } = await this.openDialog({ title, message, buttons });
    return { button, value };
  }

  async prompt(title: string, value: string, placeholder?: string, selectStem = false): Promise<string | null> {
    const r = await this.openDialog({
      title,
      input: { value, placeholder, selectStem },
      buttons: [
        CANCEL,
        { label: "OK", value: "ok", role: "primary" },
      ],
    });
    return r.button === "ok" ? r.value : null;
  }

  /** Answers the dialog on screen (`values`: its form fields, in order) and shows the next queued one, if any. */
  closeDialog(button: string, value = "", values: string[] = []) {
    const d = this.dialog;
    this.dialog = this.dialogQueue.shift() ?? null;
    d?.resolve({ button, value, values });
  }
}

export const app = new AppStore();
