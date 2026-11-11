// The editor documents built for response bodies, kept per editor tab and
// view (Raw, Pretty, Hex) outside any component, so switching to another tab
// and back (which remounts the response viewer) shows the body again without
// fetching or building it again. Each is a CodeMirror `Text`, the only copy of
// the body's text the webview holds. Previews' `blob:` URLs are kept per tab
// the same way. A response's documents and preview go (its URL revoked) when
// the tab releases the response (closed, replaced, or gone with the workspace).

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

/** Drops every document and preview of a released response, revoking the preview's URL. */
export function dropDocs(responseId: string): void {
  for (const [k, entry] of kept) if (entry.responseId === responseId) kept.delete(k);
  for (const [tabId, preview] of previews) {
    if (preview.responseId !== responseId) continue;
    previews.delete(tabId);
    if (preview.made?.url) URL.revokeObjectURL(preview.made.url);
  }
}

/** A preview: its `blob:` URL, or why the body's bytes couldn't be fetched. */
export interface Preview {
  url?: string;
  error?: string;
}

interface KeptPreview {
  responseId: string;
  /** The preview once made. */
  made?: Preview;
  /** The preview on its way. */
  making: Promise<Preview>;
}

/** By `tabId`: the preview of the tab's latest response that has one. */
const previews = new Map<string, KeptPreview>();

/** The preview made for `tabId`'s response `responseId`, if there is one. */
export function keptPreview(tabId: string, responseId: string): Preview | undefined {
  const p = previews.get(tabId);
  return p?.responseId === responseId ? p.made : undefined;
}

/**
 * The preview for `tabId`'s response `responseId`: the kept one, the one on
 * its way, or else one `make` makes (`make` must not reject). Once made it
 * replaces the tab's preview of an earlier response, whose URL is revoked; if
 * the response was released (or replaced) meanwhile, its own URL is revoked.
 */
export function loadPreview(tabId: string, responseId: string, make: () => Promise<Preview>): Promise<Preview> {
  const existing = previews.get(tabId);
  if (existing?.responseId === responseId) return existing.made ? Promise.resolve(existing.made) : existing.making;
  const entry: KeptPreview = { responseId, making: make() };
  previews.set(tabId, entry);
  if (existing?.made?.url) URL.revokeObjectURL(existing.made.url);
  return entry.making.then((made) => {
    if (previews.get(tabId) === entry) entry.made = made;
    else if (made.url) URL.revokeObjectURL(made.url);
    return made;
  });
}
