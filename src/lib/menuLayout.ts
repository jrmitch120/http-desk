// The native menu bar, for each OS: which menus and items there are. Items run
// registered commands (src/lib/commands.ts) by id; the OS's own items (Edit,
// Hide, Minimize…) are predefined. src/lib/nativeMenu.svelte.ts renders this
// for the shell and keeps it up to date (ADR-0005 decides the shortcuts).
import { command, isCommandId, type CommandId } from "./commands";
import { basename } from "./http";
import { formatShortcut, joinShortcut, type OS, type Shortcut } from "./platform";

/** Items the OS provides and runs itself (muda's predefined menu items). The shell's `Predefined` enum lists the same. */
export const PREDEFINED = [
  "undo",
  "redo",
  "cut",
  "copy",
  "paste",
  "selectAll",
  "services",
  "hide",
  "hideOthers",
  "showAll",
  "quit",
  "minimize",
  "zoom",
  "bringAllToFront",
] as const;

export type Predefined = (typeof PREDEFINED)[number];

export type MenuEntry =
  /** Runs a command. `label` and `shortcut` replace the command's own in this menu. */
  | { kind: "command"; id: CommandId; label?: string; shortcut?: Shortcut }
  | { kind: "separator" }
  /** `label` replaces the OS's own text. */
  | { kind: "predefined"; item: Predefined; label?: string }
  | { kind: "submenu"; label: string; items: MenuEntry[] }
  /** The recent workspaces, one item each (File → Open Recent). */
  | { kind: "recent" };

/** The menu macOS lists its windows in, and the one it adds Help search to. */
export type MenuRole = "window" | "help";

/** A menu in the menu bar. On macOS the first one is the app menu. */
export interface TopMenu {
  label: string;
  role?: MenuRole;
  items: MenuEntry[];
}

const cmd = (id: CommandId, more: { label?: string; shortcut?: Shortcut } = {}): MenuEntry => ({ kind: "command", id, ...more });
const native = (item: Predefined, label?: string): MenuEntry => ({ kind: "predefined", item, ...(label ? { label } : {}) });
const SEP: MenuEntry = { kind: "separator" };

/** The menu bar on `os`. */
export function menuLayout(os: OS): TopMenu[] {
  const mac = os === "mac";
  const file: MenuEntry[] = [
    cmd("open-folder"),
    { kind: "submenu", label: "Open Recent", items: [{ kind: "recent" }] },
    SEP,
    cmd("new-request"),
    cmd("new-file"),
    cmd("new-folder"),
    SEP,
    cmd("import-openapi"),
    SEP,
    cmd("save"),
    cmd("save-all"),
    // Windows and Linux keep Settings and quitting in File; macOS in the app menu.
    ...(mac ? [] : [SEP, cmd("settings")]),
    SEP,
    cmd("close-tab"),
    cmd("close-window"),
    ...(os === "windows" ? [SEP, cmd("quit", { label: "Exit", shortcut: { alt: true, key: "F4" } })] : []),
    ...(os === "linux" ? [SEP, cmd("quit", { label: "Quit" })] : []),
  ];
  // The OS's own Edit items, except on Linux: muda's predefined ones don't work
  // on GTK (ADR-0005), so there they're the app's, acting as the context menu does.
  const edit: MenuEntry[] =
    os === "linux"
      ? [cmd("undo"), cmd("redo"), SEP, cmd("cut"), cmd("copy"), cmd("paste"), cmd("select-all")]
      : [native("undo"), native("redo"), SEP, native("cut"), native("copy"), native("paste"), native("selectAll")];
  const view: MenuEntry[] = [
    cmd("toggle-sidebar"),
    cmd("toggle-session"),
    cmd("toggle-runner"),
    SEP,
    cmd("zoom-in"),
    cmd("zoom-out"),
    cmd("zoom-reset"),
    SEP,
    { kind: "submenu", label: "Response Layout", items: [cmd("layout-right"), cmd("layout-below")] },
    { kind: "submenu", label: "Theme", items: [cmd("theme-system"), cmd("theme-light"), cmd("theme-dark")] },
  ];
  const help: MenuEntry[] = [cmd("documentation"), cmd("release-notes"), SEP, cmd("report-issue")];
  const request: MenuEntry[] = [cmd("send"), cmd("cancel"), SEP, cmd("run-file"), cmd("stop-run"), SEP, cmd("save"), cmd("duplicate-request"), cmd("rename-request"), SEP, cmd("show-source"), SEP, cmd("clear-session")];

  if (mac) {
    return [
      {
        label: "HttpDesk",
        items: [
          cmd("about"),
          SEP,
          cmd("settings"),
          cmd("check-updates"),
          SEP,
          native("services"),
          SEP,
          native("hide", "Hide HttpDesk"),
          native("hideOthers"),
          native("showAll"),
          SEP,
          native("quit", "Quit HttpDesk"),
        ],
      },
      { label: "File", items: file },
      { label: "Edit", items: edit },
      { label: "View", items: view },
      { label: "Request", items: request },
      { label: "Window", role: "window", items: [native("minimize"), native("zoom", "Zoom"), SEP, native("bringAllToFront")] },
      { label: "Help", role: "help", items: help },
    ];
  }
  return [
    { label: "File", items: file },
    { label: "Edit", items: edit },
    { label: "View", items: view },
    { label: "Request", items: request },
    // About and Check for Updates are in the app menu on macOS, here elsewhere.
    { label: "Help", role: "help", items: [...help, SEP, cmd("check-updates"), SEP, cmd("about")] },
  ];
}

// ------------------------------------------------------------ for the shell

/** A menu item as the shell builds it (src-tauri/src/menu.rs). */
export type NativeEntry =
  /** A checkbox item when `checked` isn't null. Clicking it sends a `menu` event with `id`. */
  | { kind: "item"; id: string; label: string; accelerator: string | null; enabled: boolean; checked: boolean | null }
  | { kind: "separator" }
  | { kind: "predefined"; item: Predefined; label: string | null }
  | { kind: "submenu"; label: string; enabled: boolean; items: NativeEntry[] };

export type NativeMenu = { label: string; role?: MenuRole; items: NativeEntry[] }[];

/** What an item shows: greyed out or not, ticked or not (null: it isn't a checkbox). */
export interface ItemState {
  enabled: boolean;
  checked: boolean | null;
}

/** A change to every item with this id; what isn't given stays as it is. */
export type MenuItemChange = { id: string; enabled?: boolean; checked?: boolean };

/** Each recent workspace's item id: this, then its path. */
const RECENT_PREFIX = "open-recent:";

/** What clicking a menu item does: run a command, or open a recent workspace. */
export type MenuAction = { kind: "command"; id: CommandId } | { kind: "recent"; path: string };

/** What the item with id `id` (as the shell sends it back) does; null for an id the app never gives an item. */
export function menuAction(id: string): MenuAction | null {
  if (id.startsWith(RECENT_PREFIX)) return { kind: "recent", path: id.slice(RECENT_PREFIX.length) };
  return isCommandId(id) ? { kind: "command", id } : null;
}

/**
 * The menu bar as the shell builds it on `os`, with `recents` under Open
 * Recent and each item in its `state` now. Shortcuts follow ADR-0005: key
 * equivalents on macOS, in the label on Windows, none on Linux.
 */
export function nativeMenu(layout: TopMenu[], opts: { os: OS; recents: string[]; state: (id: string) => ItemState }): NativeMenu {
  const { os, recents, state } = opts;
  const item = (id: string, label: string, shortcut?: Shortcut): NativeEntry => ({
    kind: "item",
    id,
    label: os === "windows" && shortcut ? `${label}\t${formatShortcut(shortcut, "windows")}` : label,
    accelerator: os === "mac" && shortcut ? accelerator(shortcut) : null,
    ...state(id),
  });
  const render = (e: MenuEntry): NativeEntry[] => {
    switch (e.kind) {
      case "command": {
        const c = command(e.id);
        return [item(e.id, e.label ?? c.label, e.shortcut ?? c.shortcut)];
      }
      case "separator":
        return [e];
      case "predefined":
        return [{ kind: "predefined", item: e.item, label: e.label ?? null }];
      case "recent":
        return recents.map((path) => item(RECENT_PREFIX + path, basename(path)));
      case "submenu": {
        const items = e.items.flatMap(render);
        return [{ kind: "submenu", label: e.label, enabled: items.length > 0, items }];
      }
    }
  };
  return layout.map((m) => ({ label: m.label, ...(m.role ? { role: m.role } : {}), items: m.items.flatMap(render) }));
}

/** A shortcut as a macOS key equivalent the shell (muda) parses: "Cmd+Shift+S", "Cmd+Enter", "Cmd+,". */
function accelerator(s: Shortcut): string {
  return joinShortcut(s, "Cmd");
}
