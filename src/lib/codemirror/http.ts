// The `.http` language for CodeMirror: a hand-written, line-oriented parser that
// reads the text the way the core's parser does (crates/httpdesk-core/src/parser.rs,
// docs/ARCHITECTURE.md §2), building a Lezer tree that highlighting (and later
// completion, diagnostics and folding) read. It only reads: nothing here changes
// the text.
import { Language, LanguageSupport, defineLanguageFacet, foldNodeProp, languageDataProp } from "@codemirror/language";
import { NodeSet, NodeType, Parser, Tree, parseMixed, type Input, type PartialParse, type SyntaxNodeRef, type TreeFragment } from "@lezer/common";
import { jsonLanguage } from "@codemirror/lang-json";
import { xmlLanguage } from "@codemirror/lang-xml";
import { htmlLanguage } from "@codemirror/lang-html";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { graphqlLanguage } from "./graphql";
import { styleTags, tags as t } from "@lezer/highlight";
import { segments } from "../http";

/**
 * The node names of the `.http` tree, for whatever reads it. Its shape:
 *
 *     Document
 *       Block                       one per `###` block (the first may have no `###`); folds
 *         Separator                 the `###` line
 *         Comment | DisabledLine    `#` / `//` comments; `#~` lines (preamble, headers, multipart bodies)
 *         Directive                 `# @name value` (preamble only): DirectiveName (`@name`), DirectiveValue
 *         FileVariable              `@name = value`: VariableName, Equals, VariableValue
 *         PreRequestScript          `< {% %}` / `< path`: ScriptMark, ScriptOpen, Script, ScriptClose | FilePath
 *         RequestLine               Method, Url, HttpVersion
 *         Url                       an indented `?` / `&` continuation line
 *         Header                    HeaderName, Colon, HeaderValue
 *         Body | JsonBody | XmlBody | HtmlBody | GraphqlBody
 *                                   VariableRef and FileRef children; the rest is parsed in its language;
 *                                   folds when it has more than one line
 *         Handler                   `> {% %}` / `> path.js`: as PreRequestScript
 *         Redirect                  `>>` / `>>!` path: ScriptMark, FilePath
 *
 * Url, HeaderValue, DirectiveValue, VariableValue and FilePath have a
 * VariableRef child for each `{{…}}`; a Script is parsed as JavaScript.
 */
export const NODES = [
  "Document",
  "Block",
  "Separator",
  "RequestLine",
  "Method",
  "Url",
  "HttpVersion",
  "Header",
  "HeaderName",
  "Colon",
  "HeaderValue",
  "Comment",
  "DisabledLine",
  "Directive",
  "DirectiveName",
  "DirectiveValue",
  "FileVariable",
  "VariableName",
  "Equals",
  "VariableValue",
  "VariableRef",
  "Body",
  "JsonBody",
  "XmlBody",
  "HtmlBody",
  "GraphqlBody",
  "FileRef",
  "FileMark",
  "FilePath",
  "PreRequestScript",
  "Handler",
  "Redirect",
  "ScriptMark",
  "ScriptOpen",
  "Script",
  "ScriptClose",
] as const;
export type NodeName = (typeof NODES)[number];

const data = defineLanguageFacet({ commentTokens: { line: "#" } });

const nodeSet = new NodeSet(
  NODES.map((name, id) => NodeType.define({ id, name, top: id === 0, props: id === 0 ? [[languageDataProp, data]] : [] })),
).extend(
  styleTags({
    Method: t.keyword,
    Url: t.url,
    HttpVersion: t.atom,
    Separator: t.heading,
    HeaderName: t.propertyName,
    Colon: t.punctuation,
    HeaderValue: t.string,
    Comment: t.lineComment,
    // A `#~` line: HttpDesk's own, a comment to every other client.
    DisabledLine: [t.lineComment, t.deleted],
    Directive: t.lineComment,
    DirectiveName: t.annotation,
    DirectiveValue: t.string,
    VariableName: t.definition(t.variableName),
    Equals: t.definitionOperator,
    VariableValue: t.string,
    // Coloured by state in an editor with a VarProvider (`variableExtensions` in setup.ts).
    VariableRef: t.special(t.variableName),
    "FileMark ScriptMark": t.operator,
    FilePath: t.link,
    "ScriptOpen ScriptClose": t.brace,
  }),
  foldNodeProp.add({
    // A block folds from the end of its first line (its `###` line) to its last line
    // that isn't blank; so does a body of more than one line.
    "Block Body JsonBody XmlBody HtmlBody GraphqlBody"(tree, state) {
      const from = state.doc.lineAt(tree.from).to;
      let to = tree.to;
      while (to > from && /\s/.test(state.sliceDoc(to - 1, to))) to--;
      return to > from ? { from, to } : null;
    },
  }),
);
const type = (name: NodeName) => nodeSet.types[NODES.indexOf(name)];
const BLOCK = type("Block");

/** A node as the line parser builds it: absolute positions, children in order. */
interface Node {
  name: NodeName;
  from: number;
  to: number;
  children: Node[];
}

const node = (name: NodeName, from: number, to: number, children: Node[] = []): Node => ({ name, from, to, children });

function toTree(n: Node): Tree {
  return new Tree(type(n.name), n.children.map(toTree), n.children.map((c) => c.from - n.from), n.to - n.from);
}

/** A `name` node over `from`–`to` of `line`, with a VariableRef for each `{{…}}` in it, as `segments` reads them. */
function withRefs(line: Line, name: NodeName, from: number, to: number): Node {
  const refs = segments(line.text.slice(from - line.from, to - line.from))
    .filter((s) => s.ref !== undefined)
    .map((s) => node("VariableRef", from + s.from, from + s.from + s.text.length));
  return node(name, from, to, refs);
}

/** A line of the text: its content (no line break) and where it starts. */
interface Line {
  text: string;
  from: number;
}

/** The lines of `text`, which starts at `from` in the document. */
function linesOf(text: string, from = 0): Line[] {
  const out: Line[] = [];
  for (const l of text.split("\n")) {
    out.push({ text: l, from });
    from += l.length + 1;
  }
  return out;
}

/** The whitespace-separated words of `line`, with where each starts. */
function words(line: Line): { text: string; from: number }[] {
  return [...line.text.matchAll(/\S+/g)].map((m) => ({ text: m[0], from: line.from + m.index! }));
}

const KNOWN_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"];

/** A method as the core's `is_method` reads one: a known method in any case, or an upper-case word. */
function isMethod(word: string): boolean {
  return KNOWN_METHODS.includes(word.toUpperCase()) || /^[A-Z][A-Z0-9_-]*$/.test(word);
}

/** `[ METHOD ] URL [ HTTP/version ]` (the core's `parse_request_line`). */
function requestLine(line: Line): Node {
  const ws = words(line);
  const children: Node[] = [];
  let first = 0;
  let last = ws.length;
  if (ws.length >= 2 && isMethod(ws[0].text)) {
    children.push(node("Method", ws[0].from, ws[0].from + ws[0].text.length));
    first = 1;
  }
  const version = last - first >= 2 && ws[last - 1].text.startsWith("HTTP/") ? ws[last - 1] : null;
  if (version) last--;
  if (last > first) children.push(withRefs(line, "Url", ws[first].from, ws[last - 1].from + ws[last - 1].text.length));
  if (version) children.push(node("HttpVersion", version.from, version.from + version.text.length));
  return node("RequestLine", line.from, line.from + line.text.length, children);
}

const end = (line: Line) => line.from + line.text.length;

/** `Name: value` (the core's `split_header`): a name without whitespace, before the first colon. */
function header(line: Line): Node | null {
  const colon = line.text.indexOf(":");
  if (colon < 0) return null;
  const name = line.text.slice(0, colon).trim();
  if (!name || /\s/.test(name)) return null;
  const nameFrom = line.from + line.text.indexOf(name);
  const children = [node("HeaderName", nameFrom, nameFrom + name.length), node("Colon", line.from + colon, line.from + colon + 1)];
  const value = line.text.slice(colon + 1);
  const valueText = value.trim();
  if (valueText) {
    const valueFrom = line.from + colon + 1 + value.indexOf(valueText);
    children.push(withRefs(line, "HeaderValue", valueFrom, valueFrom + valueText.length));
  }
  return node("Header", line.from, end(line), children);
}

/** Where the trimmed text of `line` starts, and that text. */
function trimmedOf(line: Line): { text: string; from: number } {
  const text = line.text.trim();
  return { text, from: line.from + line.text.indexOf(text) };
}

/**
 * A `#~` disabled line, a `#` or `//` comment, or (where `directives`, in the
 * preamble) a directive: `# @name value`, its `@` right after the comment prefix
 * or one space (the core's rule; `#   @x` is description text).
 */
function commentLine(line: Line, directives: boolean): Node | null {
  const { text, from } = trimmedOf(line);
  if (text.startsWith("#~")) return node("DisabledLine", from, end(line));
  const prefix = text.startsWith("//") ? 2 : text.startsWith("#") ? 1 : 0;
  if (!prefix) return null;
  const body = text.slice(prefix);
  const at = body.startsWith("@") ? 0 : body.startsWith(" @") ? 1 : -1;
  const name = at < 0 ? "" : /^[^\s=]*/.exec(body.slice(at + 1))![0];
  if (!directives || !name) return node("Comment", from, end(line));
  const nameFrom = from + prefix + at;
  const nameTo = nameFrom + 1 + name.length;
  const children = [node("DirectiveName", nameFrom, nameTo)];
  const rest = line.text.slice(nameTo - line.from);
  const value = rest.trimStart().replace(/^=/, "").trim();
  if (value) {
    const valueFrom = nameTo + rest.indexOf(value, rest.length - rest.trimStart().length);
    children.push(withRefs(line, "DirectiveValue", valueFrom, valueFrom + value.length));
  }
  return node("Directive", from, end(line), children);
}

/** `@name = value` (the core's `parse_variable`): a File variable, wherever it's written. */
function fileVariable(line: Line): Node | null {
  const { text, from } = trimmedOf(line);
  const m = /^@([^=]*)=(.*)$/.exec(text);
  if (!m) return null;
  const name = m[1].trim();
  if (!/^[\p{Alphabetic}\p{N}_.$-]+$/u.test(name)) return null;
  const eq = from + 1 + m[1].length;
  const children = [node("VariableName", from, from + 1 + m[1].trimEnd().length), node("Equals", eq, eq + 1)];
  const value = m[2].trim();
  if (value) {
    const valueFrom = eq + 1 + m[2].indexOf(value);
    children.push(withRefs(line, "VariableValue", valueFrom, valueFrom + value.length));
  }
  return node("FileVariable", from, end(line), children);
}

/** One block: an optional `###` line, the preamble, the request line, headers, body and handler (the core's `parse_block_at`). */
function block(lines: Line[]): Node {
  const children: Node[] = [];
  let i = 0;
  if (lines[0].text.startsWith("###")) children.push(node("Separator", lines[0].from, end(lines[i++])));

  // ---- preamble, up to the request line ----
  let request: Line | null = null;
  while (i < lines.length) {
    const line = lines[i++];
    const trimmed = line.text.trim();
    if (trimmed === "") continue;
    const n = commentLine(line, true) ?? fileVariable(line);
    if (n) {
      children.push(n);
      continue;
    }
    if (trimmed.startsWith("<")) {
      const s = script(lines, i - 1, "PreRequestScript");
      children.push(s.node);
      i = s.next;
      continue;
    }
    request = line;
    break;
  }
  if (!request) return node("Block", lines[0].from, end(lines[lines.length - 1]), children);
  const reqLine = requestLine(request);
  children.push(reqLine);

  // ---- query continuation: indented `?` or `&` lines ----
  while (i < lines.length && /^\s/.test(lines[i].text) && /^[?&]/.test(lines[i].text.trim())) {
    children.push(withRefs(lines[i], "Url", trimmedOf(lines[i]).from, end(lines[i])));
    i++;
  }

  // ---- header area, up to a blank line ----
  /** The first value of each header, by its name in lower case. */
  const headers = new Map<string, string>();
  while (i < lines.length) {
    const line = lines[i++];
    if (line.text.trim() === "") break;
    const n = commentLine(line, false) ?? header(line);
    if (!n) continue;
    children.push(n);
    if (n.name === "Header") {
      const colon = line.text.indexOf(":");
      const name = line.text.slice(0, colon).trim().toLowerCase();
      if (!headers.has(name)) headers.set(name, line.text.slice(colon + 1).trim());
    }
  }

  // ---- body, up to a response handler ----
  const rest = lines.slice(i);
  const handlerAt = rest.findIndex((l) => isHandlerStart(l.text));
  const bodyLines = trimBlank(handlerAt < 0 ? rest : rest.slice(0, handlerAt));
  if (bodyLines.length) {
    const method = reqLine.children.find((c) => c.name === "Method");
    const verb = method ? request.text.slice(method.from - request.from, method.to - request.from) : "GET";
    // Every File line of a body is read from its file, as the sender reads it (the core's
    // `read_body_lines`): a body of one is, and so are those among other lines, in a form
    // body too (which is then sent like a text body).
    const fromFile = bodyLines.length === 1 && fileRef(bodyLines[0]);
    const contentType = (headers.get("content-type") ?? "").toLowerCase();
    const multipart = contentType.startsWith("multipart/");
    const parts = bodyLines.flatMap((l) => {
      if (fromFile) return [fromFile];
      const ref = multipart && l.text.startsWith("#~") ? node("DisabledLine", l.from, end(l)) : fileRef(l);
      return ref ? [ref] : withRefs(l, "Body", l.from, end(l)).children;
    });
    const kind = fromFile ? "Body" : bodyKind(verb, headers, bodyLines);
    children.push(node(kind, bodyLines[0].from, end(bodyLines[bodyLines.length - 1]), parts));
  }

  // ---- response handler: `> {% %}` and `> file.js` scripts, `>>` redirects ----
  for (let h = handlerAt < 0 ? lines.length : i + handlerAt; h < lines.length; h++) {
    const line = lines[h];
    if (line.text.startsWith(">>")) {
      const mark = line.text.startsWith(">>!") ? 3 : 2;
      const path = filePath(line, line.from + mark);
      children.push(node("Redirect", line.from, end(line), [node("ScriptMark", line.from, line.from + mark), ...(path ? [path] : [])]));
    } else if (line.text.startsWith(">")) {
      const s = script(lines, h, "Handler");
      children.push(s.node);
      h = s.next - 1;
    }
  }
  return node("Block", lines[0].from, end(lines[lines.length - 1]), children);
}

/** The path written from `from` to the end of `line`, if there is one (trimmed). */
function filePath(line: Line, from: number): Node | null {
  const text = line.text.slice(from - line.from);
  const path = text.trim();
  if (!path) return null;
  const pathFrom = from + text.indexOf(path);
  return withRefs(line, "FilePath", pathFrom, pathFrom + path.length);
}

/**
 * A File line, `< path` or `<@ path`, the mark at the very start of the line and then a
 * space or a tab: a body (or a multipart part) read from a file (the core's `file_reference`).
 */
function fileRef(line: Line): Node | null {
  const mark = /^<@?(?=[ \t])/.exec(line.text)?.[0].length;
  if (!mark) return null;
  const path = line.text.slice(mark).trim();
  if (!path || path.startsWith("<") || path.includes(">")) return null;
  const from = line.from;
  return node("FileRef", from, end(line), [node("FileMark", from, from + mark), filePath(line, from + mark)!]);
}

/**
 * A `<` pre-request script or `>` response handler starting on `lines[at]`:
 * `{%` starts an inline script, up to the next `%}` (on a later line if need be),
 * anything else names a script file (the core's `script_source`). `next` is the
 * line after it.
 */
function script(lines: Line[], at: number, name: NodeName): { node: Node; next: number } {
  const line = lines[at];
  const markFrom = trimmedOf(line).from;
  const children = [node("ScriptMark", markFrom, markFrom + 1)];
  const rest = line.text.slice(markFrom + 1 - line.from);
  const open = markFrom + 1 + (rest.length - rest.trimStart().length);
  if (!rest.trimStart().startsWith("{%")) {
    const path = filePath(line, markFrom + 1);
    return { node: node(name, line.from, end(line), path ? [...children, path] : children), next: at + 1 };
  }
  children.push(node("ScriptOpen", open, open + 2));
  // The close: on this line after the `{%`, or on a later one.
  let close = -1;
  let next = at;
  for (let from = open + 2; next < lines.length; next++, from = lines[next]?.from) {
    const l = lines[next];
    const found = l.text.indexOf("%}", from - l.from);
    if (found >= 0) {
      close = l.from + found;
      break;
    }
  }
  const last = lines[Math.min(next, lines.length - 1)];
  const scriptEnd = close >= 0 ? close : end(last);
  if (scriptEnd > open + 2) children.push(node("Script", open + 2, scriptEnd));
  if (close >= 0) children.push(node("ScriptClose", close, close + 2));
  return { node: node(name, line.from, end(last), children), next: next + 1 };
}

/** `lines` without the blank lines at either end. */
function trimBlank(lines: Line[]): Line[] {
  const start = lines.findIndex((l) => l.text.trim() !== "");
  if (start < 0) return [];
  let stop = lines.length;
  while (lines[stop - 1].text.trim() === "") stop--;
  return lines.slice(start, stop);
}

/** A response handler or output redirect, at column 0 (the core's `is_handler_start`). */
function isHandlerStart(line: string): boolean {
  if (line.startsWith(">>")) return true;
  if (!line.startsWith(">")) return false;
  const rest = line.slice(1).trim();
  return rest.startsWith("{%") || (rest !== "" && !/\s/.test(rest) && rest.endsWith(".js"));
}

/**
 * The language a body is read in: GraphQL for a GraphQL request (both editors'
 * `X-REQUEST-TYPE: GraphQL`, JetBrains' GRAPHQL method), else by the request's
 * Content-Type, else by its first character (the core's `detect_body_mode`).
 */
function bodyKind(method: string, headers: Map<string, string>, lines: Line[]): NodeName {
  const ct = (headers.get("content-type") ?? "").toLowerCase();
  if (method.toUpperCase() === "GRAPHQL" || headers.get("x-request-type")?.toLowerCase() === "graphql" || ct.includes("graphql")) return "GraphqlBody";
  if (ct.includes("json")) return "JsonBody";
  if (ct.includes("xml")) return "XmlBody";
  if (ct.includes("html")) return "HtmlBody";
  if (ct) return "Body";
  const first = lines[0].text.trim();
  return first.startsWith("{") || first.startsWith("[") ? "JsonBody" : first.startsWith("<") ? "XmlBody" : "Body";
}

/**
 * The tree of `text`, one Block per `###` block. A block reads the same wherever it
 * is (only its own lines count, as in the core), so one whose text an edit left
 * untouched (inside one of `fragments`, the last tree's parts still valid) is that
 * tree's Block, nested languages and all: only the blocks an edit touched are read
 * again, and `parseMixed` parses their bodies and scripts only (#168).
 */
function parseText(input: { read(from: number, to: number): string }, length: number, fragments: readonly TreeFragment[]): Tree {
  const children: Tree[] = [];
  const positions: number[] = [];
  let f = 0;
  // Each block starts at the start of the text or of a `###` line, and ends at the end
  // of the line before the next one. A kept block is taken whole, its text not read.
  for (let from = 0; ; ) {
    while (f < fragments.length && fragments[f].to <= from) f++;
    let tree = f < fragments.length && fragments[f].from <= from ? keptBlock(fragments[f], from) : null;
    // Kept only if a `###` line (or the text's end) still follows it.
    if (tree && from + tree.length !== length && input.read(from + tree.length, from + tree.length + 4) !== "\n###") tree = null;
    const to = tree ? from + tree.length : blockEnd(input, from, length);
    children.push(tree ?? toTree(block(linesOf(input.read(from, to), from))));
    positions.push(from);
    if (to >= length) break;
    from = to + 1;
  }
  return new Tree(type("Document"), children, positions, length);
}

/** How much of the text is looked through at a time for the next `###` line. */
const SCAN = 4096;

/** Where the block starting at `from` ends: the end of the line before the next line starting with `###`, else the text's end. */
function blockEnd(input: { read(from: number, to: number): string }, from: number, length: number): number {
  for (let at = from; at < length; at += SCAN) {
    // Three characters on, for a `\n###` that starts inside this piece.
    const found = input.read(at, Math.min(length, at + SCAN + 3)).indexOf("\n###");
    if (found >= 0 && found < SCAN) return at + found;
  }
  return length;
}

/** The Block of `fragment`'s tree that is now at `from`, if it has one there that `fragment` holds all of. */
function keptBlock(fragment: TreeFragment, from: number): Tree | null {
  const { tree, offset } = fragment;
  const at = from + offset;
  // Its Blocks, in order: the one starting at `at`, by binary search.
  let lo = 0;
  let hi = tree.children.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const pos = tree.positions[mid];
    if (pos < at) lo = mid + 1;
    else if (pos > at) hi = mid - 1;
    else {
      const child = tree.children[mid];
      return child instanceof Tree && child.type === BLOCK && from + child.length <= fragment.to ? child : null;
    }
  }
  return null;
}

/**
 * The `.http` tree of `text` without its nested languages (bodies and scripts aren't
 * parsed inside): cheap, for reading the text's structure (its blocks and requests)
 * outside an editor.
 */
export function httpLineTree(text: string): Tree {
  return parseText({ read: (from, to) => text.slice(from, to) }, text.length, []);
}

/** The parsers of the languages nested in `.http`, by the node they parse. */
const nested: Partial<Record<NodeName, Parser>> = {
  JsonBody: jsonLanguage.parser,
  XmlBody: xmlLanguage.parser,
  HtmlBody: htmlLanguage.parser,
  GraphqlBody: graphqlLanguage.parser,
  Script: javascriptLanguage.parser,
};

/**
 * Parses a body (or script) in its own language, around what `.http` reads in it
 * (its `{{variables}}` and `< file` references, the node's children), which the
 * nested parser doesn't see.
 */
const mixed = parseMixed((ref: SyntaxNodeRef) => {
  const parser = nested[ref.name as NodeName];
  if (!parser) return null;
  const overlay: { from: number; to: number }[] = [];
  let pos = ref.from;
  for (let c = ref.node.firstChild; c; c = c.nextSibling) {
    if (c.from > pos) overlay.push({ from: pos, to: c.from });
    pos = c.to;
  }
  if (pos === ref.from) return { parser };
  if (pos < ref.to) overlay.push({ from: pos, to: ref.to });
  return overlay.length ? { parser, overlay } : null;
});

class HttpParser extends Parser {
  createParse(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
    return mixed(this.lines(input, fragments, ranges), input, fragments, ranges);
  }

  /** The `.http` tree without its nested languages. */
  private lines(input: Input, fragments: readonly TreeFragment[], ranges: readonly { from: number; to: number }[]): PartialParse {
    return new LineParse(input, fragments, ranges[0].from, ranges[ranges.length - 1].to);
  }
}

/**
 * Parses the whole text in one go, on the first `advance`, reusing the blocks an
 * edit didn't touch (`parseText`). The `.http` text is always the whole document,
 * so `from` is 0.
 */
class LineParse implements PartialParse {
  parsedPos: number;
  stoppedAt: number | null = null;
  constructor(
    private input: Input,
    private fragments: readonly TreeFragment[],
    from: number,
    private to: number,
  ) {
    this.parsedPos = from;
  }
  advance(): Tree {
    this.parsedPos = this.to;
    return parseText(this.input, this.to, this.fragments);
  }
  stopAt(pos: number) {
    this.stoppedAt = pos;
  }
}

export const httpLanguage = new Language(data, new HttpParser(), [], "http");

/** `.http` support for an editor: the language and its highlighting. */
export function http(): LanguageSupport {
  return new LanguageSupport(httpLanguage);
}
