// A tab, and what it shows besides its request: the request section and the response
// view. Both are part of the Layout; the response filter isn't, so it stays with the viewer.
import type { BodyMode } from "./bodyView.svelte";
import { uid } from "./http";

/** The request editor's sections. */
export type RequestSection = "params" | "headers" | "auth" | "body" | "settings";

/** How a response viewer shows its response: the viewer tab (Body, Headers, …), the body's mode and wrap. */
export interface ResponseView {
  tab: string;
  mode: BodyMode;
  wrap: boolean;
}

/** What every tab has: its id and the file it shows. */
interface TabBase {
  id: string;
  path: string;
  /**
   * A tab restored from the Layout whose file hasn't been read yet: what it shows as the
   * Layout has it (a request's method and name: its `###` title, else its method and
   * URL; a file view's file name), shown until it re-attaches (or is dropped).
   */
  restoring?: { method: string; name: string };
  /**
   * The workspace's Preview tab (at most one): the next navigation replaces it in place.
   * Absent on a kept tab, which only the user closes.
   */
  preview?: true;
}

/** A tab on a request of a document (by file and the document's key for it), and how it shows it. */
export interface RequestTab extends TabBase {
  kind: "request";
  key: string;
  /** The request section shown (part of the Layout). */
  section: RequestSection;
  /** How the response viewer shows the tab's response (part of the Layout). */
  responseView: ResponseView;
}

/** A file view: the whole file as one text (one per file, with no request of its own). */
export interface FileTab extends TabBase {
  kind: "file";
}

/** An editor tab: a request of a document, or a file view of the document. */
export type Tab = RequestTab | FileTab;

/** Whether `tab` is on a request (not a file view). */
export const isRequestTab = (tab: Tab | null | undefined): tab is RequestTab => tab?.kind === "request";

export const newResponseView = (): ResponseView => ({ tab: "body", mode: "pretty", wrap: false });

/** A new tab's view: Params, and the response on Body in Pretty without wrap. */
export const newTabView = (): { section: RequestSection; responseView: ResponseView } => ({ section: "params", responseView: newResponseView() });

/** A new tab on request `key` of the file at `path`, with a new view unless given one. */
export const newTab = (path: string, key: string, view: Pick<RequestTab, "section" | "responseView"> = newTabView()): RequestTab => ({
  id: uid(),
  kind: "request",
  path,
  key,
  section: view.section,
  responseView: { ...view.responseView },
});

/** A file view of the file at `path`: the whole file as one text. */
export const newFileTab = (path: string): FileTab => ({ id: uid(), kind: "file", path });
