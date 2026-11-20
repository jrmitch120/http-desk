// Underlines in a request's `.http` source for what the check strip lists
// (src/lib/checks.ts): the core's problems at their place, each sent reference to
// an Undefined variable, and a duplicate `# @name`. Hovering one shows its message.
// The editor is given them with `setUnderlines` (Editor.svelte's `underlines`);
// they then follow its edits until it's given others.
import { EditorSelection, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, hoverTooltip, keymap, showTooltip, type DecorationSet, type Tooltip } from "@codemirror/view";
import type { Check } from "../checks";
import { segments } from "../http";
import type { HttpFile } from "../types";

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
  // Nothing to place: the text (a whole file's, in the file view) isn't split for nothing.
  if (!checks.length) return [];
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

/** A whole file's text as it was read into `file`: each part as written. */
export function textRead(file: HttpFile): string {
  return (file.header.raw ?? "") + file.requests.map((r) => r.leading + (r.raw ?? "")).join("") + file.trailing;
}

/**
 * Where each request's `checks` (the `i`th, its request's) show in the text `file` was
 * read from (`textRead`), as `checkUnderlines` places them in its block: a file view's
 * or the Problems panel's Undefined variables and shared `# @name`s.
 */
export function fileUnderlines(file: HttpFile, checks: Check[][]): Underline[] {
  let at = (file.header.raw ?? "").length;
  return file.requests.flatMap((req, i) => {
    at += req.leading.length;
    const block = req.raw ?? "";
    const start = at;
    at += block.length;
    return checks[i]?.length ? checkUnderlines(block, checks[i]).map((u) => ({ ...u, from: u.from + start, to: u.to + start })) : [];
  });
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

/** Every underline in `state`, where its text is now. */
export function underlinesIn(state: EditorState): Underline[] {
  return state.field(underlineField, false)?.underlines ?? [];
}

/** The underlines covering `pos` in `state`. */
export function underlinesAt(state: EditorState, pos: number): Underline[] {
  return state.field(underlineField, false)?.underlines.filter((u) => u.to > u.from && pos >= u.from && pos <= u.to) ?? [];
}

/** The messages of the underlines `here`, as a tooltip over them. */
function tipOf(here: Underline[]): Tooltip {
  return {
    pos: Math.min(...here.map((u) => u.from)),
    end: Math.max(...here.map((u) => u.to)),
    create() {
      const dom = document.createElement("div");
      dom.className = "cm-underline-tip";
      // Read out when it shows from the keyboard (`nextUnderline`).
      dom.setAttribute("role", "status");
      for (const u of here) {
        const p = dom.appendChild(document.createElement("div"));
        p.className = `cm-underline-message cm-underline-${u.severity}`;
        p.textContent = `${u.severity === "error" ? "Error" : "Warning"}: ${u.message}`;
      }
      return { dom };
    },
  };
}

/** Shows the messages of the underlines at an offset (Next problem), or none. */
const showUnderlineAt = StateEffect.define<number | null>();

/** The tooltip Next / Previous problem shows at the caret, until the caret moves or the text changes. */
const shownField = StateField.define<Tooltip | null>({
  create: () => null,
  update(tip, tr) {
    for (const e of tr.effects) {
      if (!e.is(showUnderlineAt)) continue;
      const here = e.value === null ? [] : underlinesAt(tr.state, e.value);
      return here.length ? tipOf(here) : null;
    }
    return tr.docChanged || tr.selection ? null : tip;
  },
  provide: (f) => showTooltip.from(f),
});

/**
 * Moves the caret to the next underline after it (`dir` 1) or the last before it
 * (-1), around the ends, and shows its message: the problems by keyboard, as a hover
 * shows them. False when there's none.
 */
export function nextUnderline(view: EditorView, dir: 1 | -1): boolean {
  const all = (view.state.field(underlineField, false)?.underlines ?? []).filter((u) => u.to > u.from);
  if (!all.length) return false;
  const at = view.state.selection.main.head;
  const starts = [...new Set(all.map((u) => u.from))].sort((a, b) => a - b);
  const to = dir === 1 ? (starts.find((s) => s > at) ?? starts[0]) : ([...starts].reverse().find((s) => s < at) ?? starts[starts.length - 1]);
  view.dispatch({ selection: EditorSelection.cursor(to), effects: [EditorView.scrollIntoView(to, { y: "nearest", yMargin: 40 }), showUnderlineAt.of(to)], userEvent: "select.problem" });
  return true;
}

/** Underlines (given with `setUnderlines`), their messages on hover, and F8 / Shift-F8 to go through them. */
export function underlines(): Extension {
  return [
    underlineField,
    shownField,
    keymap.of([
      { key: "F8", run: (v) => nextUnderline(v, 1), shift: (v) => nextUnderline(v, -1) },
      { key: "Escape", run: (v) => (v.state.field(shownField) ? (v.dispatch({ effects: showUnderlineAt.of(null) }), true) : false) },
    ]),
    hoverTooltip((view, pos) => {
      const here = underlinesAt(view.state, pos);
      return here.length ? tipOf(here) : null;
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
