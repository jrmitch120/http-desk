// The native menu bar, for each OS: which menus and items there are. Items run
// registered commands (src/lib/commands.ts) by id; the OS's own items (Edit,
// Hide, Minimize…) are predefined. src/lib/nativeMenu.svelte.ts renders this
// for the shell and keeps it up to date (ADR-0005 decides the shortcuts).
import { command, type CommandId } from "./commands";
import { basename } from "./http";
import { formatShortcut, type OS, type Shortcut } from "./platform";

/** Items the OS provides and runs itself (muda's predefined menu items). */
export type Predefined =
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "services"
  | "hide"
  | "hideOthers"
  | "showAll"
  | "quit"
  | "minimize"
  | "zoom"
  | "bringAllToFront";

export type MenuEntry =
  /** Runs a command. `label` and `shortcut` replace the command's own in this menu. */
  | { kind: "command"; id: CommandId; label?: string; shortcut?: Shortcut }
  | { kind: "separator" }
  /** `label` replaces the OS's own text. */
  | { kind: "predefined"; item: Predefined; label?: string }
  | { kind: "submenu"; label: string; items: MenuEntry[] }
  /** The recent workspaces, one item each (File → Open Recent). */
  | { kind: "recent" };

/** A menu in the menu bar. On macOS the first one is the app menu. */
export interface TopMenu {
  label: string;
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
  // Linux gets its own Edit items separately: muda's predefined ones don't work on GTK (ADR-0005).
  const edit: MenuEntry[] = [native("undo"), native("redo"), SEP, native("cut"), native("copy"), native("paste"), native("selectAll")];
  const view: MenuEntry[] = [
    { kind: "submenu", label: "Response Layout", items: [cmd("layout-right"), cmd("layout-below")] },
    { kind: "submenu", label: "Theme", items: [cmd("theme-system"), cmd("theme-light"), cmd("theme-dark")] },
  ];
  const request: MenuEntry[] = [cmd("send"), cmd("cancel"), SEP, cmd("save"), cmd("duplicate-request"), cmd("rename-request"), SEP, cmd("show-source")];

  if (mac) {
    return [
      {
        label: "HttpDesk",
        items: [
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
      { label: "Window", items: [native("minimize"), native("zoom", "Zoom"), SEP, native("bringAllToFront")] },
    ];
  }
  return [
    { label: "File", items: file },
    ...(os === "windows" ? [{ label: "Edit", items: edit }] : []),
    { label: "View", items: view },
    { label: "Request", items: request },
    { label: "Help", items: [cmd("check-updates")] },
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

export type NativeMenu = { label: string; items: NativeEntry[] }[];

/** What an item shows: greyed out or not, ticked or not (null: it isn't a checkbox). */
export interface ItemState {
  enabled: boolean;
  checked: boolean | null;
}

/** Each recent workspace's item id: this, then its path. */
export const RECENT_PREFIX = "open-recent:";

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
  return layout.map((m) => ({ label: m.label, items: m.items.flatMap(render) }));
}

/** A shortcut as a macOS key equivalent the shell (muda) parses: "Cmd+Shift+S", "Cmd+Enter", "Cmd+,". */
function accelerator(s: Shortcut): string {
  const key = s.key.length === 1 ? s.key.toUpperCase() : s.key;
  return [s.mod && "Cmd", s.alt && "Alt", s.shift && "Shift", key].filter(Boolean).join("+");
}
