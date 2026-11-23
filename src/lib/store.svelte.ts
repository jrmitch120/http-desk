// Global application state (Svelte 5 runes). Documents are parsed `.http`
// files; tabs point at a request inside a document by a frontend-only key.
import { untrack } from "svelte";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, errorMessage, type RequestArgs, type RunExportFormat } from "./api";
import { basename, dirname, displayName, fileVariables, getDirective, hasScripts, joinAnd, joinPath, nameError, newRequest, promptMasked, requestNames, requestPrompts, uid, verbOf } from "./http";
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
import type { PortabilitySettings } from "./checks";
import { SHARED } from "./vars";
import { wording } from "./platform";
import { CANCEL, type DialogAnswer, type DialogButton, type DialogState } from "./dialog";
import { SessionStore, type SessionHost, type TestMark } from "./session.svelte";
import { HistoryStore, historyLink, historyLinkKey, type HistoryHost } from "./history.svelte";
import { Trust, type TrustHost } from "./trust";
import { RunnerStore, type Runner, type RunnerHost } from "./runner.svelte";
import { treeFiles } from "./tree";
import { carryKeys, reattach, signature, type KnownRequest } from "./reattach";
import { LayoutStore, type LayoutHost } from "./layoutStore.svelte";
import { docSnapshot, fileShot, kept, restShot, snapshot } from "./snapshots.svelte";
import { forgetEditors } from "./editorMemory";
import { fileEdit, fileView, sourceEdit, sourceView, TextViews, type FileEdit, type SourceEdit, type TextViewsHost, type UnparsedText } from "./textViews.svelte";
import { WorkspaceProblems, type ProblemsHost } from "./workspaceProblems.svelte";
import { isRequestTab, newFileTab, newTab, type RequestSection, type RequestTab, type Tab } from "./tabView";
import type {
  AppSettings,
  EnvironmentSet,
  ExchangeShape,
  EnvironmentSettings,
  MatrixWidths,
  RunnerOptions,
  FolderEnvironments,
  HistoryBodyKept,
  HttpFile,
  HttpResponse,
  NamedExchange,
  ParsedFile,
  ParsedRequest,
  PortabilityMark,
  Problem,
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
  /** The rest of the file as last loaded/saved (`fileShot`'s `rest`): the text after its last request, its line ending and byte order mark. */
  savedRest: string;
  externalChange: boolean;
  missing: boolean;
  /** Requests of Orphaned tabs: gone from the file on disk but still open, with
   *  their edits. Saving appends them back to the file (see `save`). */
  orphans: Request[];
  /** Per request key: the text the user typed in its Source view (textViews.svelte.ts). */
  sources: Record<string, SourceEdit>;
  /** The text the user typed in the file's file view, and the file it goes with (textViews.svelte.ts). */
  fileText: FileEdit | null;
}

/** An answer to `AppStore.askWhatToKeep`. */
export type KeepChoice = "written" | "revert" | "cancel";

export type { RequestTab, Tab } from "./tabView";
export type { TextView, TypedText, UnparsedText, ViewLock } from "./textViews.svelte";

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
  /** For a History entry's response: how much of its body History kept. */
  bodyKept?: HistoryBodyKept;
  /** A response restored from History (not sent in this Session): when its entry was sent. */
  fromHistory?: string;
}

export type { Runner, RunItem, RunItemState } from "./runner.svelte";


export interface Toast {
  id: string;
  kind: "info" | "success" | "error";
  message: string;
  /** Hovered or has selected text: not auto-dismissed (see `holdToast`). */
  held?: boolean;
}

export { CANCEL, type DialogButton, type DialogField, type DialogState } from "./dialog";

/** A definition's row to open; with `add`, one with an empty value is added if there's none. */
export type WantedDefinition = Definition & { add?: boolean };

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
export type PanelId = "session" | "runner" | "problems";
/** What the sidebar shows (`Sidebar.svelte`): the Explorer, or the workspace's History. */
export type SidebarView = "explorer" | "history";
/** A section of the Settings modal that can be opened scrolled into view. */
export type SettingsSection = "tls" | "history";

/** Methods that don't change data, so the production guard lets them through. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const keptByKey = new WeakMap<Request[], () => Map<string, Request>>();

/** A document's requests (its state) by key. */
const byKey = (requests: Request[]) => new Map(requests.map((r) => [r._key!, r]));

const keptDirty = new WeakMap<Doc, () => boolean>();
const keptRequestsDirty = new WeakMap<Doc, () => boolean>();
/** A document's requests' keys, in order, joined (as `savedOrder`). */
const keptOrders = new WeakMap<Request[], () => string>();

/** `doc` (a document's state) was edited since loaded or saved. Edits in an Orphaned tab count too: they exist nowhere on disk. */
function docDirty(doc: Doc): boolean {
  if (kept(keptOrders, doc.file.requests, (rs) => rs.map((r) => r._key).join(",")) !== doc.savedOrder) return true;
  if (JSON.stringify(doc.file.header) !== doc.savedHeader) return true;
  // The text after the last request (a file view edit there changes nothing else).
  if (fileShot(doc.file).rest !== doc.savedRest) return true;
  if (fileEdit(doc)?.parses === false) return true;
  // Kept apart, so text typed in the file view doesn't have every request checked again.
  return kept(keptRequestsDirty, doc, (d) => [...d.file.requests, ...d.orphans].some((r) => requestDirty(d, r)));
}

/** `req` (of `doc`) was edited since loaded or saved; source text that doesn't parse counts as an edit. */
function requestDirty(doc: Doc, req: Request): boolean {
  const shot = docSnapshot(req);
  return doc.saved[req._key!] !== shot || sourceEdit(doc, req, shot)?.parses === false;
}

const ensureKey = (r: Request) => {
  if (!r._key) r._key = uid();
  return r._key;
};

/** How many closed tabs Reopen Closed Tab remembers. */
const CLOSED_TABS_KEPT = 20;

/** A request in the explorer: its file and its key (`_key`). */
export interface RequestRef {
  path: string;
  key: string;
}

/** A tab the user closed (Reopen Closed Tab): what it showed, and where it sat in the tab bar. */
type ClosedTab = ({ kind: "request" } & RequestRef & { index: number }) | { kind: "file"; path: string; index: number };

class AppStore {
  root = $state<string | null>(null);
  tree = $state<TreeNode | null>(null);
  docs = $state<Record<string, Doc>>({});
  tabs = $state<Tab[]>([]);
  activeTabId = $state<string | null>(null);
  runs = $state<Record<string, RunState>>({});
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
  /** Which Portability notes show, and how (Settings → Portability): an editor's only when its
   *  switch is `true`, as warnings only when that setting is `true`. Missing, or anything else in a
   *  hand-edited settings file: the editor off, notes. */
  portability = $derived<PortabilitySettings>({
    editors: { vscode: this.settings?.portabilityEditors?.vscode === true, rider: this.settings?.portabilityEditors?.rider === true },
    level: this.settings?.portabilityWarnings === true ? "warning" : "note",
  });
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
  /** Set to ask the panel area to put focus in the shown panel's list; it clears this. */
  panelFocusWanted = $state(false);
  /** What the sidebar shows. Not part of the Layout: each start shows the Explorer. */
  sidebarView = $state<SidebarView>("explorer");
  dialog =$state<DialogState | null>(null);
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
  /** Bumped to ask the sidebar's Explorer, or its History list, to take focus (Focus
   *  Explorer, Focus History): on the row last focused, else the list's current row. */
  focusExplorer = $state(0);
  focusHistory = $state(0);
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
    const shown = this.activeTab?.kind === "file" ? basename(this.activeTab.path) : req && displayName(req);
    return [shown, basename(this.root), this.envName].filter(Boolean).join(" — ");
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
      // Saves the open workspace's Layout once its changes settle.
      $effect(() => this.layout.track());
      // The Problems panel reads an open document again once its edits pause.
      $effect(() => this.problems.track());
      // A restored tab loads its last response from History the first time it shows.
      $effect(() => {
        const id = this.activeTabId;
        if (id && this.unshown.delete(id)) untrack(() => void this.showLastResponse(id));
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

  /** Shows the sidebar if it's hidden, on `view`, for what puts its results or focus there
   *  (Search Requests and Find usages, in the Explorer; Focus Explorer and Focus History). */
  showSidebar(view: SidebarView = "explorer") {
    this.sidebarView = view;
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
    // Text typed a moment ago counts: it's read before the documents are asked about.
    const typing = Object.keys(this.docs).filter((p) => this.texts.waiting(p));
    if (typing.length) await Promise.all(typing.map((p) => this.texts.readNow(p)));
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
      if (!(await this.confirmUnsaved())) return false;
      await this.layout.flush();
      return true;
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
    await this.layout.flush();
    try {
      const info = await api.openWorkspace(path);
      // The last workspace's Layout was saved; this one's is saved once it's restored.
      this.layout.reset();
      // The shell started a new Session for it, so nothing from the last one shows.
      this.session.reset();
      this.missingRoot = null;
      if (info.gitignoreUpdated) this.gitignoreUpdated("");
      this.problems.reset();
      this.root = info.root;
      // In the background: the shell reads every file off the main thread.
      void this.problems.scan();
      this.trust.reset();
      this.tree = info.tree;
      // Reads still under way are the last workspace's: none is shared or kept.
      this.opens++;
      this.loading.clear();
      this.docs = {};
      this.tabs = [];
      this.unshown.clear();
      this.closed = [];
      this.history.reset();
      for (const run of Object.values(this.runs)) this.releaseResponse(run.response);
      this.runs = {};
      this.runnerStore.reset();
      if (this.panel === "runner") this.panel = null;
      this.activeTabId = null;
      this.expanded = { [info.root]: true };
      this.clearTreeSelection();
      let restored!: () => void;
      this.restored = new Promise((r) => (restored = r));
      try {
        await this.layout.restore(info.root, info.tree);
      } finally {
        restored();
      }
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
      savedRest: restShot(file),
      externalChange: false,
      missing: false,
      orphans,
      sources: {},
      fileText: null,
    };
  }

  /** The reads of the open workspace's files under way, which a load of the same file shares. */
  private loading = new Map<string, Promise<Doc | null>>();
  /** Goes up as each workspace opens, so a read the last one started knows it's stale. */
  private opens = 0;
  /** Settles once the opening workspace's Layout has started reading its tabs' files. */
  private restored: Promise<void> = Promise.resolve();

  /** Loads (once) and caches a document. Concurrent callers share one read so
   *  request keys stay stable; a second parse would orphan open tabs. While a
   *  workspace opens, it waits for the Layout's reads to start, so a file the
   *  Layout re-attaches tabs to is read by it first. Null if another workspace
   *  opened meanwhile. */
  async loadDoc(path: string): Promise<Doc | null> {
    const open = this.opens;
    await this.restored;
    if (this.opens !== open) return null;
    return this.readDoc(path, { report: true });
  }

  /**
   * `loadDoc`, and a failed read reported only with `report`. With `prepare` (the
   * Layout's restore re-attaching tabs), the file is read afresh, never an earlier
   * read's, and `prepare` sees its requests before they get keys. Null if another
   * workspace opened meanwhile.
   */
  private readDoc(path: string, how: { prepare?: (requests: Request[]) => void; report?: boolean }): Promise<Doc | null> {
    if (!how.prepare) {
      if (this.docs[path]) return Promise.resolve(this.docs[path]);
      const reading = this.loading.get(path);
      if (reading) return reading;
    }
    const open = this.opens;
    const read = async () => {
      try {
        const file = await api.readHttpFile(path);
        if (this.opens !== open) return null;
        how.prepare?.(file.requests);
        this.docs[path] ??= this.makeDoc(path, file);
        return this.docs[path];
      } catch (e) {
        if (how.report && this.opens === open) this.toast("error", errorMessage(e));
        return null;
      }
    };
    // Another workspace's read of the same path may have taken its place meanwhile.
    const pending = read().finally(() => this.loading.get(path) === pending && this.loading.delete(path));
    this.loading.set(path, pending);
    return pending;
  }

  /** Re-reads documents that are already open after the app itself rewrote
   *  them (e.g. OpenAPI regeneration); our own writes produce no watcher event. */
  async reloadOpen(paths: string[]) {
    for (const p of paths) if (this.docs[p]) await this.reload(p);
  }

  /** A request tab's request (a file view has none). */
  requestFor(tab: Tab | null): Request | undefined {
    if (!isRequestTab(tab)) return undefined;
    return this.findRequest(tab.path, tab.key);
  }

  /** A request of the document: in the file, or held by an Orphaned tab. */
  private findRequest(path: string, key: string): Request | undefined {
    const doc = this.docs[path];
    return doc && (kept(keptByKey, doc.file.requests, byKey).get(key) ?? doc.orphans.find((r) => r._key === key));
  }

  /** True for an Orphaned tab: its request is no longer in the file on disk. */
  isOrphaned(tab: Tab): boolean {
    const doc = this.docs[tab.path];
    return !!doc && (doc.missing || (tab.kind === "request" && doc.orphans.some((r) => r._key === tab.key)));
  }

  /** Edited since loaded or saved; source text that doesn't parse counts as an edit too. */
  isRequestDirty(path: string, key: string): boolean {
    const doc = this.docs[path];
    const req = this.findRequest(path, key);
    return !!doc && !!req && requestDirty(doc, req);
  }

  /** Edits in an Orphaned tab count too: they exist nowhere on disk. */
  isDocDirty(path: string): boolean {
    const doc = this.docs[path];
    return !!doc && kept(keptDirty, doc, docDirty);
  }

  dirtyDocs(): string[] {
    return Object.keys(this.docs).filter((p) => this.isDocDirty(p));
  }

  /** Saves the file. Orphaned requests with edits, or listed in `revive`, are
   *  appended to it; unedited ones stay orphaned so a request another editor
   *  removed isn't silently restored. */
  async save(path: string, revive: string[] = []): Promise<boolean> {
    if (!(await this.settleUnparsed([path]))) return false;
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
    return this.save(tab.path, tab.kind === "request" ? [tab.key] : []);
  }

  async saveActive() {
    const tab = this.activeTab;
    if (tab) await this.saveTab(tab);
  }

  /** Saves every unsaved file, after asking about all their text that doesn't parse
   *  (Cancel saves none of them). */
  async saveAll() {
    if (!(await this.settleUnparsed(Object.keys(this.docs)))) return;
    for (const p of this.dirtyDocs()) await this.save(p);
  }

  /**
   * Before `paths` are saved: asks, in turn, what to keep of each text that doesn't
   * parse in their views (`askWhatToKeep`), then applies every answer. False on
   * Cancel, and then nothing changes. Text typed but not yet read is read first.
   */
  async settleUnparsed(paths: string[]): Promise<boolean> {
    await Promise.all(paths.map((p) => this.texts.readNow(p)));
    const answers: [UnparsedText, KeepChoice][] = [];
    for (const text of paths.flatMap((p) => this.texts.unparsed(p))) {
      const choice = await this.askWhatToKeep(text);
      if (choice === "cancel") return false;
      answers.push([text, choice]);
    }
    for (const [text, choice] of answers) {
      if (choice === "written") text.saveAsWritten();
      else text.revert();
    }
    return true;
  }

  /** The Save as written / Revert to last valid dialog for one text that doesn't parse. */
  async askWhatToKeep(text: UnparsedText): Promise<KeepChoice> {
    const revert = { label: "Revert to last valid", value: "revert" };
    if (!text.canSaveAsWritten) {
      const r = await this.choose(
        `Revert "${text.name}" to the last valid ${text.noun}?`,
        `Nothing could be read from its text, so it can't be saved as written. The text you typed is discarded and the last valid ${text.noun} is saved instead. Undo in its editor brings the text back.`,
        [{ ...CANCEL, focus: true }, { ...revert, role: "primary", danger: true }],
      );
      return r.button === "revert" ? "revert" : "cancel";
    }
    if (text.asText) {
      const r = await this.choose(
        `Save "${text.name}" as written?`,
        `Its text has no request line. Save it as written and it stays in the file as text, not a request, and its tab closes. Or revert: the text you typed is discarded and the last valid ${text.noun} is saved. Undo in its editor brings the text back.`,
        [CANCEL, { ...revert, role: "destructive", danger: true }, { label: "Save as written", value: "written", role: "primary" }],
      );
      return r.button === "written" || r.button === "revert" ? r.button : "cancel";
    }
    const r = await this.choose(
      `Save "${text.name}" as written?`,
      `${text.problem ? `${text.problem} ` : "Its text doesn't parse. "}Save it as written, with the lines that don't parse kept as they are, or revert: the text you typed is discarded and the last valid ${text.noun} is saved. Undo in its editor brings the text back.`,
      [CANCEL, { ...revert, role: "destructive", danger: true }, { label: "Save as written", value: "written", role: "primary" }],
    );
    return r.button === "written" || r.button === "revert" ? r.button : "cancel";
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
      const known = (r: Request, position: number | null): KnownRequest => ({ key: r._key!, name: r.name, method: r.method, url: r.url, position });
      const unused = reattach([...old.file.requests.map((r, i) => known(r, i)), ...old.orphans.map((r) => known(r, null))], file.requests);
      const held = new Set(this.tabs.flatMap((t) => (t.kind === "request" && t.path === path ? [t.key] : [])));
      orphans = [...old.file.requests, ...old.orphans].filter((r) => unused.has(r._key!) && held.has(r._key!));
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
      !file.mixedEndings === !doc.file.mixedEndings &&
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
    this.problems.changed(paths);
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
    const want = signature(hit);
    const reqs = doc.file.requests;
    const same = (r: Request | undefined) => !!r && signature({ name: displayName(r), method: r.method, url: r.url }) === want;
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
    let tab = this.tabs.find((t) => t.kind === "request" && t.path === path && t.key === key);
    if (!tab) {
      tab = newTab(path, key);
      const at = this.tabs.findIndex((t) => t.id === this.activeTabId);
      this.tabs.splice(at < 0 ? this.tabs.length : at + 1, 0, tab);
    }
    this.activeTabId = tab.id;
  }

  /** Shows one of a tab's request sections (Params, Headers, …). */
  showSection(tabId: string, section: RequestSection) {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (isRequestTab(tab)) tab.section = section;
  }

  /** Per document, where the tab of each request typed out of its file view sat: it comes back there with the request. */
  private typedOutTabs = new WeakMap<Doc, Map<string, number>>();

  private removeTab(id: string) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [tab] = this.tabs.splice(idx, 1);
    forgetEditors(id);
    this.unshown.delete(id);
    delete this.fileCursors[id];
    this.releaseResponse(this.runs[id]?.response);
    delete this.runs[id];
    this.history.forget(id);
    if (this.activeTabId === id) this.activeTabId = this.tabs[Math.min(idx, this.tabs.length - 1)]?.id ?? null;
    // A file view's text lives only in its tab. An orphaned request lives only in its
    // tabs, and so does the text typed in its Source view.
    const doc = this.docs[tab.path];
    if (!doc) return;
    if (tab.kind === "file") this.texts.drop(tab.path, fileView);
    else if (!this.tabs.some((t) => t.kind === "request" && t.path === tab.path && t.key === tab.key)) {
      doc.orphans = doc.orphans.filter((r) => r._key !== tab.key);
      this.texts.drop(tab.path, sourceView(tab.key));
    }
  }

  /** Closes a tab, asking first if it has unsaved edits. Returns false if it stays open
   *  (the user cancelled or the save failed). */
  async closeTab(id: string): Promise<boolean> {
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return true;
    // Text typed a moment ago counts as an edit: it's read before the tab is asked about.
    if (this.texts.waiting(tab.path)) {
      await this.texts.readNow(tab.path);
      if (!this.tabs.some((t) => t.id === id)) return true;
    }
    const req = this.requestFor(tab);
    if (tab.kind === "file") {
      if (!(await this.closingFileView(tab))) return false;
    } else if (req && this.isRequestDirty(tab.path, tab.key) && !this.texts.blocked(tab.path)) {
      // (While the file view holds text that doesn't parse, the tab just closes: its
      // request's edits stay in the document, which the file view still shows, and
      // reverting them would drop that text unseen, #174.)
      const r = await this.choose(`Save changes to "${displayName(req)}"?`, "Your changes will be lost if you don't save them.", [
        CANCEL,
        { label: "Don't save", value: "discard", role: "destructive", danger: true },
        { label: "Save", value: "save", role: "primary" },
      ]);
      if (r.button === "cancel") return false;
      if (r.button === "save" && !(await this.saveTab(tab))) return false;
      if (r.button === "discard") this.revertRequest(tab.path, tab.key);
    }
    const index = this.tabs.indexOf(tab);
    const was: ClosedTab = tab.kind === "file" ? { kind: "file", path: tab.path, index } : { kind: "request", path: tab.path, key: tab.key, index };
    if (index >= 0) this.closed = [was, ...this.closed].slice(0, CLOSED_TABS_KEPT);
    this.removeTab(id);
    return true;
  }

  /**
   * Before file view `tab` closes: asks what to do with edits that would show nowhere
   * else, the file's when no other tab shows it, or its text that doesn't parse. Don't
   * save reads the file from disk again (or, with other tabs open, drops the text).
   * False if it stays open.
   */
  private async closingFileView(tab: Tab): Promise<boolean> {
    const others = this.tabs.some((t) => t !== tab && t.path === tab.path);
    if (!this.texts.isInvalid(tab.path, fileView) && (others || !this.isDocDirty(tab.path))) return true;
    // With other tabs open only the text here that doesn't parse goes: their edits stay in the document.
    const lost = others ? "The text typed here doesn't parse, and is discarded if you don't save it. Edits made in the file's request tabs stay." : "Your changes will be lost if you don't save them.";
    const r = await this.choose(`Save changes to ${basename(tab.path)}?`, lost, [
      CANCEL,
      { label: "Don't save", value: "discard", role: "destructive", danger: true },
      { label: "Save", value: "save", role: "primary" },
    ]);
    if (r.button === "cancel") return false;
    if (r.button === "save") return this.save(tab.path);
    this.texts.drop(tab.path, fileView);
    if (!others) await this.reload(tab.path);
    return true;
  }

  /** Closes tabs one after another (Close all / Close others), asking about each
   *  unsaved one in turn. Stops at the first tab that stays open; the rest stay too. */
  async closeTabs(ids: string[]): Promise<boolean> {
    for (const id of ids) if (!(await this.closeTab(id))) return false;
    return true;
  }

  /** The tabs the user closed in this workspace, the last closed first: each one's
   *  request (or file, for a file view) and where it sat in the tab bar. In memory only. */
  private closed = $state<ClosedTab[]>([]);

  /** Whether Reopen Closed Tab has a tab to reopen. */
  get canReopenTab(): boolean {
    return this.closed.length > 0;
  }

  /**
   * Reopens the last closed tab where it sat, at the request it was on, made
   * active. One whose request is gone from its file is skipped, and the one
   * closed before it reopens instead. Closing released its response (ADR-0006),
   * so it shows its last response from History instead.
   */
  reopenClosedTab() {
    while (this.closed.length) {
      const [was, ...rest] = this.closed;
      const { path, index } = was;
      this.closed = rest;
      const doc = this.docs[path];
      if (!doc || doc.missing || (was.kind === "request" && !doc.file.requests.some((r) => r._key === was.key))) continue;
      let tab = this.tabs.find((t) => t.path === path && (t.kind === "file" ? was.kind === "file" : was.kind === "request" && t.key === was.key));
      if (!tab && was.kind === "file") {
        tab = newFileTab(path);
        this.tabs.splice(Math.min(index, this.tabs.length), 0, tab);
      } else if (!tab && was.kind === "request") {
        tab = newTab(path, was.key);
        this.tabs.splice(Math.min(index, this.tabs.length), 0, tab);
        void this.showLastResponse(tab.id);
      }
      if (!tab) continue;
      this.activeTabId = tab.id;
      return;
    }
  }

  /** Restored tabs (Layout restore) not shown yet: each loads its last response when it first shows. */
  private unshown = new Set<string>();
  /** By tab id, what settles once a restored tab has re-attached to its request (or been dropped). */
  private reattaching = new Map<string, Promise<void>>();

  /**
   * Shows tab `tabId`'s last response from History (a restored or reopened tab),
   * unless it has closed or sent meanwhile. It goes into `runs`, so closing the tab
   * releases it (ADR-0006), but not into the Session (ADR-0009).
   */
  private async showLastResponse(tabId: string) {
    await this.reattaching.get(tabId);
    const tab = this.tabs.find((t) => t.id === tabId);
    const req = this.requestFor(tab ?? null);
    if (!tab || !req) return;
    const last = await this.history.lastResponse(tab.path, req);
    if (!last) return;
    if (this.runs[tabId] || !this.tabs.some((t) => t.id === tabId)) {
      this.releaseResponse(last.response);
      return;
    }
    this.runs[tabId] = { runId: uid(), ...last };
  }

  revertRequest(path: string, key: string) {
    const doc = this.docs[path];
    if (!doc || this.refused(path)) return;
    this.texts.drop(path, sourceView(key));
    const idx = doc.file.requests.findIndex((r) => r._key === key);
    if (idx < 0) return;
    if (doc.saved[key]) {
      doc.file.requests[idx] = { ...JSON.parse(doc.saved[key]), _key: key };
    } else {
      doc.file.requests.splice(idx, 1); // never saved
    }
  }

  /**
   * Restore request: a History entry's source text (the request as written at send
   * time, `{{variables}}` and all) replaces request `key` of `path` as unsaved edits,
   * and its tab shows. With no `key` (from the sidebar's History), it replaces the
   * request of the file the entry links to (`historyLinkKey`: by `# @name`, else method
   * and URL as written). A request no longer in the file comes back as a new unsaved
   * request at its end. Nothing is written until the file is saved.
   */
  async restoreRequest(path: string, key: string | null, source: string) {
    let restored: Request | null;
    try {
      restored = (await api.parseRequest(source)).request;
    } catch (e) {
      this.toast("error", errorMessage(e));
      return;
    }
    if (!restored) return this.toast("error", "This History entry has no request to restore");
    const doc = await this.loadDoc(path);
    if (!doc) return;
    // An entry sent from a file with mixed line endings keeps its text's `\r\n`s. Put
    // into a file that has one ending, they'd be written beside the file's own: read
    // with `\n`, the request takes the file's ending like the rest of it.
    if (!doc.file.mixedEndings && source.includes("\r\n")) {
      restored = (await api.parseRequest(source.replaceAll("\r\n", "\n")).catch(() => null))?.request ?? restored;
    }
    const linked = historyLinkKey(path, historyLink(path, restored));
    const at = doc.file.requests.findIndex((r) => (key === null ? historyLinkKey(path, historyLink(path, r)) === linked : r._key === key));
    if (this.refused(path, at >= 0 ? [doc.file.requests[at]._key!] : [])) return;
    const req: Request = { ...restored, leading: "", _key: at >= 0 ? doc.file.requests[at]._key! : uid() };
    if (at >= 0) {
      // Text that preceded the request in its file stays as it is.
      doc.file.requests[at] = { ...req, leading: doc.file.requests[at].leading };
    } else {
      doc.file.requests.push(req);
    }
    await this.openRequest(path, { key: req._key });
  }

  // ---------------------------------------------------------------- file view

  /** A file view asked to show a line (`openFileView`), until it has. */
  fileLineWanted = $state<{ tabId: string; line: number; column?: number } | null>(null);
  /** A file view asked to show a request (`openFileView`), until it has. */
  fileRequestWanted = $state<{ tabId: string; key: string } | null>(null);

  /**
   * Opens the file at `path` as one text (its file view, a tab of its own; the one
   * already open, if there is one), made active. With `line` (1-based), the view
   * scrolls that line into view with the caret on it (at character `column`, or its
   * start); with `key`, it shows that request.
   */
  async openFileView(path: string, at: { line?: number; column?: number; key?: string } = {}) {
    const doc = await this.loadDoc(path);
    if (!doc) return;
    let tab = this.tabs.find((t) => t.kind === "file" && t.path === path);
    if (!tab) {
      tab = newFileTab(path);
      const i = this.tabs.findIndex((t) => t.id === this.activeTabId);
      this.tabs.splice(i < 0 ? this.tabs.length : i + 1, 0, tab);
    }
    this.activeTabId = tab.id;
    if (at.line) this.fileLineWanted = { tabId: tab.id, line: at.line, column: at.column };
    if (at.key) this.fileRequestWanted = { tabId: tab.id, key: at.key };
  }

  /** The request under each file view's cursor (by tab id): its place among the requests of the text shown, null outside one. */
  private fileCursors = $state<Record<string, number | null>>({});

  /**
   * The file view `tabId` has its cursor in the `index`th request of its text (0-based),
   * or in none. That request is the explorer's selection while the view is active, and
   * the one Send sends from it.
   */
  setFileCursor(tabId: string, index: number | null) {
    this.fileCursors[tabId] = index;
  }

  /**
   * The key of the request under file view `tab`'s cursor: none outside a request, or
   * while the text doesn't parse (the file's requests are then as they last read, not
   * those of the text shown).
   */
  private requestUnderCursor(tab: Tab): string | null {
    const index = this.fileCursors[tab.id];
    if (tab.kind !== "file" || index === null || index === undefined || this.texts.isInvalid(tab.path, fileView)) return null;
    return this.docs[tab.path]?.file.requests[index]?._key ?? null;
  }

  /**
   * Sends the request under file view `tab`'s cursor the way its own tab sends it
   * (opened, made active, and its response shown there), once the text typed in the
   * view is read.
   */
  private async sendUnderCursor(tab: Tab) {
    if (this.texts.waiting(tab.path, fileView)) await this.texts.readNow(tab.path, fileView);
    if (this.texts.isInvalid(tab.path, fileView)) {
      this.toast("error", `The text in ${basename(tab.path)}'s file view doesn't parse. Fix the text to send a request from it.`);
      return;
    }
    const key = this.requestUnderCursor(tab);
    if (!key) {
      this.toast("info", "Put the cursor in a request to send it.");
      return;
    }
    await this.openRequest(tab.path, { key });
    if (isRequestTab(this.activeTab) && this.activeTab.key === key) await this.send(this.activeTab.id);
  }

  // ---------------------------------------------------------------- request ops

  /**
   * Whether an action from outside the views (the explorer, History, Rename variable, a
   * quick fix) is refused from changing the file at `path` (or requests `keys` of it): a
   * view holds text that doesn't parse that the change would stop standing for, which
   * would drop it unseen (`TextViews.blocked`, #174). Says why when it is.
   */
  private refused(path: string, keys: string[] = []): boolean {
    const why = this.texts.blocked(path, keys);
    if (why) this.toast("error", `${why}. Fix the text, or save the file and choose what to keep.`);
    return !!why;
  }

  /** Adds a request to a file and opens it. Saves immediately if the file was clean. */
  async addRequest(path: string, req: Request = newRequest()) {
    const doc = await this.loadDoc(path);
    if (!doc || this.refused(path)) return;
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
    if (!doc || !src || this.refused(path)) return;
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
    // The request after it takes the text before it.
    const next = doc.file.requests[doc.file.requests.indexOf(req) + 1];
    if (this.refused(path, [key, ...(req.leading && next ? [next._key!] : [])])) return;
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
    for (const t of this.tabs.filter((t) => t.kind === "request" && t.path === path && t.key === key)) this.removeTab(t.id);
    if (wasClean) await this.save(path);
  }

  async renameRequest(path: string, key: string) {
    const doc = await this.loadDoc(path);
    const req = doc?.file.requests.find((r) => r._key === key);
    if (!req || this.refused(path, [key])) return;
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
    for (const t of [...this.tabs, ...this.closed]) t.path = remap(t.path);
    if (this.expanded[from]) this.expanded[to] = true;
    // No watcher event follows the app's own change: the Problems panel is told here.
    this.problems.moved(from, to);
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
    this.problems.removed(path);
    await this.refreshTree();
    await this.reloadFolderEnvironments(path);
  }

  // ---------------------------------------------------------------- execution

  /** The request with the scope it's sent in. Send and the resolved preview both use this, so they agree. */
  private requestArgs(tab: RequestTab, req: Request, doc: Doc): RequestArgs {
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
   * The values the Session remembers for the tab's request's Prompt variables, by
   * name. The Session (in the shell) holds them, never the webview.
   */
  promptAnswers(tab: RequestTab): Promise<Record<string, string>> {
    return api.promptAnswers(tab.key);
  }

  /**
   * A panel's command (⌘J, ⌘⇧M, Show Runner): shows `panel` below the requests and
   * puts focus in its list, or, with focus in it already (`focusInPanel`), hides it.
   */
  togglePanel(panel: PanelId, focusInPanel: boolean) {
    if (this.panel === panel && focusInPanel) {
      this.panel = null;
      return;
    }
    this.panel = panel;
    this.panelFocusWanted = true;
  }

  /**
   * Asks for the request's Prompt variables that the Session has no value for, all in
   * one form, and has the Session remember the answers. False if the user cancelled.
   */
  private async askPrompts(tab: RequestTab, req: Request): Promise<boolean> {
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
  async preview(tab: RequestTab): Promise<RequestPreview | null> {
    const req = this.requestFor(tab);
    const doc = this.docs[tab.path];
    if (!req || !doc) return null;
    return api.previewRequest(this.requestArgs(tab, req, doc));
  }

  async send(tabId: string) {
    const typing = this.tabs.find((t) => t.id === tabId);
    if (typing?.kind === "file") return this.sendUnderCursor(typing);
    // Text typed in the Source view a moment ago is sent too (and only then awaited).
    if (typing && this.texts.waiting(typing.path, sourceView(typing.key))) await this.texts.readNow(typing.path, sourceView(typing.key));
    const tab = this.tabs.find((t): t is RequestTab => t.id === tabId && t.kind === "request");
    const req = this.requestFor(tab ?? null);
    const doc = tab && this.docs[tab.path];
    if (!tab || !req || !doc) return;
    if (this.runs[tabId]?.loading || this.confirmingSend.has(tabId)) return;
    // What would be sent is the request as it last read, not the text shown: say so instead.
    if (this.texts.isInvalid(tab.path, sourceView(tab.key))) {
      this.toast("error", `The source of "${displayName(req)}" doesn't parse. Fix the text to send it.`);
      return;
    }
    // Only awaited for a request with prompts, so an ordinary send starts loading at once.
    if (requestPrompts(req).length && !(await this.confirming(tabId, () => this.askPrompts(tab, req)))) return;
    const env = this.guardedEnvironment(tab.path, req.method);
    if (env && !(await this.confirming(tabId, () => this.confirmProductionSend(env, req.method)))) return;
    // A send blocked as unsent runs no script, so it needs no trust: the shell reports the
    // block. Only awaited for a request with scripts, like the prompts.
    const runsScripts = hasScripts(req) && (await this.trust.sendRunsScripts(tab.path, req, requestNames(doc.file)));
    const scripts = runsScripts ? await this.confirming(tabId, () => this.trust.scriptsAllowed()) : "none";
    if (scripts === "cancel") return;
    const runId = uid();
    const previous = this.runs[tabId]?.response;
    // A response from History stays marked until a live one replaces it.
    const fromHistory = this.runs[tabId]?.fromHistory;
    const bodyKept = fromHistory && this.runs[tabId]?.bodyKept;
    this.runs[tabId] = { runId, loading: true, startedAt: performance.now(), response: previous };
    try {
      const response = await api.sendRequest({ runId, ...this.requestArgs(tab, req, doc), skipScripts: scripts === "skip" });
      // The Session changed if the jar kept cookies the response set, if the request is
      // named (its exchange is now the latest, which Request variables read), or if its
      // scripts ran (they may have set Global variables): views showing the Session read
      // it again, even if the tab has closed.
      const named = getDirective(req, "name")?.trim();
      if (response.cookies?.length || named || scripts === "run") this.sessionVersion++;
      this.session.noteExchange(tab.path, tab.key, req);
      // A tab that closed (or a workspace that changed) meanwhile never shows it.
      if (this.runs[tabId]?.runId !== runId) {
        this.releaseResponse(response);
        return;
      }
      this.runs[tabId] = { runId, loading: false, startedAt: 0, response };
      if (previous?.id !== response.id) this.releaseResponse(previous);
      this.markTests(tab.key, response.tests);
    } catch (e) {
      // A pre-request script that failed may have set Global variables first.
      if (scripts === "run") this.sessionVersion++;
      if (this.runs[tabId]?.runId !== runId) return;
      if (this.cancelled.delete(runId)) {
        this.runs[tabId] = { runId, loading: false, startedAt: 0, cancelled: true, response: previous, fromHistory: previous && fromHistory, bodyKept: (previous && bodyKept) || undefined };
      } else {
        const error = toSendError(e);
        this.runs[tabId] = { runId, loading: false, startedAt: 0, error };
        this.releaseResponse(previous);
        this.clearTestMark(tab.key);
        // The shell knows best: trust revoked elsewhere asks again on the next send.
        if (error.kind === "untrustedWorkspace") this.trust.refusedByShell();
      }
    } finally {
      this.cancelled.delete(runId);
      // The shell recorded it in History if anything went out.
      this.history.sent();
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

  /** Tabs whose send is waiting on the prompt form, the production confirmation or the trust question. */
  private confirmingSend = new Set<string>();

  /** Asks `ask` for the send of tab `tabId`, which doesn't start again meanwhile. */
  private async confirming<T>(tabId: string, ask: () => Promise<T>): Promise<T> {
    this.confirmingSend.add(tabId);
    try {
      return await ask();
    } finally {
      this.confirmingSend.delete(tabId);
    }
  }

  /** The environment a request in the file at `path` is sent with: the selected one if
   *  the request's folders define it, else none (ADR-0004; the send warns about it). */
  sentEnvironment(path: string): string | null {
    const name = this.envName;
    return name && this.envSetFor(path)?.environments.some((e) => e.name === name) ? name : null;
  }

  /** The environment a send of `method` from the file at `path` needs confirming for:
   *  the one it's sent with, if that's a production environment and the method isn't
   *  GET, HEAD or OPTIONS. */
  private guardedEnvironment(path: string, method: string): string | null {
    const env = this.sentEnvironment(path);
    return env && this.environmentSettings(env).production && !SAFE_METHODS.has(verbOf(method)) ? env : null;
  }

  /** Asks before sending with production environment `env`. True to go ahead. */
  private async confirmProductionSend(env: string, method: string): Promise<boolean> {
    const verb = verbOf(method);
    const r = await this.choose("Send to production?", `"${env}" is a production environment. Send this ${verb} request anyway?`, [
      { ...CANCEL, focus: true },
      { label: `Send ${verb}`, value: "send", role: "primary", danger: true },
    ]);
    return r.button === "send";
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

  // ---------------------------------------------------------------- explorer selection

  /** The requests selected in the explorer: those picked, else the active request (in a file view, the one under its cursor). */
  get selectedRequests(): RequestRef[] {
    if (this.treeSelection.length) return this.treeSelection;
    const tab = this.activeTab;
    if (tab?.kind === "file") {
      const key = this.requestUnderCursor(tab);
      return key ? [{ path: tab.path, key }] : [];
    }
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

  // ---------------------------------------------------------------- Session, trust and runs

  /** The workspace's Session as the page sees it: its version, exchange shapes, test markers (session.svelte.ts). */
  readonly session: SessionStore = new SessionStore(this.sessionHost());
  /** Whether the workspace's scripts may run (trust.ts). */
  readonly trust: Trust = new Trust(this.trustHost());
  /** Runs and the Runner panel (runner.svelte.ts). */
  readonly runnerStore: RunnerStore = new RunnerStore(this.runnerHost());
  /** History as the page sees it: each tab's History view and the entry it opened (history.svelte.ts). */
  readonly history: HistoryStore = new HistoryStore(this.historyHost());
  /** The open workspace's Layout: saved as it changes, restored when it opens (layoutStore.svelte.ts). */
  readonly layout: LayoutStore = new LayoutStore(this.layoutHost());
  /** The Problems panel's list: every file's problems and portability notes (workspaceProblems.svelte.ts). */
  readonly problems: WorkspaceProblems = new WorkspaceProblems(this.problemsHost());
  /** Text typed in each document's views, its Source views and file view (textViews.svelte.ts). */
  readonly texts: TextViews = new TextViews(this.textViewsHost());

  private problemsHost(): ProblemsHost {
    const store = this;
    return {
      get root() {
        return store.root;
      },
      get openPaths() {
        return Object.keys(store.docs);
      },
      openText: (path) => store.texts.openText(path),
      openVersion: (path) => store.texts.openVersion(path),
      get portability() {
        return store.portability;
      },
      environmentsOf: (path) => store.envSetFor(path),
      get envName() {
        return store.envName;
      },
      get sessionVersion() {
        return store.sessionVersion;
      },
    };
  }

  private textViewsHost(): TextViewsHost {
    const store = this;
    return {
      get docs() {
        return store.docs;
      },
      findRequest: (path, key) => store.findRequest(path, key),
      requestsGone: (path, keys) => {
        const doc = store.docs[path];
        for (const t of store.tabs.filter((t): t is RequestTab => t.kind === "request" && t.path === path && keys.has(t.key))) {
          // Where it sat, for when the request is typed back in (`requestsBack`).
          if (doc) store.typedOutTabs.set(doc, new Map(store.typedOutTabs.get(doc) ?? []).set(t.key, store.tabs.indexOf(t)));
          store.removeTab(t.id);
        }
      },
      requestsBack: (path, keys) => {
        const doc = store.docs[path];
        const sat = doc && store.typedOutTabs.get(doc);
        if (!sat) return;
        for (const key of keys) {
          const index = sat.get(key);
          sat.delete(key);
          if (index === undefined || store.tabs.some((t) => t.kind === "request" && t.path === path && t.key === key)) continue;
          // Where it sat, not made active: the user is typing in the file view.
          const tab = newTab(path, key);
          store.tabs.splice(Math.min(index, store.tabs.length), 0, tab);
          void store.showLastResponse(tab.id);
        }
      },
      toast: (kind, message) => store.toast(kind, message),
    };
  }

  private layoutHost(): LayoutHost {
    const store = this;
    return {
      get tabs() {
        return store.tabs;
      },
      set tabs(tabs) {
        store.tabs = tabs;
      },
      get activeTabId() {
        return store.activeTabId;
      },
      set activeTabId(id) {
        store.activeTabId = id;
      },
      get expanded() {
        return store.expanded;
      },
      set expanded(expanded) {
        store.expanded = expanded;
      },
      get docs() {
        return store.docs;
      },
      readDoc: (path, prepare) => store.readDoc(path, { prepare }),
      removeTab: (id) => store.removeTab(id),
      restoring: (ready) => {
        store.unshown = new Set(ready.keys());
        store.reattaching = ready;
      },
      toast: (kind, message) => store.toast(kind, message),
    };
  }

  private historyHost(): HistoryHost {
    const store = this;
    return {
      get runs() {
        return store.runs;
      },
      releaseResponse: (response) => store.releaseResponse(response),
      toast: (kind, message) => store.toast(kind, message),
      choose: (title, message, buttons) => store.choose(title, message, buttons),
      get settings() {
        return store.settings?.history ?? null;
      },
      updateSettings: (history) => store.updateSettings({ history }),
    };
  }

  private sessionHost(): SessionHost {
    const store = this;
    return {
      get runs() {
        return store.runs;
      },
      releaseResponse: (response) => store.releaseResponse(response),
      toast: (kind, message) => store.toast(kind, message),
      choose: (title, message, buttons) => store.choose(title, message, buttons),
    };
  }

  private trustHost(): TrustHost {
    const store = this;
    return {
      get root() {
        return store.root;
      },
      get settings() {
        return store.settings;
      },
      toast: (kind, message) => store.toast(kind, message),
      choose: (title, message, buttons) => store.choose(title, message, buttons),
      exchangeShape: (path, name) => store.session.exchangeShape(path, name),
    };
  }

  private runnerHost(): RunnerHost {
    const store = this;
    return {
      get root() {
        return store.root;
      },
      get settings() {
        return store.settings;
      },
      get envName() {
        return store.envName;
      },
      get tree() {
        return store.tree;
      },
      get tabs() {
        return store.tabs;
      },
      get docs() {
        return store.docs;
      },
      get selectedRequests() {
        return store.selectedRequests;
      },
      get session() {
        return store.session;
      },
      get trust() {
        return store.trust;
      },
      showRunner: () => (store.panel = "runner"),
      loadDoc: (path) => store.loadDoc(path),
      isRequestDirty: (path, key) => store.isRequestDirty(path, key),
      updateSettings: (patch) => store.updateSettings(patch),
      guardedEnvironment: (path, method) => store.guardedEnvironment(path, method),
      releaseResponse: (response) => store.releaseResponse(response),
      toast: (kind, message) => store.toast(kind, message),
      openDialog: (d) => store.openDialog(d),
      choose: (title, message, buttons) => store.choose(title, message, buttons),
    };
  }

  // The members below hand over to those modules, so `app.*` keeps working where it's used.

  get sessionVersion(): number {
    return this.session.version;
  }
  set sessionVersion(version: number) {
    this.session.version = version;
  }
  exchangeShape(path: string, name: string): Promise<ExchangeShape | null> {
    return this.session.exchangeShape(path, name);
  }
  forgetPrompts(tab: RequestTab): Promise<void> {
    return this.session.forgetPrompts(tab.key);
  }
  deleteGlobal(name: string): Promise<void> {
    return this.session.deleteGlobal(name);
  }
  clearGlobals(): Promise<void> {
    return this.session.clearGlobals();
  }
  deleteCookie(c: Pick<StoredCookie, "domain" | "path" | "name">): Promise<void> {
    return this.session.deleteCookie(c);
  }
  clearCookies(): Promise<void> {
    return this.session.clearCookies();
  }
  removeNamedExchange(entry: Pick<NamedExchange, "file" | "name">): Promise<void> {
    return this.session.removeNamedExchange(entry);
  }
  clearNamedExchanges(): Promise<void> {
    return this.session.clearNamedExchanges();
  }
  get shownExchange() {
    return this.session.shownExchange;
  }
  openExchange(entry: NamedExchange): Promise<void> {
    return this.session.openExchange(entry);
  }
  closeExchange() {
    this.session.closeExchange();
  }
  clearSession(): Promise<void> {
    return this.session.clear();
  }
  testMark(key: string): TestMark | undefined {
    return this.session.testMark(key);
  }
  markTests(key: string, tests: TestResult[] | undefined) {
    this.session.markTests(key, tests);
  }
  clearTestMark(key: string) {
    this.session.clearTestMark(key);
  }
  clearTestMarks() {
    this.session.clearTestMarks();
  }

  get trusted(): boolean {
    return this.trust.trusted;
  }
  revokeTrust(path: string): Promise<void> {
    return this.trust.revoke(path);
  }

  get runner(): Runner | null {
    return this.runnerStore.current;
  }
  set runner(runner: Runner | null) {
    this.runnerStore.current = runner;
  }
  get running(): boolean {
    return this.runnerStore.running;
  }
  runFile(path: string): Promise<void> {
    return this.runnerStore.runFile(path);
  }
  runFolder(path: string): Promise<void> {
    return this.runnerStore.runFolder(path);
  }
  runSelection(): Promise<void> {
    return this.runnerStore.runSelection();
  }
  stopRun(): Promise<void> {
    return this.runnerStore.stop();
  }
  get runnerOptions(): RunnerOptions {
    return this.runnerStore.options;
  }
  setRunnerOptions(patch: Partial<RunnerOptions>): Promise<boolean> {
    return this.runnerStore.setOptions(patch);
  }
  get canRerunFailed(): boolean {
    return this.runnerStore.canRerunFailed;
  }
  rerunFailed(): Promise<void> {
    return this.runnerStore.rerunFailed();
  }
  exportRun(format: RunExportFormat): Promise<void> {
    return this.runnerStore.export(format);
  }
  onRunProgress(p: RunProgress) {
    this.runnerStore.onProgress(p);
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
    // Adding a File variable changes the file.
    const tab = this.tabs.find((t) => t.id === tabId);
    if (definition.kind === "file" && definition.add && tab && this.refused(tab.path)) return;
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

  /** Shows or hides the `.http` source in place of the request editor's sections; an
   *  app setting, so it lasts across tabs and restarts. */
  toggleSource() {
    void this.updateSettings({ showSource: this.settings?.showSource !== true });
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
    const byFile = new Map<string, Usage[]>();
    for (const u of usages) if (u.kind !== "environment") byFile.set(u.path, [...(byFile.get(u.path) ?? []), u]);
    // Nothing changes if a file it would rewrite can't be (an open one's view holds text that doesn't parse).
    for (const [path, list] of byFile) {
      const requests = this.docs[path]?.file.requests ?? [];
      const keys = list.flatMap((u) => (u.kind === "request" && requests[u.index] ? [requests[u.index]._key!] : []));
      if (this.refused(path, keys)) return false;
    }
    const set = await this.folderPair(dir);
    if (!set) return false;
    renameInEnvironments(set, usages, name, next);
    if (!(await this.writeEnvironments(set, dir))) return false;

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
    // The field gets `{{name}}`, and a File variable goes in the file.
    if (tab && this.refused(tab.path, isRequestTab(tab) ? [tab.key] : [])) return null;
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
  private openDialog(d: Omit<DialogState, "resolve">): Promise<DialogAnswer> {
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
