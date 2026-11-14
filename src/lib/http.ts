// Pure helpers for editing the request model. No Svelte/Tauri imports so
// they can be unit tested with vitest (src/lib/http.test.ts).
import type { BodyMode, HttpFile, KeyValue, Prompt, Request, Variable } from "./types";

export const STANDARD_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function methodClass(method: string): string {
  const m = method.toUpperCase();
  return STANDARD_METHODS.includes(m) ? `m-${m.toLowerCase()}` : "m-custom";
}

/**
 * The method a typed token stands for (uppercased), or null when it isn't one.
 * It must start with a letter, then letters, digits, `-` or `_`: the `.http`
 * parser only reads such tokens back as a method.
 */
export function customMethod(text: string): string | null {
  const t = text.trim();
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(t) ? t.toUpperCase() : null;
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

/** A run of plain text, or a `{{…}}` reference: `ref` is what's between the braces, trimmed. */
export interface Segment {
  text: string;
  ref?: string;
  /** Where `text` starts in the text split. */
  from: number;
}

/**
 * Splits text into plain runs and `{{…}}` references, the one way every part of the
 * frontend reads them, as the core's `vars::segments` does: a reference runs from
 * `{{` to the next `}}` (so `{{a{b}}` names `a{b`); an unclosed `{{` is plain text.
 * Empty plain runs are left out.
 */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (;;) {
    const start = text.indexOf("{{", at);
    const end = start < 0 ? -1 : text.indexOf("}}", start + 2);
    if (end < 0) break;
    if (start > at) out.push({ text: text.slice(at, start), from: at });
    out.push({ text: text.slice(start, end + 2), ref: text.slice(start + 2, end).trim(), from: start });
    at = end + 2;
  }
  if (at < text.length) out.push({ text: text.slice(at), from: at });
  return out;
}

function percentEncode(c: string): string {
  return [...new TextEncoder().encode(c)].map((b) => "%" + b.toString(16).toUpperCase().padStart(2, "0")).join("");
}

function escapeParam(text: string, part: Part): string {
  let out = "";
  for (const { text: s, ref } of segments(text)) {
    if (ref !== undefined) {
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
  for (const { text: s, ref } of segments(text)) {
    if (ref !== undefined) {
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

/** What bulk edit reads and writes of a row. Rows with an `enabled` flag can be disabled with `//`. */
export interface BulkRow {
  name: string;
  value: string;
  enabled?: boolean;
}

/** How `parseBulk` builds rows of a type other than `KeyValue`. */
export interface BulkRows<R extends BulkRow> {
  /** A new, empty row. If it has an `enabled` flag, a `//` prefix disables the line. */
  blank: () => R;
  /** Fields the text doesn't show, carried over from the previous row of the same name. */
  carry: (keyof R)[];
}

/** Rows of plain `KeyValue`s (params, headers): enabled when new, descriptions carried. */
export const KEY_VALUE_ROWS: BulkRows<KeyValue> = { blank: () => ({ enabled: true, name: "", value: "" }), carry: ["description"] };

/** Rows as bulk-edit text: one `name<sep> value` per line, `//` = disabled. */
export function formatBulk(items: BulkRow[], separator: string, toggles: boolean): string {
  return items
    .filter((r) => r.name || r.value)
    .map((r) => `${toggles && !r.enabled ? "//" : ""}${r.name}${separator}${separator === ":" ? " " : ""}${r.value}`)
    .join("\n");
}

/** Bulk-edit text back to rows. Fields the text can't show (descriptions, by default) come
 *  from `previous` (matched by name), which should be the rows as they were when bulk
 *  editing started. `rows` describes rows other than `KeyValue`. */
export function parseBulk(text: string, separator: string, previous: KeyValue[]): KeyValue[];
export function parseBulk<R extends BulkRow>(text: string, separator: string, previous: R[], rows: BulkRows<R>): R[];
export function parseBulk<R extends BulkRow>(text: string, separator: string, previous: R[], rows = KEY_VALUE_ROWS as unknown as BulkRows<R>): R[] {
  const pool = [...previous];
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const row = rows.blank();
      const disabled = "enabled" in row && l.trimStart().startsWith("//");
      const line = disabled ? l.trimStart().slice(2) : l;
      const idx = line.indexOf(separator);
      row.name = (idx < 0 ? line : line.slice(0, idx)).trim();
      row.value = idx < 0 ? "" : line.slice(idx + 1).trim();
      if ("enabled" in row) row.enabled = !disabled;
      const at = pool.findIndex((p) => p.name === row.name);
      const match = at < 0 ? undefined : pool.splice(at, 1)[0];
      for (const key of rows.carry) if (match?.[key]) row[key] = match[key];
      return row;
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
  // Read before the Content-Type below replaces it.
  const prevBoundary = boundaryOf(ct?.value ?? "") ?? "";
  if (wanted && (!ct || AUTO_TYPES.has(ct.value.split(";")[0].trim()) || ct.value.startsWith("multipart/"))) {
    setHeader(req, "Content-Type", wanted);
  }
  if (mode === "formUrlEncoded" && prev === "multipart") {
    req.body.text = buildForm(parseMultipart(req.body.text, prevBoundary).filter((p) => p.kind === "text"));
  }
}

function parseFormish(text: string, mode: BodyMode): MultipartPart[] {
  if (mode !== "formUrlEncoded") return [];
  return parseForm(text).map(({ name, value, enabled }) => ({ name, value, enabled, kind: "text" as const }));
}

// ------------------------------------------------------------------ form-urlencoded

export interface FormField {
  name: string;
  value: string;
  /** Off: written in place as a `#~` line, which no client sends. */
  enabled: boolean;
  /** Plain `#` / `//` comment lines just above the field, kept as written. */
  comments?: string[];
  /** Comment lines after the last field. */
  after?: string[];
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

const DISABLED = "#~";

function parsePair(p: string): { name: string; value: string } {
  const i = p.indexOf("=");
  return i < 0 ? { name: safeDecode(p), value: "" } : { name: safeDecode(p.slice(0, i)), value: safeDecode(p.slice(i + 1)) };
}

/** Reads a form body one line at a time, as it is sent: each line holds one or
 *  more `&`-joined fields. A `#~` line holds disabled fields; other `#` and `//`
 *  lines are comments, which no client sends. */
export function parseForm(text: string): FormField[] {
  const fields: FormField[] = [];
  let comments: string[] = [];
  for (const line of text.split("\n").map((l) => l.trim())) {
    if (line === "") continue;
    const disabled = line.startsWith(DISABLED);
    if (!disabled && (line.startsWith("#") || line.startsWith("//"))) {
      comments.push(line);
      continue;
    }
    const rest = disabled ? line.replace(/^#~+/, "").trim() : line;
    for (const p of rest.split("&").filter((p) => p !== "")) {
      const field: FormField = { ...parsePair(p), enabled: !disabled };
      if (comments.length) [field.comments, comments] = [comments, []];
      fields.push(field);
    }
  }
  if (comments.length && fields.length) fields[fields.length - 1].after = comments;
  return fields;
}

/** One field per line. A disabled field stays in place as a `#~` line. The first
 *  field sent has no leading `&`: JetBrains sends an empty body if it does. */
export function buildForm(fields: FormField[]): string {
  const lines: string[] = [];
  let first = true;
  let sent = false;
  for (const f of fields.filter((f) => f.name !== "")) {
    lines.push(...(f.comments ?? []));
    const pair = `${encodePreservingVars(f.name)}=${encodePreservingVars(f.value)}`;
    if (f.enabled) lines.push(sent ? `&${pair}` : pair);
    else lines.push(`${DISABLED} ${first ? "" : "&"}${pair}`);
    sent ||= f.enabled;
    first = false;
    lines.push(...(f.after ?? []));
  }
  return lines.join("\n");
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
  /** Off: every line of the part, boundary included, is held as a `#~` line. */
  enabled: boolean;
}

export function boundaryOf(contentType: string): string | null {
  const m = /boundary=("?)([^";]+)\1/i.exec(contentType);
  return m ? m[2] : null;
}

function parseParts(text: string, boundary: string, enabled: boolean): MultipartPart[] {
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
    parts.push({ name: disp[1], kind: isFile ? "file" : "text", value: isFile ? fileRef!.path : content, contentType: ct, enabled });
  }
  return parts;
}

/** Runs of `#~` lines are disabled parts; the rest is the body as sent. */
export function parseMultipart(text: string, boundary: string): MultipartPart[] {
  if (!boundary) return [];
  const parts: MultipartPart[] = [];
  let run: string[] = [];
  let runDisabled = false;
  const flush = () => {
    const uncommented = runDisabled ? run.map((l) => l.replace(/^#~ ?/, "")) : run;
    parts.push(...parseParts(uncommented.join("\n"), boundary, !runDisabled));
    run = [];
  };
  for (const line of text.split("\n")) {
    const disabled = line.startsWith(DISABLED);
    if (disabled !== runDisabled && run.length) flush();
    runDisabled = disabled;
    run.push(line);
  }
  if (run.length) flush();
  return parts;
}

export function buildMultipart(parts: MultipartPart[], boundary: string): string {
  const lines: string[] = [];
  for (const p of parts.filter((p) => p.name !== "")) {
    const part = [`--${boundary}`];
    if (p.kind === "file") {
      const filename = p.value.split(/[\\/]/).pop() || "file";
      part.push(`Content-Disposition: form-data; name="${p.name}"; filename="${filename}"`);
      part.push(`Content-Type: ${p.contentType || "application/octet-stream"}`, "", `< ${p.value}`);
    } else {
      part.push(`Content-Disposition: form-data; name="${p.name}"`);
      if (p.contentType) part.push(`Content-Type: ${p.contentType}`);
      part.push("", ...p.value.split("\n"));
    }
    lines.push(...(p.enabled ? part : part.map((l) => (l === "" ? DISABLED : `${DISABLED} ${l}`))));
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

/**
 * The request's Prompt variables (`# @prompt name [description]`), in order, as
 * the core's `Request::prompts` reads them: a name declared twice is asked once.
 */
export function requestPrompts(req: Request): Prompt[] {
  const out: Prompt[] = [];
  for (const d of req.directives) {
    if (d.name.toLowerCase() !== "prompt") continue;
    const m = /^(\S+)\s*(.*)$/s.exec(d.value.trim());
    if (m && !out.some((p) => p.name === m[1])) out.push({ name: m[1], description: m[2].trim() });
  }
  return out;
}

/** Whether a prompt's value is typed masked: its name is `password`, `passwd` or `pass`, ignoring case. */
export function promptMasked(name: string): boolean {
  return ["password", "passwd", "pass"].includes(name.toLowerCase());
}

// ------------------------------------------------------------------ variables

/** The definition of `name` in use in `list`: the last one, since a later definition wins. */
export function lastNamed<T extends { name: string }>(list: readonly T[], name: string): T | undefined {
  return list.filter((v) => v.name === name).at(-1);
}

/** All file-scoped variables: header + every request's `@var` lines. */
export function fileVariables(file: HttpFile): Variable[] {
  return [...file.header.variables, ...file.requests.flatMap((r) => r.variables)];
}

// ------------------------------------------------------------------ formatting

/** "A", "A and B", "A, B and C". */
export function joinAnd(items: string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 2 : 1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

// JSON and XML are formatted in the core (`api.formatBody`): a JSON.parse
// round trip would change numbers (precision above 2^53, `10.50` → `10.5`).

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

// ------------------------------------------------------------------ field safety
// Mirrors the save-time checks in crates/httpdesk-core/src/serializer.rs.

/** Why a header line with this name would read back as something else, or null. */
export function headerNameError(name: string): string | null {
  if (/[\r\n]/.test(name)) return "Header names can't contain line breaks";
  if (/\s/.test(name)) return "Header names can't contain spaces";
  if (name.includes(":")) return "Header names can't contain ':'";
  const prefix = ["//", "#", "~", "|", "&", "?"].find((p) => name.startsWith(p));
  return prefix ? `Header names can't start with '${prefix}'` : null;
}

/** Why a Basic auth username can't be saved, or null. The username ends at the first ':' (RFC 7617). */
export function basicUsernameError(username: string): string | null {
  return username.includes(":") ? "Basic auth usernames can't contain ':'" : null;
}

/** Why `@name = value` wouldn't read back as a variable, or null. Empty names aren't saved. */
export function variableNameError(name: string): string | null {
  return name === "" || /^[\p{Alphabetic}\p{N}_.$-]+$/u.test(name) ? null : "Variable names can only use letters, digits, _, -, . and $";
}

export interface BodySyntaxWarning {
  /** 1-based line number. */
  line: number;
  message: string;
}

/**
 * Whether sending the request would run a script, which only a Trusted workspace
 * may do: a `> {% %}` or `> file.js` response handler line. `>>` output redirects
 * aren't scripts. Mirrors the core's `script::has_scripts`.
 */
export function hasScripts(req: Request): boolean {
  return (req.responseHandler ?? "").split("\n").some((l) => l.startsWith(">") && !l.startsWith(">>") && l.slice(1).trim() !== "");
}

/** Response handler or output redirect at column 0, the same rule as the parser. */
function isHandlerStart(line: string): boolean {
  if (line.startsWith(">>")) return true;
  if (!line.startsWith(">")) return false;
  const rest = line.slice(1).trim();
  return rest.startsWith("{%") || (rest !== "" && !/\s/.test(rest) && rest.endsWith(".js"));
}

/** Body lines that `.http` syntax (other clients, and HttpDesk on reload) reads as a separator or handler. */
export function bodySyntaxWarnings(text: string): BodySyntaxWarning[] {
  const out: BodySyntaxWarning[] = [];
  text.split("\n").forEach((l, i) => {
    const line = i + 1;
    if (l.startsWith("###")) {
      out.push({ line, message: `Line ${line} starts with ###, so it will be read as the start of a new request.` });
    } else if (isHandlerStart(l)) {
      const prefix = l.startsWith(">>") ? ">>" : ">";
      out.push({ line, message: `Line ${line} starts with ${prefix}, so it and the lines after it will be read as a response handler.` });
    }
  });
  return out;
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
