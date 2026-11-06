// Store behaviour that depends on async ordering: concurrent loads of the same
// file and refreshing open documents after the app itself rewrote them.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpFile } from "./types";
import { newRequest } from "./http";

const { readHttpFile, createFile, createDir, renamePath } = vi.hoisted(() => ({
  readHttpFile: vi.fn(),
  createFile: vi.fn(),
  createDir: vi.fn(),
  renamePath: vi.fn(),
}));
vi.mock("./api", () => ({ api: { readHttpFile, createFile, createDir, renamePath }, errorMessage: (e: unknown) => String(e) }));
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
  for (const fn of [readHttpFile, createFile, createDir, renamePath]) fn.mockReset();
  app.dialog = null;
  app.toasts = [];
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
