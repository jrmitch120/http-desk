// Completion in `.http` source (the Source view, the file view): methods at the
// start of a request line, header names on a header line and directives after
// `# @`, placed by the `.http` tree (./http.ts), so a body, a script or a
// handler is offered nothing. The lists are the ones the app already has: the
// method Select's, the Headers table's suggestions, the parser's directives.
// `variableExtensions` (./setup.ts) runs it next to the `{{variables}}`
// completion, so any `.http` editor with variables has both.
import { pickedCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { ensureSyntaxTree, language, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { HEADER_NAMES, KNOWN_DIRECTIVES, STANDARD_METHODS } from "../http";
import { matchSuggestions } from "../suggest";
import { httpLanguage } from "./http";

/** What the caret is in: a list to offer and where the word it completes starts. */
interface Place {
  options: readonly string[];
  type: string;
  from: number;
  /** What follows an accepted option, unless it's there already: a method's space, a header name's `: `. */
  then?: string;
}

/**
 * Which editor reads each directive that isn't read by both (the core's portability
 * table, crates/httpdesk-text/src/portability.rs): shown beside it in the list.
 */
const DIRECTIVE_SUPPORT: Record<string, string> = {
  "no-log": "Rider only",
  "no-auto-encoding": "Rider only",
  timeout: "Rider only",
  "connection-timeout": "Rider only",
  "use-os-credentials": "Rider only",
  note: "VS Code only",
  prompt: "VS Code only",
  "httpdesk-disabled": "HttpDesk only",
  "httpdesk-auth": "HttpDesk only",
  param: "HttpDesk only",
  header: "HttpDesk only",
};

/**
 * The `.http` tree of `state`, parsed to the end of line `to` ends on: every block
 * is there (the `.http` lines are parsed in one go), and bodies and scripts further
 * on, a file view's thousand of them, aren't parsed for nothing (#168).
 */
function treeOf(state: EditorState, to: number) {
  return ensureSyntaxTree(state, to, 50) ?? syntaxTree(state);
}

function placeAt(state: EditorState, pos: number): Place | null {
  if (state.facet(language) !== httpLanguage) return null;
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  // The block the caret is in: the last starting at or before it (blocks don't overlap).
  const block = treeOf(state, line.to).topNode.childBefore(pos + 1);
  if (!block || block.name !== "Block" || block.to < pos) return null;
  const request = block.getChild("RequestLine");
  // The node on the caret's line, if the line reads as one (a header without its colon yet doesn't).
  let covering = null;
  for (let c = block.firstChild; c; c = c.nextSibling) if (c.from <= line.to && c.to >= line.from) covering = c;

  const word = /[\w-]*$/.exec(before)![0];
  if (covering?.name === "RequestLine") {
    if (/^\s*[A-Za-z]*$/.test(before)) return { options: STANDARD_METHODS, type: "keyword", from: pos - word.length, then: " " };
    return null;
  }
  // A directive: `@` right after `#` or `//`, or one space after (the core's rule), above the request line.
  if ((covering?.name === "Comment" || covering?.name === "Directive") && (!request || line.to < request.from)) {
    if (/^\s*(#|\/\/) ?@[\w-]*$/.test(before)) return { options: KNOWN_DIRECTIVES, type: "keyword", from: pos - word.length };
    return null;
  }
  // A header's name: a line in the header area, before its colon. A line without one isn't a Header yet.
  if ((!covering || covering.name === "Header") && request && line.from > request.to && headerArea(state, request.to, line.number)) {
    if (/^\s*[\w-]*$/.test(before)) return { options: HEADER_NAMES, type: "property", from: pos - word.length, then: ": " };
  }
  return null;
}

/** Whether every line from the one after `requestEnd` up to (not including) line `number` is non-blank: the header area hasn't ended. */
function headerArea(state: EditorState, requestEnd: number, number: number): boolean {
  for (let n = state.doc.lineAt(requestEnd).number + 1; n < number; n++) if (state.doc.line(n).text.trim() === "") return false;
  return true;
}

/**
 * The change that puts `value` in place of the word at `from`..`to` (and the rest of
 * that word after the caret), followed by `then` (a method's space, a header name's
 * `: `) unless that's there already, the caret after it.
 */
export function accepting(state: EditorState, from: number, to: number, value: string, then: string): { changes: { from: number; to: number; insert: string }; selection: { anchor: number } } {
  const rest = /^[\w-]*/.exec(state.sliceDoc(to, state.doc.lineAt(to).to))![0].length;
  const after = state.sliceDoc(to + rest, to + rest + then.length);
  // All of it there (`: `), or its start (`:` at the line's end): the caret goes past what is.
  const there = after === then ? then.length : after.startsWith(then.trimEnd()) && then.trimEnd() ? then.trimEnd().length : 0;
  const insert = value + (there ? "" : then);
  return { changes: { from, to: to + rest, insert }, selection: { anchor: from + insert.length + there } };
}

/** The `.http` completion source: nothing outside a `.http` editor. */
export function httpCompletion(ctx: CompletionContext): CompletionResult | null {
  const place = placeAt(ctx.state, ctx.pos);
  if (!place) return null;
  const typed = ctx.state.sliceDoc(place.from, ctx.pos);
  // Every name before anything's typed only when asked (Ctrl+Space); typing `# @` asks for a directive.
  if (!typed && !ctx.explicit && place.options !== KNOWN_DIRECTIVES) return null;
  const matches = matchSuggestions(typed, place.options);
  if (!matches.length) return null;
  const { then } = place;
  const options: Completion[] = matches.map((m) => ({
    label: m.value,
    type: place.type,
    detail: place.options === KNOWN_DIRECTIVES ? DIRECTIVE_SUPPORT[m.value] : undefined,
    apply: then ? (view, c, from, to) => view.dispatch({ ...accepting(view.state, from, to, m.value, then), userEvent: "input.complete", annotations: pickedCompletion.of(c) }) : undefined,
  }));
  const where = new Map(matches.map((m) => [m.value, [m.from, m.to]]));
  return { from: place.from, options, filter: false, getMatch: (c) => where.get(c.label) ?? [] };
}
