// What a tab shows besides its request: the request section and the response view.
// Both are part of the Layout; the response filter isn't, so it stays with the viewer.
import type { BodyMode } from "./bodyView.svelte";

/** The request editor's sections. */
export type RequestSection = "params" | "headers" | "auth" | "body" | "settings";

/** How a response viewer shows its response: the viewer tab (Body, Headers, …), the body's mode and wrap. */
export interface ResponseView {
  tab: string;
  mode: BodyMode;
  wrap: boolean;
}

export const newResponseView = (): ResponseView => ({ tab: "body", mode: "pretty", wrap: false });

/** A new tab's view: Params, and the response on Body in Pretty without wrap. */
export const newTabView = (): { section: RequestSection; responseView: ResponseView } => ({ section: "params", responseView: newResponseView() });
