// Store behaviour that depends on async ordering (concurrent loads of the same
// file, refreshing documents the app itself rewrote), Orphaned tabs and search.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpFile, HttpResponse } from "./types";
import { newRequest } from "./http";

const { readHttpFile, saveHttpFile, createFile, createDir, renamePath, pathExists, searchRequests, openWorkspace, getSettings, loadEnvironments } =
  vi.hoisted(() => ({
    readHttpFile: vi.fn(),
    saveHttpFile: vi.fn(),
    createFile: vi.fn(),
    createDir: vi.fn(),
    renamePath: vi.fn(),
    pathExists: vi.fn(),
    searchRequests: vi.fn(),
    openWorkspace: vi.fn(),
    getSettings: vi.fn(),
    loadEnvironments: vi.fn(),
  }));
vi.mock("./api", () => ({
  api: { readHttpFile, saveHttpFile, createFile, createDir, renamePath, pathExists, searchRequests, openWorkspace, getSettings, loadEnvironments },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTitle: async () => {} }) }));

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
  for (const fn of [readHttpFile, saveHttpFile, createFile, createDir, searchRequests]) fn.mockReset();
  renamePath.mockReset().mockResolvedValue(undefined);
  pathExists.mockReset().mockResolvedValue(true);
  app.dialog = null;
  app.toasts = [];
  app.tree = null;
  app.docs = {};
  app.tabs = [];
  app.activeTabId = null;
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
