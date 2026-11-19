// The open workspace's Layout as the page keeps it (GLOSSARY "Layout"; its shape and
// paths are layout.ts's): saved by the shell once its changes settle, saved at once
// before quitting or opening another workspace, and brought back when a workspace opens.
//
// Restoring shows the Layout's tabs at once, from what the Layout says of them, so a
// Layout with many tabs opens as fast as an empty workspace. Their files are read in
// the background, each afresh: as soon as one is read it becomes its document, its tabs
// re-attach to their requests as a reload does (`reattach`) and are ready, and those
// whose request is gone are dropped. Once every file is read, one note says how many
// were dropped. A tab's editor is built when it first shows. Each workspace opened
// restores on its own: a restore that another opening superseded stops, and saves nothing.
import { untrack } from "svelte";
import { api, errorMessage } from "./api";
import { findNode } from "./tree";
import { reattach, type KnownRequest } from "./reattach";
import { fromWorkspace, inWorkspace, LAYOUT_SETTLE_MS, readLayout, type Layout, type LayoutTab } from "./layout";
import { newTab, type Tab } from "./tabView";
import type { Doc } from "./store.svelte";
import type { Request, TreeNode } from "./types";
import { displayName, uid } from "./http";

/** What the Layout needs from the rest of the store. */
export interface LayoutHost {
  tabs: Tab[];
  activeTabId: string | null;
  expanded: Record<string, boolean>;
  readonly docs: Record<string, Doc>;
  /**
   * Reads the file at `path` afresh into its document, `prepare` seeing its requests
   * before they get keys (to re-attach them); whoever loads it meanwhile shares the
   * read. Null if it can't be read, or another workspace opened meanwhile.
   */
  readDoc(path: string, prepare: (requests: Request[]) => void): Promise<Doc | null>;
  /** Drops tab `id`, whose request is gone, as closing it would, without asking or remembering it. */
  removeTab(id: string): void;
  /** Restored tabs are about to show: each (by id) is re-attached, or dropped, once its promise settles. */
  restoring(ready: Map<string, Promise<void>>): void;
  toast(kind: "info" | "error", message: string): void;
}

export class LayoutStore {
  constructor(private readonly host: LayoutHost) {}

  /** The workspace whose Layout changes are saved; null while a workspace opens. */
  private savingFor = $state<string | null>(null);
  /** Goes up as each workspace opens, so a restore another opening superseded knows it. */
  private opens = 0;
  /** The Layout last queued for saving, as JSON, so an unchanged one isn't saved again. */
  private last = "";
  private pending: { root: string; layout: Layout } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The Layout saves under way, one after another, so an older one is never written last. */
  private saves: Promise<void> = Promise.resolve();

  /** Saves the Layout once its changes settle. Call it from an effect, which reruns on each change. */
  track() {
    const root = this.savingFor;
    if (!root) return;
    const layout = this.now(root);
    untrack(() => this.changed(root, layout));
  }

  /** Stops saving, for a workspace about to open; it saves again once its Layout is restored. */
  reset() {
    this.savingFor = null;
    this.last = "";
    this.opens++;
  }

  /** The workspace's Layout as it is now. Tabs whose request was never saved are
   *  left out (they can't be found again); the others are described as last saved. */
  private now(root: string): Layout {
    const { tabs: open, docs, activeTabId, expanded: shown } = this.host;
    const tabs: LayoutTab[] = [];
    let active: number | null = null;
    for (const t of open) {
      const doc = docs[t.path];
      const saved = doc?.saved[t.key];
      const path = inWorkspace(root, t.path);
      if (!saved || path === null) continue;
      const req = JSON.parse(saved) as Request;
      const position = doc.savedOrder.split(",").indexOf(t.key);
      if (t.id === activeTabId) active = tabs.length;
      tabs.push({
        path,
        name: req.name,
        method: req.method,
        url: req.url,
        title: displayName(req),
        position: position < 0 ? null : position,
        section: t.section,
        responseView: { ...t.responseView },
      });
    }
    const expanded = Object.keys(shown).flatMap((p) => {
      const rel = shown[p] ? inWorkspace(root, p) : null;
      return rel === null ? [] : [rel];
    });
    return { tabs, active, expanded };
  }

  /** Saves `layout` once changes stop for a moment. */
  private changed(root: string, layout: Layout) {
    const json = JSON.stringify(layout);
    if (json === this.last) return;
    this.last = json;
    this.pending = { root, layout };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), LAYOUT_SETTLE_MS);
  }

  /** Saves a Layout still settling now, and waits for every Layout save under way
   *  (before quitting or opening another workspace). */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const pending = this.pending;
    this.pending = null;
    if (pending) {
      this.saves = this.saves
        .then(() => api.saveLayout(pending.root, pending.layout))
        .catch((e) => this.host.toast("error", `Could not save the layout: ${errorMessage(e)}`));
    }
    return this.saves;
  }

  /**
   * Brings back the Layout saved for the workspace at `root` (whose tree is `tree`),
   * the one opening since `reset`: its tabs and the active one at once, and the
   * expanded folders. Their files are read after, in the background (see the module
   * docs); the Layout is saved again once every one is read.
   */
  async restore(root: string, tree: TreeNode) {
    const open = this.opens;
    let saved: unknown = null;
    try {
      saved = await api.loadLayout(root);
    } catch {
      // No Layout to restore: the workspace opens as it always did.
    }
    if (this.opens !== open) return;
    const layout = readLayout(saved);
    const tabs = layout.tabs.map((t): Tab => ({ ...newTab(fromWorkspace(root, t.path), uid(), t), restoring: { method: t.method, name: t.title ?? displayName(t) } }));
    this.host.restoring(this.reattach(open, root, layout.tabs, tabs));
    this.host.tabs = tabs;
    this.host.activeTabId = (layout.active === null ? undefined : tabs[layout.active]?.id) ?? tabs.at(-1)?.id ?? null;
    const expanded: Record<string, boolean> = { [root]: true };
    for (const p of layout.expanded.map((rel) => fromWorkspace(root, rel))) if (findNode(tree, p)) expanded[p] = true;
    this.host.expanded = expanded;
  }

  /**
   * Reads restored `tabs`' files (each once, together). As each is read, its tabs
   * (described by `described`) re-attach to their requests, or are dropped if theirs
   * is gone. Once all are read, says how many were dropped and saves the Layout again.
   * Nothing of it happens once another workspace has opened since `open`. Returns, by
   * tab id, when each tab is ready.
   */
  private reattach(open: number, root: string, described: LayoutTab[], tabs: Tab[]): Map<string, Promise<void>> {
    const known = new Map<string, KnownRequest[]>();
    tabs.forEach((t, i) => {
      const { name, method, url, position } = described[i];
      known.set(t.path, [...(known.get(t.path) ?? []), { key: t.key, name, method, url, position }]);
    });
    const ready = new Map<string, Promise<void>>();
    let dropped = 0;
    const reads = [...known].map(([path, requests]) => {
      const read = this.host.readDoc(path, (fresh) => reattach(requests, fresh)).then(() => {
        if (this.opens !== open) return;
        for (const { id, key } of tabs.filter((t) => t.path === path)) {
          const shown = this.host.tabs.find((t) => t.id === id);
          if (!shown) continue; // closed meanwhile
          if (this.host.docs[path]?.file.requests.some((r) => r._key === key)) {
            shown.restoring = undefined;
          } else {
            // The active tab's place goes to the one after it.
            this.host.removeTab(id);
            dropped++;
          }
        }
      });
      for (const t of tabs) if (t.path === path) ready.set(t.id, read);
      return read;
    });
    void Promise.all(reads).then(() => {
      if (this.opens !== open) return;
      if (dropped === 1) this.host.toast("info", "1 tab wasn't restored: its request no longer exists.");
      else if (dropped > 1) this.host.toast("info", `${dropped} tabs weren't restored: their requests no longer exist.`);
      this.savingFor = root;
    });
    return ready;
  }
}
