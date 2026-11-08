import { describe, expect, it } from "vitest";
import shell from "../../src-tauri/src/menu.rs?raw";
import { allCommands } from "./commands";
import { menuAction, menuLayout, nativeMenu, PREDEFINED, type MenuEntry, type NativeEntry, type NativeMenu, type TopMenu } from "./menuLayout";
import type { OS } from "./platform";

/** One line per menu: "File: open-folder, Open Recent ▸ [recent], -, …". Commands by id, predefined items as "(item)". */
function outline(menus: TopMenu[]): string[] {
  const entry = (e: MenuEntry): string => {
    switch (e.kind) {
      case "command":
        return e.id;
      case "separator":
        return "-";
      case "predefined":
        return `(${e.item})`;
      case "recent":
        return "[recent]";
      case "submenu":
        return `${e.label} ▸ [${e.items.map(entry).join(", ")}]`;
    }
  };
  return menus.map((m) => `${m.label}: ${m.items.map(entry).join(", ")}`);
}

function entries(items: MenuEntry[]): MenuEntry[] {
  return items.flatMap((e) => (e.kind === "submenu" ? [e, ...entries(e.items)] : [e]));
}

describe("the menu layout", () => {
  it("on macOS is the app menu, File, Edit, View, Request, Window and Help", () => {
    expect(outline(menuLayout("mac"))).toEqual([
      "HttpDesk: about, -, settings, check-updates, -, (services), -, (hide), (hideOthers), (showAll), -, (quit)",
      "File: open-folder, Open Recent ▸ [[recent]], -, new-request, new-file, new-folder, -, import-openapi, -, save, save-all, -, close-tab, close-window",
      "Edit: (undo), (redo), -, (cut), (copy), (paste), (selectAll)",
      "View: Response Layout ▸ [layout-right, layout-below], Theme ▸ [theme-system, theme-light, theme-dark]",
      "Request: send, cancel, -, save, duplicate-request, rename-request, -, show-source",
      "Window: (minimize), (zoom), -, (bringAllToFront)",
      "Help: documentation, release-notes, -, report-issue",
    ]);
  });

  it("on Windows puts Settings, Close Window and Exit under File, and Check for Updates and About under Help", () => {
    expect(outline(menuLayout("windows"))).toEqual([
      "File: open-folder, Open Recent ▸ [[recent]], -, new-request, new-file, new-folder, -, import-openapi, -, save, save-all, -, settings, -, close-tab, close-window, -, quit",
      "Edit: (undo), (redo), -, (cut), (copy), (paste), (selectAll)",
      "View: Response Layout ▸ [layout-right, layout-below], Theme ▸ [theme-system, theme-light, theme-dark]",
      "Request: send, cancel, -, save, duplicate-request, rename-request, -, show-source",
      "Help: documentation, release-notes, -, report-issue, -, check-updates, -, about",
    ]);
  });

  it("on Linux is Windows' layout with the app's own Edit items, not the OS's (ADR-0005)", () => {
    expect(outline(menuLayout("linux"))).toEqual([
      "File: open-folder, Open Recent ▸ [[recent]], -, new-request, new-file, new-folder, -, import-openapi, -, save, save-all, -, settings, -, close-tab, close-window, -, quit",
      "Edit: undo, redo, -, cut, copy, paste, select-all",
      "View: Response Layout ▸ [layout-right, layout-below], Theme ▸ [theme-system, theme-light, theme-dark]",
      "Request: send, cancel, -, save, duplicate-request, rename-request, -, show-source",
      "Help: documentation, release-notes, -, report-issue, -, check-updates, -, about",
    ]);
  });

  it.each<OS>(["mac", "windows", "linux"])("on %s, every item that isn't predefined runs a registered command", (os) => {
    const registered = new Set(allCommands().map((c) => c.id));
    const ids = entries(menuLayout(os).flatMap((m) => m.items)).flatMap((e) => (e.kind === "command" ? [e.id] : []));
    expect(ids.length).toBeGreaterThan(20);
    for (const id of ids) expect(registered, id).toContain(id);
  });

  it("names About after the app on every OS", () => {
    for (const os of ["mac", "windows", "linux"] as OS[]) {
      const about = nativeMenu(menuLayout(os), { os, recents: [], state: () => ({ enabled: true, checked: null }) })
        .flatMap((m) => m.items)
        .find((e) => e.kind === "item" && e.id === "about");
      expect(about, os).toMatchObject({ label: "About HttpDesk" });
    }
  });

  it("names the last File item Exit on Windows and Quit on Linux", () => {
    const quit = (os: OS) => menuLayout(os)[0].items.at(-1);
    expect(quit("windows")).toMatchObject({ kind: "command", id: "quit", label: "Exit" });
    expect(quit("linux")).toMatchObject({ kind: "command", id: "quit", label: "Quit" });
  });
});

describe("the menu the shell builds", () => {
  const ready = () => ({ enabled: true, checked: null });
  const render = (os: OS, recents: string[] = []) => nativeMenu(menuLayout(os), { os, recents, state: ready });
  /** The first item with this id, anywhere in the menu bar. */
  const item = (menus: NativeMenu, id: string) => {
    const find = (items: NativeEntry[]): NativeEntry | undefined => {
      for (const e of items) {
        if (e.kind === "item" && e.id === id) return e;
        const inner = e.kind === "submenu" ? find(e.items) : undefined;
        if (inner) return inner;
      }
    };
    return find(menus.flatMap((m) => m.items));
  };

  it("binds key equivalents on macOS (ADR-0005)", () => {
    const mac = render("mac");
    expect(item(mac, "save")).toMatchObject({ label: "Save", accelerator: "Cmd+S" });
    expect(item(mac, "save-all")).toMatchObject({ label: "Save All", accelerator: "Cmd+Shift+S" });
    expect(item(mac, "send")).toMatchObject({ label: "Send", accelerator: "Cmd+Enter" });
    expect(item(mac, "settings")).toMatchObject({ label: "Settings…", accelerator: "Cmd+," });
    expect(item(mac, "close-window")).toMatchObject({ label: "Close Window", accelerator: "Cmd+Shift+W" });
    expect(item(mac, "open-folder")).toMatchObject({ label: "Open Folder…", accelerator: null });
  });

  it("shows shortcuts in the label on Windows, binding nothing", () => {
    const win = render("windows");
    expect(item(win, "save")).toMatchObject({ label: "Save\tCtrl+S", accelerator: null });
    expect(item(win, "save-all")).toMatchObject({ label: "Save All\tCtrl+Shift+S", accelerator: null });
    expect(item(win, "settings")).toMatchObject({ label: "Settings…\tCtrl+,", accelerator: null });
    expect(item(win, "quit")).toMatchObject({ label: "Exit\tAlt+F4", accelerator: null });
    expect(item(win, "open-folder")).toMatchObject({ label: "Open Folder…", accelerator: null });
  });

  it("shows no shortcuts for app commands on Linux", () => {
    const linux = render("linux");
    expect(item(linux, "save")).toMatchObject({ label: "Save", accelerator: null });
    expect(item(linux, "quit")).toMatchObject({ label: "Quit", accelerator: null });
  });

  it("shows the Linux Edit items without shortcuts, so Ctrl+C and the rest stay the page's", () => {
    const linux = render("linux");
    const edit = linux.find((m) => m.label === "Edit")!.items;
    expect(edit.map((e) => (e.kind === "item" ? [e.label, e.accelerator] : e.kind))).toEqual([
      ["Undo", null],
      ["Redo", null],
      "separator",
      ["Cut", null],
      ["Copy", null],
      ["Paste", null],
      ["Select All", null],
    ]);
  });

  it("lists recent workspaces under Open Recent by folder name, greyed out when there are none", () => {
    const recent = (menus: NativeMenu) => menus[0].items.find((e) => e.kind === "submenu" && e.label === "Open Recent");
    expect(recent(render("linux", ["/work/api", "C:\\Users\\me\\shop"]))).toEqual({
      kind: "submenu",
      label: "Open Recent",
      enabled: true,
      items: [
        { kind: "item", id: "open-recent:/work/api", label: "api", accelerator: null, enabled: true, checked: null },
        { kind: "item", id: "open-recent:C:\\Users\\me\\shop", label: "shop", accelerator: null, enabled: true, checked: null },
      ],
    });
    expect(recent(render("linux"))).toEqual({ kind: "submenu", label: "Open Recent", enabled: false, items: [] });
  });

  it("starts each item in the state it is given", () => {
    const state = (id: string) => ({ enabled: id !== "send", checked: id === "theme-dark" ? true : id.startsWith("theme-") ? false : null });
    const menus = nativeMenu(menuLayout("mac"), { os: "mac", recents: [], state });
    expect(item(menus, "send")).toMatchObject({ enabled: false, checked: null });
    expect(item(menus, "theme-dark")).toMatchObject({ enabled: true, checked: true });
    expect(item(menus, "theme-light")).toMatchObject({ enabled: true, checked: false });
  });

  it("marks the Window and Help menus, so macOS lists windows and adds Help search", () => {
    expect(render("mac").map((m) => m.role ?? null)).toEqual([null, null, null, null, null, "window", "help"]);
    expect(render("windows").map((m) => m.role ?? null)).toEqual([null, null, null, null, "help"]);
  });

  it("passes predefined items and separators through", () => {
    const mac = render("mac");
    expect(mac[0]).toMatchObject({ label: "HttpDesk" });
    expect(mac[0].items.slice(-3)).toEqual([
      { kind: "predefined", item: "showAll", label: null },
      { kind: "separator" },
      { kind: "predefined", item: "quit", label: "Quit HttpDesk" },
    ]);
  });
});

describe("an item id the shell sends back", () => {
  it("names a registered command, or the recent workspace to open", () => {
    expect(menuAction("save")).toEqual({ kind: "command", id: "save" });
    expect(menuAction("open-recent:/work/api")).toEqual({ kind: "recent", path: "/work/api" });
    expect(menuAction("open-recent:C:\\Users\\me\\shop")).toEqual({ kind: "recent", path: "C:\\Users\\me\\shop" });
  });

  it("names nothing when the app never gives an item that id", () => {
    expect(menuAction("no-such-command")).toBeNull();
    expect(menuAction("")).toBeNull();
  });

  it("opens the workspace its Open Recent item was rendered for", () => {
    const recents = ["/work/api", "/work/open-recent:odd"];
    const menus = nativeMenu(menuLayout("linux"), { os: "linux", recents, state: () => ({ enabled: true, checked: null }) });
    const openRecent = menus[0].items.find((e) => e.kind === "submenu" && e.label === "Open Recent");
    const ids = openRecent?.kind === "submenu" ? openRecent.items.flatMap((e) => (e.kind === "item" ? [e.id] : [])) : [];
    expect(ids.map(menuAction)).toEqual([
      { kind: "recent", path: "/work/api" },
      { kind: "recent", path: "/work/open-recent:odd" },
    ]);
  });
});

// The predefined items live twice: PREDEFINED here, and the Predefined enum the
// shell deserializes them into (camelCase) in src-tauri/src/menu.rs.
describe("the predefined items", () => {
  it("are the ones the shell's Predefined enum knows", () => {
    const body = shell.match(/enum Predefined\s*\{([^}]*)\}/)?.[1];
    if (!body) throw new Error("src-tauri/src/menu.rs no longer has `enum Predefined { … }`; update this test");
    const variants = body
      .replace(/\/\/.*$/gm, "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => v[0].toLowerCase() + v.slice(1));
    expect(variants).toEqual([...PREDEFINED]);
  });
});
