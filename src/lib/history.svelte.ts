// History as the page sees it (GLOSSARY "History"; ADR-0009). The shell records each
// send from a tab and keeps the entries; the page keeps what follows from them: a
// revision that goes up after each send (so History views list again), whether each
// tab's response pane shows its request's History, and the entry a tab has opened.
// An opened entry shows read-only in a response viewer under a pseudo tab, its
// response a copy with its own id, released when it's closed (ADR-0006). It also
// turns the History switch (an app setting) on and off, and clears all History.
import { api, errorMessage } from "./api";
import { CANCEL, type DialogButton } from "./dialog";
import { getDirective, uid } from "./http";
import { newTabView } from "./tabView";
import type { RunState, Tab } from "./store.svelte";
import type { HistoryLink, HistorySettings, HistorySummary, HttpResponse, Request } from "./types";

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

/** An entry opened from a History view: its summary, and the pseudo tab its response shows under. */
export type OpenedEntry = { entry: HistorySummary; tab: Tab };

/** What links a request's History entries to it: its file and `# @name`, else its file, method and URL. */
export function historyLink(path: string, req: Request): HistoryLink {
  return { filePath: path, name: getDirective(req, "name")?.trim() || null, method: req.method, url: req.url };
}

/** When an entry was sent (RFC 3339): the time of day today, else the date and time. */
export function sentAt(time: string, now = new Date()): string {
  const at = new Date(time);
  return at.toDateString() === now.toDateString() ? at.toLocaleTimeString() : at.toLocaleString();
}

export class HistoryStore {
  constructor(private readonly host: HistoryHost) {}

  /** Goes up after every send from a tab, so History views list their entries again. */
  revision = $state(0);

  /** The editor tabs whose response pane shows their request's History. */
  private shownIn = $state<Record<string, true>>({});
  /** The entry each editor tab has opened from its History view. */
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
    for (const tabId of Object.keys(this.opened)) this.close(tabId);
    this.revision++;
    return true;
  }

  /** Notes that a send from a tab finished: it may have been recorded. */
  sent() {
    this.revision++;
  }

  /** Whether tab `tabId`'s response pane shows its request's History. */
  isShown(tabId: string): boolean {
    return !!this.shownIn[tabId];
  }

  /** Shows or hides tab `tabId`'s History view; hiding it closes the entry it opened. */
  toggle(tabId: string) {
    if (this.shownIn[tabId]) {
      this.close(tabId);
      delete this.shownIn[tabId];
    } else {
      this.shownIn[tabId] = true;
    }
  }

  /** The entry tab `tabId` has opened, if any. */
  openedIn(tabId: string): OpenedEntry | undefined {
    return this.opened[tabId];
  }

  /** Opens `entry` read-only in tab `tabId`'s History view, in place of the one it had open. */
  async open(tabId: string, entry: HistorySummary) {
    let whole;
    try {
      whole = await api.openHistoryEntry(entry.id);
    } catch (e) {
      this.host.toast("error", errorMessage(e));
      return;
    }
    this.close(tabId);
    const tab: Tab = { id: `history:${uid()}`, path: "", key: "", ...newTabView() };
    this.host.runs[tab.id] = {
      runId: uid(),
      loading: false,
      startedAt: 0,
      response: whole.response ?? undefined,
      error: whole.sendError ?? undefined,
      cancelled: whole.cancelled || undefined,
    };
    this.opened[tabId] = { entry, tab };
  }

  /** Closes the entry tab `tabId` has open, releasing its copy of the response. */
  close(tabId: string) {
    const opened = this.opened[tabId];
    if (!opened) return;
    delete this.opened[tabId];
    this.host.releaseResponse(this.host.runs[opened.tab.id]?.response);
    delete this.host.runs[opened.tab.id];
  }

  /** Forgets tab `tabId` (it closed): its History view and the entry it opened. */
  forget(tabId: string) {
    this.close(tabId);
    delete this.shownIn[tabId];
  }

  /** Forgets every tab's History view, for another workspace. */
  reset() {
    for (const tabId of Object.keys(this.opened)) this.close(tabId);
    this.shownIn = {};
  }
}
