// What the source guardrails (native-widgets, text-fields) share: the file shape they
// check and a walk over Svelte's AST. Used only by the guardrails; never imported by the app.

export interface SourceFile {
  /** Repo-relative path, e.g. `src/components/TopBar.svelte`. */
  path: string;
  source: string;
}

/** A Svelte AST node, as loosely as the guardrails need it. */
export type Node = { type: string; name?: string; start: number; [key: string]: unknown };

/** The 1-based line of `offset` in `source`. */
export function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

/** Calls `visit` on every node under `value`, depth first. */
export function walk(value: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (typeof (value as Node).type === "string") visit(value as Node);
  for (const [key, child] of Object.entries(value)) {
    if (key !== "metadata" && key !== "parent") walk(child, visit);
  }
}
