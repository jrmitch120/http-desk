// The command registry: every app command the keyboard (and later the native
// menu and the command palette) can run, in one table. Keys reach it through
// `handleCommandKey`, the page's global key handler (ADR-0005).
import { getCurrentWindow } from "@tauri-apps/api/window";
import { app } from "./store.svelte";
import { modalOpen } from "./modal";
import { matchesShortcut, type KeyPress, type Shortcut } from "./platform";

export type CommandId =
  | "save"
  | "save-all"
  | "send"
  | "search"
  | "new-request"
  | "choose-environment"
  | "manage-environments"
  | "settings"
  | "close-tab"
  | "close-window";

export interface Command {
  id: CommandId;
  label: string;
  /** The shortcut hints and menus show. */
  shortcut?: Shortcut;
  /** More keys that run the command, never shown. */
  aliases?: Shortcut[];
  /** Whether the command applies now. A disabled command's keys are still swallowed. */
  enabled(): boolean;
  /** For a choice the menu shows ticked (a layout, a theme). */
  checked?(): boolean;
  run(): void;
}

const always = () => true;
const inWorkspace = () => app.root !== null;
const withTab = () => app.activeTabId !== null;

const COMMANDS: Command[] = [
  { id: "save", label: "Save", shortcut: { mod: true, key: "s" }, enabled: always, run: () => void app.saveActive() },
  { id: "save-all", label: "Save All", shortcut: { mod: true, shift: true, key: "s" }, enabled: always, run: () => void app.saveAll() },
  {
    id: "send",
    label: "Send",
    shortcut: { mod: true, key: "Enter" },
    enabled: withTab,
    run: () => app.activeTabId && void app.send(app.activeTabId),
  },
  {
    id: "search",
    label: "Search Requests",
    shortcut: { mod: true, key: "p" },
    aliases: [{ mod: true, key: "k" }],
    enabled: inWorkspace,
    run: () => app.focusSearch++,
  },
  {
    id: "new-request",
    label: "New Request",
    shortcut: { mod: true, key: "t" },
    enabled: inWorkspace,
    run: () => void (app.activeTab ? app.addRequest(app.activeTab.path) : app.createFile(app.root!)),
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
  { id: "settings", label: "Settings…", shortcut: { mod: true, key: "," }, enabled: always, run: () => (app.modal = "settings") },
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

/**
 * Whether a command can run now. Under a modal or dialog no app command runs
 * (only Escape acts there, and Modal.svelte handles it).
 */
export function canRun(id: CommandId): boolean {
  return !modalOpen() && command(id).enabled();
}

/** Runs a command if it can run now. True if it ran. */
export function runCommand(id: CommandId): boolean {
  if (!canRun(id)) return false;
  command(id).run();
  return true;
}

/** The command a key press is the shortcut of, on the current OS. */
export function commandForKey(e: KeyPress): Command | undefined {
  return COMMANDS.find((c) => [c.shortcut, ...(c.aliases ?? [])].some((s) => s && matchesShortcut(e, s)));
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
