// The frontend's variable resolver, used for highlighting, tooltips and
// autocomplete. It gives the same answers as the core's `vars::Resolver`
// (src/lib/vars.test.ts drives both through the same cases), except that dynamic
// variables are left as written: they're generated at send time.
import type { Definition, Resolution, VarCompletion, VarInfo, VarProvider } from "./codemirror/setup";
import { VAR_RE } from "./http";
import type { EnvironmentSet, Variable } from "./types";
import catalogue from "../../crates/httpdesk-core/dynamic-variables.json";

/**
 * A dynamic variable the core generates, as autocomplete lists it. The list is
 * the core's (`vars::DYNAMIC_VARIABLES`; a Rust test keeps the two equal).
 */
export interface DynamicVariable {
  /** With the `$`. One ending in `.` (`$env.`) takes a name straight after it. */
  name: string;
  /** The argument hint, e.g. `[min max]`, `(length)`, `NAME`; empty without arguments. */
  args: string;
  description: string;
  /** Nothing is generated without the argument. */
  required?: boolean;
}

export const DYNAMIC_VARIABLES: DynamicVariable[] = catalogue.variables;

/**
 * Whether `{{reference}}` (the trimmed text between the braces) is a dynamic
 * variable: its name, before `(` or a space, is one the core generates.
 */
export function isDynamic(reference: string): boolean {
  if (!reference.startsWith("$")) return false;
  const name = reference.includes("(") ? reference.slice(0, reference.indexOf("(")) : reference.split(/\s/, 1)[0];
  return DYNAMIC_VARIABLES.some((d) => (d.name.endsWith(".") ? name.length > d.name.length && name.startsWith(d.name) : name === d.name));
}

export type EnvVarMap = Record<string, { value: string; secret: boolean; source: string }>;

/**
 * The variables of environment `envName`: the shared variables, then the
 * environment's own over them (as the core's `env::variables`). `source` is
 * `"$shared"` or the environment's name. Private values were already merged into
 * the set by the core.
 */
export function envVariables(set: EnvironmentSet | null, envName: string | null): EnvVarMap {
  const out: EnvVarMap = {};
  if (!set) return out;
  for (const v of set.shared) out[v.name] = { value: v.value, secret: v.secret, source: "$shared" };
  const env = set.environments.find((e) => e.name === envName);
  for (const v of env?.variables ?? []) out[v.name] = { value: v.value, secret: v.secret, source: env!.name };
  return out;
}

/** What a request's `{{references}}` can see, as the core's `Resolver::for_request` takes it. */
export interface Scope {
  /** The selected environment over the shared variables (`envVariables`). */
  env: EnvVarMap;
  /** Every `@name` line in the file, in file order (`fileVariables`). */
  fileVars: Variable[];
  /** The request's own `@name` lines, which win over the rest of the file. */
  requestVars: Variable[];
  /** The `@name` lines at the top of the file (some of `fileVars`): the ones the request's Settings edit. */
  headerVars?: Variable[];
  envName: string | null;
}

interface Entry {
  value: string;
  secret: boolean;
  /** How the hover card says where it's from. */
  source: string;
  /** How autocomplete says it. */
  origin: VarCompletion["source"];
  definition?: Definition;
}

/** A run of text, or a `{{…}}` reference with its trimmed name. Mirrors the core's `vars::segments`. */
type Segment = { text: string } | { whole: string; name: string };

function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf("{{");
    if (start < 0) break;
    const len = rest.indexOf("}}", start + 2) - (start + 2);
    if (len < 0) break;
    out.push({ text: rest.slice(0, start) });
    out.push({ whole: rest.slice(start, start + 4 + len), name: rest.slice(start + 2, start + 2 + len).trim() });
    rest = rest.slice(start + 4 + len);
  }
  out.push({ text: rest });
  return out;
}

export function makeVarProvider({ env, fileVars, requestVars, headerVars = [], envName }: Scope): VarProvider {
  // Later wins: environment, then the file, then the request's own declarations.
  const scope = new Map<string, Entry>();
  for (const [name, e] of Object.entries(env)) {
    const source = e.source === "$shared" ? "shared variables" : `environment "${e.source}"`;
    const origin = e.source === "$shared" ? "shared" : "environment";
    scope.set(name, { ...e, source, origin, definition: { kind: "env", env: e.source, name } });
  }
  for (const v of fileVars) {
    const definition: Definition | undefined = headerVars.includes(v) ? { kind: "file", name: v.name } : undefined;
    scope.set(v.name, { value: v.value, secret: false, source: "this file", origin: "file", definition });
  }
  for (const v of requestVars) scope.set(v.name, { value: v.value, secret: false, source: "this request", origin: "file" });

  function resolve(text: string): Resolution {
    const undefinedNames = new Set<string>();
    const circular: string[][] = [];
    let secret = false;
    const walk = (text: string, chain: string[]): string =>
      segments(text)
        .map((s) => {
          if ("text" in s) return s.text;
          // A `$name` is generated at send time, or (unknown to the core) undefined; never looked up.
          if (isDynamic(s.name)) return s.whole;
          if (s.name.startsWith("$")) {
            undefinedNames.add(s.name);
            return s.whole;
          }
          if (chain.includes(s.name)) {
            const cycle = [...chain, s.name];
            if (!circular.some((c) => c.join("\0") === cycle.join("\0"))) circular.push(cycle);
            return s.whole;
          }
          const entry = scope.get(s.name);
          if (!entry) {
            undefinedNames.add(s.name);
            return s.whole;
          }
          secret ||= entry.secret;
          return walk(entry.value, [...chain, s.name]);
        })
        .join("");
    const value = walk(text, []);
    return { value, undefined: [...undefinedNames].sort(), circular, secret };
  }

  function info(name: string): VarInfo {
    if (isDynamic(name)) return { state: "dyn" };
    if (name.startsWith("$")) return { state: "bad" };
    const entry = scope.get(name);
    if (!entry) return { state: "bad", source: envName ? undefined : "no environment selected" };
    const r = resolve(`{{${name}}}`);
    if (r.circular.length) return { state: "circular", chain: r.circular[0], source: entry.source, definition: entry.definition };
    return { state: "ok", value: r.value, secret: r.secret, source: entry.source, definition: entry.definition };
  }

  function completions(): VarCompletion[] {
    const named = [...scope].map(([name, entry]): VarCompletion => {
      const source = entry.origin;
      const i = info(name);
      if (i.secret) return { name, source, secret: true };
      if (i.state !== "ok") return { name, source };
      return { name, source, preview: shorten(i.value ?? "") };
    });
    const dynamic = DYNAMIC_VARIABLES.map(({ name, args, description, required }): VarCompletion => ({
      name,
      source: "dynamic",
      args,
      description,
      ...(required ? { required } : {}),
    }));
    return [...named, ...dynamic];
  }

  return { resolve, info, completions };
}

const PREVIEW_LENGTH = 40;
const shorten = (value: string) => (value.length > PREVIEW_LENGTH ? value.slice(0, PREVIEW_LENGTH - 1) + "…" : value);

/** The classes of a `{{name}}` mark: `cm-var cm-var-<state>`, plus `cm-var-secret` when a Secret went into its value. */
export function varClass(info: VarInfo): string {
  return `cm-var cm-var-${info.state}${info.secret ? " cm-var-secret" : ""}`;
}

/** A run of a variable-aware field's text: plain, or a `{{name}}` reference with its name and mark classes. */
export interface VarSegment {
  text: string;
  name?: string;
  cls?: string;
}

/**
 * The text split into plain runs and `{{name}}` references, marked the way the
 * editor marks them, for rendering a field without an editor.
 */
export function varSegments(text: string, provider: VarProvider | null): VarSegment[] {
  if (!provider) return text ? [{ text }] : [];
  const out: VarSegment[] = [];
  let at = 0;
  for (const m of text.matchAll(VAR_RE)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index) });
    out.push({ text: m[0], name: m[1], cls: varClass(provider.info(m[1])) });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
