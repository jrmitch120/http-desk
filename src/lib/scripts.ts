// A request's JetBrains scripts as the Scripts editor (Settings) shows and edits
// them. The request keeps them as verbatim text (`preScript`: the `<` lines above
// the request line; `responseHandler`: the `>` / `>>` lines after the body), and
// every edit here changes only the part of that text it's about: an edited body
// is the text between `{%` and `%}`, so the markers, the other scripts and any
// `>>` redirect stay as written. The core writes the edited text back in place
// (serializer.rs, `scripts_in_place`). Splitting follows the parser
// (parser.rs: the preamble's `<` lines and `handler_parts`).

import type { Request } from "./types";

/** `pre-request`: `< {% %}`, run before the request is built. `handler`: `> {% %}`, run after the response. */
export type ScriptKind = "pre-request" | "handler";

/** One script: written inline (`{% … %}`, editable) or a file reference (`> check.js`). */
export type Script =
  | { kind: ScriptKind; index: number; form: "inline"; body: string }
  | { kind: ScriptKind; index: number; form: "file"; path: string };

interface Span {
  /** Where its lines start and end (the end of its last line, before the line break). */
  from: number;
  to: number;
  form: "inline" | "file" | "redirect";
  path?: string;
  /** Inline: the text the editor shows, inside the markers and the line breaks (or spaces) next to them. */
  bodyFrom?: number;
  bodyTo?: number;
}

const field = (kind: ScriptKind) => (kind === "pre-request" ? "preScript" : "responseHandler");

/** The parts of a pre-request script (`<` lines) or a response handler (`>` / `>>` lines, at column 0). */
function spans(text: string, kind: ScriptKind): Span[] {
  const out: Span[] = [];
  let at = 0;
  while (at <= text.length) {
    const lineEnd = text.indexOf("\n", at) < 0 ? text.length : text.indexOf("\n", at);
    const line = text.slice(at, lineEnd);
    const start = kind === "pre-request" ? line.length - line.trimStart().length : 0;
    const sigil = kind === "pre-request" ? "<" : ">";
    let next = lineEnd + 1;
    if (kind === "handler" && line.startsWith(">>")) {
      out.push({ from: at, to: lineEnd, form: "redirect" });
    } else if (line.startsWith(sigil, start)) {
      const rest = line.slice(start + 1);
      const marker = rest.trimStart();
      if (marker.startsWith("{%")) {
        const open = at + start + 1 + (rest.length - marker.length) + 2;
        const found = text.indexOf("%}", open);
        const close = found < 0 ? text.length : found;
        const end = text.indexOf("\n", close) < 0 ? text.length : text.indexOf("\n", close);
        const source = text.slice(open, close);
        const lead = (/^[ \t]*\n/.exec(source) ?? /^[ \t]*/.exec(source)!)[0];
        const inner = source.slice(lead.length);
        const trail = (/\n[ \t]*$/.exec(inner) ?? /[ \t]*$/.exec(inner)!)[0];
        out.push({ from: at, to: end, form: "inline", bodyFrom: open + lead.length, bodyTo: close - trail.length });
        next = end + 1;
      } else if (marker.trim() !== "") {
        out.push({ from: at, to: lineEnd, form: "file", path: marker.trim() });
      }
    }
    at = next;
  }
  return out;
}

const scriptSpans = (text: string | null, kind: ScriptKind) => spans(text ?? "", kind).filter((s) => s.form !== "redirect");

/** The request's scripts: its pre-request scripts, then its response handlers, each in file order. */
export function requestScripts(req: Request): Script[] {
  return (["pre-request", "handler"] as const).flatMap((kind) => {
    const text = req[field(kind)] ?? "";
    return scriptSpans(text, kind).map((s, index): Script =>
      s.form === "inline" ? { kind, index, form: "inline", body: text.slice(s.bodyFrom, s.bodyTo) } : { kind, index, form: "file", path: s.path! },
    );
  });
}

/** Replaces `script`'s body (an inline script) with `body`, leaving the rest of the text as it was. */
export function setScriptBody(req: Request, script: Script, body: string) {
  const key = field(script.kind);
  const text = req[key] ?? "";
  const span = scriptSpans(text, script.kind)[script.index];
  if (span?.form !== "inline") return;
  const before = text.slice(0, span.bodyFrom);
  let after = text.slice(span.bodyTo);
  // `{%` then a line break with nothing after it: the closing `%}` goes on its own line too.
  if (before.endsWith("\n") && !/^[ \t]*\n/.test(after) && body !== "") after = "\n" + after;
  req[key] = before + body + after;
}

/** An empty inline script, as JetBrains writes one. */
const block = (kind: ScriptKind) => `${kind === "pre-request" ? "<" : ">"} {%\n\n%}`;

/** Adds an empty inline script of `kind`: a handler goes before any `>>` redirect, a pre-request script after the others. */
export function addScript(req: Request, kind: ScriptKind) {
  const key = field(kind);
  const text = req[key];
  if (text == null || text.trim() === "") {
    req[key] = block(kind);
    return;
  }
  const redirect = kind === "handler" ? spans(text, kind).find((s) => s.form === "redirect") : undefined;
  req[key] = redirect ? `${text.slice(0, redirect.from)}${block(kind)}\n${text.slice(redirect.from)}` : `${text}\n${block(kind)}`;
}

/** Takes `script`'s lines out of the request. Nothing left means no script at all. */
export function removeScript(req: Request, script: Script) {
  const key = field(script.kind);
  const text = req[key] ?? "";
  const span = scriptSpans(text, script.kind)[script.index];
  if (!span) return;
  const rest = span.to < text.length ? text.slice(0, span.from) + text.slice(span.to + 1) : text.slice(0, Math.max(0, span.from - 1));
  req[key] = rest.trim() === "" ? null : rest;
}

/** Why `body` can't be written as it is, or null. */
export function scriptBodyProblem(body: string): string | null {
  return body.includes("%}") ? "%} ends the script here, so the text after it would be lost. Split it, as in \"%\" + \"}\"." : null;
}
