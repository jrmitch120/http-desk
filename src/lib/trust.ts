// Workspace trust (GLOSSARY "Trusted workspace"): scripts run only in a workspace the
// user trusts. The page asks the first time a send or run would run one ("Trust and
// run", "Send without scripts", "Cancel"); the shell stores the answer in the app
// settings and refuses scripts itself in an untrusted workspace. A send blocked as
// unsent runs no script, so it never asks.
import { api, errorMessage } from "./api";
import { requestVariableReads } from "./checks";
import { CANCEL, type DialogButton } from "./dialog";
import { getDirective, hasScripts } from "./http";
import type { AppSettings, ExchangeShape, Request } from "./types";

/** What trust needs from the rest of the store. */
export interface TrustHost {
  readonly root: string | null;
  readonly settings: AppSettings | null;
  toast(kind: "error", message: string): void;
  choose(title: string, message: string, buttons: DialogButton[]): Promise<{ button: string }>;
  /** The shape of the latest exchange of the request named `name` in file `path`: null if it hasn't been sent. */
  exchangeShape(path: string, name: string): Promise<ExchangeShape | null>;
}

/** A request a run sends, as far as trust reads it. */
export interface ScriptedSend {
  path: string;
  args: { request: Request; requestNames?: string[] };
}

/** Whether a send that would run a script runs it, sends without it, or doesn't send. */
export type ScriptsChoice = "run" | "skip" | "cancel";

export class Trust {
  constructor(private readonly host: TrustHost) {}

  /** The workspace whose scripts the user chose to skip ("Send without scripts"), until it's opened again. */
  private skippedIn: string | null = null;

  /** Whether the open workspace is a Trusted workspace (its scripts run). */
  get trusted(): boolean {
    const { root, settings } = this.host;
    return !!root && (settings?.trustedWorkspaces ?? []).includes(root);
  }

  /**
   * Whether a send (or a run: `what`) that would run a script runs it ("run"), sends
   * without it ("skip"), or doesn't send ("cancel"). Asks the first time in a
   * workspace that isn't trusted; "Trust and run" is stored by the shell, in the app
   * settings.
   */
  async scriptsAllowed(what: "send" | "run" = "send"): Promise<ScriptsChoice> {
    if (this.trusted) return "run";
    const { root } = this.host;
    if (root && this.skippedIn === root) return "skip";
    const r = await this.host.choose(
      "Run this workspace's scripts?",
      `${what === "run" ? "Requests in this run have scripts" : "This request has a script"}. Scripts in ${root} run only if you trust this workspace. Trust it only if you trust whoever wrote its files. It's remembered in HttpDesk's settings, never in the workspace, and can be revoked in Settings.`,
      [
        { ...CANCEL, focus: true },
        { label: what === "run" ? "Run without scripts" : "Send without scripts", value: "skip" },
        { label: "Trust and run", value: "trust", role: "primary" },
      ],
    );
    if (r.button === "skip") {
      this.skippedIn = root;
      return "skip";
    }
    if (r.button !== "trust") return "cancel";
    try {
      this.setTrusted(await api.trustWorkspace());
      return "run";
    } catch (e) {
      this.host.toast("error", errorMessage(e));
      return "cancel";
    }
  }

  /** Stops trusting the workspace at `path` (Settings → Trusted workspaces). */
  async revoke(path: string) {
    try {
      this.setTrusted(await api.revokeWorkspaceTrust(path));
    } catch (e) {
      this.host.toast("error", errorMessage(e));
    }
  }

  /** The shell refused a send as untrusted: the page forgets the trust it thought the workspace had, so the next send asks again (trust revoked elsewhere). */
  refusedByShell() {
    const { root, settings } = this.host;
    if (settings) settings.trustedWorkspaces = (settings.trustedWorkspaces ?? []).filter((p) => p !== root);
  }

  /** Forgets "Send without scripts", for another workspace (or the same one opened again). */
  reset() {
    this.skippedIn = null;
  }

  /**
   * Whether a send of `req` would run a script: it has one, and isn't blocked as
   * unsent (see `blockedAsUnsent`). `names` are its file's `# @name`s.
   */
  async sendRunsScripts(path: string, req: Request, names: string[]): Promise<boolean> {
    return hasScripts(req) && !(await this.blockedAsUnsent(path, req, names));
  }

  /**
   * Whether a run of `entries` would run a script: one of them has a script and isn't
   * blocked as unsent, counting a named request earlier in the run (in the same file)
   * as sent by the time it's read.
   */
  async runRunsScripts(entries: ScriptedSend[]): Promise<boolean> {
    const named = new Map<string, string[]>();
    for (const { path, args } of entries) {
      const sentFirst = named.get(path) ?? [];
      if (hasScripts(args.request) && !(await this.blockedAsUnsent(path, args.request, args.requestNames ?? [], sentFirst))) return true;
      const name = getDirective(args.request, "name")?.trim();
      if (name) named.set(path, [...sentFirst, name]);
    }
    return false;
  }

  /**
   * Whether a send of `req`, from the file at `path` whose `# @name`s are `names`, is
   * blocked as unsent: a Request variable it writes reads a named request with no
   * latest exchange in the Session, other than those in `sentFirst` (sent earlier in
   * the same run). The shell blocks it before any script runs or trust is checked
   * (`send::send`), so it needs no trust.
   */
  private async blockedAsUnsent(path: string, req: Request, names: string[], sentFirst: string[] = []): Promise<boolean> {
    const reads = requestVariableReads(req).filter((n) => names.includes(n) && !sentFirst.includes(n));
    const shapes = await Promise.all(reads.map((n) => this.host.exchangeShape(path, n)));
    return shapes.some((shape) => shape === null);
  }

  private setTrusted(workspaces: string[]) {
    if (this.host.settings) this.host.settings.trustedWorkspaces = workspaces;
  }
}
