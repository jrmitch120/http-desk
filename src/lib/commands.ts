// The command registry: every app command the keyboard and the native menu
// (and later the command palette) can run, in one table. Keys reach it through
// `handleCommandKey`, the page's global key handler (ADR-0005); menu clicks
// through `runCommand` (src/lib/nativeMenu.svelte.ts).
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { app } from "./store.svelte";
import { updates } from "./updates.svelte";
import { DOCUMENTATION_URL, openLink, RELEASE_NOTES_URL, reportIssue } from "./about";
import { modalOpen } from "./modal.svelte";
import { focusedEditActions, type EditActions } from "./editMenu";
import { currentOS, formatShortcut, matchesShortcut, type KeyPress, type OS, type Shortcut } from "./platform";
import type { AppSettings } from "./types";
import { ACTUAL_SIZE, zoomIn, zoomOut } from "./zoom";

export type CommandId =
  | "open-folder"
  | "new-request"
  | "new-file"
  | "new-folder"
  | "import-openapi"
  | "save"
  | "save-all"
  | "close-tab"
  | "close-window"
  | "quit"
  | "settings"
  | "check-updates"
  | "send"
  | "cancel"
  | "duplicate-request"
  | "rename-request"
  | "show-source"
  | "toggle-sidebar"
  | "toggle-session"
  | "clear-session"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "search"
  | "choose-environment"
  | "manage-environments"
  | "layout-right"
  | "layout-below"
  | "theme-system"
  | "theme-light"
  | "theme-dark"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "select-all"
  | "about"
  | "documentation"
  | "release-notes"
  | "report-issue";

export interface Command {
  id: CommandId;
  label: string;
  /** The shortcut hints and menus show. */
  shortcut?: Shortcut;
  /** More keys that run the command, never shown. */
  aliases?: Shortcut[];
  /** The OSes where the page takes the command's keys; every OS if not given. */
  keysOn?: OS[];
  /** Whether the command applies now. A disabled command's keys are still swallowed. */
  enabled(): boolean;
  /** Runs even while a modal or dialog is open, like the window's close button (Quit). */
  underModal?: boolean;
  /** For a choice or a toggle the menu shows ticked (a layout, a theme, the .http source, the sidebar). */
  checked?(): boolean;
  run(): void;
}

const always = () => true;
const inWorkspace = () => app.root !== null;
const withTab = () => app.activeTabId !== null;
/** The active tab's request is in its file (not an Orphaned tab's). */
const withRequest = () => {
  const tab = app.activeTab;
  return !!tab && !app.isOrphaned(tab) && !!app.requestFor(tab);
};
const withSettings = () => app.settings !== null;

/** Asks for a folder and opens it as the workspace. */
async function openFolder() {
  const dir = await open({ directory: true, title: "Open workspace folder" });
  if (typeof dir === "string") await app.openWorkspace(dir);
}

/** A View → Response Layout choice. */
function layoutChoice(id: CommandId, label: string, layout: AppSettings["layout"]): Command {
  return {
    id,
    label,
    enabled: withSettings,
    checked: () => (app.settings?.layout ?? "horizontal") === layout,
    run: () => void app.updateSettings({ layout }),
  };
}

/** View → Zoom In or Zoom Out: one level up or down from the zoom now, disabled at the end. */
function zoomStep(id: CommandId, label: string, step: (zoom: number) => number | null, keys: Pick<Command, "shortcut" | "aliases">): Command {
  return {
    id,
    label,
    ...keys,
    enabled: () => withSettings() && step(app.zoom) !== null,
    run: () => {
      const zoom = step(app.zoom);
      if (zoom !== null) void app.updateSettings({ zoom });
    },
  };
}

/** A View → Theme choice. */
function themeChoice(id: CommandId, label: string, theme: AppSettings["theme"]): Command {
  return { id, label, enabled: withSettings, checked: () => app.themeChoice === theme, run: () => void app.updateSettings({ theme }) };
}

/**
 * An Edit item on Linux, acting on the focused text field as its context menu
 * does (ADR-0005: muda's predefined ones don't work on GTK). No shortcut: Ctrl+C
 * and the rest stay the field's own. Available under a modal, which has text
 * fields too.
 */
function editCommand(id: CommandId & keyof EditActions, label: string): Command {
  return {
    id,
    label,
    underModal: true,
    enabled: () => {
      const action = focusedEditActions()[id];
      return !!action && !action.disabled;
    },
    run: () => focusedEditActions()[id]?.run(),
  };
}

const COMMANDS: Command[] = [
  { id: "open-folder", label: "Open Folder…", enabled: always, run: () => void openFolder() },
  {
    id: "new-request",
    label: "New Request",
    shortcut: { mod: true, key: "t" },
    enabled: inWorkspace,
    run: () => void (app.activeTab ? app.addRequest(app.activeTab.path) : app.createFile(app.root!)),
  },
  { id: "new-file", label: "New .http File…", enabled: inWorkspace, run: () => void app.createFile(app.root!) },
  { id: "new-folder", label: "New Folder…", enabled: inWorkspace, run: () => void app.createFolder(app.root!) },
  { id: "import-openapi", label: "Import OpenAPI…", enabled: inWorkspace, run: () => (app.modal = "openapi") },
  {
    id: "save",
    label: "Save",
    shortcut: { mod: true, key: "s" },
    // What the request's Save button saves: its file with edits, or an Orphaned tab's request.
    enabled: () => !!app.activeTab && (app.isDocDirty(app.activeTab.path) || app.isOrphaned(app.activeTab)),
    run: () => void app.saveActive(),
  },
  {
    id: "save-all",
    label: "Save All",
    shortcut: { mod: true, shift: true, key: "s" },
    enabled: () => app.dirtyDocs().length > 0,
    run: () => void app.saveAll(),
  },
  {
    id: "close-tab",
    label: "Close Tab",
    shortcut: { mod: true, key: "w" },
    enabled: withTab,
    run: () => app.activeTabId && void app.closeTab(app.activeTabId),
  },
  {
    id: "close-window",
    label: "Close Window",
    shortcut: { mod: true, shift: true, key: "w" },
    enabled: always,
    // A close request, like the window's close button: the store's
    // close-requested handler asks about unsaved files first.
    run: () => void getCurrentWindow().close(),
  },
  {
    // Windows' File → Exit and Linux's File → Quit. macOS has its own Quit (the
    // app menu's, through the shell's quit path in quit.rs) and Windows' Alt+F4
    // is the OS's, so only Linux's Ctrl+Q is the page's.
    id: "quit",
    label: "Quit",
    shortcut: { mod: true, key: "q" },
    keysOn: ["linux"],
    enabled: always,
    underModal: true,
    // One window: quitting is closing it, through the same unsaved-changes flow.
    run: () => void getCurrentWindow().close(),
  },
  { id: "settings", label: "Settings…", shortcut: { mod: true, key: "," }, enabled: always, run: () => (app.modal = "settings") },
  {
    id: "check-updates",
    label: "Check for Updates…",
    enabled: () => !updates.checking && updates.progress === null,
    run: () => void updates.check(true),
  },
  {
    id: "send",
    label: "Send",
    shortcut: { mod: true, key: "Enter" },
    enabled: withTab,
    run: () => app.activeTabId && void app.send(app.activeTabId),
  },
  {
    id: "cancel",
    label: "Cancel",
    enabled: () => !!app.activeTabId && !!app.runs[app.activeTabId]?.loading,
    run: () => app.activeTabId && void app.cancel(app.activeTabId),
  },
  {
    id: "duplicate-request",
    label: "Duplicate",
    enabled: withRequest,
    run: () => app.activeTab && void app.duplicateRequest(app.activeTab.path, app.activeTab.key),
  },
  {
    id: "rename-request",
    label: "Rename…",
    enabled: withRequest,
    run: () => app.activeTab && void app.renameRequest(app.activeTab.path, app.activeTab.key),
  },
  {
    id: "show-source",
    label: "Show .http Source",
    enabled: withTab,
    checked: () => app.activeTabId !== null && app.sourceShownFor === app.activeTabId,
    run: () => app.activeTabId && app.toggleSource(app.activeTabId),
  },
  {
    // Hiding never changes the stored width, so showing again restores it.
    id: "toggle-sidebar",
    label: "Show Sidebar",
    shortcut: { mod: true, key: "b" },
    enabled: inWorkspace,
    checked: () => app.sidebarShown,
    run: () => void app.updateSettings({ sidebarHidden: app.sidebarShown }),
  },
  {
    id: "toggle-session",
    label: "Show Session",
    shortcut: { mod: true, key: "j" },
    enabled: inWorkspace,
    checked: () => app.panel === "session",
    run: () => app.togglePanel("session"),
  },
  { id: "clear-session", label: "Clear Session…", enabled: inWorkspace, run: () => void app.clearSession() },
  zoomStep("zoom-in", "Zoom In", zoomIn, {
    shortcut: { mod: true, key: "=" },
    // ⌘+ on a US keyboard is ⇧=; other layouts need Shift for = or have a + of their own, as the keypad does.
    aliases: [
      { mod: true, key: "+" },
      { mod: true, shift: true, key: "+" },
      { mod: true, shift: true, key: "=" },
    ],
  }),
  zoomStep("zoom-out", "Zoom Out", zoomOut, { shortcut: { mod: true, key: "-" } }),
  {
    id: "zoom-reset",
    label: "Actual Size",
    shortcut: { mod: true, key: "0" },
    enabled: () => withSettings() && app.zoom !== ACTUAL_SIZE,
    run: () => void app.updateSettings({ zoom: ACTUAL_SIZE }),
  },
  {
    id: "search",
    label: "Search Requests",
    shortcut: { mod: true, key: "p" },
    aliases: [{ mod: true, key: "k" }],
    enabled: inWorkspace,
    // The search box is in the sidebar.
    run: () => {
      app.showSidebar();
      app.focusSearch++;
    },
  },
  {
    id: "choose-environment",
    label: "Choose Environment",
    shortcut: { mod: true, alt: true, key: "e" },
    enabled: inWorkspace,
    run: () => app.chooseEnvironment(),
  },
  {
    id: "manage-environments",
    label: "Manage Environments…",
    shortcut: { mod: true, key: "e" },
    enabled: inWorkspace,
    run: () => (app.modal = "env"),
  },
  layoutChoice("layout-right", "Response on the Right", "horizontal"),
  layoutChoice("layout-below", "Response Below", "vertical"),
  themeChoice("theme-system", "System", "system"),
  themeChoice("theme-light", "Light", "light"),
  themeChoice("theme-dark", "Dark", "dark"),
  editCommand("undo", "Undo"),
  editCommand("redo", "Redo"),
  editCommand("cut", "Cut"),
  editCommand("copy", "Copy"),
  editCommand("paste", "Paste"),
  editCommand("select-all", "Select All"),
  { id: "about", label: "About HttpDesk", enabled: always, run: () => (app.modal = "about") },
  { id: "documentation", label: "Documentation", enabled: always, run: () => void openLink(DOCUMENTATION_URL) },
  { id: "release-notes", label: "Release Notes", enabled: always, run: () => void openLink(RELEASE_NOTES_URL) },
  { id: "report-issue", label: "Report an Issue", enabled: always, run: () => void reportIssue() },
];

const byId = new Map(COMMANDS.map((c) => [c.id, c]));

/** The command with this id. */
export function command(id: CommandId): Command {
  return byId.get(id)!;
}

/** Every registered command, in table order. */
export function allCommands(): readonly Command[] {
  return COMMANDS;
}

/** Whether `id` names a registered command (a menu event carries any string). */
export function isCommandId(id: string): id is CommandId {
  return byId.has(id as CommandId);
}

/**
 * Whether a command can run now. Under a modal or dialog no app command runs
 * (only Escape acts there, and Modal.svelte handles it), except the few that
 * act on the window like its close button does. Reactive: the native menu's
 * greyed-out state follows it.
 */
export function canRun(id: CommandId): boolean {
  const cmd = command(id);
  return (!!cmd.underModal || !modalOpen()) && cmd.enabled();
}

/** Runs a command if it can run now. True if it ran. */
export function runCommand(id: CommandId): boolean {
  if (!canRun(id)) return false;
  command(id).run();
  return true;
}

/**
 * How a command's shortcut reads on the current OS ("⌘S", "Ctrl+S"), for
 * hints. Taken from the registry, so a hint can't disagree with the key that
 * runs the command.
 */
export function shortcutHint(id: CommandId): string {
  const s = command(id).shortcut;
  return s ? formatShortcut(s) : "";
}

/** The command a key press is the shortcut of, on the current OS. */
export function commandForKey(e: KeyPress): Command | undefined {
  const os = currentOS();
  return COMMANDS.find(
    (c) => (!c.keysOn || c.keysOn.includes(os)) && [c.shortcut, ...(c.aliases ?? [])].some((s) => s && matchesShortcut(e, s, os)),
  );
}

/**
 * The global shortcut handler. A key that is some command's shortcut is
 * always swallowed, so the macOS menu never runs it a second time
 * (ADR-0005), and runs the command only if it can run now.
 */
export function handleCommandKey(e: KeyboardEvent): void {
  const cmd = commandForKey(e);
  if (!cmd) return;
  e.preventDefault();
  runCommand(cmd.id);
}
