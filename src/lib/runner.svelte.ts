// Runs (GLOSSARY "Run"): sending a file's, a folder's or the explorer's selected
// requests in order, with the Session carried from each to the next, followed in the
// Runner panel. The page asks what a run needs up front (unanswered Prompt variables,
// the Production confirmation, trust), then the shell runs it (`run_requests`) and
// reports each request's progress (`run-progress`). Also Stop, Re-run failed, the
// Runner options and exporting the results.
import { save } from "@tauri-apps/plugin-dialog";
import { api, errorMessage, type RequestArgs, type RunExportFormat } from "./api";
import { CANCEL, type DialogAnswer, type DialogButton, type DialogField, type DialogState } from "./dialog";
import { basename, displayName, fileVariables, joinAnd, promptMasked, requestNames, requestPrompts, uid, verbOf } from "./http";
import type { SessionStore } from "./session.svelte";
import { toSendError } from "./sendError";
import type { Doc, RequestRef, Tab } from "./store.svelte";
import { findNode, treeFiles } from "./tree";
import type { Trust } from "./trust";
import type { AppSettings, HttpResponse, Request, RunnerOptions, RunProgress, RunRequestReport, SendError, TreeNode } from "./types";

/**
 * Where one request of a run is: waiting its turn, being sent, done (`passed`, or
 * `failed` per GLOSSARY "Run": a failed test, script error, blocked send or network
 * error, never an error status alone), stopped while sending (`cancelled`), or never
 * reached because the run stopped first (`notRun`).
 */
export type RunItemState = "queued" | "sending" | "passed" | "failed" | "cancelled" | "notRun";

/** One request of a run, as the Runner panel lists it. */
export interface RunItem {
  path: string;
  /** The request's key (`_key`), for its test marker and prompt answers. */
  key: string;
  name: string;
  method: string;
  /** Sent from its open tab's unsaved edits rather than the file on disk. */
  unsaved: boolean;
  state: RunItemState;
  /** Its response, kept for the viewer until the run is replaced. */
  response?: HttpResponse;
  /** Why it got no response. */
  error?: SendError;
}

/** A run (GLOSSARY "Run") and its results, shown in the Runner panel. */
export interface Runner {
  runId: string;
  /** What was run: the file's name. */
  title: string;
  items: RunItem[];
  running: boolean;
  /** Each request as an export shows it, from the shell once the run ends (finished or stopped). */
  results?: RunRequestReport[];
}

/** A request a run sends: where it's from, and what `run_requests` gets for it. */
interface RunEntry {
  path: string;
  key: string;
  unsaved: boolean;
  args: Omit<RequestArgs, "environment">;
}

/** A workspace's Runner options until they're changed: no delay, and failures don't stop a run. */
const DEFAULT_RUNNER_OPTIONS: RunnerOptions = { delayMs: 0, stopOnFailure: false };

/** Ends the title of a run of the last run's failed requests (Re-run failed). */
const FAILED_SUFFIX = " (failed)";

/** What runs need from the rest of the store. */
export interface RunnerHost {
  readonly root: string | null;
  readonly settings: AppSettings | null;
  readonly envName: string | null;
  readonly tree: TreeNode | null;
  readonly tabs: Tab[];
  readonly docs: Record<string, Doc>;
  /** The requests selected in the explorer. */
  readonly selectedRequests: RequestRef[];
  readonly session: SessionStore;
  readonly trust: Trust;
  /** Shows the Runner panel. */
  showRunner(): void;
  loadDoc(path: string): Promise<Doc | null>;
  isRequestDirty(path: string, key: string): boolean;
  updateSettings(patch: Partial<AppSettings>): Promise<boolean>;
  /** The production environment a send of `method` from the file at `path` needs confirming for, if any. */
  guardedEnvironment(path: string, method: string): string | null;
  releaseResponse(response: HttpResponse | undefined): void;
  toast(kind: "info" | "success" | "error", message: string): void;
  openDialog(d: Omit<DialogState, "resolve">): Promise<DialogAnswer>;
  choose(title: string, message: string, buttons: DialogButton[]): Promise<{ button: string }>;
}

export class RunnerStore {
  constructor(private readonly host: RunnerHost) {}

  /** The last run and its results (the Runner panel), until the next run or workspace. */
  current = $state<Runner | null>(null);

  /** A run is asking its questions, before it starts. */
  private asking = false;

  /** Whether a run is under way. */
  get running(): boolean {
    return !!this.current?.running;
  }

  /**
   * Runs every request of the file at `path` in order (GLOSSARY "Run"), following it
   * in the Runner panel. Asks first, once each: unanswered Prompt variables, the
   * Production confirmation, and whether to run scripts in an untrusted workspace.
   */
  async runFile(path: string) {
    const doc = await this.host.loadDoc(path);
    if (!doc) return;
    await this.run(basename(path), this.entries(path, doc));
  }

  /**
   * Runs every request of every `.http` file under the folder at `path`, subfolders
   * included, in the order the explorer shows them; each file's requests in file
   * order. Global variables and cookies carry from file to file; Request variables
   * don't, since they belong to their file. Asks first as `runFile` does.
   */
  async runFolder(path: string) {
    const { tree } = this.host;
    const folder = tree && findNode(tree, path);
    if (!folder) return;
    await this.run(basename(path), await this.entriesOf(treeFiles(folder)));
  }

  /**
   * Runs the requests selected in the explorer (`selectedRequests`), across files if
   * need be, in the order the explorer shows them. Asks first as `runFile` does.
   */
  async runSelection() {
    const { tree, selectedRequests: picked } = this.host;
    const order = new Map((tree ? treeFiles(tree) : []).map((path, i) => [path, i]));
    const rank = (path: string) => order.get(path) ?? order.size;
    const paths = [...new Set(picked.map((r) => r.path))].sort((a, b) => rank(a) - rank(b));
    const entries = await this.entriesOf(paths, (path, key) => picked.some((r) => r.path === path && r.key === key));
    await this.run(`${entries.length} selected ${entries.length === 1 ? "request" : "requests"}`, entries);
  }

  /** Stops the run, its request in flight included. */
  async stop() {
    if (this.current?.running) await api.cancelRequest(this.current.runId);
  }

  /** The open workspace's Runner options (the delay, stop on first failure). */
  get options(): RunnerOptions {
    const { root, settings } = this.host;
    return { ...DEFAULT_RUNNER_OPTIONS, ...(root ? settings?.runnerOptions?.[root] : undefined) };
  }

  /** Changes the open workspace's Runner options, remembered for its next runs. */
  async setOptions(patch: Partial<RunnerOptions>): Promise<boolean> {
    const { root, settings } = this.host;
    if (!root || !settings) return false;
    return this.host.updateSettings({ runnerOptions: { ...settings.runnerOptions, [root]: { ...this.options, ...patch } } });
  }

  /** Whether the last run has finished with failed requests to re-run. */
  get canRerunFailed(): boolean {
    const runner = this.current;
    return !!runner && !runner.running && runner.items.some((i) => i.state === "failed");
  }

  /**
   * Re-runs the last run's failed requests, in order, as a new run with the Session as
   * it is now (nothing is rolled back). Each is read again, from its open tab or its
   * file, as any run reads it, so a fix made since is what's sent.
   */
  async rerunFailed() {
    const runner = this.current;
    if (!runner || !this.canRerunFailed) return;
    const failed = runner.items.filter((i) => i.state === "failed");
    const entries: RunEntry[] = [];
    for (const item of failed) {
      const doc = await this.host.loadDoc(item.path);
      const entry = doc && this.entries(item.path, doc).find((e) => e.key === item.key);
      if (entry) entries.push(entry);
    }
    await this.run(runner.title.endsWith(FAILED_SUFFIX) ? runner.title : `${runner.title}${FAILED_SUFFIX}`, entries);
  }

  /**
   * Exports the ended run's results as JUnit XML or JSON to a file the user picks.
   * The shell writes them as it reported them: no response body, no Secret value.
   */
  async export(format: RunExportFormat) {
    const runner = this.current;
    if (!runner?.results || runner.running) return;
    const [name, extension] = format === "junit" ? ["JUnit XML", "xml"] : ["JSON", "json"];
    const path = await save({ defaultPath: `${runner.title} results.${extension}`, filters: [{ name, extensions: [extension] }] });
    if (!path) return;
    try {
      await api.exportRun($state.snapshot(runner.results), format, path);
      this.host.toast("success", `Run results exported to ${path}`);
    } catch (e) {
      this.host.toast("error", errorMessage(e));
    }
  }

  /** Applies a `run-progress` event to the run it belongs to; one for a replaced run only lets go of its response. */
  onProgress(p: RunProgress) {
    const { session } = this.host;
    const item = this.current?.runId === p.runId ? this.current.items[p.index] : undefined;
    if (!item) {
      if (p.state === "sent") this.host.releaseResponse(p.response);
      return;
    }
    switch (p.state) {
      case "sending":
        item.state = "sending";
        break;
      case "sent":
        item.state = p.failed ? "failed" : "passed";
        item.response = p.response;
        session.markTests(item.key, p.response.tests);
        // Its exchange, Global variables and cookies are now the Session's latest.
        session.version++;
        session.noteExchange(item.path, item.key, this.host.docs[item.path]?.file.requests.find((r) => r._key === item.key));
        break;
      case "failed":
        item.state = "failed";
        item.error = toSendError(p.error);
        session.clearTestMark(item.key);
        // A pre-request script that failed may have set Global variables first.
        session.version++;
        break;
      case "cancelled":
        item.state = "cancelled";
        break;
    }
  }

  /** Lets go of the last run and its responses, for another workspace. */
  reset() {
    this.release();
    this.current = null;
  }

  /** The run entries of each file of `paths` in turn, loading the ones not loaded yet;
   *  `keep` picks which requests of a file go in. A file that won't load is left out. */
  private async entriesOf(paths: string[], keep: (path: string, key: string) => boolean = () => true): Promise<RunEntry[]> {
    const docs = await Promise.all(paths.map((p) => this.host.loadDoc(p)));
    return paths.flatMap((p, i) => {
      const doc = docs[i];
      return doc ? this.entries(p, doc).filter((e) => keep(p, e.key)) : [];
    });
  }

  /**
   * The requests of `doc` a run sends, in order: from the open tab's edits when the
   * request is open, otherwise as in the file on disk (its saved snapshot). A request
   * that isn't open and was never saved isn't in the file, so it isn't sent.
   */
  private entries(path: string, doc: Doc): RunEntry[] {
    const args = { filePath: path, fileVariables: $state.snapshot(fileVariables(doc.file)), requestNames: requestNames(doc.file) };
    return doc.file.requests.flatMap((req) => {
      const key = req._key!;
      const open = this.host.tabs.some((t) => t.path === path && t.key === key);
      const saved = doc.saved[key];
      if (!open && saved === undefined) return [];
      const request = open ? ($state.snapshot(req) as Request) : (JSON.parse(saved) as Request);
      return [{ path, key, unsaved: open && this.host.isRequestDirty(path, key), args: { ...args, request, requestKey: key } }];
    });
  }

  /** Asks what a run needs to know up front, then runs `entries` (see `runFile`). */
  private async run(title: string, entries: RunEntry[]) {
    if (this.current?.running || this.asking) return;
    if (!entries.length) {
      this.host.toast("info", `${title} has no requests to run`);
      return;
    }
    let scripts: "run" | "skip" | "cancel" | "none";
    this.asking = true;
    try {
      if (!(await this.askPrompts(entries))) return;
      if (!(await this.confirmProduction(entries))) return;
      scripts = (await this.host.trust.runRunsScripts(entries)) ? await this.host.trust.scriptsAllowed("run") : "none";
      if (scripts === "cancel") return;
    } finally {
      this.asking = false;
    }

    this.release();
    const runId = uid();
    this.current = {
      runId,
      title,
      running: true,
      items: entries.map((e) => ({
        path: e.path,
        key: e.key,
        name: displayName(e.args.request),
        method: verbOf(e.args.request.method),
        unsaved: e.unsaved,
        state: "queued",
      })),
    };
    this.host.showRunner();
    try {
      const summary = await api.runRequests({
        runId,
        selection: { requests: entries.map((e) => e.args), environment: this.host.envName },
        options: { skipScripts: scripts === "skip", ...this.options },
      });
      if (this.current?.runId === runId) this.current.results = summary.requests;
    } catch (e) {
      this.host.toast("error", errorMessage(e));
    } finally {
      const runner = this.current;
      if (runner?.runId === runId) {
        runner.running = false;
        for (const item of runner.items) {
          if (item.state === "queued") item.state = "notRun";
          else if (item.state === "sending") item.state = "cancelled";
        }
      }
    }
  }

  /**
   * Asks, in one form, for every Prompt variable of the run's requests that the Session
   * has no answer for, each name once, and has the Session remember the answers for
   * each request that asks for it. False if the user cancelled.
   */
  private async askPrompts(entries: RunEntry[]): Promise<boolean> {
    const unanswered: { entry: RunEntry; names: string[] }[] = [];
    const fields = new Map<string, DialogField>();
    for (const entry of entries) {
      const prompts = requestPrompts(entry.args.request);
      if (!prompts.length) continue;
      const remembered = await api.promptAnswers(entry.key);
      const asked = prompts.filter((p) => !Object.hasOwn(remembered, p.name));
      if (!asked.length) continue;
      unanswered.push({ entry, names: asked.map((p) => p.name) });
      for (const p of asked) {
        const field = fields.get(p.name);
        if (!field) fields.set(p.name, { label: p.name, help: p.description, masked: promptMasked(p.name), value: "" });
        else if (!field.help) field.help = p.description;
      }
    }
    if (!fields.size) return true;
    const asked = [...fields.values()];
    const r = await this.host.openDialog({
      title: asked.length === 1 ? `Value for "${asked[0].label}"` : "Values for this run",
      message: "Asked once for the whole run, then remembered for each request that asks for it until you open another workspace or quit. Never saved.",
      fields: asked,
      buttons: [CANCEL, { label: "Run", value: "run", role: "primary" }],
    });
    if (r.button !== "run") return false;
    const values = Object.fromEntries(asked.map((f, i) => [f.label, r.values[i] ?? ""]));
    for (const { entry, names } of unanswered) {
      await api.answerPrompts(entry.key, Object.fromEntries(names.map((n) => [n, values[n]])));
    }
    this.host.session.version++;
    return true;
  }

  /**
   * With a Production environment selected, asks once before a run that sends anything
   * but GET, HEAD or OPTIONS with it, listing those requests. True to go ahead.
   */
  private async confirmProduction(entries: RunEntry[]): Promise<boolean> {
    const guarded = entries.flatMap((e) => {
      const env = this.host.guardedEnvironment(e.path, e.args.request.method);
      return env ? [{ env, line: `${verbOf(e.args.request.method)} ${displayName(e.args.request)}` }] : [];
    });
    if (!guarded.length) return true;
    const envs = joinAnd([...new Set(guarded.map((g) => `"${g.env}"`))]);
    const r = await this.host.choose(
      "Run against production?",
      `${envs} ${guarded.length > 1 && envs.includes(" and ") ? "are production environments" : "is a production environment"}. This run sends:\n${guarded.map((g) => `• ${g.line}`).join("\n")}`,
      [
        { ...CANCEL, focus: true },
        { label: "Run", value: "run", role: "primary", danger: true },
      ],
    );
    return r.button === "run";
  }

  /** Lets the shell drop the last run's responses (a new run, or another workspace). */
  private release() {
    for (const item of this.current?.items ?? []) this.host.releaseResponse(item.response);
  }
}
