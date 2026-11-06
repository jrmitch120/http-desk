// Store behaviour that depends on async ordering: concurrent loads of the same
// file and refreshing open documents after the app itself rewrote them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpFile } from "./types";
import { newRequest } from "./http";

const { readHttpFile, renamePath, pathExists } = vi.hoisted(() => ({ readHttpFile: vi.fn(), renamePath: vi.fn(), pathExists: vi.fn() }));
vi.mock("./api", () => ({ api: { readHttpFile, renamePath, pathExists }, errorMessage: (e: unknown) => String(e) }));
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

beforeEach(() => {
  readHttpFile.mockReset();
  renamePath.mockReset().mockResolvedValue(undefined);
  pathExists.mockReset().mockResolvedValue(true);
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
