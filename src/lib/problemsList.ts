// What the Problems panel shows of the workspace's problems (workspaceProblems.svelte.ts):
// each file's entries by line, a summary of the lines that behave differently in VS Code
// or Rider, and the count on the panel's toggle. Portability notes take the level the
// setting gives them (`app.portabilityLevel`): notes, or warnings for teams that need
// files to work in both editors. Neither ever blocks a send.
import type { PortabilityLevel } from "./checks";
import type { FileProblems, PortabilityMark } from "./types";

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
}

/** The lines (sorted, once each) of `marks` that only Rider reads (`vscode`: they behave differently in VS Code), or only VS Code. */
function differingLines(marks: PortabilityMark[], editor: "vscode" | "rider"): number[] {
  const support = editor === "vscode" ? "jetbrains-only" : "vscode-only";
  return [...new Set(marks.filter((m) => m.support === support).map((m) => m.line))].sort((a, b) => a - b);
}

const EDITOR = { vscode: "VS Code", rider: "Rider" } as const;

/** The panel's files, by path. */
export function problemFiles(files: FileProblems[], level: PortabilityLevel): ProblemFile[] {
  return [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => {
      const entries: ProblemEntry[] = [
        ...f.problems.map((p) => ({ line: p.line, tone: p.severity, message: p.message })),
        ...f.portability.map((m) => ({ line: m.line, tone: level, message: m.hover })),
      ];
      // A stable sort keeps problems before notes on one line.
      entries.sort((a, b) => a.line - b.line);
      const summary = (["vscode", "rider"] as const).flatMap((editor) => {
        const n = differingLines(f.portability, editor).length;
        return n ? [`${n === 1 ? "1 line behaves" : `${n} lines behave`} differently in ${EDITOR[editor]}`] : [];
      });
      return { path: f.path, entries, summary };
    });
}

/** The count on the panel's toggle: every problem, and each line that behaves differently once they're warnings. */
export function problemCount(files: FileProblems[], level: PortabilityLevel): number {
  return files.reduce(
    (n, f) => n + f.problems.length + (level === "warning" ? differingLines(f.portability, "vscode").length + differingLines(f.portability, "rider").length : 0),
    0,
  );
}
