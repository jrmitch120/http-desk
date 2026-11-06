// Pure helpers for editing the request model. No Svelte/Tauri imports so
// they can be unit tested with vitest (src/lib/http.test.ts).
import type { BodyMode, HttpFile, KeyValue, Request, Variable } from "./types";

export const STANDARD_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function methodClass(method: string): string {
  const m = method.toUpperCase();
  return STANDARD_METHODS.includes(m) ? `m-${m.toLowerCase()}` : "m-custom";
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function newRequest(name = "New request"): Request {
  return {
    name,
    comments: [],
    directives: [],
    variables: [],
    preScript: null,
    method: "GET",
    url: "",
    httpVersion: null,
    query: { enabled: true, items: [] },
    headers: { enabled: true, items: [] },
    auth: { enabled: true, kind: "none", username: "", password: "", token: "", keyName: "", keyValue: "", keyLocation: "header", raw: null },
    body: { enabled: true, mode: "none", text: "" },
    extraLines: [],
    responseHandler: null,
    leading: "",
    raw: null,
  };
}

export function displayName(req: Request): string {
  if (req.name.trim()) return req.name.trim();
  const n = req.directives.find((d) => d.name === "name")?.value;
  if (n) return n;
  return req.url ? `${req.method} ${req.url}` : "Untitled request";
}

// ------------------------------------------------------------------ URL ⇄ params

// Query escaping per ADR-0001, mirroring crates/httpdesk-core/src/query.rs: the table
// holds decoded values; the URL bar (like the file) escapes only what would change the
// query's structure. Other `%XX` stay as written. `{{variable}}` references are kept.

type Part = "name" | "value";

function structural(c: string, part: Part): boolean {
  return /\p{White_Space}/u.test(c) || c === "%" || c === "&" || c === "#" || (part === "name" && c === "=");
}

function escapedByte(s: string, i: number): number | null {
  return s[i] === "%" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3)) ? parseInt(s.slice(i + 1, i + 3), 16) : null;
}

/** The character that the `%XX` escapes at `s[i]` decode to, and their length. */
function escapedChar(s: string, i: number): [string, number] | null {
  const lead = escapedByte(s, i);
  if (lead === null) return null;
  const len = lead < 0x80 ? 1 : lead >= 0xc0 && lead < 0xe0 ? 2 : lead >= 0xe0 && lead < 0xf0 ? 3 : lead >= 0xf0 && lead < 0xf8 ? 4 : 0;
  if (!len) return null;
  const bytes: number[] = [];
  for (let k = 0; k < len; k++) {
    const b = escapedByte(s, i + k * 3);
    if (b === null) return null;
    bytes.push(b);
  }
  try {
    const c = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    return [...c].length === 1 ? [c, len * 3] : null;
  } catch {
    return null;
  }
}

/** Splits text into plain runs and `{{…}}` references, as the resolver finds them. */
function segments(text: string): [boolean, string][] {
  const out: [boolean, string][] = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf("{{");
    const end = start < 0 ? -1 : rest.indexOf("}}", start + 2);
    if (end < 0) break;
    out.push([false, rest.slice(0, start)], [true, rest.slice(start, end + 2)]);
    rest = rest.slice(end + 2);
  }
  out.push([false, rest]);
  return out;
}

function percentEncode(c: string): string {
  return [...new TextEncoder().encode(c)].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
}

function escapeParam(text: string, part: Part): string {
  let out = "";
  for (const [ref, s] of segments(text)) {
    if (ref) {
      out += s;
      continue;
    }
    const chars = [...s];
    let i = 0;
    chars.forEach((c, k) => {
      if (c === "%") {
        const decoded = escapedChar(s, i);
        const readsAsEscape = decoded !== null && structural(decoded[0], part);
        const beforeEscape = k + 1 < chars.length && structural(chars[k + 1], part);
        out += readsAsEscape || beforeEscape ? "%25" : "%";
      } else {
        out += structural(c, part) ? percentEncode(c) : c;
      }
      i += c.length;
    });
  }
  return out;
}

function unescapeParam(text: string, part: Part): string {
  let out = "";
  for (const [ref, s] of segments(text)) {
    if (ref) {
      out += s;
      continue;
    }
    let i = 0;
    while (i < s.length) {
      const decoded = escapedChar(s, i);
      if (decoded && structural(decoded[0], part)) {
        out += decoded[0];
        i += decoded[1];
      } else {
        const c = String.fromCodePoint(s.codePointAt(i)!);
        out += c;
        i += c.length;
      }
    }
  }
  return out;
}

function renderParam(p: KeyValue): string {
  const name = escapeParam(p.name, "name");
  if (p.value === "") return p.equals ? `${name}=` : name;
  return `${name}=${escapeParam(p.value, "value")}`;
}

export function parseQuery(qs: string): KeyValue[] {
  return qs
    .split("&")
    .filter((p) => p !== "")
    .map((p) => {
      const i = p.indexOf("=");
      if (i < 0) return { enabled: true, name: unescapeParam(p, "name"), value: "" };
      const kv: KeyValue = { enabled: true, name: unescapeParam(p.slice(0, i), "name"), value: unescapeParam(p.slice(i + 1), "value") };
      if (kv.value === "") kv.equals = true;
      return kv;
    });
}

function isActive(p: KeyValue): boolean {
  return p.enabled && p.name !== "";
}

/** URL as shown in the URL bar: base + active query params. */
export function composeUrl(req: Request): string {
  const active = req.query.enabled ? req.query.items.filter(isActive) : [];
  if (!active.length) return req.url;
  return req.url + (req.url.includes("?") ? "&" : "?") + active.map(renderParam).join("&");
}

/**
 * Applies text typed in the URL bar. Active params are replaced by the ones in the
 * text (in place); disabled params and blank rows are kept so nothing is lost.
 */
export function applyUrlText(req: Request, text: string): void {
  const q = text.indexOf("?");
  const base = q < 0 ? text : text.slice(0, q);
  const parsed = q < 0 ? [] : parseQuery(text.slice(q + 1));
  req.url = base;
  if (parsed.length && !req.query.enabled) req.query.enabled = true;
  const sectionOn = req.query.enabled;
  // Retyped params keep their documentation (matched by name).
  const docs = new Map<string, string>();
  for (const item of req.query.items) if (sectionOn && isActive(item) && item.description && !docs.has(item.name)) docs.set(item.name, item.description);
  const withDoc = (p: KeyValue): KeyValue => (docs.has(p.name) ? { ...p, description: docs.get(p.name) } : p);
  const next: KeyValue[] = [];
  let k = 0;
  for (const item of req.query.items) {
    if (sectionOn && isActive(item)) {
      if (k < parsed.length) next.push(withDoc(parsed[k++]));
    } else {
      next.push(item);
    }
  }
  while (k < parsed.length) next.push(withDoc(parsed[k++]));
  req.query.items = next;
}

// ------------------------------------------------------------------ bulk edit

/** Key/value rows as bulk-edit text: one `name<sep> value` per line, `//` = disabled. */
export function formatBulk(items: KeyValue[], separator: string, toggles: boolean): string {
  return items
    .filter((r) => r.name || r.value)
    .map((r) => `${toggles && !r.enabled ? "//" : ""}${r.name}${separator}${separator === ":" ? " " : ""}${r.value}`)
    .join("\n");
}

/** Bulk-edit text back to rows. Descriptions come from `previous` (matched by name),
 *  which should be the rows as they were when bulk editing started. */
export function parseBulk(text: string, separator: string, previous: KeyValue[]): KeyValue[] {
  const docs = [...previous];
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const disabled = l.trimStart().startsWith("//");
      const line = disabled ? l.trimStart().slice(2) : l;
      const idx = line.indexOf(separator);
      const name = (idx < 0 ? line : line.slice(0, idx)).trim();
      const value = idx < 0 ? "" : line.slice(idx + 1).trim();
      const at = docs.findIndex((p) => p.name === name);
      const description = at < 0 ? undefined : docs.splice(at, 1)[0].description;
      return description ? { enabled: !disabled, name, value, description } : { enabled: !disabled, name, value };
    });
}

// ------------------------------------------------------------------ headers

export function findHeader(req: Request, name: string): KeyValue | undefined {
  return req.headers.items.find((h) => h.name.toLowerCase() === name.toLowerCase());
}

export function setHeader(req: Request, name: string, value: string): void {
  const h = findHeader(req, name);
  if (h) {
    h.value = value;
    h.enabled = true;
  } else {
    req.headers.items.push({ enabled: true, name, value });
  }
}

export const MODE_CONTENT_TYPES: Partial<Record<BodyMode, string>> = {
  json: "application/json",
  xml: "application/xml",
  text: "text/plain",
  formUrlEncoded: "application/x-www-form-urlencoded",
};

const AUTO_TYPES = new Set(Object.values(MODE_CONTENT_TYPES).concat(["text/xml"]));

/** The Content-Type `setBodyMode` sets for `mode`: what HttpDesk adds by itself.
 *  `current` supplies the boundary of a multipart header. */
function autoContentType(mode: BodyMode, current: string): string | undefined {
  if (mode === "multipart") return `multipart/form-data; boundary=${boundaryOf(current) ?? "HttpDeskBoundary"}`;
  return MODE_CONTENT_TYPES[mode];
}

/** Switches body mode and keeps Content-Type in sync, like Postman. Switching to
 *  none drops a Content-Type HttpDesk added itself, but not one the user typed. */
export function setBodyMode(req: Request, mode: BodyMode): void {
  const prev = req.body.mode;
  req.body.mode = mode;
  const ct = findHeader(req, "content-type");
  const wanted = MODE_CONTENT_TYPES[mode];
  if (mode === "none") {
    if (ct && ct.value === autoContentType(prev, ct.value)) req.headers.items.splice(req.headers.items.indexOf(ct), 1);
    return;
  }
  if (mode === "multipart") {
    const boundary = boundaryOf(ct?.value ?? "") ?? "HttpDeskBoundary";
    setHeader(req, "Content-Type", `multipart/form-data; boundary=${boundary}`);
    if (prev !== "multipart") req.body.text = buildMultipart(parseFormish(req.body.text, prev), boundary);
    return;
  }
  if (wanted && (!ct || AUTO_TYPES.has(ct.value.split(";")[0].trim()) || ct.value.startsWith("multipart/"))) {
    setHeader(req, "Content-Type", wanted);
  }
  if (mode === "formUrlEncoded" && prev === "multipart") {
    req.body.text = buildForm(parseMultipart(req.body.text, boundaryOf(ct?.value ?? "") ?? "").filter((p) => p.kind === "text"));
  }
}

function parseFormish(text: string, mode: BodyMode): MultipartPart[] {
  return mode === "formUrlEncoded" ? parseForm(text).map((f) => ({ ...f, kind: "text" as const })) : [];
}

// ------------------------------------------------------------------ form-urlencoded

export interface FormField {
  name: string;
  value: string;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, " "));
  } catch {
    return s;
  }
}

/** Encodes a value but keeps `{{variables}}` intact. */
function encodePreservingVars(s: string): string {
  return s
    .split(/(\{\{[^}]*\}\})/)
    .map((part) => (part.startsWith("{{") ? part : encodeURIComponent(part)))
    .join("");
}

/** Joins one-field-per-line form bodies with `&`, like the sender does. */
function joinFormLines(text: string): string {
  let out = "";
  for (const line of text.split("\n").map((l) => l.trim())) {
    if (line === "") continue;
    if (out !== "" && !out.endsWith("&") && !line.startsWith("&")) out += "&";
    out += line;
  }
  return out;
}

export function parseForm(text: string): FormField[] {
  return joinFormLines(text)
    .split("&")
    .filter((p) => p !== "")
    .map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? { name: safeDecode(p), value: "" } : { name: safeDecode(p.slice(0, i)), value: safeDecode(p.slice(i + 1)) };
    });
}

export function buildForm(fields: FormField[]): string {
  return fields
    .filter((f) => f.name !== "")
    .map((f) => `${encodePreservingVars(f.name)}=${encodePreservingVars(f.value)}`)
    .join("\n&");
}

// ------------------------------------------------------------------ file

export interface FileRef {
  /** `<@ path`: variables in the file's content are substituted. */
  substitute: boolean;
  path: string;
}

/** `< path` or `<@ path` (space optional), the same rule as the sender. `<tag>` and `<?xml` are content. */
export function parseFileRef(text: string): FileRef | null {
  const t = text.trim();
  const m = /^<(@?)\s*([^\n]*)$/.exec(t);
  if (!m || t.startsWith("<?")) return null;
  const path = m[2].trim();
  if (path === "" || path.startsWith("<") || path.includes(">")) return null;
  return { substitute: m[1] === "@", path };
}

// ------------------------------------------------------------------ multipart

export interface MultipartPart {
  name: string;
  kind: "text" | "file";
  /** Text value, or the file path for file parts. */
  value: string;
  contentType?: string;
}

export function boundaryOf(contentType: string): string | null {
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType);
  return m ? m[2] : null;
}

export function parseMultipart(text: string, boundary: string): MultipartPart[] {
  if (!boundary) return [];
  const parts: MultipartPart[] = [];
  const chunks = text.split(new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?\\s*$`, "m"));
  for (const chunk of chunks) {
    const c = chunk.replace(/^\n/, "").replace(/\n$/, "");
    if (!c.trim()) continue;
    const split = c.indexOf("\n\n");
    const head = split < 0 ? c : c.slice(0, split);
    const content = split < 0 ? "" : c.slice(split + 2);
    const disp = /content-disposition:[^\n]*?;\s*name="([^"]*)"/i.exec(head);
    if (!disp) continue;
    const ct = /content-type:\s*([^\n]+)/i.exec(head)?.[1].trim();
    const fileRef = parseFileRef(content);
    const isFile = /filename=/i.test(head) && !!fileRef && !fileRef.substitute;
    parts.push({ name: disp[1], kind: isFile ? "file" : "text", value: isFile ? fileRef!.path : content, contentType: ct });
  }
  return parts;
}

export function buildMultipart(parts: MultipartPart[], boundary: string): string {
  const lines: string[] = [];
  for (const p of parts.filter((p) => p.name !== "")) {
    lines.push(`--${boundary}`);
    if (p.kind === "file") {
      const filename = p.value.split(/[\\/]/).pop() || "file";
      lines.push(`Content-Disposition: form-data; name="${p.name}"; filename="${filename}"`);
      lines.push(`Content-Type: ${p.contentType || "application/octet-stream"}`, "", `< ${p.value}`);
    } else {
      lines.push(`Content-Disposition: form-data; name="${p.name}"`);
      if (p.contentType) lines.push(`Content-Type: ${p.contentType}`);
      lines.push("", p.value);
    }
  }
  lines.push(`--${boundary}--`);
  return lines.join("\n");
}

// ------------------------------------------------------------------ directives

export function getDirective(req: Request, name: string): string | undefined {
  return req.directives.find((d) => d.name.toLowerCase() === name.toLowerCase())?.value;
}

/** Sets (value: string) or removes (value: null) a `# @name value` directive. */
export function setDirective(req: Request, name: string, value: string | null): void {
  const idx = req.directives.findIndex((d) => d.name.toLowerCase() === name.toLowerCase());
  if (value === null) {
    if (idx >= 0) req.directives.splice(idx, 1);
  } else if (idx >= 0) {
    req.directives[idx].value = value;
  } else {
    req.directives.push({ name, value });
  }
}

// ------------------------------------------------------------------ variables

/** A `{{name}}` reference; group 1 is the name. Global: use with matchAll. */
export const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/** All file-scoped variables: header + every request's `@var` lines. */
export function fileVariables(file: HttpFile): Variable[] {
  return [...file.header.variables, ...file.requests.flatMap((r) => r.variables)];
}

// ------------------------------------------------------------------ formatting

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 2 : 1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** Minimal XML pretty printer: one element per line, two-space indent. */
export function prettyXml(text: string): string {
  const tokens = text.replace(/>\s+</g, "><").match(/<[^>]+>|[^<]+/g) ?? [];
  const out: string[] = [];
  let depth = 0;
  const pad = () => "  ".repeat(Math.max(0, depth));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].trim();
    if (!t) continue;
    if (t.startsWith("</")) {
      depth--;
      out.push(pad() + t);
    } else if (t.startsWith("<?") || t.startsWith("<!") || t.endsWith("/>") || !t.startsWith("<")) {
      out.push(pad() + t);
    } else {
      const next = tokens[i + 1];
      const close = tokens[i + 2];
      if (next !== undefined && !next.startsWith("<") && close?.startsWith("</")) {
        out.push(pad() + t + next.trim() + close);
        i += 2;
      } else {
        out.push(pad() + t);
        depth++;
      }
    }
  }
  return out.join("\n");
}

export function statusClass(status: number): string {
  if (status >= 500) return "s-5xx";
  if (status >= 400) return "s-4xx";
  if (status >= 300) return "s-3xx";
  if (status >= 200) return "s-2xx";
  return "s-1xx";
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i <= 0 ? path : path.slice(0, i);
}

/** Why `name` can't be used as a file or folder name, or null if it can. */
export function nameError(name: string): string | null {
  return /[\\/]/.test(name) || name === "." || name === ".." ? "Names can't contain / or \\, or be . or .." : null;
}

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** Path of `target` relative to directory `from` (both absolute). */
export function relativePath(from: string, target: string): string {
  const norm = (p: string) => p.replace(/\\/g, "/").split("/").filter(Boolean);
  const a = norm(from);
  const b = norm(target);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => "..");
  const rel = [...up, ...b.slice(i)].join("/");
  return up.length ? rel : `./${rel}`;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "untitled";
}
