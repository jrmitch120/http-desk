// Store behaviour that depends on async ordering (concurrent loads of the same
// file, refreshing documents the app itself rewrote) and Orphaned tabs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpFile, HttpResponse } from "./types";
import { newRequest } from "./http";

const { readHttpFile, saveHttpFile } = vi.hoisted(() => ({ readHttpFile: vi.fn(), saveHttpFile: vi.fn() }));
vi.mock("./api", () => ({ api: { readHttpFile, saveHttpFile }, errorMessage: (e: unknown) => String(e) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));

import { app } from "./store.svelte";

const PATH = "/ws/api/books.http";

function file(...names: string[]): HttpFile {
  return {
    header: { comments: [], variables: [], raw: null },
    requests: names.map((n) => ({ ...newRequest(n), url: `https://example.com/${n}` })),
    trailing: "",
    lineEnding: "lf",
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
  readHttpFile.mockReset();
  saveHttpFile.mockReset();
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
