// Finds text fields (<input>, <textarea>) that don't spread `textFieldAttrs`
// (src/lib/textField.ts). Used only by text-fields.test.ts; never imported by the app.
import { parse } from "svelte/compiler";

type Node = { type: string; name?: string; start: number; [key: string]: unknown };

/** Problems, each naming the file and line of a text field without `{...textFieldAttrs}`. */
export function checkTextFields(files: { path: string; source: string }[]): string[] {
  const problems: string[] = [];
  for (const file of files) {
    if (!file.path.endsWith(".svelte")) continue;
    const lineAt = (offset: number) => file.source.slice(0, offset).split("\n").length;
    walk(parse(file.source, { modern: true }).fragment, (node) => {
      if (node.type !== "RegularElement" || (node.name !== "input" && node.name !== "textarea")) return;
      const spreads = (node.attributes as Node[]).some(
        (a) => a.type === "SpreadAttribute" && (a.expression as { type: string; name?: string }).name === "textFieldAttrs",
      );
      if (!spreads) problems.push(`${file.path}:${lineAt(node.start)} <${node.name}> without {...textFieldAttrs}`);
    });
  }
  return problems;
}

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
