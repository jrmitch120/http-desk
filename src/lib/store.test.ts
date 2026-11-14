// Store behaviour that depends on async ordering (concurrent loads of the same
// file, refreshing documents the app itself rewrote), Orphaned tabs, search,
// sending, settings, toasts, startup and watcher resilience.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, EnvironmentSet, HttpFile, HttpResponse, TestResult, Usage } from "./types";
import type { ExtractChoice } from "./store.svelte";
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
  findUsages: vi.fn(),
  sendRequest: vi.fn(),
  previewRequest: vi.fn(),
  promptAnswers: vi.fn(),
  answerPrompts: vi.fn(),
  forgetPromptAnswers: vi.fn(),
  cancelRequest: vi.fn(),
  releaseResponse: vi.fn(),
  saveSettings: vi.fn(),
  getSettings: vi.fn(),
  openWorkspace: vi.fn(),
  loadEnvironments: vi.fn(),
  loadFolderEnvironments: vi.fn(),
  saveEnvironments: vi.fn(),
  getTree: vi.fn(),
  trustWorkspace: vi.fn(),
  revokeWorkspaceTrust: vi.fn(),
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
  findUsages,
  openWorkspace,
  getSettings,
  loadEnvironments,
  saveEnvironments,
  loadFolderEnvironments,
  getTree,
} = api;
vi.mock("./api", () => ({ api, errorMessage: (e: unknown) => String(e) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const win = vi.hoisted(() => ({ setTheme: vi.fn(async (_theme: "light" | "dark" | null) => {}) }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: vi.fn(), setTitle: vi.fn(async () => {}), setTheme: win.setTheme }),
}));
const webview = vi.hoisted(() => ({ setZoom: vi.fn(async (_zoom: number) => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: () => ({ setZoom: webview.setZoom }) }));

import { app } from "./store.svelte";
import { forceOS } from "./platform";
import { canRun, command, runCommand } from "./commands";
import { trackModal } from "./modal.svelte";

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
  loadFolderEnvironments.mockResolvedValue([]);
  api.releaseResponse.mockResolvedValue(undefined);
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

describe("releasing responses", () => {
  const released = () => api.releaseResponse.mock.calls.map(([id]) => id);
  const response = (id: string) => ({ id, status: 200 }) as HttpResponse;

  it("releases the previous response when a send fails, since the tab no longer shows it", async () => {
    const [tab] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    api.sendRequest.mockResolvedValueOnce(response("r1"));
    await app.send(tab.id);
    api.sendRequest.mockRejectedValueOnce({ kind: "connection", message: "refused", details: null });
    await app.send(tab.id);

    expect(app.runs[tab.id].response).toBeUndefined();
    expect(released()).toEqual(["r1"]);
  });

  it("releases a response that arrives after its tab closed", async () => {
    const [tab] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    let resolve!: (r: HttpResponse) => void;
    api.sendRequest.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const sending = app.send(tab.id);
    await app.closeTab(tab.id);

    resolve(response("late"));
    await sending;
    expect(released()).toEqual(["late"]);
  });

  it("releases every tab's response when another workspace opens", async () => {
    const [list, create] = await openAll(fileOf(["GET", "List", "https://x/books"], ["POST", "Create", "https://x/books"]));
    api.sendRequest.mockResolvedValueOnce(response("r1")).mockResolvedValueOnce(response("r2"));
    await app.send(list.id);
    await app.send(create.id);
    openWorkspace.mockResolvedValue({ root: "/other", tree: { name: "other", path: "/other", kind: "dir", children: [] }, gitignoreUpdated: false });
    getSettings.mockResolvedValue({ environments: {} });
    loadEnvironments.mockResolvedValue({ shared: [], environments: [], privateFileIgnored: true });

    await app.openWorkspace("/other");

    expect(released().sort()).toEqual(["r1", "r2"]);
  });
});

describe("download progress", () => {
  it("counts bytes received for the in-flight send and drops the count when it completes", async () => {
    const [tab] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    let resolve!: (r: HttpResponse) => void;
    api.sendRequest.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const sending = app.send(tab.id);
    const runId = app.runs[tab.id].runId;

    app.onSendProgress(runId, 1200);
    expect(app.runs[tab.id].received).toBe(1200);
    app.onSendProgress("some-other-run", 99);
    expect(app.runs[tab.id].received).toBe(1200);

    resolve({ id: "r1", status: 200 } as HttpResponse);
    await sending;
    expect(app.runs[tab.id].received).toBeUndefined();
    app.onSendProgress(runId, 5000);
    expect(app.runs[tab.id].received).toBeUndefined();
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

describe("the sidebar", () => {
  const loaded = (extra: Record<string, unknown>) =>
    ({ theme: "dark", recentWorkspaces: [], environments: {}, sidebarWidth: 340, ...extra }) as unknown as AppSettings;

  beforeEach(() => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    api.saveSettings.mockReset().mockResolvedValue(undefined);
    app.settings = loaded({});
    app.root = "/ws";
    return () => vi.unstubAllGlobals();
  });

  it.each([
    ["missing", {}, true],
    ["not a bool", { sidebarHidden: "yes" }, true],
    ["false", { sidebarHidden: false }, true],
    ["true", { sidebarHidden: true }, false],
  ])("loads shown or hidden from settings (%s)", async (_, extra, shown) => {
    api.getSettings.mockResolvedValue(loaded(extra));
    await app.init();
    expect(app.sidebarShown).toBe(shown);
    expect(app.settings?.sidebarWidth).toBe(340);
  });

  it("is hidden and shown again by Show Sidebar, keeping its width and saving the choice", async () => {
    expect(command("toggle-sidebar").checked?.()).toBe(true);
    expect(runCommand("toggle-sidebar")).toBe(true);
    expect(app.sidebarShown).toBe(false);
    expect(command("toggle-sidebar").checked?.()).toBe(false);
    await vi.waitFor(() => expect(api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ sidebarHidden: true, sidebarWidth: 340 })));

    runCommand("toggle-sidebar");
    expect(app.sidebarShown).toBe(true);
    expect(app.settings?.sidebarWidth).toBe(340);
    await vi.waitFor(() => expect(api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ sidebarHidden: false, sidebarWidth: 340 })));
  });

  it("isn't toggled while a modal is open", () => {
    const closed = trackModal();
    try {
      expect(runCommand("toggle-sidebar")).toBe(false);
    } finally {
      closed();
    }
    expect(app.sidebarShown).toBe(true);
  });

  it("is shown by Search Requests, which then focuses its search box", () => {
    app.settings!.sidebarHidden = true;
    const asked = app.focusSearch;
    runCommand("search");
    expect(app.sidebarShown).toBe(true);
    expect(app.focusSearch).toBe(asked + 1);
  });

  it("is shown by Find usages, which lists its results there", async () => {
    app.settings!.sidebarHidden = true;
    findUsages.mockResolvedValue([]);
    await app.findUsages("host");
    expect(app.sidebarShown).toBe(true);
    expect(app.usages).toEqual({ name: "host", usages: [] });
  });

  it("isn't saved again when shown while already shown", async () => {
    app.showSidebar();
    runCommand("search");
    expect(api.saveSettings).not.toHaveBeenCalled();
  });
});

describe("zoom", () => {
  const loaded = (extra: Record<string, unknown>) =>
    ({ theme: "dark", recentWorkspaces: [], environments: {}, ...extra }) as unknown as AppSettings;
  const saved = () => api.saveSettings.mock.lastCall?.[0]?.zoom;

  beforeEach(() => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    api.saveSettings.mockReset().mockResolvedValue(undefined);
    webview.setZoom.mockClear();
    app.settings = loaded({});
    return () => vi.unstubAllGlobals();
  });

  it.each([
    ["missing", {}, 1],
    ["not a number", { zoom: "big" }, 1],
    ["out of range", { zoom: 3 }, 1],
    ["a level", { zoom: 1.25 }, 1.25],
    ["between two levels", { zoom: 1.05 }, 1.05],
  ])("loads the saved zoom and applies it to the webview (%s)", async (_, extra, zoom) => {
    api.getSettings.mockResolvedValue(loaded(extra));
    await app.init();
    expect(app.zoom).toBe(zoom);
    expect(webview.setZoom).toHaveBeenLastCalledWith(zoom);
  });

  it("steps up and down one level with Zoom In and Zoom Out, saving each", async () => {
    expect(runCommand("zoom-in")).toBe(true);
    expect(app.zoom).toBe(1.1);
    expect(webview.setZoom).toHaveBeenLastCalledWith(1.1);
    await vi.waitFor(() => expect(saved()).toBe(1.1));
    runCommand("zoom-in");
    expect(app.zoom).toBe(1.25);
    runCommand("zoom-out");
    runCommand("zoom-out");
    runCommand("zoom-out");
    expect(app.zoom).toBe(0.9);
    expect(webview.setZoom).toHaveBeenLastCalledWith(0.9);
    await vi.waitFor(() => expect(saved()).toBe(0.9));
  });

  it("goes back to 100% with Actual Size", async () => {
    app.settings!.zoom = 1.5;
    expect(runCommand("zoom-reset")).toBe(true);
    expect(app.zoom).toBe(1);
    expect(webview.setZoom).toHaveBeenLastCalledWith(1);
    await vi.waitFor(() => expect(saved()).toBe(1));
  });

  it("disables Zoom In at the top level, Zoom Out at the bottom and Actual Size at 100%", () => {
    expect([canRun("zoom-in"), canRun("zoom-out"), canRun("zoom-reset")]).toEqual([true, true, false]);
    app.settings!.zoom = 1.5;
    expect([canRun("zoom-in"), canRun("zoom-out"), canRun("zoom-reset")]).toEqual([false, true, true]);
    app.settings!.zoom = 0.5;
    expect([canRun("zoom-in"), canRun("zoom-out"), canRun("zoom-reset")]).toEqual([true, false, true]);
    expect(runCommand("zoom-out")).toBe(false);
    expect(app.zoom).toBe(0.5);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it("moves from a hand-edited zoom between two levels to the next level", () => {
    app.settings!.zoom = 1.05;
    runCommand("zoom-in");
    expect(app.zoom).toBe(1.1);
    app.settings!.zoom = 1.05;
    runCommand("zoom-out");
    expect(app.zoom).toBe(1);
  });

  it("doesn't zoom while a modal is open", () => {
    const closed = trackModal();
    try {
      expect(runCommand("zoom-in")).toBe(false);
    } finally {
      closed();
    }
    expect(app.zoom).toBe(1);
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

describe("window title", () => {
  const tree = { name: "my-api", path: "/dev/my-api", kind: "dir" as const, children: [] };
  const environments = [
    { name: "local", variables: [] },
    { name: "staging", variables: [] },
  ];
  beforeEach(() => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    app.toasts = [];
    getSettings.mockResolvedValue({ environments: { "/dev/my-api": "staging" } });
    loadEnvironments.mockResolvedValue({ shared: [], environments, privateFileIgnored: true });
    openWorkspace.mockResolvedValue({ root: "/dev/my-api", tree, gitignoreUpdated: false });
  });

  it("is just the app name with no workspace open", () => {
    app.root = null;
    expect(app.windowTitle).toBe("HttpDesk");
  });

  it("names the workspace and the active environment", async () => {
    await app.openWorkspace("/dev/my-api");
    expect(app.windowTitle).toBe("my-api — staging");
  });

  it("follows the environment as it changes, and drops it when none is selected", async () => {
    await app.openWorkspace("/dev/my-api");
    await app.selectEnvironment("local");
    expect(app.windowTitle).toBe("my-api — local");
    await app.selectEnvironment(null);
    expect(app.windowTitle).toBe("my-api");
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
      { label: "Cancel", value: "cancel", role: "cancel" },
      { label: "Delete", value: "delete", role: "primary", danger: true },
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
  beforeEach(() => forceOS("mac"));
  afterEach(() => forceOS(null));

  it("moves to the trash after one confirmation, closing the file's tabs", async () => {
    await openAll(file("List"));

    const deleting = app.deletePath(PATH);
    expect(await answer("delete")).toBe("Move to Trash");
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
    expect(await answer("delete")).toBe("Couldn't Move to the Trash");
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

describe("production guard", () => {
  beforeEach(() => {
    app.root = "/ws";
    app.settings = {
      theme: "dark",
      recentWorkspaces: [],
      environments: {},
      environmentSettings: { "/ws": { prod: { production: true }, staging: { color: "blue" } } },
    } as unknown as AppSettings;
    app.envName = "prod";
    const env = (name: string) => ({ name, variables: [] });
    app.envSet = { shared: [], environments: [env("prod"), env("staging")], privateFileIgnored: null };
    app.envFolders = [];
    api.sendRequest.mockResolvedValue({ id: "r1", status: 200 } as HttpResponse);
  });

  it("doesn't ask when the request's folder doesn't define the selected production environment (it's sent with none)", async () => {
    // books.http is in api/, whose env files define only dev (ADR-0004).
    app.envFolders = [{ dir: "api", set: { shared: [], environments: [{ name: "dev", variables: [] }], privateFileIgnored: null } }];
    const tab = await tabFor("POST");
    await app.send(tab.id);
    expect(app.dialog).toBeNull();
    expect(api.sendRequest).toHaveBeenCalledTimes(1);
  });

  async function tabFor(method: string) {
    const [tab] = await openAll(fileOf([method, "Req", "https://api.example.com/books"]));
    return tab;
  }

  it("asks before sending a POST with a production environment, naming the environment and method", async () => {
    const tab = await tabFor("POST");
    const sending = app.send(tab.id);
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    expect(app.dialog!.message).toMatch(/POST/);
    expect(app.dialog!.message).toMatch(/"prod"/);
    expect(app.dialog!.buttons.find((b) => b.focus)?.value).toBe("cancel");
    app.closeDialog("send");
    await sending;
    expect(api.sendRequest).toHaveBeenCalledTimes(1);
  });

  it("doesn't send when the confirmation is cancelled", async () => {
    const tab = await tabFor("DELETE");
    const sending = app.send(tab.id);
    await answer("cancel");
    await sending;
    expect(api.sendRequest).not.toHaveBeenCalled();
    expect(app.runs[tab.id]).toBeUndefined();
  });

  it.each(["PUT", "PATCH", "PURGE"])("asks for %s too", async (method) => {
    const tab = await tabFor(method);
    const sending = app.send(tab.id);
    await answer("cancel");
    await sending;
    expect(api.sendRequest).not.toHaveBeenCalled();
  });

  it.each(["GET", "HEAD", "OPTIONS"])("sends %s without asking", async (method) => {
    const tab = await tabFor(method);
    await app.send(tab.id);
    expect(app.dialog).toBeNull();
    expect(api.sendRequest).toHaveBeenCalledTimes(1);
  });

  it("doesn't ask when the selected environment isn't production", async () => {
    app.envName = "staging";
    const tab = await tabFor("POST");
    await app.send(tab.id);
    expect(app.dialog).toBeNull();
    expect(api.sendRequest).toHaveBeenCalledTimes(1);
  });

  it("asks only once when Send is pressed again while it's asking", async () => {
    const tab = await tabFor("POST");
    const first = app.send(tab.id);
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    const second = app.send(tab.id);
    app.closeDialog("send");
    await Promise.all([first, second]);
    expect(app.dialog).toBeNull();
    expect(api.sendRequest).toHaveBeenCalledTimes(1);
  });

  it("asks before sending a request first for another's Request variables", async () => {
    const [, me] = await openAll(chained());
    app.activeTabId = me.id;
    const sending = app.sendFirst(me.id, "login");
    expect(await answer("cancel")).toMatch(/production/i);
    await sending;
    expect(api.sendRequest).not.toHaveBeenCalled();
  });
});

/** A file whose `# @name login` POST is read by a GET's Request variable. */
function chained(): HttpFile {
  const f = fileOf(["POST", "Log in", "https://example.com/login"], ["GET", "Me", "https://example.com/me"]);
  f.requests[0].directives = [{ name: "name", value: "login" }];
  f.requests[1].headers.items = [{ name: "X-Token", value: "{{login.response.body.$.token}}", enabled: true }];
  return f;
}

describe("Request variables", () => {
  beforeEach(() => {
    app.envName = null;
    app.envSet = null;
    app.envFolders = [];
    api.sendRequest.mockResolvedValue({ id: "r1", status: 200 } as HttpResponse);
  });

  it("send and preview name the file's named requests, so the Session's exchanges are read", async () => {
    const [, me] = await openAll(chained());
    await app.send(me.id);
    await app.preview(me);
    expect(api.sendRequest.mock.lastCall![0].requestNames).toEqual(["login"]);
    expect(api.previewRequest.mock.lastCall![0].requestNames).toEqual(["login"]);
  });

  it("Send first opens the named request and sends it, never the request that asked", async () => {
    const f = chained();
    readHttpFile.mockResolvedValueOnce(f);
    await app.openRequest(PATH, { index: 1 });
    const me = app.activeTab!;

    await app.sendFirst(me.id, "login");

    expect(api.sendRequest).toHaveBeenCalledTimes(1);
    expect(api.sendRequest.mock.lastCall![0].request.url).toBe("https://example.com/login");
    expect(app.requestFor(app.activeTab!)?.name).toBe("Log in");
    expect(app.runs[app.activeTab!.id]?.response?.id).toBe("r1");
  });

  it("a named request's send changes the Session, so views reading it ask again", async () => {
    const [login, me] = await openAll(chained());
    const before = app.sessionVersion;
    await app.send(me.id);
    expect(app.sessionVersion).toBe(before);
    await app.send(login.id);
    expect(app.sessionVersion).toBe(before + 1);
  });

  it("Send first does nothing when no request in the file has that name any more", async () => {
    const [, me] = await openAll(chained());
    await app.sendFirst(me.id, "gone");
    expect(api.sendRequest).not.toHaveBeenCalled();
  });
});

// #137: scripts run only in a Trusted workspace, asked the first time a send would run one.
describe("workspace trust", () => {
  const HANDLER = '> {% client.test("ok", () => {}); %}';

  beforeEach(() => {
    app.root = "/ws";
    app.settings = { theme: "dark", recentWorkspaces: [], environments: {}, environmentSettings: {}, trustedWorkspaces: [] } as unknown as AppSettings;
    app.envName = null;
    app.envSet = { shared: [], environments: [], privateFileIgnored: null };
    app.envFolders = [];
    api.sendRequest.mockResolvedValue({ id: "r1", status: 200, tests: [] } as unknown as HttpResponse);
    api.trustWorkspace.mockResolvedValue(["/ws"]);
    api.revokeWorkspaceTrust.mockResolvedValue([]);
  });

  async function tabWith(handler: string | null) {
    const f = fileOf(["GET", "Req", "https://api.example.com/books"]);
    f.requests[0].responseHandler = handler;
    const [tab] = await openAll(f);
    return tab;
  }

  const skipped = (call: number) => api.sendRequest.mock.calls[call][0].skipScripts;

  it("asks before running a handler in an untrusted workspace, with Trust and run, Send without scripts and Cancel", async () => {
    const tab = await tabWith(HANDLER);
    const sending = app.send(tab.id);
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    expect(app.dialog!.buttons.map((b) => b.label)).toEqual(["Cancel", "Send without scripts", "Trust and run"]);
    expect(app.dialog!.buttons.find((b) => b.focus)?.value).toBe("cancel");
    expect(app.dialog!.message).toMatch(/\/ws/);
    app.closeDialog("cancel");
    await sending;
    expect(api.sendRequest).not.toHaveBeenCalled();
    expect(app.runs[tab.id]).toBeUndefined();
  });

  it("Trust and run trusts the workspace in the shell, sends with scripts, and never asks again", async () => {
    const tab = await tabWith(HANDLER);
    const sending = app.send(tab.id);
    await answer("trust");
    await sending;
    expect(api.trustWorkspace).toHaveBeenCalledTimes(1);
    expect(app.settings!.trustedWorkspaces).toEqual(["/ws"]);
    expect(skipped(0)).toBe(false);
    await app.send(tab.id);
    expect(app.dialog).toBeNull();
    expect(skipped(1)).toBe(false);
    expect(api.saveSettings).not.toHaveBeenCalled();
  });

  it("Send without scripts sends without them, and isn't asked again until the workspace is opened again", async () => {
    const tab = await tabWith(HANDLER);
    const sending = app.send(tab.id);
    await answer("skip");
    await sending;
    expect(skipped(0)).toBe(true);
    await app.send(tab.id);
    expect(app.dialog).toBeNull();
    expect(skipped(1)).toBe(true);
    expect(api.trustWorkspace).not.toHaveBeenCalled();

    openWorkspace.mockResolvedValue({ root: "/ws", tree: { name: "ws", path: "/ws", isDir: true, children: [] }, gitignoreUpdated: false });
    getSettings.mockResolvedValue(app.settings);
    loadEnvironments.mockResolvedValue({ shared: [], environments: [], privateFileIgnored: null });
    await app.openWorkspace("/ws");
    const again = await tabWith(HANDLER);
    const third = app.send(again.id);
    await answer("cancel");
    await third;
    expect(api.sendRequest).toHaveBeenCalledTimes(2);
  });

  it("never asks in a Trusted workspace", async () => {
    app.settings!.trustedWorkspaces = ["/ws"];
    const tab = await tabWith(HANDLER);
    await app.send(tab.id);
    expect(app.dialog).toBeNull();
    expect(skipped(0)).toBe(false);
  });

  it.each([null, ">> ./saved.json"])("never asks for a request without a script (%s)", async (handler) => {
    const tab = await tabWith(handler);
    await app.send(tab.id);
    expect(app.dialog).toBeNull();
    expect(api.sendRequest).toHaveBeenCalledTimes(1);
  });

  it("revoking trust goes through the shell and asks again on the next send", async () => {
    app.settings!.trustedWorkspaces = ["/ws"];
    await app.revokeTrust("/ws");
    expect(api.revokeWorkspaceTrust).toHaveBeenCalledWith("/ws");
    expect(app.settings!.trustedWorkspaces).toEqual([]);
    const tab = await tabWith(HANDLER);
    const sending = app.send(tab.id);
    await answer("cancel");
    await sending;
    expect(api.sendRequest).not.toHaveBeenCalled();
  });

  it("a send the shell refuses as untrusted forgets the trust this page thought it had", async () => {
    app.settings!.trustedWorkspaces = ["/ws"];
    api.sendRequest.mockRejectedValueOnce({ kind: "untrustedWorkspace", message: "not trusted", details: null });
    const tab = await tabWith(HANDLER);
    await app.send(tab.id);
    expect(app.runs[tab.id].error?.kind).toBe("untrustedWorkspace");
    expect(app.settings!.trustedWorkspaces).toEqual([]);
  });
});

describe("test markers", () => {
  const pass = (name: string): TestResult => ({ name, passed: true, message: null });
  const fail = (name: string): TestResult => ({ name, passed: false, message: "nope" });
  const responding = (id: string, tests: TestResult[]) =>
    api.sendRequest.mockResolvedValueOnce({ id, status: 200, tests, logs: [] } as unknown as HttpResponse);

  beforeEach(() => {
    app.settings = { theme: "dark", recentWorkspaces: [], environments: {}, environmentSettings: {}, trustedWorkspaces: [] } as unknown as AppSettings;
    app.envName = null;
    app.clearTestMarks();
  });

  it("are green when every test of the latest send passed, red when any failed", async () => {
    const [list, create] = await openAll(fileOf(["GET", "List", "https://x/books"], ["POST", "Create", "https://x/books"]));
    responding("r1", [pass("a"), pass("b")]);
    await app.send(list.id);
    responding("r2", [pass("a"), fail("Response handler")]);
    await app.send(create.id);
    expect(app.testMark(list.key)).toBe("passed");
    expect(app.testMark(create.key)).toBe("failed");

    responding("r3", [fail("a")]);
    await app.send(list.id);
    expect(app.testMark(list.key)).toBe("failed");
  });

  it("go away when the latest send had no tests or failed, and stay when it was cancelled", async () => {
    const [tab] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    responding("r1", [pass("a")]);
    await app.send(tab.id);
    responding("r2", []);
    await app.send(tab.id);
    expect(app.testMark(tab.key)).toBeUndefined();

    responding("r3", [pass("a")]);
    await app.send(tab.id);
    api.sendRequest.mockRejectedValueOnce({ kind: "refused", message: "refused", details: null });
    await app.send(tab.id);
    expect(app.testMark(tab.key)).toBeUndefined();

    responding("r4", [fail("a")]);
    await app.send(tab.id);
    let reject!: (e: unknown) => void;
    api.sendRequest.mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    api.cancelRequest.mockImplementationOnce(async () => reject("Request cancelled"));
    const sending = app.send(tab.id);
    await app.cancel(tab.id);
    await sending;
    expect(app.testMark(tab.key)).toBe("failed");
  });

  it("outlast the tab, since they belong to the request", async () => {
    const [tab] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    responding("r1", [pass("a")]);
    await app.send(tab.id);
    app.closeTab(tab.id);
    expect(app.testMark(tab.key)).toBe("passed");
  });

  it("clear with the Session: on opening a workspace, or all at once", async () => {
    const [tab] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    responding("r1", [pass("a")]);
    await app.send(tab.id);
    app.clearTestMarks();
    expect(app.testMark(tab.key)).toBeUndefined();

    responding("r2", [fail("a")]);
    await app.send(tab.id);
    openWorkspace.mockResolvedValue({ root: "/ws", tree: { name: "ws", path: "/ws", isDir: true, children: [] }, gitignoreUpdated: false });
    getSettings.mockResolvedValue(app.settings);
    loadEnvironments.mockResolvedValue({ shared: [], environments: [], privateFileIgnored: null });
    await app.openWorkspace("/ws");
    expect(app.testMark(tab.key)).toBeUndefined();
  });

  it("one request's can be cleared alone", async () => {
    const [list, create] = await openAll(fileOf(["GET", "List", "https://x/books"], ["POST", "Create", "https://x/books"]));
    responding("r1", [pass("a")]);
    await app.send(list.id);
    responding("r2", [pass("a")]);
    await app.send(create.id);
    app.clearTestMark(list.key);
    expect(app.testMark(list.key)).toBeUndefined();
    expect(app.testMark(create.key)).toBe("passed");
  });
});

describe("environment settings", () => {
  beforeEach(() => {
    vi.stubGlobal("document", { documentElement: { dataset: {} } });
    app.root = "/ws";
    app.settings = {
      theme: "dark",
      recentWorkspaces: [],
      environments: {},
      environmentSettings: { "/other": { prod: { production: true } }, "/ws": { gone: { color: "red" } } },
    } as unknown as AppSettings;
    api.saveSettings.mockResolvedValue(undefined);
  });

  it("replace the workspace's, leaving out environments with nothing set and other workspaces alone", async () => {
    expect(await app.saveEnvironmentSettings({ prod: { production: true, color: "red" }, dev: { production: false, color: null } })).toBe(true);
    expect(app.environmentSettings("prod")).toEqual({ production: true, color: "red" });
    expect(app.environmentSettings("dev")).toEqual({});
    expect(app.environmentSettings("gone")).toEqual({});
    expect(api.saveSettings.mock.lastCall![0].environmentSettings).toEqual({
      "/other": { prod: { production: true } },
      "/ws": { prod: { production: true, color: "red" } },
    });
  });

  it("carry a matrix column's width to a renamed environment, and drop those of environments gone", async () => {
    app.settings!.envMatrixWidths = {
      "/other": { columns: { local: 300 } },
      "/ws": { variable: 120, columns: { $shared: 180, local: 100, staging: 116 } },
    };
    expect(await app.carryMatrixWidth("local", "dev")).toBe(true);
    // The old name keeps it until saved: another folder may still have a `local`.
    expect(app.matrixWidths()).toEqual({ variable: 120, columns: { $shared: 180, local: 100, staging: 116, dev: 100 } });
    expect(await app.carryMatrixWidth("qa", "test")).toBe(true);
    expect(app.matrixWidths().columns.test).toBeUndefined();

    expect(await app.keepMatrixWidths(["dev"])).toBe(true);
    expect(api.saveSettings.mock.lastCall![0].envMatrixWidths).toEqual({
      "/other": { columns: { local: 300 } },
      "/ws": { variable: 120, columns: { $shared: 180, dev: 100 } },
    });
  });

  it("give the selected environment's colour, ignoring names outside the palette", () => {
    app.settings!.environmentSettings["/ws"] = { a: { color: "green" }, b: { color: "#123456" } };
    app.envName = "a";
    expect(app.envColor).toBe("green");
    app.envName = "b";
    expect(app.envColor).toBeNull();
    app.envName = null;
    expect(app.envColor).toBeNull();
  });
});

describe("find usages", () => {
  const usage = (index: number, name: string, url: string): Usage => ({
    kind: "request",
    path: PATH,
    index,
    name,
    method: "GET",
    url,
    field: { kind: "header", index: 0, name: "Authorization", part: "value" },
    disabled: false,
    start: 7,
    end: 16,
  });

  it("searches open documents as they are on screen and lists what the backend found", async () => {
    const [list] = await openAll(fileOf(["GET", "List", "https://x/books"]));
    app.requestFor(list)!.url = "{{host}}/books"; // unsaved
    findUsages.mockResolvedValue([usage(0, "List", "{{host}}/books")]);

    await app.findUsages("host");

    const [name, open] = findUsages.mock.lastCall!;
    expect(name).toBe("host");
    expect(open).toHaveLength(1);
    expect(open[0].path).toBe(PATH);
    expect(open[0].file.requests[0].url).toBe("{{host}}/books");
    expect(app.usages).toEqual({ name: "host", usages: [usage(0, "List", "{{host}}/books")] });
  });

  it("keeps only the latest search when two overlap", async () => {
    findUsages.mockImplementationOnce(() => later(30, [usage(0, "Old", "x")])).mockImplementationOnce(() => later(5, []));
    const first = app.findUsages("a");
    await app.findUsages("b");
    await first;
    expect(app.usages).toEqual({ name: "b", usages: [] });
  });

  it("opens a usage's request on the field that holds it, even after unsaved edits moved it", async () => {
    const [list] = await openAll(fileOf(["GET", "List", "https://x/books"], ["GET", "Get", "https://x/books/1"]));
    await app.duplicateRequest(PATH, list.key); // "Get" moves to index 2
    const u = usage(1, "Get", "https://x/books/1");

    await app.openUsage(u);

    expect(app.requestFor(app.activeTab)?.name).toBe("Get");
    expect(app.fieldWanted).toEqual({ tabId: app.activeTabId, field: { kind: "header", index: 0, name: "Authorization", part: "value" } });
  });

  it("opens a File variable's row in its file's request Settings", async () => {
    readHttpFile.mockResolvedValueOnce(fileOf(["GET", "List", "https://x/books"]));

    await app.openUsage({ kind: "fileVariable", path: PATH, index: 0, name: "base", start: 0, end: 8 });

    expect(app.requestFor(app.activeTab)?.name).toBe("List");
    expect(app.requestSettingsFor).toBe(app.activeTabId);
    expect(app.definitionWanted).toEqual({ kind: "file", name: "base" });
  });

  it("opens an environment value's row in the Environments modal, on the folder of its env file", async () => {
    app.root = "/ws";
    await app.openUsage({ kind: "environment", path: "/ws/http-client.env.json", env: "dev", name: "url", secret: false, start: 0, end: 8 });

    expect(app.modal).toBe("env");
    expect(app.definitionWanted).toEqual({ kind: "env", env: "dev", name: "url", dir: "" });

    // One in a nested folder's file opens that folder's environments.
    await app.openUsage({ kind: "environment", path: "/ws/api/users/http-client.private.env.json", env: "dev", name: "token", secret: true, start: 0, end: 8 });
    expect(app.definitionWanted).toEqual({ kind: "env", env: "dev", name: "token", dir: "api/users" });
  });
});

describe("Edit on a File variable declared in a request", () => {
  it("shows the declaring request's .http source at that @name line: the request's own, else the last one in the file", async () => {
    const f = fileOf(["GET", "List", "https://x/books"], ["GET", "Get", "https://x/books/1"], ["GET", "Other", "https://x/o"]);
    f.requests[0].variables = [{ name: "id", value: "1" }, { name: "page", value: "1" }];
    f.requests[1].variables = [{ name: "page", value: "2" }];
    f.requests[2].variables = [{ name: "page", value: "3" }, { name: "size", value: "9" }];
    const [list] = await openAll(f);
    app.activeTabId = list.id;

    // List's own @page wins for List.
    await app.editDefinition(list.id, { kind: "request", name: "page" });
    expect(app.activeTabId).toBe(list.id);
    expect(app.fieldWanted).toEqual({ tabId: list.id, field: { kind: "variable", index: 1, name: "page" } });

    // @size is only Other's: its tab comes forward on that line.
    await app.editDefinition(list.id, { kind: "request", name: "size" });
    expect(app.requestFor(app.activeTab)?.name).toBe("Other");
    expect(app.fieldWanted).toEqual({ tabId: app.activeTabId, field: { kind: "variable", index: 1, name: "size" } });
  });
});

describe("renaming a variable", () => {
  const OTHER = "/ws/api/authors.http";
  const envSet = (): EnvironmentSet => ({
    shared: [],
    environments: [
      { name: "dev", variables: [{ name: "token", value: "t", secret: true }, { name: "auth", value: "Bearer {{token}}", secret: false }] },
    ],
    privateFileIgnored: true,
  });
  const inUrl = (path: string, index: number, name: string, url: string): Usage => ({
    kind: "request",
    path,
    index,
    name,
    method: "GET",
    url,
    field: { kind: "url" },
    disabled: false,
    start: 0,
    end: 9,
  });

  beforeEach(() => {
    app.root = "/ws";
    app.envSet = envSet();
    saveEnvironments.mockResolvedValue({ gitignoreUpdated: false });
    loadEnvironments.mockImplementation(async () => structuredClone(saveEnvironments.mock.lastCall![0]));
    saveHttpFile.mockImplementation(async (_path: string, f: HttpFile) => structuredClone(f));
  });

  /** Renames `token` to `apiToken` through the form, as the user would. */
  async function rename(usages: Usage[] | null) {
    const done = app.renameVariable("token");
    expect(app.renaming?.name).toBe("token");
    app.closeRenaming({ name: "apiToken", usages });
    return done;
  }

  it("without updating references, renames it in every environment and touches no .http file", async () => {
    expect(await rename(null)).toBe(true);

    expect(saveEnvironments).toHaveBeenCalledWith({
      ...envSet(),
      environments: [
        { name: "dev", variables: [{ name: "apiToken", value: "t", secret: true }, { name: "auth", value: "Bearer {{token}}", secret: false }] },
      ],
    }, "");
    expect(app.envSet?.environments[0].variables[0].name).toBe("apiToken");
    expect(saveHttpFile).not.toHaveBeenCalled();
    expect(readHttpFile).not.toHaveBeenCalled();
  });

  it("updating references saves files that had no unsaved edits, and only renames in memory in one that had", async () => {
    // books.http is open with an unsaved edit; authors.http isn't open.
    const [list] = await openAll(fileOf(["GET", "List", "{{token}}/books"], ["GET", "Get", "https://x/1"]));
    app.requestFor(list)!.name = "List all"; // unsaved
    readHttpFile.mockResolvedValueOnce(fileOf(["GET", "Authors", "{{token}}/authors"]));

    expect(
      await rename([
        inUrl(PATH, 0, "List all", "{{token}}/books"),
        inUrl(OTHER, 0, "Authors", "{{token}}/authors"),
        { kind: "environment", path: "/ws/http-client.env.json", env: "dev", name: "auth", secret: false, start: 7, end: 16 },
      ]),
    ).toBe(true);

    expect(saveEnvironments.mock.lastCall![0].environments[0].variables).toEqual([
      { name: "apiToken", value: "t", secret: true },
      { name: "auth", value: "Bearer {{apiToken}}", secret: false },
    ]);
    expect(saveHttpFile).toHaveBeenCalledTimes(1);
    const [path, saved] = saveHttpFile.mock.lastCall!;
    expect(path).toBe(OTHER);
    expect(saved.requests[0].url).toBe("{{apiToken}}/authors");
    expect(app.isDocDirty(OTHER)).toBe(false);
    // The open file has the rename on screen, and is still unsaved.
    expect(app.docs[PATH].file.requests.map((r) => r.url)).toEqual(["{{apiToken}}/books", "https://x/1"]);
    expect(app.isDocDirty(PATH)).toBe(true);
    expect(app.toasts.at(-1)?.message).toBe("Renamed token to apiToken in every environment and 2 files. books.http had unsaved edits, so it was left unsaved.");
  });

  it("in a nested folder's environments: renames in that folder's files only, with only its env values' references", async () => {
    const apiPair = (): EnvironmentSet => ({
      shared: [],
      environments: [{ name: "dev", variables: [{ name: "token", value: "api-t", secret: true }, { name: "url", value: "{{token}}", secret: false }] }],
      privateFileIgnored: true,
    });
    loadEnvironments.mockImplementation(async (dir?: string) => (dir === "api" ? apiPair() : envSet()));
    const done = app.renameVariable("token", "api");
    app.closeRenaming({
      name: "apiToken",
      usages: [
        // The root's auth uses the root's token: not this folder's to rename.
        { kind: "environment", path: "/ws/http-client.env.json", env: "dev", name: "auth", secret: false, start: 7, end: 16 },
        { kind: "environment", path: "/ws/api/http-client.env.json", env: "dev", name: "url", secret: false, start: 0, end: 9 },
      ],
    });
    expect(await done).toBe(true);

    expect(saveEnvironments.mock.calls).toEqual([
      [
        {
          ...apiPair(),
          environments: [{ name: "dev", variables: [{ name: "apiToken", value: "api-t", secret: true }, { name: "url", value: "{{apiToken}}", secret: false }] }],
        },
        "api",
      ],
    ]);
    expect(app.toasts.at(-1)?.message).toBe("Renamed token to apiToken in every environment of api/.");
  });

  describe("with env files in folders below (ADR-0004: the nearest folder wins)", () => {
    const pair = (token: boolean): EnvironmentSet => ({
      shared: [],
      environments: [{ name: "dev", variables: token ? [{ name: "token", value: "own", secret: true }] : [{ name: "host", value: "h", secret: false }] }],
      privateFileIgnored: true,
    });
    const files: Record<string, HttpFile> = {
      "/ws/a.http": fileOf(["GET", "A", "{{token}}/a"]),
      "/ws/api/b.http": fileOf(["GET", "B", "{{token}}/b"]),
      "/ws/api/v2/c.http": fileOf(["GET", "C", "{{token}}/c"]),
      "/ws/web/d.http": fileOf(["GET", "D", "{{token}}/d"]),
    };
    const usages = Object.entries(files).map(([path, f]) => inUrl(path, 0, f.requests[0].name, f.requests[0].url));

    beforeEach(() => {
      // api/ has env files defining token, web/ has some that don't.
      app.envFolders = [
        { dir: "api", set: pair(true) },
        { dir: "web", set: pair(false) },
      ];
      loadEnvironments.mockImplementation(async (dir?: string) =>
        dir === "api" ? pair(true) : dir === "web" ? pair(false) : structuredClone(saveEnvironments.mock.lastCall?.[0] ?? envSet()),
      );
      readHttpFile.mockImplementation(async (path: string) => structuredClone(files[path]));
      findUsages.mockResolvedValue(usages);
    });

    it("renaming the root's variable rewrites only files that don't get the name from a nearer folder", async () => {
      expect(await rename(usages)).toBe(true);
      expect(saveHttpFile.mock.calls.map(([path, f]) => [path, f.requests[0].url])).toEqual([
        ["/ws/a.http", "{{apiToken}}/a"],
        ["/ws/web/d.http", "{{apiToken}}/d"],
      ]);
    });

    it("renaming a folder's variable rewrites only files in or below it", async () => {
      const done = app.renameVariable("token", "api");
      app.closeRenaming({ name: "apiToken", usages });
      expect(await done).toBe(true);
      expect(saveEnvironments.mock.calls.map(([, dir]) => dir)).toEqual(["api"]);
      expect(saveHttpFile.mock.calls.map(([path]) => path)).toEqual(["/ws/api/b.http", "/ws/api/v2/c.http"]);
    });

    it("the form is given that folder's env files (for the name check) and exactly the references that change", async () => {
      const done = app.renameVariable("token", "web");
      expect(app.renaming).toMatchObject({ name: "token", dir: "web" });
      const plan = await app.renamePlan("token", "web");
      expect(plan.pair).toEqual(pair(false));
      expect(plan.usages.map((u) => u.path)).toEqual(["/ws/web/d.http"]);
      app.closeRenaming(null);
      await done;
    });
  });

  it("cancelling the form changes nothing", async () => {
    const done = app.renameVariable("token");
    app.closeRenaming(null);
    expect(await done).toBe(false);
    expect(saveEnvironments).not.toHaveBeenCalled();
  });

  it("stops before touching any file if the environments can't be saved", async () => {
    saveEnvironments.mockRejectedValue("disk full");
    expect(await rename([inUrl(OTHER, 0, "Authors", "{{token}}/authors")])).toBe(false);
    expect(readHttpFile).not.toHaveBeenCalled();
    expect(app.toasts.at(-1)?.message).toBe("Could not save environments: disk full");
  });
});

describe("Prompt variables", () => {
  /** A stand-in for the shell's Session: prompt answers by request key. */
  let session: Map<string, Record<string, string>>;
  /** The answers the Session held for each sent request, in order. */
  let sentAnswers: Record<string, string>[];
  beforeEach(() => {
    app.root = "/ws";
    app.settings = null;
    app.envName = null;
    session = new Map();
    sentAnswers = [];
    api.promptAnswers.mockImplementation(async (key: string) => ({ ...session.get(key) }));
    api.answerPrompts.mockImplementation(async (key: string, answers: Record<string, string>) => {
      session.set(key, { ...session.get(key), ...answers });
    });
    api.forgetPromptAnswers.mockImplementation(async (key: string) => session.delete(key));
    api.sendRequest.mockImplementation(async (args: { requestKey: string }) => {
      sentAnswers.push({ ...session.get(args.requestKey) });
      return { id: "r1", status: 200 } as HttpResponse;
    });
  });

  /** A tab on a POST that declares `otp` (with help text) and `password`. */
  async function promptingTab() {
    const f = fileOf(["GET", "Login", "https://api.example.com/login?otp={{otp}}"]);
    f.requests[0].directives = [
      { name: "prompt", value: "otp Your one-time password" },
      { name: "prompt", value: "password" },
    ];
    const [tab] = await openAll(f);
    return tab;
  }
  const sentPrompts = (call = 0) => sentAnswers[call];

  it("asks once for all of them, in order, with their descriptions and masking, then sends with the values", async () => {
    const tab = await promptingTab();
    const sending = app.send(tab.id);
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    expect(app.dialog!.fields).toEqual([
      { label: "otp", help: "Your one-time password", masked: false, value: "" },
      { label: "password", help: "", masked: true, value: "" },
    ]);
    expect(api.sendRequest).not.toHaveBeenCalled();
    app.closeDialog("send", "", ["123456", "s3cret"]);
    await sending;
    expect(api.sendRequest).toHaveBeenCalledTimes(1);
    expect(sentPrompts()).toEqual({ otp: "123456", password: "s3cret" });
  });

  it("cancelling the form cancels the send", async () => {
    const tab = await promptingTab();
    const sending = app.send(tab.id);
    await answer("cancel");
    await sending;
    expect(api.sendRequest).not.toHaveBeenCalled();
    expect(app.runs[tab.id]).toBeUndefined();
    expect(await app.promptAnswers(tab)).toEqual({});
  });

  it("remembers the values: a second send, or one after reopening the tab, doesn't ask again", async () => {
    const tab = await promptingTab();
    const first = app.send(tab.id);
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    app.closeDialog("send", "", ["123456", "s3cret"]);
    await first;

    await app.send(tab.id);
    await app.closeTab(tab.id);
    await app.openRequest(PATH, { index: 0 });
    await app.send(app.activeTabId!);
    expect(app.dialog).toBeNull();
    expect(api.sendRequest).toHaveBeenCalledTimes(3);
    expect(sentPrompts(2)).toEqual({ otp: "123456", password: "s3cret" });
  });

  it("asks only for prompts without a remembered value, and again for all after forgetting", async () => {
    const tab = await promptingTab();
    const first = app.send(tab.id);
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    app.closeDialog("send", "", ["123456", "s3cret"]);
    await first;

    app.requestFor(tab)!.directives.push({ name: "prompt", value: "user Who to log in as" });
    const second = app.send(tab.id);
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    expect(app.dialog!.fields!.map((f) => f.label)).toEqual(["user"]);
    app.closeDialog("send", "", ["ann"]);
    await second;
    expect(sentPrompts(1)).toEqual({ otp: "123456", password: "s3cret", user: "ann" });

    await app.forgetPrompts(tab);
    expect(await app.promptAnswers(tab)).toEqual({});
    const third = app.send(tab.id);
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    expect(app.dialog!.fields!.map((f) => f.label)).toEqual(["otp", "password", "user"]);
    app.closeDialog("cancel");
    await third;
  });

  it("are remembered per request", async () => {
    const f = fileOf(["GET", "A", "https://x/a"], ["GET", "B", "https://x/b"]);
    for (const r of f.requests) r.directives = [{ name: "prompt", value: "otp" }];
    const [a, b] = await openAll(f);
    const first = app.send(a.id);
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    app.closeDialog("send", "", ["1"]);
    await first;
    const second = app.send(b.id);
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    app.closeDialog("cancel");
    await second;
    expect(api.sendRequest).toHaveBeenCalledTimes(1);
  });

  it("are kept in the Session, which the send and the resolved preview read by the request's key", async () => {
    const tab = await promptingTab();
    api.previewRequest.mockResolvedValue(null);
    const sending = app.send(tab.id);
    await vi.waitFor(() => expect(app.dialog).not.toBeNull());
    app.closeDialog("send", "", ["1", "2"]);
    await sending;
    expect(api.answerPrompts).toHaveBeenCalledWith(tab.key, { otp: "1", password: "2" });
    expect(api.sendRequest.mock.calls[0][0]).toMatchObject({ requestKey: tab.key });
    expect(api.sendRequest.mock.calls[0][0]).not.toHaveProperty("promptValues");
    await app.preview(tab);
    expect(api.previewRequest.mock.calls[0][0]).toMatchObject({ requestKey: tab.key });
  });

  it("a request without prompts is sent at once, without asking the Session", async () => {
    readHttpFile.mockResolvedValueOnce(fileOf(["GET", "Plain", "https://x"]));
    await app.openRequest("/ws/api/plain.http", { index: 0 });
    void app.send(app.activeTabId!);
    expect(app.runs[app.activeTabId!]?.loading).toBe(true);
    expect(api.promptAnswers).not.toHaveBeenCalled();
  });

  it("opening a workspace tells views showing the Session's answers to read them again", async () => {
    openWorkspace.mockResolvedValue({ root: "/other", tree: { name: "other", path: "/other", kind: "dir", children: [] }, gitignoreUpdated: false });
    getSettings.mockResolvedValue(null);
    loadEnvironments.mockResolvedValue({ shared: [], environments: [], privateFileIgnored: null });
    const before = app.sessionVersion;
    await app.openWorkspace("/other");
    expect(app.sessionVersion).not.toBe(before);
  });
});

describe("per-directory environments", () => {
  const env = (...names: string[]) => names.map((name) => ({ name, variables: [{ name: "host", value: name, secret: false }] }));
  const rootSet = { shared: [], environments: env("dev", "prod"), privateFileIgnored: null };
  const apiSet = { shared: [], environments: env("dev", "prod", "qa"), privateFileIgnored: null };
  const tree = { name: "ws", path: "/ws", kind: "dir" as const, children: [] };
  beforeEach(() => {
    app.root = "/ws";
    app.envName = null;
    app.envFolders = [];
    loadEnvironments.mockResolvedValue(rootSet);
    loadFolderEnvironments.mockResolvedValue([{ dir: "api", set: apiSet }]);
  });

  it("each request takes its own folder's environments, and the picker gets every name in the workspace", async () => {
    await app.loadEnvironments();
    expect(app.envSetFor("/ws/api/users/list.http")).toEqual(apiSet);
    expect(app.envSetFor("/ws/web/home.http")).toEqual(rootSet);
    expect(app.envNames).toEqual(["dev", "prod", "qa"]);
  });

  it("keeps a selected environment only a folder defines, also when the workspace opens", async () => {
    app.envName = "qa";
    await app.loadEnvironments();
    expect(app.envName).toBe("qa");

    getSettings.mockResolvedValue({ environments: { "/ws": "qa" } });
    openWorkspace.mockResolvedValueOnce({ root: "/ws", tree, gitignoreUpdated: false });
    await app.openWorkspace("/ws");
    expect(app.envName).toBe("qa");

    loadFolderEnvironments.mockResolvedValue([]);
    await app.loadEnvironments();
    expect(app.envName).toBeNull();
  });

  it("editing or adding a nested env file, or changing a folder, reloads them", async () => {
    await app.onExternalChange(["/ws/api/users/http-client.private.env.json"]);
    expect(loadFolderEnvironments).toHaveBeenCalledTimes(1);
    expect(app.envFolders).toEqual([{ dir: "api", set: apiSet }]);

    // A folder holding env files that's moved in or deleted is reported as the folder.
    await app.onExternalChange(["/ws/legacy"]);
    expect(loadFolderEnvironments).toHaveBeenCalledTimes(2);

    await app.onExternalChange(["/ws/api/pets.http"]);
    expect(loadFolderEnvironments).toHaveBeenCalledTimes(2);
  });

  it("moving or deleting a folder in the app reloads them (the watcher ignores the app's own changes)", async () => {
    await app.movePath("/ws/api.http", "/ws/v1.http");
    expect(loadFolderEnvironments).not.toHaveBeenCalled();
    await app.movePath("/ws/api", "/ws/v1");
    expect(loadFolderEnvironments).toHaveBeenCalledTimes(1);

    const deleting = app.deletePath("/ws/v1");
    await answer("delete");
    await deleting;
    expect(loadFolderEnvironments).toHaveBeenCalledTimes(2);
  });

  it("a folder's env file that can't be read is reported, and the root's environments still load", async () => {
    loadFolderEnvironments.mockRejectedValueOnce("api/http-client.env.json is not a valid environment file");
    await app.loadEnvironments();
    expect(app.envSet).toEqual(rootSet);
    expect(app.envFolders).toEqual([]);
    expect(app.toasts.map((t) => t.message)).toEqual(["api/http-client.env.json is not a valid environment file"]);
  });
});

describe("Extract to variable", () => {
  beforeEach(() => {
    app.root = "/ws";
    app.settings = null;
    app.envName = null;
    app.envSet = { shared: [], environments: [], privateFileIgnored: true };
    app.closeExtraction(null);
  });

  it("to a File variable: adds an @name line at the top of the file, unsaved, and returns the name", async () => {
    const [tab] = await openAll(fileOf(["GET", "List", "https://api.example.com/books"]));
    const extracting = app.extractVariable(tab.id, "https://api.example.com");
    await vi.waitFor(() => expect(app.extraction).not.toBeNull());
    expect(app.extraction!.value).toBe("https://api.example.com");
    app.closeExtraction({ name: "baseUrl", target: { kind: "file" } });

    expect(await extracting).toBe("baseUrl");
    expect(app.docs[PATH].file.header.variables).toEqual([{ name: "baseUrl", value: "https://api.example.com" }]);
    expect(app.isDocDirty(PATH)).toBe(true);
    expect(saveHttpFile).not.toHaveBeenCalled();
    expect(app.extraction).toBeNull();
  });

  /** Two environments; `staging` already has a Secret. */
  const twoEnvs = () => ({
    shared: [{ name: "version", value: "v1", secret: false }],
    environments: [
      { name: "local", variables: [{ name: "token", value: "dev", secret: false }] },
      { name: "staging", variables: [{ name: "token", value: "s3cret", secret: true }] },
    ],
    privateFileIgnored: true,
  });
  /** Extracts `value` from the tab's request with `choice` and returns what the store returned. */
  async function extract(tabId: string, value: string, choice: ExtractChoice | null) {
    const extracting = app.extractVariable(tabId, value);
    await vi.waitFor(() => expect(app.extraction).not.toBeNull());
    app.closeExtraction(choice);
    return extracting;
  }

  it("to the selected environment: saves it in that environment's env file and reloads the environments", async () => {
    app.envSet = twoEnvs();
    app.envName = "staging";
    api.saveEnvironments.mockResolvedValue({ gitignoreUpdated: false });
    loadEnvironments.mockResolvedValue(twoEnvs());
    const [tab] = await openAll(fileOf(["GET", "List", "https://api.example.com/books"]));

    expect(await extract(tab.id, "https://api.example.com", { name: "baseUrl", target: { kind: "env", env: "staging" } })).toBe("baseUrl");

    const saved = api.saveEnvironments.mock.calls[0][0];
    expect(saved.environments).toEqual([
      { name: "local", variables: [{ name: "token", value: "dev", secret: false }] },
      {
        name: "staging",
        variables: [
          { name: "token", value: "s3cret", secret: true },
          { name: "baseUrl", value: "https://api.example.com", secret: false },
        ],
      },
    ]);
    expect(saved.shared).toEqual([{ name: "version", value: "v1", secret: false }]);
    expect(loadEnvironments).toHaveBeenCalled();
    expect(app.docs[PATH].file.header.variables).toEqual([]);
  });

  it("to all environments: sets the same value in each, replacing a same-named one in place (a Secret stays a Secret)", async () => {
    app.envSet = twoEnvs();
    api.saveEnvironments.mockResolvedValue({ gitignoreUpdated: false });
    loadEnvironments.mockResolvedValue(twoEnvs());
    const [tab] = await openAll(fileOf(["GET", "List", "https://api.example.com/books?key=abc"]));

    expect(await extract(tab.id, "abc", { name: "token", target: { kind: "all" } })).toBe("token");

    expect(api.saveEnvironments.mock.calls[0][0].environments).toEqual([
      { name: "local", variables: [{ name: "token", value: "abc", secret: false }] },
      { name: "staging", variables: [{ name: "token", value: "abc", secret: true }] },
    ]);
    expect(app.toasts.map((t) => t.message)).toContain("Added token to every environment");
  });

  it("returns null when the env files can't be written, or when cancelled, so the field keeps its text", async () => {
    app.envSet = twoEnvs();
    api.saveEnvironments.mockRejectedValue("disk full");
    const [tab] = await openAll(fileOf(["GET", "List", "https://api.example.com/books"]));

    expect(await extract(tab.id, "https://api.example.com", { name: "baseUrl", target: { kind: "env", env: "local" } })).toBeNull();
    expect(app.toasts.map((t) => t.message)).toContain("Could not save environments: disk full");

    expect(await extract(tab.id, "https://api.example.com", null)).toBeNull();
    expect(app.docs[PATH].file.header.variables).toEqual([]);
    expect(app.isDocDirty(PATH)).toBe(false);
  });

  it("from a request in a nested folder: writes to the folders whose env files supply each environment to it", async () => {
    // PATH is in api/. dev's public file is the root's, its private one api/'s; qa is api/'s only.
    const rootPair = () => ({ shared: [], environments: [{ name: "dev", variables: [{ name: "host", value: "h", secret: false }] }], privateFileIgnored: true });
    const apiPair = () => ({
      shared: [],
      environments: [
        { name: "dev", variables: [{ name: "token", value: "old", secret: true }] },
        { name: "qa", variables: [] },
      ],
      privateFileIgnored: true,
    });
    app.envSet = rootPair();
    app.envFolders = [
      {
        dir: "api",
        set: {
          shared: [],
          environments: [
            { name: "dev", source: { public: "", private: "api" }, variables: [{ name: "host", value: "h", secret: false }, { name: "token", value: "old", secret: true }] },
            { name: "qa", source: { public: "api" }, variables: [] },
          ],
          privateFileIgnored: true,
        },
      },
    ];
    loadEnvironments.mockImplementation(async (dir?: string) => (dir === "api" ? apiPair() : rootPair()));
    api.saveEnvironments.mockResolvedValue({ gitignoreUpdated: false });
    const [tab] = await openAll(fileOf(["GET", "List", "https://api.example.com/books?key=abc"]));

    expect(await extract(tab.id, "abc", { name: "token", target: { kind: "all" } })).toBe("token");
    expect(api.saveEnvironments.mock.calls).toEqual([
      [
        {
          shared: [],
          environments: [
            { name: "dev", variables: [{ name: "token", value: "abc", secret: true }] },
            { name: "qa", variables: [{ name: "token", value: "abc", secret: false }] },
          ],
          privateFileIgnored: true,
        },
        "api",
      ],
    ]);

    // A new value of dev goes to the root, whose shareable file supplies dev here.
    api.saveEnvironments.mockClear();
    app.envName = "dev";
    await extract(tab.id, "https://api.example.com", { name: "baseUrl", target: { kind: "env", env: "dev" } });
    expect(api.saveEnvironments.mock.calls[0][1]).toBe("");
    expect(api.saveEnvironments.mock.calls[0][0].environments[0].variables).toContainEqual({ name: "baseUrl", value: "https://api.example.com", secret: false });
  });

  it("to a File variable that exists: replaces the value of the definition the request uses, adding no line", async () => {
    const f = fileOf(["GET", "A", "https://a.example.com/x"], ["GET", "B", "https://b.example.com/y"]);
    f.header.variables = [{ name: "host", value: "old" }, { name: "id", value: "1" }];
    f.requests[1].variables = [{ name: "host", value: "own" }];
    const [a, b] = await openAll(f);
    const file = () => app.docs[PATH].file;

    await extract(a.id, "https://a.example.com", { name: "host", target: { kind: "file" } });
    expect(file().header.variables).toEqual([{ name: "host", value: "https://a.example.com" }, { name: "id", value: "1" }]);

    // B declares its own @host, which wins over the file's, so that one changes.
    await extract(b.id, "https://b.example.com", { name: "host", target: { kind: "file" } });
    expect(file().requests[1].variables).toEqual([{ name: "host", value: "https://b.example.com" }]);
    expect(file().header.variables[0]).toEqual({ name: "host", value: "https://a.example.com" });
  });
});
