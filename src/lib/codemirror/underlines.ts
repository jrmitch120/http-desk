// Underlines in a request's `.http` source for what the check strip lists
// (src/lib/checks.ts): the core's problems at their place, each sent reference to
// an Undefined variable, and a duplicate `# @name`. Hovering one shows its message.
// The editor is given them with `setUnderlines` (Editor.svelte's `underlines`);
// they then follow its edits until it's given others.
import { StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, type DecorationSet } from "@codemirror/view";
import type { Check } from "../checks";
import { segments } from "../http";

export interface Underline {
  from: number;
  to: number;
  severity: "error" | "warning";
  message: string;
}

/** Replaces an editor's underlines (offsets into its document as it is). */
export const setUnderlines = StateEffect.define<Underline[]>();

/** The UTF-16 offset in `line` of 1-based character column `column`. */
const offsetOf = (line: string, column: number) => Array.from(line).slice(0, column - 1).join("").length;

/** A comment or a `#~` disabled line, which isn't sent. */
const isComment = (line: string) => /^\s*(#|\/\/)/.test(line);

/**
 * Where `checks` show in `text`, the request's source they were found in, in the
 * order of the text. A problem runs from its column to its line's end (less trailing
 * blanks); one on a line the text doesn't have is left out. Undefined variables are
 * underlined where a sent line references them (not in comments or `#~` lines).
 */
export function checkUnderlines(text: string, checks: Check[]): Underline[] {
  const lines = text.split("\n");
  const starts: number[] = [];
  lines.reduce((at, l) => (starts.push(at), at + l.length + 1), 0);
  const out: Underline[] = [];
  const lineEnd = (i: number) => starts[i] + lines[i].trimEnd().length;
  const undefinedNames = new Set(checks.flatMap((c) => (c.kind === "undefined" ? [c.name] : [])));
  for (const check of checks) {
    if (check.kind === "problem") {
      const { line, column, severity, message } = check.problem;
      if (line > lines.length) continue;
      const from = starts[line - 1] + offsetOf(lines[line - 1], column);
      out.push({ from, to: Math.max(from, lineEnd(line - 1)), severity, message });
    } else if (check.kind === "duplicateName") {
      const message = `# @name ${check.name} is also the name of ${check.others === 1 ? "another request" : `${check.others} other requests`} in this file`;
      lines.forEach((l, i) => {
        const m = /^\s*(?:#|\/\/)\s*(@name)(?:\s+(.*))?$/.exec(l);
        if (m && m[2]?.trim() === check.name) out.push({ from: starts[i] + m.index + m[0].indexOf("@name"), to: lineEnd(i), severity: "warning", message });
      });
    }
  }
  if (undefinedNames.size) {
    lines.forEach((l, i) => {
      if (isComment(l)) return;
      for (const s of segments(l)) {
        if (s.ref !== undefined && undefinedNames.has(s.ref)) {
          out.push({ from: starts[i] + s.from, to: starts[i] + s.from + s.text.length, severity: "warning", message: `{{${s.ref}}} is undefined` });
        }
      }
    });
  }
  return out.sort((a, b) => a.from - b.from);
}

interface Marked {
  decorations: DecorationSet;
  underlines: Underline[];
}

const marks = (u: Underline[]): DecorationSet =>
  Decoration.set(
    u.filter((x) => x.to > x.from).map((x) => Decoration.mark({ class: `cm-underline cm-underline-${x.severity}`, attributes: { "data-message": x.message } }).range(x.from, x.to)),
    true,
  );

const underlineField = StateField.define<Marked>({
  create: () => ({ decorations: Decoration.none, underlines: [] }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setUnderlines)) {
        const max = tr.state.doc.length;
        const u = e.value.filter((x) => x.from <= max && x.to <= max);
        return { decorations: marks(u), underlines: u };
      }
    }
    if (!tr.docChanged) return value;
    const underlines = value.underlines.map((u) => ({ ...u, from: tr.changes.mapPos(u.from, 1), to: tr.changes.mapPos(u.to, -1) }));
    return { decorations: value.decorations.map(tr.changes), underlines };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.decorations),
});

/** The underlines covering `pos` in `state`. */
export function underlinesAt(state: EditorState, pos: number): Underline[] {
  return state.field(underlineField, false)?.underlines.filter((u) => u.to > u.from && pos >= u.from && pos <= u.to) ?? [];
}

/** Underlines (given with `setUnderlines`), and their messages on hover. */
export function underlines(): Extension {
  return [
    underlineField,
    hoverTooltip((view, pos) => {
      const here = underlinesAt(view.state, pos);
      if (!here.length) return null;
      return {
        pos: Math.min(...here.map((u) => u.from)),
        end: Math.max(...here.map((u) => u.to)),
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-underline-tip";
          for (const u of here) {
            const p = dom.appendChild(document.createElement("div"));
            p.className = `cm-underline-message cm-underline-${u.severity}`;
            p.textContent = u.message;
          }
          return { dom };
        },
      };
    }),
    EditorView.theme({
      ".cm-underline": { textDecoration: "underline wavy", textDecorationSkipInk: "none", textUnderlineOffset: "3px" },
      ".cm-underline-error": { textDecorationColor: "var(--danger)" },
      ".cm-underline-warning": { textDecorationColor: "var(--warning)" },
      // Same text box as the app's own tooltips (TooltipHost.svelte).
      ".cm-underline-tip": { maxWidth: "360px", padding: "4px 8px", fontFamily: "var(--font)", fontSize: "12px", lineHeight: "1.4" },
      ".cm-underline-tip .cm-underline-message + .cm-underline-message": { marginTop: "4px" },
    }),
  ];
}
