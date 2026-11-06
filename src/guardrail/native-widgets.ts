// Finds native form widgets and `title` tooltips in the app's sources (ADR 0002).
// Used only by native-widgets.test.ts; never imported by the app.
import { parse } from "svelte/compiler";

export const WIDGET_KINDS = ["select", "checkbox", "radio", "number", "datalist", "title"] as const;
export type WidgetKind = (typeof WIDGET_KINDS)[number];

/** Files still allowed to contain each widget kind (repo-relative paths). */
export type Allowlist = Record<WidgetKind, readonly string[]>;

export interface SourceFile {
  /** Repo-relative path, e.g. `src/components/TopBar.svelte`. */
  path: string;
  source: string;
}

export interface Finding {
  kind: WidgetKind;
  line: number;
}

const LABEL: Record<WidgetKind, string> = {
  select: "native <select>",
  checkbox: 'native <input type="checkbox">',
  radio: 'native <input type="radio">',
  number: 'native <input type="number">',
  datalist: "native <datalist>",
  title: "native title= tooltip",
};

export function emptyAllowlist(): Allowlist {
  return { select: [], checkbox: [], radio: [], number: [], datalist: [], title: [] };
}

/** Every native widget in one file (`.svelte` markup or `.ts` DOM code), in source order. */
export function findNativeWidgets(file: SourceFile): Finding[] {
  return file.path.endsWith(".svelte") ? findInSvelte(file.source) : findInScript(file.source);
}

// DOM-building code: CodeMirror decoration attributes, setAttribute, property
// assignment and createElement. Deliberately narrow, so `title: string` in a
// type or `el.title === x` doesn't count.
const SCRIPT_PATTERNS: [WidgetKind, RegExp][] = [
  ["title", /\battributes\s*:\s*\{[^}]*\btitle\s*:/],
  ["title", /\.setAttribute\(\s*["'`]title["'`]/],
  ["title", /\.title\s*=(?!=)/],
  ["select", /createElement\(\s*["'`]select["'`]/],
  ["datalist", /createElement\(\s*["'`]datalist["'`]/],
  ["checkbox", /\.type\s*=\s*["'`]checkbox["'`]/],
  ["radio", /\.type\s*=\s*["'`]radio["'`]/],
  ["number", /\.type\s*=\s*["'`]number["'`]/],
];

function findInScript(source: string): Finding[] {
  const findings: Finding[] = [];
  source.split("\n").forEach((text, i) => {
    for (const [kind, pattern] of SCRIPT_PATTERNS) if (pattern.test(text)) findings.push({ kind, line: i + 1 });
  });
  return findings;
}

function findInSvelte(source: string): Finding[] {
  const findings: Finding[] = [];
  const lineAt = (offset: number) => source.slice(0, offset).split("\n").length;
  const ast = parse(source, { modern: true });

  walk(ast.fragment, (node) => {
    if (node.type !== "RegularElement") return;
    const at = (kind: WidgetKind, n: Node) => findings.push({ kind, line: lineAt(n.start) });
    if (node.name === "select" || node.name === "datalist") at(node.name, node);
    for (const attr of node.attributes as Node[]) {
      if (attr.type !== "Attribute") continue;
      if (attr.name === "type" && node.name === "input") {
        const type = staticValue(attr);
        if (type === "checkbox" || type === "radio" || type === "number") at(type, attr);
      }
      // An <iframe>'s title is its accessible name, not a tooltip, and Svelte's
      // a11y check requires it. Component props named `title` aren't
      // RegularElements, so they never get here.
      if (attr.name === "title" && node.name !== "iframe") at("title", attr);
    }
  });

  for (const script of [ast.module, ast.instance]) {
    if (!script) continue;
    const offset = lineAt(script.start) - 1;
    for (const f of findInScript(source.slice(script.start, script.end))) findings.push({ kind: f.kind, line: f.line + offset });
  }
  return findings.sort((a, b) => a.line - b.line);
}

/** The attribute's value when it's a constant (`"x"`, `'x'` or `{"x"}`). */
function staticValue(attr: Node): string | undefined {
  const parts = (Array.isArray(attr.value) ? attr.value : [attr.value]) as Node[];
  if (parts.length !== 1 || !parts[0] || typeof parts[0] !== "object") return undefined;
  const part = parts[0];
  if (part.type === "Text") return part.data as string;
  const expr = part.expression as { type: string; value?: unknown } | undefined;
  if (part.type === "ExpressionTag" && expr?.type === "Literal" && typeof expr.value === "string") return expr.value;
  return undefined;
}

/**
 * Problems to fail the guardrail with: native widgets in files not allowlisted
 * for that kind (each message names the file, line and widget), and allowlist
 * entries whose file no longer has that widget, so the list only shrinks.
 */
export function checkSources(files: SourceFile[], allowlist: Allowlist): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    for (const f of findNativeWidgets(file)) {
      seen.add(`${f.kind} ${file.path}`);
      if (allowlist[f.kind].includes(file.path)) continue;
      problems.push(`${file.path}:${f.line} uses a ${LABEL[f.kind]}`);
    }
  }
  for (const kind of WIDGET_KINDS) {
    for (const path of allowlist[kind]) {
      if (!seen.has(`${kind} ${path}`)) problems.push(`${path} has no ${LABEL[kind]} any more: remove it from the "${kind}" allowlist`);
    }
  }
  return problems;
}

type Node = { type: string; name?: string; start: number; [key: string]: unknown };

function walk(value: unknown, visit: (node: Node) => void): void {
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
