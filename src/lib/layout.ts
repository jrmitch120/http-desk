// The Layout (GLOSSARY): how the user left a workspace, saved per workspace by
// the shell (src-tauri/src/layout.rs) and brought back when it reopens. Paths
// are relative to the workspace root and `/`-separated, so the document doesn't
// care how the root is spelled. Unsaved edits, the sidebar search, response
// filters and pane sizes are never part of it.
import { newResponseView, type RequestSection, type ResponseView } from "./tabView";
import type { BodyMode } from "./bodyView.svelte";

/** An open tab: its request (as last saved: `###` name, method, URL, and its
 *  index in the file, if it's still there) and how the tab showed it. */
export interface LayoutTab {
  path: string;
  name: string;
  method: string;
  url: string;
  position: number | null;
  section: RequestSection;
  responseView: ResponseView;
}

export interface Layout {
  tabs: LayoutTab[];
  /** Index of the active tab in `tabs`. */
  active: number | null;
  /** The expanded folders and files ("" is the root). */
  expanded: string[];
}

/** How long the Layout waits for changes to settle before it's saved. */
export const LAYOUT_SETTLE_MS = 400;

const parts = (p: string) => p.split(/[\\/]/).filter(Boolean);

/** `path` relative to workspace `root`, `/`-separated; null if it's outside the workspace. */
export function inWorkspace(root: string, path: string): string | null {
  const r = parts(root);
  const p = parts(path);
  return r.every((x, i) => p[i] === x) ? p.slice(r.length).join("/") : null;
}

/** The absolute path of `rel` (relative to `root`), with the root's separator. */
export function fromWorkspace(root: string, rel: string): string {
  if (!rel) return root;
  const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return (root.endsWith(sep) ? root : root + sep) + rel.split("/").join(sep);
}

const SECTIONS: RequestSection[] = ["params", "headers", "auth", "body", "settings"];
const MODES: BodyMode[] = ["pretty", "raw", "preview"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : null);

function readTab(v: unknown): LayoutTab | null {
  if (!isObject(v)) return null;
  const [path, name, method, url] = [str(v.path), str(v.name), str(v.method), str(v.url)];
  if (path === null || name === null || method === null || url === null) return null;
  const position = typeof v.position === "number" && Number.isInteger(v.position) && v.position >= 0 ? v.position : null;
  const section = SECTIONS.find((s) => s === v.section) ?? "params";
  const view = isObject(v.responseView) ? v.responseView : {};
  const fallback = newResponseView();
  const responseView: ResponseView = {
    tab: str(view.tab) ?? fallback.tab,
    mode: MODES.find((m) => m === view.mode) ?? fallback.mode,
    wrap: typeof view.wrap === "boolean" ? view.wrap : fallback.wrap,
  };
  return { path, name, method, url, position, section, responseView };
}

/** What `load_layout` returned, as a Layout: none, or anything damaged, is an empty
 *  one; a damaged tab is left out, and anything else unusable takes its default. */
export function readLayout(value: unknown): Layout {
  const v = isObject(value) ? value : {};
  const tabs: LayoutTab[] = [];
  let active: number | null = null;
  (Array.isArray(v.tabs) ? v.tabs : []).forEach((t, i) => {
    const tab = readTab(t);
    if (!tab) return;
    if (i === v.active) active = tabs.length;
    tabs.push(tab);
  });
  const expanded = Array.isArray(v.expanded) ? v.expanded.filter((e): e is string => typeof e === "string") : [];
  return { tabs, active, expanded };
}
