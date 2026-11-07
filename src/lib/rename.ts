// Rename variable: renames a variable in every environment and, optionally, every
// `{{name}}` reference Find usages found. This module edits the models in place;
// the store saves them.
import { displayName, variableNameError } from "./http";
import type { EnvironmentSet, EnvVar, HttpFile, Request, Usage, UsageField } from "./types";

type At = { start: number; end: number };

/**
 * `text` with each reference at `at` (`{{ old }}`, braces included) naming `next`
 * instead, spacing kept. A range that no longer holds a reference to `old` (the
 * text changed since the search) is left alone.
 */
function renameAt(text: string, at: At[], old: string, next: string): string {
  // From the end, so earlier offsets stay valid.
  for (const { start, end } of [...at].sort((a, b) => b.start - a.start)) {
    const m = /^(\{\{\s*)(.*?)(\s*\}\})$/s.exec(text.slice(start, end));
    if (!m || m[2] !== old) continue;
    text = text.slice(0, start) + m[1] + next + m[3] + text.slice(end);
  }
  return text;
}

/** The text of a request's field, and how to put it back. */
function field(req: Request, f: UsageField): [string, (text: string) => void] | null {
  switch (f.kind) {
    case "url":
      return [req.url, (t) => (req.url = t)];
    case "param":
    case "header": {
      const kv = (f.kind === "param" ? req.query : req.headers).items[f.index];
      return kv ? [kv[f.part], (t) => (kv[f.part] = t)] : null;
    }
    case "auth":
      return [req.auth[f.part], (t) => (req.auth[f.part] = t)];
    case "body":
      return [req.body.text, (t) => (req.body.text = t)];
    case "variable": {
      const v = req.variables[f.index];
      return v ? [v.value, (t) => (v.value = t)] : null;
    }
  }
}

/** The request a usage is in: at its index if it is still the same request, else
 *  the one with its name, method and URL (as `openSearchHit` finds it). */
function requestOf(file: HttpFile, u: Extract<Usage, { kind: "request" }>): Request | undefined {
  const same = (r: Request | undefined) => !!r && displayName(r) === u.name && r.method === u.method && r.url === u.url;
  const at = file.requests[u.index];
  return same(at) ? at : file.requests.find(same);
}

/**
 * Renames `{{old}}` to `{{next}}` at the request and File variable usages found
 * in `file` (in place). Every request is found before any is edited, since an
 * edited URL no longer matches its usage.
 */
export function renameInFile(file: HttpFile, usages: Usage[], old: string, next: string) {
  const edits = new Map<string, { text: [string, (t: string) => void]; at: At[] }>();
  const add = (key: string, text: [string, (t: string) => void] | null, at: At) => {
    if (!text) return;
    const e = edits.get(key) ?? { text, at: [] };
    e.at.push(at);
    edits.set(key, e);
  };
  for (const u of usages) {
    if (u.kind === "fileVariable") {
      const v = file.header.variables[u.index];
      if (v?.name === u.name) add(`@${u.index}`, [v.value, (t) => (v.value = t)], u);
    } else if (u.kind === "request") {
      const req = requestOf(file, u);
      if (req) add(`${file.requests.indexOf(req)}\0${JSON.stringify(u.field)}`, field(req, u.field), u);
    }
  }
  for (const { text, at } of edits.values()) text[1](renameAt(text[0], at, old, next));
}

/** The variables of `env` (`$shared` for the shared ones). */
function varsOf(set: EnvironmentSet, env: string): EnvVar[] {
  return env === "$shared" ? set.shared : (set.environments.find((e) => e.name === env)?.variables ?? []);
}

/**
 * Renames `old` to `next` in the shared variables and every environment (in place;
 * a Secret stays a Secret), and rewrites `{{old}}` at the environment usages found
 * in their values. Values are rewritten first: a usage names the variable holding it.
 */
export function renameInEnvironments(set: EnvironmentSet, usages: Usage[], old: string, next: string) {
  const edits = new Map<EnvVar, At[]>();
  for (const u of usages) {
    if (u.kind !== "environment") continue;
    const v = varsOf(set, u.env).filter((v) => v.name === u.name).at(-1);
    if (v) edits.set(v, [...(edits.get(v) ?? []), u]);
  }
  for (const [v, at] of edits) v.value = renameAt(v.value, at, old, next);
  for (const v of [...set.shared, ...set.environments.flatMap((e) => e.variables)]) if (v.name === old) v.name = next;
}

/**
 * Why `next` can't be the variable's new name, if it can't: a name a reference
 * can't use, or one Shared or an environment already has. Empty or unchanged is
 * no error (there is just nothing to rename).
 */
export function renameNameError(next: string, old: string, set: EnvironmentSet | null): string | null {
  if (next === "" || next === old) return null;
  if (next.startsWith("$")) return "A name starting with $ is read as a dynamic variable";
  const bad = variableNameError(next);
  if (bad) return bad;
  if (set?.shared.some((v) => v.name === next)) return `The shared variables already have a variable named ${next}`;
  const env = set?.environments.find((e) => e.variables.some((v) => v.name === next));
  return env ? `${env.name} already has a variable named ${next}` : null;
}

/** A file a rename edits, and what in it. */
export interface RenamePreviewRow {
  path: string;
  /** E.g. "2 requests, 1 File variable" or "3 environment values". */
  detail: string;
}

const count = (n: number, one: string, many = `${one}s`) => (n ? [`${n} ${n === 1 ? one : many}`] : []);

/** The files the usages are in, in the order found, with how many requests (File variables, environment values) in each. */
export function renamePreview(usages: Usage[]): RenamePreviewRow[] {
  const files = new Map<string, { requests: Set<number>; fileVariables: Set<number>; values: Set<string> }>();
  for (const u of usages) {
    let f = files.get(u.path);
    if (!f) files.set(u.path, (f = { requests: new Set(), fileVariables: new Set(), values: new Set() }));
    if (u.kind === "request") f.requests.add(u.index);
    else if (u.kind === "fileVariable") f.fileVariables.add(u.index);
    else f.values.add(`${u.env}\0${u.name}`);
  }
  return [...files].map(([path, f]) => ({
    path,
    detail: [...count(f.requests.size, "request"), ...count(f.fileVariables.size, "File variable"), ...count(f.values.size, "environment value")].join(", "),
  }));
}
