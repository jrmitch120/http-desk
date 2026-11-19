// What the Problems panel shows of the workspace's problems (workspaceProblems.svelte.ts):
// each file's entries by line, a summary of the lines that behave differently in VS Code
// or Rider, and the count on the panel's toggle. Besides what the shell found, each file's
// Undefined variables and shared `# @name`s, found here as the check strip finds them
// (the page knows the selected environment and the Session). Portability notes take the
// level the setting gives them (`app.portabilityLevel`): notes, or warnings for teams
// that need files to work in both editors. None of it ever blocks a send.
import { differingLines, differsText, ReferenceChecks, type OutsideScope, type PortabilityLevel } from "./checks";
import { fileUnderlines, textRead } from "./codemirror/underlines";
import type { FileProblems, HttpFile } from "./types";

export interface ProblemEntry {
  /** 1-based, in the file's text (as its file view shows it). */
  line: number;
  tone: "error" | "warning" | "note";
  message: string;
}

export interface ProblemFile {
  path: string;
  /** By line; on one line, problems before portability notes. */
  entries: ProblemEntry[];
  /** E.g. "2 lines behave differently in VS Code", then Rider's. */
  summary: string[];
  /** What it adds to the toggle's count: every problem, and each line that behaves differently once they're warnings. */
  count: number;
}

/**
 * Each Undefined variable a request of `file` would be sent with, where it's referenced,
 * and each `# @name` a request shares with another, by line in the file's text. `file`
 * is what that text reads as (the shell's), so its verbatim text places each.
 */
function referenceEntries(file: HttpFile, outside: OutsideScope, kept: ReferenceChecks): ProblemEntry[] {
  const underlines = fileUnderlines(file, kept.of(file, outside));
  if (!underlines.length) return [];
  const text = textRead(file);
  let line = 1;
  let at = 0;
  // In order of the text: each line counted once.
  return underlines.map((u) => {
    for (let nl = text.indexOf("\n", at); nl >= 0 && nl < u.from; nl = text.indexOf("\n", nl + 1)) {
      line++;
      at = nl + 1;
    }
    return { line, tone: u.severity, message: u.message };
  });
}

/**
 * The panel's files, by path; one with nothing to show is left out. `outside` is what
 * the requests of the file at a path see besides the file itself; without it, a file's
 * references aren't looked at. `kept` keeps each file's reference checks between readings.
 */
export function problemFiles(
  files: FileProblems[],
  level: PortabilityLevel,
  outside?: (path: string) => OutsideScope,
  kept: (path: string) => ReferenceChecks = () => new ReferenceChecks(),
): ProblemFile[] {
  return [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .flatMap((f) => {
      const references = f.file && outside ? referenceEntries(f.file, outside(f.path), kept(f.path)) : [];
      const entries: ProblemEntry[] = [
        ...f.problems.map((p) => ({ line: p.line, tone: p.severity, message: p.message })),
        ...references,
        ...f.portability.map((m) => ({ line: m.line, tone: level, message: m.hover })),
      ];
      if (!entries.length) return [];
      // A stable sort keeps problems before notes on one line.
      entries.sort((a, b) => a.line - b.line);
      const differing = (["vscode", "rider"] as const).map((editor) => [editor, differingLines(f.portability, editor).length] as const);
      const summary = differing.flatMap(([editor, n]) => (n ? [differsText(n, editor)] : []));
      const count = f.problems.length + references.length + (level === "warning" ? differing.reduce((n, [, lines]) => n + lines, 0) : 0);
      return [{ path: f.path, entries, summary, count }];
    });
}

/** The count on the panel's toggle. */
export function problemCount(files: ProblemFile[]): number {
  return files.reduce((n, f) => n + f.count, 0);
}
