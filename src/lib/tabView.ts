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

/** An editor tab: a request of a document (by file and the document's key for it) and how the tab shows it. */
export interface Tab {
  id: string;
  path: string;
  key: string;
  /** The request section shown (part of the Layout). */
  section: RequestSection;
  /** How the response viewer shows the tab's response (part of the Layout). */
  responseView: ResponseView;
  /**
   * A tab restored from the Layout whose file hasn't been read yet: its request's
   * method and name as the Layout has them (its `###` title, else its method and URL),
   * shown until it re-attaches (or is dropped).
   */
  restoring?: { method: string; name: string };
}

export const newResponseView = (): ResponseView => ({ tab: "body", mode: "pretty", wrap: false });

/** A new tab's view: Params, and the response on Body in Pretty without wrap. */
export const newTabView = (): { section: RequestSection; responseView: ResponseView } => ({ section: "params", responseView: newResponseView() });

/** A new tab on request `key` of the file at `path`, with a new view unless given one. */
export const newTab = (path: string, key: string, view: Pick<Tab, "section" | "responseView"> = newTabView()): Tab => ({
  id: uid(),
  path,
  key,
  section: view.section,
  responseView: { ...view.responseView },
});
