// Pre-send checks, shown in the strip above a request's sections (CheckStrip.svelte):
// the Undefined variables a send would leave as written, where each is used, and
// the quick fixes for it. Computed synchronously from the frontend resolver
// (`makeVarProvider`), which gives the core's answers, so they follow every edit.
import type { LineMark } from "./codemirror/lineMarks";
import type { VarProvider } from "./codemirror/setup";
import { writeFolder } from "./envFolders";
import { getDirective, segments, variableNameError } from "./http";
import type { Auth, Body, EnvironmentSet, PortabilityMark, Request } from "./types";
import { requestVariable } from "./vars";

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
  | { kind: "differs"; editor: "vscode" | "rider"; lines: number[] };

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
  const linesOf = (support: PortabilityMark["support"]) =>
    [...new Set(marks.filter((m) => m.support === support && m.construct !== "request-variable").map((m) => m.line))].sort((a, b) => a - b);
  for (const [editor, lines] of [["vscode", linesOf("jetbrains-only")], ["rider", linesOf("vscode-only")]] as const) {
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
 * Everything the strip lists for a request, in order: problems first, then notes.
 * Empty: the strip is hidden. `set` is the request's own environments (its folder's)
 * and `dir` its folder, relative to the workspace root. `file` is every request of the
 * request's file (it included), whose `# @name`s it may share. `portability` is the
 * constructs in its source and the level its notes show at (`portabilityChecks`).
 */
export function requestChecks(
  req: Request,
  variables: VarProvider,
  set: EnvironmentSet | null,
  envName: string | null,
  dir = "",
  file: Request[] = [],
  portability: { marks: PortabilityMark[]; level?: PortabilityLevel } = { marks: [] },
): Check[] {
  const missing = !!envName && !set?.environments.some((e) => e.name === envName);
  const checks: Check[] = missing ? [{ kind: "envMissing", env: envName, dir, fixes: [{ kind: "chooseEnvironment" }] }] : [];
  const name = getDirective(req, "name")?.trim();
  const others = name ? file.filter((r) => r !== req && getDirective(r, "name")?.trim() === name).length : 0;
  if (name && others) checks.push({ kind: "duplicateName", name, others });
  const env = missing ? null : envName;
  for (const u of undefinedVariables(req, variables)) checks.push({ kind: "undefined", ...u, fixes: quickFixes(u.name, set, env) });
  checks.push(...portabilityChecks(req, portability.marks, portability.level));
  return checks;
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
