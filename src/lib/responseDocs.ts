// The editor documents built for response bodies, kept per editor tab and
// view (Raw, Pretty, Hex) outside any component, so switching to another tab
// and back (which remounts the response viewer) shows the body again without
// fetching or building it again. Each is a CodeMirror `Text`, the only copy of
// the body's text the webview holds. A response's documents go when the tab
// releases the response (closed, replaced, or gone with the workspace).

import type { Text } from "@codemirror/state";

export type DocView = "raw" | "pretty" | "hex";

interface Kept {
  responseId: string;
  /** The document once built. */
  doc?: Text;
  /** The document on its way. */
  building: Promise<Text>;
}

/** By `tabId` and view. A tab keeps one document per view, of its latest response. */
const kept = new Map<string, Kept>();
const key = (tabId: string, view: DocView) => `${tabId}\n${view}`;

/** The document built for `tabId`'s `view` of response `responseId`, if there is one. */
export function keptDoc(tabId: string, view: DocView, responseId: string): Text | undefined {
  const k = kept.get(key(tabId, view));
  return k?.responseId === responseId ? k.doc : undefined;
}

/**
 * The document for `tabId`'s `view` of response `responseId`: the kept one,
 * the one already on its way, or else one `build` makes, which is kept once
 * done (unless the response was released meanwhile). `build` must not reject.
 */
export function loadDoc(tabId: string, view: DocView, responseId: string, build: () => Promise<Text>): Promise<Text> {
  const k = key(tabId, view);
  const existing = kept.get(k);
  if (existing?.responseId === responseId) return existing.doc ? Promise.resolve(existing.doc) : existing.building;
  const entry: Kept = { responseId, building: build() };
  kept.set(k, entry);
  void entry.building.then((doc) => {
    if (kept.get(k) === entry) entry.doc = doc;
  });
  return entry.building;
}

/** Drops every document of a released response. */
export function dropDocs(responseId: string): void {
  for (const [k, entry] of kept) if (entry.responseId === responseId) kept.delete(k);
}

/** How long building a document runs before giving the browser a turn. */
const BUILD_SLICE_MS = 8;

/**
 * A pause for `buildDoc` between pieces: once a slice of work has run for
 * `BUILD_SLICE_MS`, it waits for a new task, so input and paint get a turn.
 */
export function slicedPause(): () => Promise<void> {
  let start = performance.now();
  return async () => {
    if (performance.now() - start < BUILD_SLICE_MS) return;
    await new Promise((r) => setTimeout(r));
    start = performance.now();
  };
}
