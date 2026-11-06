// Store behaviour that depends on async ordering (concurrent loads of the same
// file, refreshing documents the app itself rewrote), Orphaned tabs, search,
// sending, settings, toasts, startup and watcher resilience.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, HttpFile, HttpResponse } from "./types";
import { newRequest } from "./http";

const api = vi.hoisted(() => ({
  readHttpFile: vi.fn(),
  saveHttpFile: vi.fn(),
  createFile: vi.fn(),
  createDir: vi.fn(),
  renamePath: vi.fn(),
  deletePath: vi.fn(),
  deletePermanently: vi.fn(),
  pathExists: vi.fn(),
  searchRequests: vi.fn(),
  sendRequest: vi.fn(),
  cancelRequest: vi.fn(),
  saveSettings: vi.fn(),
  getSettings: vi.fn(),
  openWorkspace: vi.fn(),
  loadEnvironments: vi.fn(),
  getTree: vi.fn(),
}));
const {
  readHttpFile,
  saveHttpFile,
  createFile,
  createDir,
  renamePath,
  deletePath,
  deletePermanently,
  pathExists,
  searchRequests,
  openWorkspace,
  getSettings,
  loadEnvironments,
  getTree,
} = api;
vi.mock("./api", () => ({ api, errorMessage: (e: unknown) => String(e) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const win = vi.hoisted(() => ({ setTheme: vi.fn(async (_theme: "light" | "dark" | null) => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: vi.fn(), setTitle: vi.fn(async () => {}), setTheme: win.setTheme }),
}));

import { app } from "./store.svelte";

const PATH = "/ws/api/books.http";

function file(...names: string[]): HttpFile {
  return {
    header: { comments: [], variables: [], raw: null },
    requests: names.map((n) => ({ ...newRequest(n), url: `https://example.com/${n}` })),
    trailing: "",
    lineEnding: "lf",
    bom: false,
  };
}

const later = <T>(ms: number, value: T) => new Promise<T>((r) => setTimeout(() => r(structuredClone(value)), ms));

/** A file of requests given as "METHOD name url" triples. */
function fileOf(...reqs: [method: string, name: string, url: string][]): HttpFile {
  return { ...file(), requests: reqs.map(([method, name, url]) => ({ ...newRequest(name), method, url })) };
}

/** Opens a tab on every request of the file at PATH. */
async function openAll(f: HttpFile) {
  readHttpFile.mockResolvedValueOnce(f);
  for (let i = 0; i < f.requests.length; i++) await app.openRequest(PATH, { index: i });
  return [...app.tabs];
}

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  renamePath.mockResolvedValue(undefined);
  pathExists.mockResolvedValue(true);
  deletePath.mockResolvedValue("trashed");
  app.dialog = null;
  app.toasts = [];
  app.tree = null;
  app.docs = {};
  app.tabs = [];
  app.activeTabId = null;
  app.runs = {};
});

describe("loadDoc", () => {
  it("shares one load between concurrent callers so open tabs keep resolving", async () => {
    // The import wizard opens a request while the explorer expands (and loads)
    // the same file; the explorer's read finishes last.
    readHttpFile.mockImplementationOnce(() => later(5, file("List", "Create")));
    readHttpFile.mockImplementationOnce(() => later(20, file("List", "Create")));

    await Promise.all([app.openRequest(PATH, { index: 0 }), app.loadDoc(PATH)]);

    const tab = app.tabs.find((t) => t.id === app.activeTabId)!;
    expect(app.requestFor(tab)?.name).toBe("List");
    expect(readHttpFile).toHaveBeenCalledTimes(1);
  });
});

describe("reloadOpen", () => {
  it("refreshes documents the app rewrote, keeping tabs on matching requests", async () => {
    readHttpFile.mockResolvedValueOnce(file("List", "Old"));
    await app.openRequest(PATH, { index: 0 });

    // Re-import overwrote the file; our own writes don't produce watcher events.
    readHttpFile.mockResolvedValueOnce(file("List", "New"));
    await app.reloadOpen([PATH, "/ws/api/not-open.http"]);

    expect(app.docs[PATH].file.requests.map((r) => r.name)).toEqual(["List", "New"]);
    expect(app.requestFor(app.tabs[0])?.name).toBe("List");
    expect(readHttpFile).toHaveBeenCalledTimes(2); // not-open.http isn't read
  });
});

/** Types `value` into the name prompt the action opens and presses OK. */
async function answerPrompt<T>(action: Promise<T>, value: string): Promise<T> {
  await vi.waitFor(() => expect(app.dialog?.input).toBeTruthy());
  app.closeDialog("ok", value);
  return action;
}

const errors = () => app.toasts.filter((t) => t.kind === "error").map((t) => t.message);

describe("name prompts", () => {
  const bad = ["../x.http", "sub/x.http", "sub\\x.http", ".."];

  it.each(bad)("new file rejects %s before calling the backend", async (name) => {
    await answerPrompt(app.createFile("/ws"), name);
    expect(createFile).not.toHaveBeenCalled();
    expect(errors()).toEqual(["Names can't contain / or \\, or be . or .."]);
  });

  it.each(bad)("new folder rejects %s before calling the backend", async (name) => {
    await answerPrompt(app.createFolder("/ws"), name);
    expect(createDir).not.toHaveBeenCalled();
    expect(errors()).toHaveLength(1);
  });

  it.each(bad)("rename rejects %s before calling the backend", async (name) => {
    await answerPrompt(app.renamePath("/ws/pets.http"), name);
    expect(renamePath).not.toHaveBeenCalled();
    expect(errors()).toHaveLength(1);
  });

  it("accepts ordinary names, including ones with dots", async () => {
    await answerPrompt(app.createFolder("/ws"), "v1..v2");
    expect(createDir).toHaveBeenCalledWith("/ws/v1..v2");
    expect(errors()).toEqual([]);
  });
});

describe("renamePath", () => {
  it("keeps the .http extension when it's omitted", async () => {
    await answerPrompt(app.renamePath("/ws/pets.http"), "dogs");
    expect(renamePath).toHaveBeenCalledWith("/ws/pets.http", "/ws/dogs.http");
  });

  it("renaming pets.http to pets leaves pets.http", async () => {
    await answerPrompt(app.renamePath("/ws/pets.http"), "pets");
    expect(renamePath).not.toHaveBeenCalledWith("/ws/pets.http", "/ws/pets");
    expect(errors()).toEqual([]);
  });

  it("keeps a .rest extension", async () => {
    await answerPrompt(app.renamePath("/ws/pets.rest"), "dogs");
    expect(renamePath).toHaveBeenCalledWith("/ws/pets.rest", "/ws/dogs.rest");
  });

  it("doesn't add an extension to folders", async () => {
    await answerPrompt(app.renamePath("/ws/api"), "v2");
    expect(renamePath).toHaveBeenCalledWith("/ws/api", "/ws/v2");
  });

  it("allows case-only renames", async () => {
    await answerPrompt(app.renamePath("/ws/api.http"), "API.http");
    expect(renamePath).toHaveBeenCalledWith("/ws/api.http", "/ws/API.http");
  });
});

describe("watcher events", () => {
  const MOVED = "/ws/api/library.http";

  async function openAndEdit() {
    readHttpFile.mockResolvedValueOnce(file("List", "Create"));
    await app.openRequest(PATH, { index: 0 });
    app.requestFor(app.tabs[0])!.url = "https://example.com/edited";
  }

  it("shows no banner when a dirty file renamed inside the app still holds what was loaded", async () => {
    await openAndEdit();
    await app.movePath(PATH, MOVED);

    // A late event for our own rename: the disk still has the loaded content.
    readHttpFile.mockResolvedValueOnce(file("List", "Create"));
    await app.onExternalChange([PATH, MOVED]);

    expect(app.docs[MOVED].externalChange).toBe(false);
    expect(app.tabs[0].path).toBe(MOVED);
    expect(app.requestFor(app.tabs[0])?.url).toBe("https://example.com/edited");
  });

  it("still shows the banner when another editor changed a dirty file", async () => {
    await openAndEdit();

    readHttpFile.mockResolvedValueOnce(file("List", "Create", "Delete"));
    await app.onExternalChange([PATH]);

    expect(app.docs[PATH].externalChange).toBe(true);
    expect(app.requestFor(app.tabs[0])?.url).toBe("https://example.com/edited");
  });
});

describe("Orphaned tabs after reload", () => {
  it("re-attaches tabs by name + method + URL, then by name, then by position", async () => {
    const [list, create, get] = await openAll(
      fileOf(["GET", "List", "https://x/books"], ["POST", "Create", "https://x/books"], ["GET", "Get", "https://x/books/1"]),
    );

    // Another editor reordered List, changed Create's URL and renamed Get in place.
    readHttpFile.mockResolvedValueOnce(
      fileOf(["POST", "Create", "https://x/books/new"], ["GET", "List", "https://x/books"], ["GET", "Fetch", "https://x/books/{id}"]),
    );
    await app.reload(PATH);

    expect(app.tabs.map((t) => app.requestFor(t)?.name)).toEqual(["List", "Create", "Fetch"]);
    expect(app.requestFor(create)?.url).toBe("https://x/books/new");
    expect([list, create, get].map((t) => app.isOrphaned(t))).toEqual([false, false, false]);
  });

  it("falls back to position when requests were also added or removed", async () => {
    const [list, get] = await openAll(fileOf(["GET", "List", "https://x/books"], ["GET", "Get", "https://x/books/1"]));

    // Another editor renamed Get in place and added a request after it.
    readHttpFile.mockResolvedValueOnce(
      fileOf(["GET", "List", "https://x/books"], ["GET", "Fetch", "https://x/books/{id}"], ["DELETE", "Remove", "https://x/books/1"]),
    );
    await app.reload(PATH);

    expect(app.tabs.map((t) => app.requestFor(t)?.name)).toEqual(["List", "Fetch"]);
    expect([list, get].map((t) => app.isOrphaned(t))).toEqual([false, false]);
  });

  it("doesn't fall back to a position whose request another tab already holds", async () => {
    const [, create, get] = await openAll(
      fileOf(["GET", "List", "https://x/books"], ["POST", "Create", "https://x/books"], ["GET", "Get", "https://x/books/1"]),
    );

    // Create was removed, so Get moved up into its position; then Get was renamed.
    readHttpFile.mockResolvedValueOnce(fileOf(["GET", "List", "https://x/books"], ["GET", "Get", "https://x/books/{id}"]));
    await app.reload(PATH);

    expect(app.requestFor(get)?.url).toBe("https://x/books/{id}");
    expect(app.isOrphaned(create)).toBe(true);
  });

  it("keeps an unmatched tab open as an Orphaned tab with its edits and last response", async () => {
    const [list, remove] = await openAll(fileOf(["GET", "List", "https://x/books"], ["DELETE", "Remove", "https://x/books/1"]));
    app.requestFor(remove)!.headers.items.push({ enabled: true, name: "X-Reason", value: "cleanup" });
    const response = { status: 204, statusText: "No Content" } as HttpResponse;
    app.runs[remove.id] = { runId: "r1", loading: false, startedAt: 0, response };

    // Another editor removed the request; the user picks "Reload from disk".
    readHttpFile.mockResolvedValueOnce(fileOf(["GET", "List", "https://x/books"]));
    await app.reload(PATH);

    expect(app.tabs.map((t) => t.id)).toEqual([list.id, remove.id]);
    expect(app.isOrphaned(remove)).toBe(true);
    expect(app.isOrphaned(list)).toBe(false);
    expect(app.requestFor(remove)?.headers.items).toEqual([{ enabled: true, name: "X-Reason", value: "cleanup" }]);
    expect(app.runs[remove.id].response).toEqual(response);
    expect(app.docs[PATH].file.requests.map((r) => r.name)).toEqual(["List"]);
  });
});

describe("saving an Orphaned tab", () => {
  /** The backend writes the file and returns it re-parsed (without frontend keys). */
  const echoSave = () =>
    saveHttpFile.mockImplementation(async (_path: string, f: HttpFile) => ({
      ...f,
      requests: f.requests.map(({ _key, ...r }) => r),
    }));

  it("appends its request to the file and the tab becomes normal again", async () => {
    echoSave();
    const [, remove] = await openAll(fileOf(["GET", "List", "https://x/books"], ["DELETE", "Remove", "https://x/books/1"]));
    readHttpFile.mockResolvedValueOnce(fileOf(["GET", "Create", "https://x/books/new"], ["GET", "List", "https://x/books"]));
    await app.reload(PATH);

    app.activeTabId = remove.id;
    await app.saveActive();

    const written: HttpFile = saveHttpFile.mock.calls[0][1];
    expect(written.requests.map((r) => `${r.method} ${r.name}`)).toEqual(["GET Create", "GET List", "DELETE Remove"]);
    expect(app.isOrphaned(remove)).toBe(false);
    expect(app.requestFor(remove)?.name).toBe("Remove");
    expect(app.isDocDirty(PATH)).toBe(false);
  });

  it("counts its edits as unsaved changes, so Save all writes them back", async () => {
    echoSave();
    const [, remove] = await openAll(fileOf(["GET", "List", "https://x/books"], ["DELETE", "Remove", "https://x/books/1"]));
    app.requestFor(remove)!.url = "https://x/books/2";
    readHttpFile.mockResolvedValueOnce(fileOf(["GET", "List", "https://x/books"]));
    await app.reload(PATH);

    expect(app.isRequestDirty(PATH, remove.key)).toBe(true);
    expect(app.dirtyDocs()).toEqual([PATH]);

    await app.saveAll();

    const written: HttpFile = saveHttpFile.mock.calls[0][1];
    expect(written.requests.map((r) => r.url)).toEqual(["https://x/books", "https://x/books/2"]);
    expect(app.isOrphaned(remove)).toBe(false);
    expect(app.dirtyDocs()).toEqual([]);
  });

  it("leaves an unedited Orphaned tab out when the file is saved from another tab", async () => {
    echoSave();
    const [list, remove] = await openAll(fileOf(["GET", "List", "https://x/books"], ["DELETE", "Remove", "https://x/books/1"]));
    readHttpFile.mockResolvedValueOnce(fileOf(["GET", "List", "https://x/books"]));
    await app.reload(PATH);
    expect(app.isRequestDirty(PATH, remove.key)).toBe(false);

    app.requestFor(list)!.url = "https://x/books?page=2";
    app.activeTabId = list.id;
    await app.saveActive();

    const written: HttpFile = saveHttpFile.mock.calls[0][1];
    expect(written.requests.map((r) => r.name)).toEqual(["List"]);
    expect(app.isOrphaned(remove)).toBe(true);
    expect(app.requestFor(remove)?.name).toBe("Remove");
  });
});

describe("Orphaned tabs of a deleted file", () => {
  it("stay open, and saving recreates the file with all its requests", async () => {
    saveHttpFile.mockImplementation(async (_path: string, f: HttpFile) => f);
    const [list, remove] = await openAll(fileOf(["GET", "List", "https://x/books"], ["DELETE", "Remove", "https://x/books/1"]));
    readHttpFile.mockRejectedValueOnce("not found");
    await app.reload(PATH);

    expect(app.tabs).toHaveLength(2);
    expect([list, remove].map((t) => app.isOrphaned(t))).toEqual([true, true]);

    app.activeTabId = list.id;
    await app.saveActive();

    expect(saveHttpFile.mock.calls[0][1].requests.map((r: { name: string }) => r.name)).toEqual(["List", "Remove"]);
    expect([list, remove].map((t) => app.isOrphaned(t))).toEqual([false, false]);
  });
});

describe("closing an Orphaned tab", () => {
  it("drops its request when the user discards its edits", async () => {
    const [, remove] = await openAll(fileOf(["GET", "List", "https://x/books"], ["DELETE", "Remove", "https://x/books/1"]));
    app.requestFor(remove)!.url = "https://x/books/2";
    readHttpFile.mockResolvedValueOnce(fileOf(["GET", "List", "https://x/books"]));
    await app.reload(PATH);

    const closing = app.closeTab(remove.id);
    expect(app.dialog?.title).toBe('Save changes to "Remove"?');
    app.closeDialog("discard");
    await closing;

    expect(app.tabs).toHaveLength(1);
    expect(app.dirtyDocs()).toEqual([]);
    expect(saveHttpFile).not.toHaveBeenCalled();
  });
});

describe("cancelling a request", () => {
  it("shows a neutral Cancelled state and keeps the previous response", async () => {
    const [tab] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    const previous = { id: "r1", status: 200, statusText: "OK" } as HttpResponse;
    api.sendRequest.mockResolvedValueOnce(previous);
    await app.send(tab.id);

    // The backend rejects the pending send once it's cancelled.
    let reject!: (e: unknown) => void;
    api.sendRequest.mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    api.cancelRequest.mockImplementationOnce(async () => reject("Request cancelled"));
    const sending = app.send(tab.id);
    await app.cancel(tab.id);
    await sending;

    expect(app.runs[tab.id]).toMatchObject({ loading: false, cancelled: true, response: previous });
    expect(app.runs[tab.id].error).toBeUndefined();
  });
});

describe("saving settings", () => {
  const settings = () => ({ theme: "dark", recentWorkspaces: [], environments: {} }) as unknown as AppSettings;

  beforeEach(() => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    app.toasts = [];
    app.settings = settings();
    app.root = "/ws";
  });

  it("shows an error toast when a theme toggle can't be saved", async () => {
    api.saveSettings.mockRejectedValueOnce("disk full");
    await app.updateSettings({ theme: "light" });
    expect(app.toasts.map((t) => [t.kind, t.message])).toEqual([["error", "Could not save settings: disk full"]]);
  });

  it("saves one at a time, so rapid changes end with the latest settings saved", async () => {
    // The backend keeps whichever save finishes last, and the first one is slow
    // (arrow presses on a pane separator, a live setting changed meanwhile).
    let stored: AppSettings | null = null;
    let inFlight = 0;
    let most = 0;
    const delays = [20, 1, 1, 1];
    api.saveSettings.mockImplementation(async (s: AppSettings) => {
      most = Math.max(most, ++inFlight);
      stored = await later(delays.shift() ?? 1, s);
      inFlight--;
    });

    const saves = [201, 202, 203].map((sidebarWidth) => app.updateSettings({ sidebarWidth }));
    expect(await Promise.all(saves)).toEqual([true, true, true]);
    expect(stored!.sidebarWidth).toBe(203);
    expect(most).toBe(1);

    // Later changes still save.
    await app.updateSettings({ sidebarWidth: 250 });
    expect(stored!.sidebarWidth).toBe(250);
  });

  it("reports a failed save to every change it carried", async () => {
    api.saveSettings.mockImplementationOnce(() => later(10, undefined));
    api.saveSettings.mockRejectedValueOnce("disk full");
    const saves = [app.updateSettings({ sidebarWidth: 201 }), app.updateSettings({ sidebarWidth: 202 }), app.updateSettings({ sidebarWidth: 203 })];
    expect(await Promise.all(saves)).toEqual([true, false, false]);
  });

  it("shows an error toast when the selected environment can't be saved", async () => {
    api.saveSettings.mockRejectedValueOnce("disk full");
    await app.selectEnvironment("staging");
    expect(app.envName).toBe("staging");
    expect(app.toasts.map((t) => t.kind)).toEqual(["error"]);
  });
});

describe("theme", () => {
  /** A stand-in for the OS appearance as `matchMedia("(prefers-color-scheme: dark)")` reports it. */
  function osAppearance(dark: boolean) {
    const listeners = new Set<(e: { matches: boolean }) => void>();
    const query = {
      matches: dark,
      addEventListener: (_: "change", f: (e: { matches: boolean }) => void) => listeners.add(f),
      removeEventListener: (_: "change", f: (e: { matches: boolean }) => void) => listeners.delete(f),
    };
    vi.stubGlobal("matchMedia", (q: string) => (q === "(prefers-color-scheme: dark)" ? query : { matches: false, addEventListener() {}, removeEventListener() {} }));
    return {
      set(next: boolean) {
        query.matches = next;
        for (const f of listeners) f({ matches: next });
      },
    };
  }
  const applied = () => (document.documentElement.dataset as { theme?: string }).theme;
  const start = async (theme: AppSettings["theme"] | undefined) => {
    api.getSettings.mockResolvedValue({ theme, recentWorkspaces: [], environments: {} } as unknown as AppSettings);
    await app.init();
  };

  beforeEach(() => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    win.setTheme.mockClear();
    app.toasts = [];
    return () => vi.unstubAllGlobals();
  });

  it.each(["dark", "light"] as const)("keeps a saved %s theme whatever the OS appearance is", async (theme) => {
    osAppearance(theme === "light");
    await start(theme);
    expect(applied()).toBe(theme);
    expect(app.effectiveTheme).toBe(theme);
    expect(win.setTheme).toHaveBeenLastCalledWith(theme);
  });

  it.each([
    [true, "dark"],
    [false, "light"],
  ])("resolves System through prefers-color-scheme (OS dark: %s)", async (dark, theme) => {
    osAppearance(dark);
    await start("system");
    expect(applied()).toBe(theme);
    expect(app.effectiveTheme).toBe(theme);
    // The native window follows the OS too, so its title bar and scrollbars agree.
    expect(win.setTheme).toHaveBeenLastCalledWith(null);
  });

  it("switches live when the OS appearance changes while System is chosen", async () => {
    const os = osAppearance(false);
    await start("system");
    os.set(true);
    expect(applied()).toBe("dark");
    os.set(false);
    expect(applied()).toBe("light");
  });

  it("ignores OS appearance changes while a fixed theme is chosen", async () => {
    const os = osAppearance(false);
    await start("light");
    os.set(true);
    expect(applied()).toBe("light");
  });

  it("applies a theme picked later at once, and the native window with it", async () => {
    osAppearance(true);
    await start("light");
    await app.updateSettings({ theme: "system" });
    expect(applied()).toBe("dark");
    expect(win.setTheme).toHaveBeenLastCalledWith(null);
    await app.updateSettings({ theme: "light" });
    expect(applied()).toBe("light");
    expect(win.setTheme).toHaveBeenLastCalledWith("light");
  });

  it("follows the OS when the settings have no theme", async () => {
    osAppearance(false);
    await start(undefined);
    expect(applied()).toBe("light");
  });

  it("treats an unknown theme in a hand-edited settings file as System, as the start-up script does", async () => {
    osAppearance(false);
    await start("sepia" as AppSettings["theme"]);
    expect(app.themeChoice).toBe("system");
    expect(applied()).toBe("light");
    expect(app.effectiveTheme).toBe("light");
    expect(win.setTheme).toHaveBeenLastCalledWith(null);
  });
});

describe("toasts", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    app.toasts = [];
    return () => vi.useRealTimers();
  });

  it("dismiss themselves after a while", () => {
    app.toast("error", "Save failed");
    vi.advanceTimersByTime(6000);
    expect(app.toasts).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(app.toasts).toHaveLength(0);
  });

  it("stay while held (hovered or text in them selected), then dismiss", () => {
    app.toast("error", "Save failed");
    app.holdToast(app.toasts[0].id, true);
    vi.advanceTimersByTime(60_000);
    expect(app.toasts.map((t) => t.message)).toEqual(["Save failed"]);

    app.holdToast(app.toasts[0].id, false);
    vi.advanceTimersByTime(2000);
    expect(app.toasts).toHaveLength(0);
  });
});

describe("startup", () => {
  const settings = (recentWorkspaces: string[]) =>
    ({ theme: "dark", recentWorkspaces, environments: {} }) as unknown as AppSettings;

  beforeEach(() => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    app.root = null;
    app.starting = true;
    api.loadEnvironments.mockResolvedValue({ shared: [], environments: [], privateFileIgnored: null });
  });

  it("is still starting (no Welcome screen) until the last workspace has reopened", async () => {
    api.getSettings.mockResolvedValue(settings(["/ws"]));
    api.pathExists.mockResolvedValue(true);
    let opened!: () => void;
    api.openWorkspace.mockReturnValueOnce(new Promise((r) => (opened = () => r({ root: "/ws", tree: { name: "ws", path: "/ws", kind: "dir" } }))));

    const starting = app.init();
    await vi.waitFor(() => expect(api.openWorkspace).toHaveBeenCalled());
    expect(app.starting).toBe(true);
    opened();
    await starting;

    expect(app.root).toBe("/ws");
    expect(app.starting).toBe(false);
  });

  it("removes recent workspaces whose folders are gone", async () => {
    api.getSettings.mockResolvedValue(settings(["/gone", "/ws", "/also-gone"]));
    api.pathExists.mockImplementation(async (p: string) => p === "/ws");

    await app.init();

    expect(api.saveSettings).toHaveBeenCalledTimes(1);
    expect(api.saveSettings.mock.calls[0][0].recentWorkspaces).toEqual(["/ws"]);
    expect(app.settings?.recentWorkspaces).toEqual(["/ws"]);
    expect(api.openWorkspace).not.toHaveBeenCalled(); // the last one is gone
    expect(app.starting).toBe(false);
  });

  describe("pane sizes left in localStorage by older versions", () => {
    let stored: Map<string, string>;
    beforeEach(() => {
      stored = new Map([
        ["sidebarWidth", "340"],
        ["splitRatio", "0.35"],
        ["unrelated", "kept"],
      ]);
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => void stored.set(k, String(v)),
        removeItem: (k: string) => void stored.delete(k),
      });
      api.getSettings.mockResolvedValue({
        ...settings([]),
        sidebarWidth: 280,
        splitRatio: { horizontal: 0.5, vertical: 0.5 },
      });
      return () => vi.unstubAllGlobals();
    });

    it("are moved into settings once, then removed from localStorage", async () => {
      await app.init();

      expect(api.saveSettings).toHaveBeenCalledTimes(1);
      // The old single ratio applied to both layouts.
      expect(api.saveSettings.mock.calls[0][0]).toMatchObject({
        sidebarWidth: 340,
        splitRatio: { horizontal: 0.35, vertical: 0.35 },
      });
      expect([...stored.keys()]).toEqual(["unrelated"]);

      await app.init();
      expect(api.saveSettings).toHaveBeenCalledTimes(1);
    });

    it("ignores values that aren't usable sizes", async () => {
      stored.set("sidebarWidth", "wide");
      stored.delete("splitRatio");

      await app.init();

      expect(api.saveSettings).not.toHaveBeenCalled();
      expect(app.settings).toMatchObject({ sidebarWidth: 280, splitRatio: { horizontal: 0.5, vertical: 0.5 } });
      expect([...stored.keys()]).toEqual(["unrelated"]);
    });
  });
});

describe("watcher resilience", () => {
  beforeEach(() => {
    app.root = "/ws";
    app.tree = { name: "ws", path: "/ws", kind: "dir", children: [] };
  });

  it("keeps the open workspace and shows why when the new one can't be watched", async () => {
    openWorkspace.mockRejectedValueOnce("Could not watch /other for changes: too many open files");
    readHttpFile.mockResolvedValueOnce(file("List"));
    await app.openRequest(PATH, { index: 0 });

    await app.openWorkspace("/other");

    expect(app.root).toBe("/ws");
    expect(app.tabs).toHaveLength(1);
    expect(app.toasts.map((t) => [t.kind, t.message])).toEqual([["error", "Could not watch /other for changes: too many open files"]]);
  });

  it("says so when the workspace folder is deleted or moved, without a cryptic tree error", async () => {
    getTree.mockRejectedValue("No such file or directory (os error 2)");

    app.onWorkspaceMissing("/ws");
    await app.refreshTree();

    expect(app.toasts.map((t) => t.message)).toEqual(['The workspace folder "ws" was deleted or moved. Open it again from where it is now.']);
  });

  it("ignores a missing-folder report for a workspace that is no longer open", () => {
    app.onWorkspaceMissing("/old");
    expect(app.toasts).toEqual([]);
  });

  it("shows watcher errors", () => {
    app.onWatchError("inotify watch limit reached");
    expect(app.toasts.map((t) => [t.kind, t.message])).toEqual([
      ["error", "Watching the workspace for changes failed: inotify watch limit reached. Changes made outside HttpDesk may not show up."],
    ]);
  });
});

describe("opening a workspace", () => {
  const tree = { name: "ws", path: "/ws", kind: "dir" as const, children: [] };
  beforeEach(() => {
    app.toasts = [];
    getSettings.mockResolvedValue({ environments: {} });
    loadEnvironments.mockResolvedValue({ shared: [], environments: [], privateFileIgnored: true });
  });

  it("tells the user when it added the private env file to .gitignore", async () => {
    openWorkspace.mockResolvedValueOnce({ root: "/ws", tree, gitignoreUpdated: true });
    await app.openWorkspace("/ws");
    expect(app.toasts.map((t) => [t.kind, t.message])).toEqual([["info", "Added http-client.private.env.json to .gitignore"]]);
  });

  it("stays quiet when .gitignore was left alone", async () => {
    openWorkspace.mockResolvedValueOnce({ root: "/ws", tree, gitignoreUpdated: false });
    await app.openWorkspace("/ws");
    expect(app.toasts).toEqual([]);
  });
});

describe("switching workspace with unsaved files", () => {
  const other = { name: "other", path: "/other", kind: "dir" as const, children: [] };
  beforeEach(() => {
    openWorkspace.mockReset().mockResolvedValue({ root: "/other", tree: other, gitignoreUpdated: false });
    getSettings.mockResolvedValue({ environments: {} });
    loadEnvironments.mockResolvedValue({ shared: [], environments: [], privateFileIgnored: true });
  });

  async function openEdited() {
    const [list] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    app.requestFor(list)!.url = "https://x/books?page=2";
  }

  it("offers Save all, Don't save and Cancel", async () => {
    await openEdited();
    const switching = app.openWorkspace("/other");
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    expect(app.dialog!.title).toBe("Unsaved changes");
    expect(app.dialog!.buttons.map((b) => b.label)).toEqual(["Cancel", "Don't save", "Save all"]);
    app.closeDialog("cancel");
    await switching;
  });

  it("Save all saves the files, then switches", async () => {
    await openEdited();
    saveHttpFile.mockImplementation(async (_path: string, f: HttpFile) => structuredClone(f));

    const switching = app.openWorkspace("/other");
    await answer("save");
    await switching;

    expect(saveHttpFile).toHaveBeenCalledTimes(1);
    expect(saveHttpFile.mock.calls[0][1].requests[0].url).toBe("https://x/books?page=2");
    expect(saveHttpFile.mock.invocationCallOrder[0]).toBeLessThan(openWorkspace.mock.invocationCallOrder[0]);
    expect(app.root).toBe("/other");
    expect(app.tabs).toEqual([]);
  });

  it("stays in the current workspace when a save fails", async () => {
    await openEdited();
    saveHttpFile.mockRejectedValue("disk full");

    const switching = app.openWorkspace("/other");
    await answer("save");
    await switching;

    expect(openWorkspace).not.toHaveBeenCalled();
    expect(app.tabs).toHaveLength(1);
    expect(app.dirtyDocs()).toEqual([PATH]);
  });

  it("Don't save switches without saving; Cancel stays", async () => {
    await openEdited();
    const cancelled = app.openWorkspace("/other");
    await answer("cancel");
    await cancelled;
    expect(openWorkspace).not.toHaveBeenCalled();
    expect(app.dirtyDocs()).toEqual([PATH]);

    const discarded = app.openWorkspace("/other");
    await answer("discard");
    await discarded;
    expect(saveHttpFile).not.toHaveBeenCalled();
    expect(app.root).toBe("/other");
  });
});

describe("quitting or closing the window with unsaved files", () => {
  async function openEdited() {
    const [list] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    app.requestFor(list)!.url = "https://x/books?page=2";
  }

  it("quits at once when nothing is unsaved", async () => {
    await openAll(fileOf(["GET", "List", "https://x/books"]));
    expect(await app.confirmQuit()).toBe(true);
    expect(app.dialog).toBeNull();
  });

  it("Cancel keeps the app open with the edits", async () => {
    await openEdited();
    const quitting = app.confirmQuit();
    expect(await answer("cancel")).toBe("Unsaved changes");
    expect(await quitting).toBe(false);
    expect(app.dirtyDocs()).toEqual([PATH]);
  });

  it("Save all saves, then quits; Don't save quits without saving", async () => {
    await openEdited();
    saveHttpFile.mockImplementation(async (_path: string, f: HttpFile) => structuredClone(f));
    const saving = app.confirmQuit();
    await answer("save");
    expect(await saving).toBe(true);
    expect(saveHttpFile).toHaveBeenCalledTimes(1);

    app.requestFor(app.tabs[0])!.url = "https://x/books?page=3";
    const discarding = app.confirmQuit();
    await answer("discard");
    expect(await discarding).toBe(true);
    expect(saveHttpFile).toHaveBeenCalledTimes(1);
  });

  it("a second quit request while the first is asking adds no second dialog", async () => {
    await openEdited();
    const first = app.confirmQuit();
    const second = app.confirmQuit(); // ⌘Q again, or the window's close button
    expect(await second).toBe(false);
    await answer("cancel");
    expect(await first).toBe(false);
    expect(app.dialog).toBeNull();

    const again = app.confirmQuit(); // asks again once the first was answered
    await answer("discard");
    expect(await again).toBe(true);
  });
});

describe("OpenAPI Overwrite", () => {
  const OTHER = "/ws/api/pets.http";

  it("names open files with unsaved edits among the files it would replace", async () => {
    const [list] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    app.requestFor(list)!.url = "https://x/books?page=2";

    const asking = app.confirmOverwrite([PATH, OTHER]);
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    expect(app.dialog!.title).toBe("Overwrite existing files?");
    expect(app.dialog!.message).toBe(
      "2 files already exist: books.http, pets.http. Overwriting replaces their contents. " +
        "books.http is open with unsaved edits, which will be lost.",
    );
    app.closeDialog("overwrite");
    expect(await asking).toBe(true);
  });

  it("doesn't mention open files without unsaved edits", async () => {
    await openAll(fileOf(["GET", "List", "https://x/books"]));
    const asking = app.confirmOverwrite([OTHER, PATH]);
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    expect(app.dialog!.message).toBe("2 files already exist: pets.http, books.http. Overwriting replaces their contents.");
    app.closeDialog("cancel");
    expect(await asking).toBe(false);
  });

  it("Cancel leaves the open document and its edits alone", async () => {
    const [list] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    app.requestFor(list)!.url = "https://x/books?page=2";

    const asking = app.confirmOverwrite([PATH]);
    expect(await answer("cancel")).toBe("Overwrite existing files?");
    expect(await asking).toBe(false);

    expect(app.requestFor(list)!.url).toBe("https://x/books?page=2");
    expect(readHttpFile).toHaveBeenCalledTimes(1);
  });

  it("only replaces the open document once the overwritten file is reloaded", async () => {
    const [list] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    app.requestFor(list)!.url = "https://x/books?page=2";
    const asking = app.confirmOverwrite([PATH]);
    await answer("overwrite");
    expect(await asking).toBe(true);
    expect(app.dirtyDocs()).toEqual([PATH]); // confirming alone changes nothing

    readHttpFile.mockResolvedValueOnce(fileOf(["GET", "List", "https://x/generated"]));
    await app.reloadOpen([PATH]);

    expect(app.requestFor(list)!.url).toBe("https://x/generated");
    expect(app.dirtyDocs()).toEqual([]);
  });
});

describe("search", () => {
  it("finds a request that was added but not saved, by its name", async () => {
    const [list] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    app.requestFor(list)!.url = "https://x/books?page=2"; // unsaved, so adding doesn't save
    await app.addRequest(PATH, { ...newRequest("Archive"), method: "POST", url: "https://x/archive" });
    expect(saveHttpFile).not.toHaveBeenCalled();
    searchRequests.mockResolvedValue([]); // the file on disk has no such request

    const hits = await app.searchRequests("archive");

    expect(hits).toEqual([{ path: PATH, index: 1, name: "Archive", method: "POST", url: "https://x/archive" }]);
  });

  it("opens the request that was clicked even after unsaved edits moved it from its disk position", async () => {
    const onDisk = fileOf(["GET", "List", "https://x/books"], ["GET", "Get", "https://x/books/1"]);
    searchRequests.mockResolvedValue([{ path: PATH, index: 1, name: "Get", method: "GET", url: "https://x/books/1" }]);
    const [hit] = await app.searchRequests("get"); // file not open yet: found on disk

    // Before clicking, the user opens the file and inserts a request above "Get" without saving.
    const [list] = await openAll(onDisk);
    app.requestFor(list)!.url = "https://x/books?page=2";
    await app.duplicateRequest(PATH, list.key);
    expect(app.docs[PATH].file.requests.map((r) => r.name)).toEqual(["List", "List copy", "Get"]);

    await app.openSearchHit(hit);

    expect(app.requestFor(app.activeTab)?.name).toBe("Get");
  });

  it("lists results in workspace file order whether or not a file is open", async () => {
    const OTHER = "/ws/zoo.http";
    app.tree = {
      name: "ws",
      path: "/ws",
      kind: "dir",
      children: [
        { name: "api", path: "/ws/api", kind: "dir", children: [{ name: "books.http", path: PATH, kind: "file" }] },
        { name: "zoo.http", path: OTHER, kind: "file" },
      ],
    };
    await openAll(fileOf(["GET", "List", "https://x/books"]));
    searchRequests.mockResolvedValue([
      { path: PATH, index: 0, name: "List", method: "GET", url: "https://x/books" },
      { path: OTHER, index: 0, name: "List animals", method: "GET", url: "https://x/zoo" },
    ]);

    const hits = await app.searchRequests("list");

    expect(hits.map((h) => h.path)).toEqual([PATH, OTHER]);
  });

  it("matches a result to its request by name + method + URL", async () => {
    const [, , post] = await openAll(
      fileOf(["GET", "Item", "https://x/items"], ["GET", "Item", "https://x/items/1"], ["POST", "Item", "https://x/items"]),
    );
    app.activeTabId = null;

    await app.openSearchHit({ path: PATH, index: 0, name: "Item", method: "POST", url: "https://x/items" });

    expect(app.activeTabId).toBe(post.id);
  });
});

describe("dialog queue", () => {
  it("shows one dialog at a time and resolves each with the user's own answer", async () => {
    const del = app.choose("Delete request", 'Delete "List"?', [
      { label: "Cancel", value: "cancel" },
      { label: "Delete", value: "delete", danger: true },
    ]);
    const name = app.prompt("Rename request", "List");

    // The prompt waits until the confirm is answered.
    expect(app.dialog?.title).toBe("Delete request");
    app.closeDialog("delete");
    expect(app.dialog?.title).toBe("Rename request");
    expect(app.dialog?.input?.value).toBe("List");
    app.closeDialog("ok", "List books");

    expect(await del).toEqual({ button: "delete", value: "" });
    expect(await name).toBe("List books");
    expect(app.dialog).toBeNull();
  });
});

/** Waits for a dialog to be on screen, answers it, and returns its title. */
async function answer(button: string, value = ""): Promise<string> {
  await vi.waitFor(() => expect(app.dialog).not.toBeNull());
  const title = app.dialog!.title;
  app.closeDialog(button, value);
  return title;
}

describe("closing several tabs", () => {
  async function openEdited() {
    const tabs = await openAll(fileOf(["GET", "List", "https://x/books"], ["POST", "Create", "https://x/books"], ["GET", "Get", "https://x/books/1"]));
    for (const t of tabs) app.requestFor(t)!.url += "?edited";
    return tabs;
  }

  it("Close all asks about each unsaved tab in turn; Don't save on each closes them all", async () => {
    await openEdited();

    const closing = app.closeTabs(app.tabs.map((t) => t.id));
    const titles = [await answer("discard"), await answer("discard"), await answer("discard")];
    await closing;

    expect(titles).toEqual(['Save changes to "List"?', 'Save changes to "Create"?', 'Save changes to "Get"?']);
    expect(app.tabs).toEqual([]);
    expect(app.dialog).toBeNull();
    expect(saveHttpFile).not.toHaveBeenCalled();
  });

  it("Cancel stops the remaining closes and leaves those tabs open", async () => {
    const [list, create, get] = await openEdited();

    const closing = app.closeTabs([list.id, create.id, get.id]);
    await answer("discard");
    await answer("cancel");
    await closing;

    expect(app.tabs.map((t) => t.id)).toEqual([create.id, get.id]);
    expect(app.dialog).toBeNull();
    expect(app.isRequestDirty(PATH, create.key)).toBe(true);
  });
});

describe("deleting", () => {
  it("moves to the trash after one confirmation, closing the file's tabs", async () => {
    await openAll(file("List"));

    const deleting = app.deletePath(PATH);
    expect(await answer("delete")).toBe("Move to trash");
    await deleting;

    expect(deletePath).toHaveBeenCalledWith(PATH);
    expect(deletePermanently).not.toHaveBeenCalled();
    expect(app.dialog).toBeNull();
    expect(app.tabs).toEqual([]);
  });

  it("asks before deleting permanently when the trash is unavailable", async () => {
    deletePath.mockResolvedValue("trashUnavailable");
    await openAll(file("List"));

    const deleting = app.deletePath(PATH);
    await answer("delete");
    expect(await answer("delete")).toBe("Couldn't move to trash");
    await deleting;

    expect(deletePermanently).toHaveBeenCalledWith(PATH);
    expect(app.tabs).toEqual([]);
  });

  it("leaves the file and its tabs alone when the permanent delete is cancelled", async () => {
    deletePath.mockResolvedValue("trashUnavailable");
    const tabs = await openAll(file("List"));

    const deleting = app.deletePath(PATH);
    await answer("delete");
    await answer("cancel");
    await deleting;

    expect(deletePermanently).not.toHaveBeenCalled();
    expect(app.tabs).toEqual(tabs);
    expect(app.docs[PATH]).toBeDefined();
  });
});
