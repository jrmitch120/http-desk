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
    auth: { enabled: true, kind: "none", username: "", password: "", token: "", keyName: "", keyValue: "", keyLocation: "header" },
    body: { enabled: true, mode: "none", text: "" },
    extraLines: [],
    responseHandler: null,
    leading: "",
    raw: null,
  };
}

export function emptyFile(): HttpFile {
  return { header: { comments: [], variables: [], raw: null }, requests: [], trailing: "", lineEnding: "lf" };
}

export function displayName(req: Request): string {
  if (req.name.trim()) return req.name.trim();
  const n = req.directives.find((d) => d.name === "name")?.value;
  if (n) return n;
  return req.url ? `${req.method} ${req.url}` : "Untitled request";
}

// ------------------------------------------------------------------ URL ⇄ params

function renderParam(p: KeyValue): string {
  return p.value === "" ? p.name : `${p.name}=${p.value}`;
}

export function parseQuery(qs: string): KeyValue[] {
  return qs
    .split("&")
    .filter((p) => p !== "")
    .map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? { enabled: true, name: p, value: "" } : { enabled: true, name: p.slice(0, i), value: p.slice(i + 1) };
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
  const next: KeyValue[] = [];
  let k = 0;
  for (const item of req.query.items) {
    if (sectionOn && isActive(item)) {
      if (k < parsed.length) next.push(parsed[k++]);
    } else {
      next.push(item);
    }
  }
  while (k < parsed.length) next.push(parsed[k++]);
  req.query.items = next;
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

/** Switches body mode and keeps Content-Type in sync, like Postman. */
export function setBodyMode(req: Request, mode: BodyMode): void {
  const prev = req.body.mode;
  req.body.mode = mode;
  const ct = findHeader(req, "content-type");
  const wanted = MODE_CONTENT_TYPES[mode];
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

export function parseForm(text: string): FormField[] {
  const joined = text
    .split("\n")
    .map((l) => l.trim())
    .join("");
  return joined
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
    const fileRef = /^<\s+(.+)$/.exec(content.trim());
    const isFile = /filename=/i.test(head) && !!fileRef;
    parts.push({ name: disp[1], kind: isFile ? "file" : "text", value: isFile ? fileRef![1].trim() : content, contentType: ct });
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

export const VAR_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

export function findVariables(text: string): string[] {
  return [...text.matchAll(VAR_RE)].map((m) => m[1]);
}

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
