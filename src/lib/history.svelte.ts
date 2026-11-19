// History as the page sees it (GLOSSARY "History"; ADR-0009). The shell records each
// send from a tab and keeps the entries; the page keeps what follows from them: a
// revision that goes up after each send (so History views list again), whether each
// tab's response pane shows its request's History, and the entry each History view
// (`HistoryViewId`: a tab's, or the sidebar's) has opened.
// An opened entry shows read-only in a response viewer under a pseudo tab, its
// response a copy with its own id, released when it's closed (ADR-0006). Compare
// shows two responses side by side (an entry and the tab's current response, or two
// entries); the entries it opens are released the same way when it closes. It also
// turns the History switch (an app setting) on and off, deletes an entry, and clears
// the workspace's or all History, closing the opened entries that go with them.
import { api, errorMessage } from "./api";
import { CANCEL, type DialogButton } from "./dialog";
import { getDirective, uid } from "./http";
import { newTab } from "./tabView";
import type { RunState, Tab } from "./store.svelte";
import type { HistoryEntry, HistoryLink, HistorySettings, HistorySummary, HttpResponse, Request } from "./types";
import type { CompareSide } from "./compare";

/** What History's page state needs from the rest of the store. */
export interface HistoryHost {
  /** The response viewers' state by tab id, where an opened entry shows under a pseudo tab. */
  readonly runs: Record<string, RunState>;
  releaseResponse(response: HttpResponse | undefined): void;
  toast(kind: "error" | "success", message: string): void;
  choose(title: string, message: string, buttons: DialogButton[]): Promise<{ button: string }>;
  /** History's settings; null until the settings have loaded. */
  readonly settings: HistorySettings | null;
  /** Applies and saves History's settings; false if they couldn't be saved. */
  updateSettings(history: HistorySettings): Promise<boolean>;
}

/** An entry opened from a History view: its summary, the pseudo tab its response shows under, and its source text (to restore). */
export type OpenedEntry = { entry: HistorySummary; tab: Tab; source: string };

/**
 * A History view, which can have one entry open: an editor tab's (its request's
 * History, in its response pane) or the sidebar's (the whole workspace's).
 */
export type HistoryViewId = { tab: string } | typeof WORKSPACE_HISTORY;

/** The sidebar's History view (the whole workspace's). */
export const WORKSPACE_HISTORY = "workspace";

/** What `opened` keeps a view's entry under: no tab id can be the sidebar's. */
const viewKey = (view: HistoryViewId) => (view === WORKSPACE_HISTORY ? view : `tab:${view.tab}`);

/** How many entries a History view lists at a time; scrolling to the end lists the next. */
export const HISTORY_PAGE = 50;

/** Retention's defaults (Settings → History), for every workspace; the shell's are in src-tauri/src/lib.rs. */
export const HISTORY_RETENTION = { maxPerRequest: 50, maxAgeDays: 30, maxSizeMb: 200 } as const;

/** Retention's limits, for every workspace (`HistorySettings` without the switch). */
export type HistoryRetention = Omit<HistorySettings, "enabled">;

const BODY_CAP_MB = 10;

/** The most of a body a History entry keeps (core `history::BODY_CAP`): 10 MB. */
export const HISTORY_BODY_CAP = BODY_CAP_MB * 1024 * 1024;

/** History's body cap as the UI says it: "10 MB". */
export const HISTORY_BODY_CAP_TEXT = `${BODY_CAP_MB} MB`;

/** What the viewer says of a body History cut off at its cap. */
export const TRUNCATED_AT_CAP = `Truncated at ${HISTORY_BODY_CAP_TEXT}`;

/** What links a request's History entries to it: its file and `# @name`, else its file, method and URL. */
export function historyLink(path: string, req: Request): HistoryLink {
  return { filePath: path, name: getDirective(req, "name")?.trim() || null, method: req.method, url: req.url };
}

/**
 * What a link's request is known by (as the core's `history::REQUEST`): its file and
 * `# @name`, else its file, method and URL. Two links with the same key are of the
 * same request; a named request's URL can change under it.
 */
export function historyLinkKey(link: HistoryLink): string {
  return JSON.stringify(link.name ? [link.filePath, link.name] : [link.filePath, null, link.method, link.url]);
}

/**
 * Whether entries `a` and `b` (of one workspace) were sent from the same request, as
 * far as their summaries say: the same file and `# @name`, or for an unnamed request
 * the same method and URL as sent.
 */
const sameRequest = (a: HistorySummary, b: HistorySummary) =>
  a.file === b.file && a.name === b.name && (a.name !== null || (a.method === b.method && a.url === b.url));

/** When an entry was sent (RFC 3339): the time of day today, else the date and time. */
export function sentAt(time: string, now = new Date()): string {
  const at = new Date(time);
  return at.toDateString() === now.toDateString() ? at.toLocaleTimeString() : at.toLocaleString();
}

/** What an entry is compared with: a response (the tab's current one), or another entry. */
export type CompareTarget = { response: HttpResponse } | { entry: HistorySummary };

/** A comparison shown in the Compare view: two sides, the older on the left (`a`). */
export type Comparison = { id: string; a: CompareSide; b: CompareSide };

/**
 * What Compare on `entries[i]` (a History list, newest first) compares it with: the
 * tab's `current` response, unless it came from History (it's then an entry's, maybe
 * this one's); else the next newer entry of the same request: the one just above in a
 * request's list, the nearest above of its request in a list that `mixes` requests
 * (the sidebar's). Nothing for its request's newest entry with no current response.
 */
export function compareTarget(entries: HistorySummary[], i: number, current?: RunState, mixes = false): CompareTarget | undefined {
  if (current?.response && !current.fromHistory) return { response: current.response };
  for (let j = i - 1; j >= 0; j--) if (!mixes || sameRequest(entries[j], entries[i])) return { entry: entries[j] };
  return undefined;
}

/** A tab's response state showing History entry `whole`, opened (no `runId`). */
function runOf(whole: HistoryEntry, fromHistory?: string): Omit<RunState, "runId"> {
  return {
    loading: false,
    startedAt: 0,
    response: whole.response ?? undefined,
    error: whole.sendError ?? undefined,
    cancelled: whole.cancelled || undefined,
    bodyKept: whole.bodyKept,
    fromHistory,
  };
}

export class HistoryStore {
  constructor(private readonly host: HistoryHost) {}

  /** The comparison the Compare view shows, if any. */
  comparison = $state<Comparison | null>(null);
  /** The entries' responses opened for the comparison, released when it closes (ADR-0006). */
  private comparing: HttpResponse[] = [];
  /** The ids of the entries compared. */
  private compared: number[] = [];
  /** Goes up with each compare and close, so a compare that finishes late knows it's stale. */
  private compareRun = 0;

  /** Goes up after every send from a tab, so History views list their entries again. */
  revision = $state(0);

  /** The editor tabs whose response pane shows their request's History. */
  private shownIn = $state<Record<string, true>>({});
  /** The entry each History view has opened, by `viewKey`. */
  private opened = $state<Record<string, OpenedEntry>>({});

  /** Whether sends are recorded: the History switch. On until the settings say otherwise. */
  get enabled(): boolean {
    return this.host.settings?.enabled !== false;
  }

  /**
   * Turns the History switch on, or off once the user has said whether to also delete
   * what's stored (Keep or Delete; Cancel leaves it on).
   */
  async setEnabled(on: boolean) {
    const settings = this.host.settings;
    if (!settings || settings.enabled === on) return;
    if (on) {
      await this.host.updateSettings({ ...settings, enabled: true });
      return;
    }
    const r = await this.host.choose(
      "Also delete existing history?",
      "While History is off, nothing you send is recorded. The History already kept, for every workspace, can stay or be deleted.",
      [CANCEL, { label: "Delete", value: "delete", role: "destructive", danger: true }, { label: "Keep", value: "keep", role: "primary" }],
    );
    if (r.button !== "keep" && r.button !== "delete") return;
    const saved = await this.host.updateSettings({ ...settings, enabled: false });
    if (saved && r.button === "delete") await this.deleteAll();
  }

  /** Retention's limits (Settings → History): the defaults until the settings have loaded. */
  get retention(): HistoryRetention {
    const s = this.host.settings;
    return {
      maxPerRequest: s?.maxPerRequest ?? HISTORY_RETENTION.maxPerRequest,
      maxAgeDays: s?.maxAgeDays ?? HISTORY_RETENTION.maxAgeDays,
      maxSizeMb: s?.maxSizeMb ?? HISTORY_RETENTION.maxSizeMb,
    };
  }

  /** Changes retention's limits; the shell applies them to what's stored at once. */
  async setRetention(limits: Partial<HistoryRetention>) {
    const settings = this.host.settings;
    if (settings) await this.host.updateSettings({ ...settings, ...this.retention, ...limits });
  }

  /** Deletes every workspace's History once the user confirms (Settings → Clear all history). */
  async clearAll() {
    const r = await this.host.choose(
      "Clear all history?",
      "Every History entry of every workspace is deleted from this computer. This can't be undone.",
      [
        { ...CANCEL, focus: true },
        { label: "Clear all history", value: "clear", role: "primary", danger: true },
      ],
    );
    if (r.button === "clear" && (await this.deleteAll())) this.host.toast("success", "History cleared");
  }

  /** Deletes every workspace's History, closing the entries tabs have open; false if it failed. */
  private async deleteAll(): Promise<boolean> {
    try {
      await api.clearAllHistory();
    } catch (e) {
      this.host.toast("error", `Could not clear History: ${errorMessage(e)}`);
      return false;
    }
    this.closeWhere(() => true);
    this.revision++;
    return true;
  }

  /** Deletes `entry` once the user confirms, closing it wherever it's open. */
  async delete(entry: HistorySummary) {
    const r = await this.host.choose(
      "Delete this History entry?",
      `${entry.method} ${entry.url}, sent ${sentAt(entry.time)}, is deleted from this computer. This can't be undone.`,
      [
        { ...CANCEL, focus: true },
        { label: "Delete", value: "delete", role: "primary", danger: true },
      ],
    );
    if (r.button !== "delete") return;
    try {
      await api.deleteHistoryEntry(entry.id);
    } catch (e) {
      this.host.toast("error", `Could not delete the History entry: ${errorMessage(e)}`);
      return;
    }
    this.closeWhere((id) => id === entry.id);
    this.revision++;
  }

  /** Deletes the open workspace's History once the user confirms (Clear workspace history). */
  async clearWorkspace() {
    const r = await this.host.choose(
      "Clear workspace history?",
      "Every History entry of this workspace is deleted from this computer; other workspaces keep theirs. This can't be undone.",
      [
        { ...CANCEL, focus: true },
        { label: "Clear workspace history", value: "clear", role: "primary", danger: true },
      ],
    );
    if (r.button !== "clear") return;
    try {
      await api.clearWorkspaceHistory();
    } catch (e) {
      this.host.toast("error", `Could not clear History: ${errorMessage(e)}`);
      return;
    }
    this.closeWhere(() => true);
    this.revision++;
    this.host.toast("success", "Workspace history cleared");
  }

  /** Closes the opened entries, and the comparison, of the entries `deleted` says were deleted. */
  private closeWhere(deleted: (id: number) => boolean) {
    for (const [key, opened] of Object.entries(this.opened)) if (deleted(opened.entry.id)) this.closeKey(key);
    if (this.compared.some(deleted)) this.closeComparison();
  }

  /** Notes that a send from a tab finished: it may have been recorded. */
  sent() {
    this.revision++;
  }

  /** Whether tab `tabId`'s response pane shows its request's History. */
  isShown(tabId: string): boolean {
    return !!this.shownIn[tabId];
  }

  /**
   * Shows or hides tab `tabId`'s History view. With an entry open, goes back to the
   * list instead (like Back), so pressing History never leaves History from an entry.
   */
  toggle(tabId: string) {
    if (this.openedIn({ tab: tabId })) {
      this.close({ tab: tabId });
    } else if (this.shownIn[tabId]) {
      delete this.shownIn[tabId];
    } else {
      this.shownIn[tabId] = true;
    }
  }

  /** The entry History view `view` has opened, if any. */
  openedIn(view: HistoryViewId): OpenedEntry | undefined {
    return this.opened[viewKey(view)];
  }

  /** Opens `entry` read-only in History view `view`, in place of the one it had open. */
  async open(view: HistoryViewId, entry: HistorySummary) {
    let whole;
    try {
      whole = await api.openHistoryEntry(entry.id);
    } catch (e) {
      this.host.toast("error", errorMessage(e));
      return;
    }
    this.close(view);
    const tab: Tab = { ...newTab("", ""), id: `history:${uid()}` };
    this.host.runs[tab.id] = { runId: uid(), ...runOf(whole) };
    this.opened[viewKey(view)] = { entry, tab, source: whole.source };
  }

  /**
   * The latest History entry of request `req` of the file at `path`, as a tab's
   * response marked "from History" (its `fromHistory` the time it was sent); its
   * response has a kept body of its own (ADR-0006). Nothing while History is off,
   * for a request marked `# @no-log`, with no entry, or if History can't be read.
   * Never put into the Session (ADR-0009): Request variables still count it unsent.
   */
  async lastResponse(path: string, req: Request): Promise<Omit<RunState, "runId"> | null> {
    if (!this.enabled || getDirective(req, "no-log") !== undefined) return null;
    try {
      const [entry] = await api.listHistory({ request: historyLink(path, req), offset: 0, limit: 1 });
      if (!entry) return null;
      return runOf(await api.openHistoryEntry(entry.id), entry.time);
    } catch {
      // A tab comes back without a response rather than with an error about History.
      return null;
    }
  }

  /** Closes the entry History view `view` has open, releasing its copy of the response. */
  close(view: HistoryViewId) {
    this.closeKey(viewKey(view));
  }

  private closeKey(key: string) {
    const opened = this.opened[key];
    if (!opened) return;
    delete this.opened[key];
    this.host.releaseResponse(this.host.runs[opened.tab.id]?.response);
    delete this.host.runs[opened.tab.id];
  }

  /** Forgets tab `tabId` (it closed): its History view and the entry it opened. */
  forget(tabId: string) {
    this.close({ tab: tabId });
    delete this.shownIn[tabId];
  }

  /** Forgets every tab's History view, for another workspace. */
  reset() {
    for (const key of Object.keys(this.opened)) this.closeKey(key);
    this.shownIn = {};
    this.closeComparison();
  }

  /**
   * Compares `entry` with `against` in the Compare view, the older entry on the left
   * and the current response on the right. The entries open as responses of their own.
   */
  async compare(entry: HistorySummary, against: CompareTarget) {
    if ("entry" in against && against.entry.id === entry.id) return;
    const run = ++this.compareRun;
    const entries = "entry" in against ? [entry, against.entry].sort((x, y) => x.time.localeCompare(y.time) || x.id - y.id) : [entry];
    const results = await Promise.allSettled(entries.map((e) => api.openHistoryEntry(e.id)));
    const opened = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    const failed = results.find((r) => r.status === "rejected");
    if (failed || run !== this.compareRun) {
      for (const whole of opened) this.host.releaseResponse(whole.response ?? undefined);
      if (failed) this.host.toast("error", errorMessage(failed.reason));
      return;
    }
    this.closeComparison();
    this.comparing = opened.flatMap((whole) => (whole.response ? [whole.response] : []));
    this.compared = entries.map((e) => e.id);
    const side = (i: number): CompareSide => ({
      label: sentAt(entries[i].time),
      response: opened[i].response,
      error: opened[i].sendError?.message,
      cancelled: opened[i].cancelled,
    });
    const b = "response" in against ? { label: "current response", response: against.response } : side(1);
    this.comparison = { id: uid(), a: side(0), b };
  }

  /** Closes the Compare view, releasing the entries opened for it. */
  closeComparison() {
    this.compareRun++;
    for (const response of this.comparing) this.host.releaseResponse(response);
    this.comparing = [];
    this.compared = [];
    this.comparison = null;
  }
}
