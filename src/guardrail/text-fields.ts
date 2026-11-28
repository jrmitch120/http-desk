// Finds text fields (<input>, <textarea>) that don't spread `textFieldAttrs`
// (src/lib/textField.ts), and text fields built in script with createElement.
// Used only by text-fields.test.ts; never imported by the app.
import { parse } from "svelte/compiler";
import { lineAt, walk, type Node, type SourceFile } from "./source";

const CREATE_FIELD = /createElement\(\s*["'`](input|textarea)["'`]/;

/** Problems, each naming the file and line of a text field without `{...textFieldAttrs}`. */
export function checkTextFields(files: SourceFile[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    const scriptProblem = (tag: string, line: number) =>
      problems.push(
        `${file.path}:${line} createElement("${tag}") builds a text field outside markup; draw it in a .svelte file with {...textFieldAttrs}`,
      );
    if (!file.path.endsWith(".svelte")) {
      findCreated(file.source, 1, scriptProblem);
      continue;
    }
    const ast = parse(file.source, { modern: true });
    walk(ast.fragment, (node) => {
      if (node.type !== "RegularElement" || (node.name !== "input" && node.name !== "textarea")) return;
      const spreads = (node.attributes as Node[]).some(
        (a) => a.type === "SpreadAttribute" && (a.expression as { type: string; name?: string }).name === "textFieldAttrs",
      );
      if (!spreads) problems.push(`${file.path}:${lineAt(file.source, node.start)} <${node.name}> without {...textFieldAttrs}`);
    });
    for (const script of [ast.module, ast.instance]) {
      if (script) findCreated(file.source.slice(script.start, script.end), lineAt(file.source, script.start), scriptProblem);
    }
  }
  return problems.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Reports each `createElement("input" | "textarea")` in `source`, whose first line is `firstLine`. */
function findCreated(source: string, firstLine: number, report: (tag: string, line: number) => void): void {
  source.split("\n").forEach((text, i) => {
    const m = CREATE_FIELD.exec(text);
    if (m) report(m[1], firstLine + i);
  });
}
