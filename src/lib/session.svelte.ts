// The workspace's Session as the page sees it (GLOSSARY "Session"). The shell holds
// the Session; the page keeps what follows from it: a version that goes up whenever it
// changes (so views showing it read it again), the shapes of named requests' latest
// exchanges for completion, an exchange opened from the Session panel, and each
// request's test marker. The Session panel's deletes and clears go through here.
import { api, errorMessage } from "./api";
import { CANCEL, type DialogButton } from "./dialog";
import { getDirective, uid } from "./http";
import type { RunState, Tab } from "./store.svelte";
import type { ExchangeShape, HttpResponse, NamedExchange, Request, StoredCookie, TestResult } from "./types";

/** What the Session's page state needs from the rest of the store. */
export interface SessionHost {
  /** The response viewers' state by tab id, where an opened exchange shows under a pseudo tab. */
  readonly runs: Record<string, RunState>;
  releaseResponse(response: HttpResponse | undefined): void;
  toast(kind: "error", message: string): void;
  choose(title: string, message: string, buttons: DialogButton[]): Promise<{ button: string }>;
}

/** Identifies the named request `name` of the file at `path` (and so its latest exchange). */
export const exchangeKey = (path: string, name: string) => `${path}\0${name}`;

/** A request's test marker: whether every test of its latest send passed. */
export type TestMark = "passed" | "failed";

export class SessionStore {
  constructor(private readonly host: SessionHost) {}

  /**
   * Goes up whenever the workspace's Session changes (answers given or forgotten, a
   * named request's exchange recorded, or a new workspace opened), so views showing
   * what it holds read it again.
   */
  version = $state(0);

  /** Exchange shapes read for `shapesVersion` of the Session, by `exchangeKey`. */
  private exchangeShapes = new Map<string, Promise<ExchangeShape | null>>();
  private shapesVersion = -1;

  /**
   * The shape of the latest exchange of the request named `name` in file `path`, in
   * the Session (null if it hasn't been sent, or can't be read): what its Request
   * variables' paths complete from. Read once, then again after the Session changes.
   */
  exchangeShape(path: string, name: string): Promise<ExchangeShape | null> {
    if (this.shapesVersion !== this.version) {
      this.exchangeShapes.clear();
      this.shapesVersion = this.version;
    }
    const key = exchangeKey(path, name);
    let shape = this.exchangeShapes.get(key);
    if (!shape) {
      shape = api.exchangeShape(path, name).catch(() => null);
      this.exchangeShapes.set(key, shape);
    }
    return shape;
  }

  /** Forgets the prompted values of the request with key `requestKey`, so its next send asks again. */
  async forgetPrompts(requestKey: string) {
    await api.forgetPromptAnswers(requestKey);
    this.version++;
  }

  /** Deletes one Global variable, so later sends don't use it. */
  async deleteGlobal(name: string) {
    await this.change(() => api.deleteGlobal(name));
  }

  /** Deletes every Global variable. */
  async clearGlobals() {
    await this.change(() => api.clearGlobals());
  }

  /** Deletes one cookie from the Session's jar, so later sends don't carry it. */
  async deleteCookie(c: Pick<StoredCookie, "domain" | "path" | "name">) {
    await this.change(() => api.deleteCookie(c.domain, c.path, c.name));
  }

  /** Deletes every cookie in the Session's jar. */
  async clearCookies() {
    await this.change(() => api.clearCookies());
  }

  /**
   * The key of the request whose send recorded each latest exchange, by `exchangeKey`:
   * the request whose test marker goes when the exchange is forgotten. Of two
   * requests sharing a name, the one sent last.
   */
  private exchangeKeys = new Map<string, string>();

  /** After a send (or a run's) of `req`, key `key`, in file `path`: if it's named, its exchange is now that name's latest. */
  noteExchange(path: string, key: string, req: Request | undefined) {
    const named = req && getDirective(req, "name")?.trim();
    if (named) this.exchangeKeys.set(exchangeKey(path, named), key);
  }

  /**
   * Forgets one named request's latest exchange, so its Request variables read as
   * unsent, with the test marker of the send that recorded it.
   */
  async removeNamedExchange(entry: Pick<NamedExchange, "file" | "name">) {
    if (!(await this.change(() => api.removeNamedExchange(entry.file, entry.name)))) return;
    const id = exchangeKey(entry.file, entry.name);
    const key = this.exchangeKeys.get(id);
    if (key) this.clearTestMark(key);
    this.exchangeKeys.delete(id);
  }

  /** Forgets every named request's latest exchange, with the test markers of the sends that recorded them. */
  async clearNamedExchanges() {
    if (!(await this.change(() => api.clearNamedExchanges()))) return;
    for (const key of this.exchangeKeys.values()) this.clearTestMark(key);
    this.exchangeKeys.clear();
  }

  /**
   * A latest exchange opened from the Session panel, shown in a response viewer of
   * its own (`ExchangeView.svelte`) under a pseudo tab: its response is a copy with
   * its own id, so the request's tab keeps the response it shows.
   */
  shownExchange = $state<{ entry: NamedExchange; tab: Tab } | null>(null);

  /** Shows a named request's latest exchange in the response viewer, over the open tabs. */
  async openExchange(entry: NamedExchange) {
    let response: HttpResponse;
    try {
      response = await api.openExchange(entry.file, entry.name);
    } catch (e) {
      this.host.toast("error", errorMessage(e));
      return;
    }
    this.closeExchange();
    const tab: Tab = { id: `exchange:${uid()}`, path: entry.file, key: "" };
    this.host.runs[tab.id] = { runId: uid(), loading: false, startedAt: 0, response };
    this.shownExchange = { entry, tab };
  }

  /** Closes the shown exchange, releasing its copy of the response. */
  closeExchange() {
    const shown = this.shownExchange;
    if (!shown) return;
    this.shownExchange = null;
    this.host.releaseResponse(this.host.runs[shown.tab.id]?.response);
    delete this.host.runs[shown.tab.id];
  }

  /**
   * Empties the whole Session, every section of it, once the user confirms (Clear
   * session in the Session panel).
   */
  async clear() {
    const r = await this.host.choose(
      "Clear the session?",
      "HttpDesk forgets what it remembers for this workspace between sends: Global variables, cookies, prompt answers, the latest exchange of each named request and test results. Files and environments aren't changed.",
      [
        { ...CANCEL, focus: true },
        { label: "Clear session", value: "clear", role: "primary", danger: true },
      ],
    );
    if (r.button !== "clear") return;
    await this.change(() => api.clearSession());
    this.clearTestMarks();
    this.exchangeKeys.clear();
  }

  /**
   * Forgets what the page knew of the last Session, for another workspace: the shell
   * started a new Session for it. Its responses go with the tabs that show them.
   */
  reset() {
    this.version++;
    this.clearTestMarks();
    this.exchangeKeys.clear();
    this.shownExchange = null;
  }

  /**
   * Runs a change to the Session in the shell, then has views showing it read it
   * again. False (after saying why) if it failed.
   */
  private async change(change: () => Promise<unknown>): Promise<boolean> {
    try {
      await change();
      return true;
    } catch (e) {
      this.host.toast("error", errorMessage(e));
      return false;
    } finally {
      this.version++;
    }
  }

  /**
   * The test marker of each request whose latest send ran tests, by request key:
   * "passed" when every test passed, "failed" when any failed (a handler error
   * included). They belong to the Session, not the tab: a closed tab's request keeps
   * its marker, and they all go when the Session is cleared (`clearTestMarks`).
   */
  private testMarks = $state<Record<string, TestMark>>({});

  /** The tab strip's and the tree's marker for the request with this key, if its latest send ran tests. */
  testMark(key: string): TestMark | undefined {
    return this.testMarks[key];
  }

  /** Records the latest send's tests as the request's marker; no tests, no marker. */
  markTests(key: string, tests: TestResult[] | undefined) {
    if (tests?.length) this.testMarks[key] = tests.every((t) => t.passed) ? "passed" : "failed";
    else this.clearTestMark(key);
  }

  /** Drops one request's marker, for when its latest result is cleared. */
  clearTestMark(key: string) {
    delete this.testMarks[key];
  }

  /** Drops every marker, for when the Session is cleared (a workspace opened, or Clear session). */
  clearTestMarks() {
    this.testMarks = {};
  }
}
