// JSONPath helpers for the response filter bar and the body editor: "Copy
// path" (the path of the value at a text offset) and key completion (from the
// core's shape summary of the body, `response_shape`).
//
// Paths written here are only the simple kind that RFC 9535 and the
// JetBrains/Jayway dialect read the same way: `$`, `.name` for plain ASCII
// identifiers, `['other key']` for every other key, and `[0]` indices.
import { matchSuggestions, type SuggestionMatch } from "./suggest";
import type { JsonShape } from "./types";

/** One step of a path: a member name or an array index. */
export type PathSegment = string | number;

/** Keys that both dialects accept after a dot. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `name` as a member selector: `.name`, or `['name']` when it isn't a plain identifier. */
export function memberSelector(name: string): string {
  return IDENTIFIER.test(name) ? `.${name}` : bracketSelector(name);
}

/** `name` as a bracketed selector, `['name']`. */
function bracketSelector(name: string): string {
  // RFC 9535 single-quoted string: escape the backslash, the quote and control characters.
  const quoted = name.replace(/[\\'\u0000-\u001f]/g, (c) => {
    if (c === "\\" || c === "'") return `\\${c}`;
    const short: Record<string, string> = { "\b": "\\b", "\f": "\\f", "\n": "\\n", "\r": "\\r", "\t": "\\t" };
    return short[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
  });
  return `['${quoted}']`;
}

/** A path from the root, e.g. `$.a['odd key'][0].b`. */
export function formatPath(segments: readonly PathSegment[]): string {
  return "$" + segments.map((s) => (typeof s === "number" ? `[${s}]` : memberSelector(s))).join("");
}

/** An open object or array while scanning, and how it was reached. */
interface Frame {
  array: boolean;
  /** The segments from the root to this container. */
  path: PathSegment[];
  /** Objects: the key whose value comes next (or is being read). Arrays: unused. */
  key: string | null;
  /** Arrays: the index of the next element. */
  index: number;
}

/**
 * The path of the JSON value at `offset` in `text` (a caret position, so a
 * value counts from just before its first character to just after its last).
 * A key names its member's value; a place between values names the innermost
 * object or array around it. Only the text up to the offset is read, so a
 * large body costs little and a truncated one still works. Returns null where
 * the text before the offset isn't JSON.
 */
export function pathAt(text: string, offset: number): string | null {
  const stack: Frame[] = [];
  const top = () => stack[stack.length - 1];
  /** The path of a value starting at the current position. */
  const nextPath = (): PathSegment[] | null => {
    const f = top();
    if (!f) return [];
    if (f.array) return [...f.path, f.index];
    return f.key === null ? null : [...f.path, f.key];
  };
  /** After a whole value: objects wait for the next key, arrays move on. */
  const valueDone = () => {
    const f = top();
    if (!f) return;
    if (f.array) f.index++;
    else f.key = null;
  };
  /** The path for a caret between tokens: the innermost container, or the member after a key. */
  const between = (): string => {
    const f = top();
    if (!f) return "$";
    return formatPath(!f.array && f.key !== null ? [...f.path, f.key] : f.path);
  };
  // Objects: whether a key and its ':' have been read and the value is next.
  let expectValue = false;

  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === " " || c === "\n" || c === "\r" || c === "\t" || c === ",") {
      if (c === "," && i >= offset) return between();
      i++;
      continue;
    }
    if (i > offset) return between();
    if (c === ":") {
      expectValue = true;
      i++;
      continue;
    }
    if (c === "{" || c === "[") {
      const path = nextPath();
      if (path === null) return null;
      stack.push({ array: c === "[", path, key: null, index: 0 });
      expectValue = false;
      i++;
      continue;
    }
    if (c === "}" || c === "]") {
      const f = top();
      if (!f || f.array !== (c === "]")) return null;
      // Just before or just after the bracket: the container itself.
      if (offset <= i + 1) return formatPath(f.path);
      stack.pop();
      valueDone();
      expectValue = false;
      i++;
      continue;
    }
    // A string or a scalar: find where it ends.
    const start = i;
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
    } else {
      while (i < text.length && !/[\s,:{}[\]"]/.test(text[i])) i++;
    }
    const f = top();
    const isKey = !!f && !f.array && !expectValue;
    if (isKey) {
      let key: string;
      try {
        key = JSON.parse(text.slice(start, i));
      } catch {
        return null;
      }
      if (typeof key !== "string") return null;
      f.key = key;
      if (offset <= i) return formatPath([...f.path, key]);
      continue;
    }
    const path = nextPath();
    if (path === null) return null;
    if (offset <= i) return formatPath(path);
    valueDone();
    expectValue = false;
  }
  return between();
}

// ------------------------------------------------------------ key completion

/** A suggested key: `value` is the key (what the list shows), `insert` the selector that replaces the typed segment. */
export interface KeyMatch extends SuggestionMatch {
  insert: string;
}

/** Suggestions for the segment being typed: accepting one replaces `text.slice(from, caret)` with its `insert`. */
export interface KeyCompletion {
  from: number;
  matches: KeyMatch[];
}

/** Every shape inside `s`, `s` included (what `..` reaches). */
function descendants(s: JsonShape, out: JsonShape[] = []): JsonShape[] {
  out.push(s);
  for (const [, child] of s.keys ?? []) descendants(child, out);
  if (s.items) descendants(s.items, out);
  return out;
}

/** Member values and array elements of each shape (what `*` and filters select). */
const children = (shapes: JsonShape[]) => shapes.flatMap((s) => [...(s.keys ?? []).map(([, c]) => c), ...(s.items ? [s.items] : [])]);
const member = (shapes: JsonShape[], name: string) => shapes.flatMap((s) => (s.keys ?? []).filter(([k]) => k === name).map(([, c]) => c));
const elements = (shapes: JsonShape[]) => shapes.flatMap((s) => (s.items ? [s.items] : []));

/** The distinct keys of `shapes`, in order. */
const keysOf = (shapes: JsonShape[]) => [...new Set(shapes.flatMap((s) => (s.keys ?? []).map(([k]) => k)))];

const NAME_START = /[A-Za-z_\u0080-￿]/;
const NAME_CHAR = /[A-Za-z0-9_\u0080-￿]/;

/**
 * Key suggestions for a JSONPath expression with the caret at `caret`, from
 * the body's shape. Completes the segment the caret ends: `.na`, `['na`,
 * `..na` (any key below). The path before it is followed through the shape:
 * names, wildcards, indices, slices and filters (which select every item).
 * Returns null where there's nothing to complete (mid-literal, or the text
 * before the caret isn't a path this understands).
 */
export function keyCompletion(text: string, caret: number, shape: JsonShape): KeyCompletion | null {
  const t = text.slice(0, caret);
  let i = 0;
  while (t[i] === " ") i++;
  if (t[i] !== "$") return null;
  i++;
  let nodes: JsonShape[] = [shape];
  /** Suggestions replacing the segment from `from`; `insert` writes one key as that segment. */
  const complete = (from: number, partial: string, at: JsonShape[], insert: (key: string) => string): KeyCompletion => ({
    from,
    matches: matchSuggestions(partial, keysOf(at)).map((m) => ({ ...m, insert: insert(m.value) })),
  });
  while (i < t.length) {
    const from = i;
    if (t.startsWith("..", i) || t[i] === ".") {
      const deep = t.startsWith("..", i);
      i += deep ? 2 : 1;
      const at = deep ? nodes.flatMap((s) => descendants(s)) : nodes;
      if (t[i] === "*") {
        i++;
        nodes = children(at);
        continue;
      }
      if (t[i] === "[" && deep) {
        nodes = at;
        continue;
      }
      let end = i;
      if (end < t.length && NAME_START.test(t[end])) while (end < t.length && NAME_CHAR.test(t[end])) end++;
      if (end === t.length) return complete(from, t.slice(i), at, (k) => (deep ? ".." + memberSelector(k).replace(/^\./, "") : memberSelector(k)));
      if (end === i) return null;
      nodes = member(at, t.slice(i, end));
      i = end;
      continue;
    }
    if (t[i] === "[") {
      const close = bracketEnd(t, i);
      if (close < 0) {
        // An unfinished quoted name, alone in its brackets: complete it.
        const m = /^\[\s*(['"])((?:[^'"\\]|\\.)*)$/.exec(t.slice(i));
        if (!m) return null;
        return complete(from, unquote(m[2]), nodes, bracketSelector);
      }
      nodes = bracketSelect(nodes, t.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (t[i] === " ") {
      i++;
      continue;
    }
    return null;
  }
  return null;
}

/** The index of the `]` closing the bracket at `open`, skipping strings and nested brackets; -1 if it's still open. */
function bracketEnd(t: string, open: number): number {
  let depth = 0;
  for (let i = open; i < t.length; i++) {
    const c = t[i];
    if (c === "'" || c === '"') {
      i++;
      while (i < t.length && t[i] !== c) i += t[i] === "\\" ? 2 : 1;
      if (i >= t.length) return -1;
    } else if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") {
      depth--;
      if (depth === 0) return c === "]" ? i : -1;
    }
  }
  return -1;
}

/** What a bracketed selection (`'name'`, `*`, `0`, `1:3`, `?@.x`, or a list of them) reaches. */
function bracketSelect(nodes: JsonShape[], inner: string): JsonShape[] {
  const out: JsonShape[] = [];
  for (const raw of splitSelectors(inner)) {
    const sel = raw.trim();
    const q = /^(['"])((?:[^'"\\]|\\.)*)\1$/.exec(sel);
    if (q) out.push(...member(nodes, unquote(q[2])));
    else if (sel === "*" || sel.startsWith("?")) out.push(...children(nodes));
    else out.push(...elements(nodes));
  }
  return [...new Set(out)];
}

/** Splits a bracket's contents on its top-level commas. */
function splitSelectors(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "'" || c === '"') {
      i++;
      while (i < inner.length && inner[i] !== c) i += inner[i] === "\\" ? 2 : 1;
    } else if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  return parts;
}

/** The text of a quoted name's contents, escapes decoded (an unfinished escape is dropped). */
function unquote(body: string): string {
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)?/g, (_, e: string | undefined) => {
    if (!e) return "";
    if (e[0] === "u" && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as Record<string, string>)[e] ?? e;
  });
}
