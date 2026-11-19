// Pre-send checks, shown in the strip above a request's sections (CheckStrip.svelte):
// the Undefined variables a send would leave as written, where each is used, and
// the quick fixes for it. Computed synchronously from the frontend resolver
// (`makeVarProvider`), which gives the core's answers, so they follow every edit.
import type { LineMark } from "./codemirror/lineMarks";
import type { VarProvider } from "./codemirror/setup";
import { writeFolder } from "./envFolders";
import { fileVariables, getDirective, requestNames, requestPrompts, segments, variableNameError } from "./http";
import { docSnapshot } from "./snapshots.svelte";
import type { Auth, Body, BodyFile, EnvironmentSet, HttpFile, PortabilityMark, Problem, Request, RequestProblems, Support } from "./types";
import { makeVarProvider, requestVariable, type Scope } from "./vars";

/** Where in the request editor a reference is written: the URL bar or a section tab. */
export type Section = "url" | "params" | "headers" | "auth" | "body";

export const SECTION_LABELS: Record<Section, string> = { url: "URL", params: "Params", headers: "Headers", auth: "Authorization", body: "Body" };

export interface UndefinedVariable {
  name: string;
  /** Where it is used, in the order of the editor (URL, Params, Headers, Authorization, Body). */
  sections: Section[];
}

/**
 * One entry of the strip. Each kind is a problem the request would be sent with, or
 * (`portability`) a note about the file; the strip renders each kind its own way, so
 * a new kind of check adds a variant here, adds its entries in `requestChecks`, and a
 * branch in CheckStrip.svelte.
 */
export type Check =
  /**
   * Something the core couldn't read cleanly in the request's source (`request_problems`),
   * or a body file that doesn't exist, placed in the source (the Source view underlines
   * it). It never blocks the send.
   */
  | { kind: "problem"; problem: Problem }
  | { kind: "undefined"; name: string; sections: Section[]; fixes: QuickFix[] }
  /** The selected environment `env` isn't defined for the request's folder `dir`, so it's sent with none (ADR-0004). */
  | { kind: "envMissing"; env: string; dir: string; fixes: QuickFix[] }
  /**
   * The request's `# @name` is also that of `others` other requests in its file, so its
   * Request variables read whichever of them was sent last. It never blocks the send.
   */
  | { kind: "duplicateName"; name: string; others: number }
  /**
   * The request behaves differently in VS Code or Rider (ADR-0007, the core's
   * portability table). HttpDesk sends it all the same, so at the `note` level (the
   * default) it isn't a problem with the send.
   */
  | { kind: "portability"; level: PortabilityLevel; note: PortabilityNote };

/** How portability notes show: quietly (`note`), or as warnings, for teams that need files to work in both editors. */
export type PortabilityLevel = "note" | "warning";

export type PortabilityNote =
  /**
   * The request has a Request variable (the first reads `name`'s exchange), which Rider
   * refuses to send (IJPL-253135). There while it sends one.
   */
  | { kind: "riderRefuses"; name: string }
  /**
   * `lines` (1-based, in the request's `.http` source) behave differently in `editor`:
   * for VS Code, the lines only Rider reads; for Rider, those only VS Code reads.
   */
  | { kind: "differs"; editor: EditorName; lines: number[] };

/** The other editors a `.http` file is shared with, whose behaviour portability notes compare. */
export type EditorName = "vscode" | "rider";

export const EDITOR_NAMES: Record<EditorName, string> = { vscode: "VS Code", rider: "Rider" };

/** What only the other editor reads, so it behaves differently in `editor`: for VS Code, what only Rider (JetBrains) reads. */
const OTHERS_ONLY: Record<EditorName, Support> = { vscode: "jetbrains-only", rider: "vscode-only" };

/**
 * The lines (sorted, once each) of `marks` that behave differently in `editor`: those
 * only the other editor reads. Without `requestVariables`, a Request variable's lines
 * are left out (the strip has a note of its own for one).
 */
export function differingLines(marks: PortabilityMark[], editor: EditorName, { requestVariables = true } = {}): number[] {
  const lines = marks.filter((m) => m.support === OTHERS_ONLY[editor] && (requestVariables || m.construct !== "request-variable")).map((m) => m.line);
  return [...new Set(lines)].sort((a, b) => a - b);
}

/** "1 line behaves differently in VS Code", "3 lines behave differently in Rider". */
export function differsText(n: number, editor: EditorName): string {
  return `${n === 1 ? "1 line behaves" : `${n} lines behave`} differently in ${EDITOR_NAMES[editor]}`;
}

/** Whether `check` is only a note, not a problem with the send. */
export const isNote = (check: Check) => check.kind === "portability" && check.level === "note";

/**
 * The portability notes for a request: a Request variable it sends (which Rider
 * refuses), then the lines of its source (`marks`, from `request_portability`) only
 * Rider reads, then those only VS Code reads. A Request variable is left to the
 * first, which counts only what is sent; portable and HttpDesk-only lines behave the
 * same in both editors.
 */
export function portabilityChecks(req: Request, marks: PortabilityMark[], level: PortabilityLevel = "note"): Check[] {
  const notes: PortabilityNote[] = [];
  const [read] = requestVariableReads(req);
  if (read) notes.push({ kind: "riderRefuses", name: read });
  for (const editor of ["vscode", "rider"] as const) {
    const lines = differingLines(marks, editor, { requestVariables: false });
    if (lines.length) notes.push({ kind: "differs", editor, lines });
  }
  return notes.map((note) => ({ kind: "portability", level, note }));
}

/**
 * The `.http` source's gutter markers for `marks`: one per line that isn't portable,
 * in line order, its hover each construct's on that line. HttpDesk's own lines are
 * marked apart from the others, which at the `warning` level are warnings.
 */
export function portabilityLineMarks(marks: PortabilityMark[], level: PortabilityLevel = "note"): LineMark[] {
  const byLine = new Map<number, PortabilityMark[]>();
  for (const m of marks) if (m.support !== "portable") byLine.set(m.line, [...(byLine.get(m.line) ?? []), m]);
  return [...byLine]
    .sort(([a], [b]) => a - b)
    .map(([line, on]) => {
      const differs = on.find((m) => m.support !== "httpdesk-only");
      const kind = !differs ? "httpdesk-only" : level === "warning" ? "warning" : differs.support;
      return { line, kind, text: on.map((m) => m.hover).join("\n") };
    });
}

/**
 * What the core and the shell last answered about a request's source (kept by
 * `problems.svelte.ts`, as the strip is computed synchronously). Each is undefined
 * until it has answered, and nothing is flagged meanwhile.
 */
export interface SourceFindings {
  /** The core's reading of the request's source (`request_problems`). */
  read?: RequestProblems;
  /** Whether the body file at `path` (as written, variables resolved) exists. */
  exists?: (path: string) => boolean | undefined;
}

/**
 * The files the request's body is read from (`read.files`), each with its path with
 * variables resolved: what the shell is asked about. A path that doesn't resolve (an
 * Undefined variable, a Prompt variable not answered yet) isn't asked about; the
 * other checks cover it.
 */
export function bodyFilePaths(read: RequestProblems | undefined, variables: VarProvider): { file: BodyFile; path: string }[] {
  return (read?.files ?? []).flatMap((file) => {
    const r = variables.resolve(file.path);
    return r.undefined.length || r.circular.length || r.asked.length ? [] : [{ file, path: r.value }];
  });
}

/** What `requestChecks` checks a request against, besides the request and its variables. */
export interface CheckContext {
  /** The request's own environments (its folder's). */
  set?: EnvironmentSet | null;
  /** The selected environment. */
  envName?: string | null;
  /** The request's folder, relative to the workspace root. */
  dir?: string;
  /** Every request of the request's file (it included), whose `# @name`s it may share. */
  file?: Request[];
  /** What the core and the shell found in its source: those problems come first, by line. */
  found?: SourceFindings;
  /** The constructs in its source and the level its notes show at (`portabilityChecks`): those notes come last. */
  portability?: { marks: PortabilityMark[]; level?: PortabilityLevel };
}

/** Everything the strip lists for a request, in order: problems first, then notes. Empty: the strip is hidden. */
export function requestChecks(req: Request, variables: VarProvider, { set = null, envName = null, dir = "", file = [], found = {}, portability = { marks: [] } }: CheckContext = {}): Check[] {
  const missingFiles = bodyFilePaths(found.read, variables).flatMap(({ file, path }) => (found.exists?.(path) === false ? [file.missing] : []));
  const problems = [...(found.read?.problems ?? []), ...missingFiles].sort((a, b) => a.line - b.line || a.column - b.column);
  const checks: Check[] = problems.map((problem) => ({ kind: "problem", problem }));
  const missing = !!envName && !set?.environments.some((e) => e.name === envName);
  if (missing) checks.push({ kind: "envMissing", env: envName, dir, fixes: [{ kind: "chooseEnvironment" }] });
  const env = missing ? null : envName;
  for (const check of referenceChecks(req, variables, file)) checks.push(check.kind === "undefined" ? { ...check, fixes: quickFixes(check.name, set, env) } : check);
  checks.push(...portabilityChecks(req, portability.marks, portability.level));
  return checks;
}

/**
 * What a request's references are flagged for: a `# @name` it shares with others of
 * `file` (its file's requests), then each Undefined variable it would be sent with (with
 * no quick fixes). The strip lists them (`requestChecks`); the Problems panel and the file
 * view, which show every request of a file, place them in its text (`fileReferenceFindings`).
 */
export function referenceChecks(req: Request, variables: VarProvider, file: Request[]): Check[] {
  const checks: Check[] = [];
  const name = getDirective(req, "name")?.trim();
  const others = name ? file.filter((r) => r !== req && getDirective(r, "name")?.trim() === name).length : 0;
  if (name && others) checks.push({ kind: "duplicateName", name, others });
  for (const u of undefinedVariables(req, variables)) checks.push({ kind: "undefined", ...u, fixes: [] });
  return checks;
}

/** What every request of a file can see, besides what the file itself declares (`fileScope`). */
export interface OutsideScope {
  /** The file's folder's environment (`envVariables`). */
  env: Scope["env"];
  envName: string | null;
  globals: Record<string, string>;
}

/** What request `req` of `file` sees, as its tab's provider does (`makeVarProvider`): Prompt variables count as defined. */
export function requestScope(file: HttpFile, req: Request, outside: OutsideScope): VarProvider {
  return makeVarProvider({
    ...outside,
    fileVars: fileVariables(file),
    headerVars: file.header.variables,
    requestVars: req.variables,
    prompts: requestPrompts(req),
    requestNames: requestNames(file),
  });
}

/**
 * `referenceChecks` of each request of a file read from its text (each request's `raw`
 * is its block as written), seeing `outside` too. One per view that asks again after each
 * edit (a file view): a request's are kept, by its block's text, while `outside` is the
 * same object and what the file declares (its variables and each request's `# @name`) is
 * unchanged, from the last two readings. A file of a thousand requests is mostly so.
 */
export class ReferenceChecks {
  private current = new Map<string, Check[]>();
  private previous = new Map<string, Check[]>();
  private scope: { outside: OutsideScope; declared: string } | null = null;

  of(file: HttpFile, outside: OutsideScope): Check[][] {
    const declared = JSON.stringify([fileVariables(file), file.header.variables, file.requests.map((r) => getDirective(r, "name")?.trim() ?? "")]);
    if (this.scope?.outside !== outside || this.scope.declared !== declared) {
      this.scope = { outside, declared };
      this.current = new Map();
      this.previous = new Map();
    }
    const found = new Map<string, Check[]>();
    const out = file.requests.map((req) => {
      const key = req.raw ?? docSnapshot(req);
      const checks = this.current.get(key) ?? this.previous.get(key) ?? referenceChecks(req, requestScope(file, req, outside), file.requests);
      found.set(key, checks);
      return checks;
    });
    this.previous = this.current;
    this.current = found;
    return out;
  }
}

/**
 * The text of each section that a send resolves, as the core's `exec::prepare`
 * reads it: the URL, then active params and headers, the enabled auth's fields and
 * the enabled body.
 */
function sentTexts(req: Request): [Section, string[]][] {
  const active = (s: Request["query"]) => (s.enabled ? s.items.filter((i) => i.enabled && i.name) : []);
  return [
    ["url", [req.url]],
    ["params", active(req.query).flatMap((p) => [p.name, p.value])],
    ["headers", active(req.headers).flatMap((h) => [h.name, h.value])],
    ["auth", authTexts(req.auth)],
    ["body", bodyTexts(req.body)],
  ];
}

function authTexts(auth: Auth): string[] {
  if (!auth.enabled) return [];
  switch (auth.kind) {
    case "basic":
      return [auth.username, auth.password];
    case "bearer":
      return [auth.token];
    case "apiKey":
      // A header's name is sent as written; a query param's is resolved.
      return auth.keyLocation === "query" ? [auth.keyName, auth.keyValue] : [auth.keyValue];
    default:
      return [];
  }
}

/** No client sends a `#~` line (a disabled field or part); a form body's other comment lines aren't sent either. */
function bodyTexts(body: Body): string[] {
  if (!body.enabled || body.mode === "none") return [];
  const lines = body.text.split("\n");
  if (body.mode === "multipart") return lines.filter((l) => !l.startsWith("#~"));
  if (body.mode === "formUrlEncoded") return lines.map((l) => l.trim()).filter((l) => !l.startsWith("#") && !l.startsWith("//"));
  return [body.text];
}

/**
 * The Undefined variables a send of `req` would meet, each once, in the order they
 * first appear (sorted within one field), with the sections using them. Only what
 * is sent counts: not disabled rows, sections, auth, bodies, form fields or
 * multipart parts. A name missing behind a defined one (`{{baseUrl}}` →
 * `https://{{host}}`) counts where the outer reference is. Circular references and
 * unanswered Prompt variables are not Undefined variables.
 */
export function undefinedVariables(req: Request, variables: VarProvider): UndefinedVariable[] {
  const found = new Map<string, Section[]>();
  for (const [section, texts] of sentTexts(req)) {
    for (const text of texts) {
      for (const name of variables.resolve(text).undefined) {
        const sections = found.get(name) ?? [];
        if (!sections.includes(section)) sections.push(section);
        found.set(name, sections);
      }
    }
  }
  return [...found].map(([name, sections]) => ({ name, sections }));
}

/**
 * The named requests whose exchanges `req`'s Request variables read, each once, in the
 * order first written: only references written in what is sent, as the core's
 * `exec::check_request_variables` reads them before the pre-request script. Names the
 * file has no `# @name` for are left in: they are Undefined variables, not reads.
 */
export function requestVariableReads(req: Request): string[] {
  const names = sentTexts(req).flatMap(([, texts]) => texts.flatMap((text) => segments(text).flatMap(({ ref }) => requestVariable(ref ?? "")?.name ?? [])));
  return [...new Set(names)];
}

/**
 * A one-click fix: for an Undefined variable, add an empty one to the selected
 * environment, add an empty File variable, or select an environment that defines it;
 * for an environment the folder doesn't define, open the picker to choose another.
 */
export type QuickFix =
  /** `dir`: the folder whose env files get it (`writeFolder`); without it, the one the Environments modal opens on. */
  | { kind: "addToEnvironment"; env: string; dir?: string }
  | { kind: "addFileVariable" }
  | { kind: "selectEnvironment"; env: string }
  | { kind: "chooseEnvironment" };

/**
 * The fixes for Undefined variable `name` with environment `envName` selected (or
 * none). A `$name` is never looked up and a name a `@name =` line can't hold can't be
 * defined, so neither gets any.
 */
export function quickFixes(name: string, set: EnvironmentSet | null, envName: string | null): QuickFix[] {
  if (name.startsWith("$") || variableNameError(name)) return [];
  const fixes: QuickFix[] = [];
  if (envName) {
    const dir = writeFolder(set, envName, name);
    fixes.push({ kind: "addToEnvironment", env: envName, ...(dir !== undefined ? { dir } : {}) });
  }
  fixes.push({ kind: "addFileVariable" });
  const defining = set?.environments.find((e) => e.name !== envName && e.variables.some((v) => v.name === name));
  if (defining) fixes.push({ kind: "selectEnvironment", env: defining.name });
  return fixes;
}
