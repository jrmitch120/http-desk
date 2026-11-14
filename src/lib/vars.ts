// The frontend's variable resolver, used for highlighting, tooltips and
// autocomplete. It gives the same answers as the core's `vars::Resolver`
// (src/lib/vars.test.ts drives both through the same cases), except that dynamic
// variables are left as written: they're generated at send time.
import type { Definition, Resolution, VarCompletion, VarInfo, VarProvider } from "./codemirror/setup";
import { promptMasked, segments } from "./http";
import type { EnvironmentSet, EnvSource, EnvVar, Prompt, Variable } from "./types";
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

/** How a masked value is shown (the core's `vars::MASK`). */
export const MASK = "••••••••";

/** Bracket each value a Secret went into in the resolved preview (the core's `vars::SECRET_MARKS`). */
export const SECRET_OPEN = "";
export const SECRET_CLOSE = "";
/** Splits text so every odd part is a value between the Secret marks. */
export const SECRET_RE = /(.*?)/s;

/**
 * Whether `{{reference}}` (the trimmed text between the braces) is a dynamic
 * variable: its name, before `(` or a space, is one the core generates.
 */
export function isDynamic(reference: string): boolean {
  if (!reference.startsWith("$")) return false;
  const name = reference.includes("(") ? reference.slice(0, reference.indexOf("(")) : reference.split(/\s/, 1)[0];
  return DYNAMIC_VARIABLES.some((d) => (d.name.endsWith(".") ? name.length > d.name.length && name.startsWith(d.name) : name === d.name));
}

/** The env files' key for the shared variables, which stands for them wherever an environment is named. */
export const SHARED = "$shared";

/** The variables of environment `env` in `set` (`SHARED`: the shared ones); undefined if the set doesn't have it. */
export function envVarsOf(set: EnvironmentSet, env: string): EnvVar[] | undefined {
  return env === SHARED ? set.shared : set.environments.find((e) => e.name === env)?.variables;
}

export type EnvVarMap =Record<string, { value: string; secret: boolean; source: string; dir?: string }>;

/**
 * The variables of environment `envName`: the shared variables, then the
 * environment's own over them (as the core's `env::variables`). `source` is
 * `"$shared"` or the environment's name, `dir` the folder whose files supply the
 * value, when the set says (`EnvSource`). Private values were already merged into
 * the set by the core.
 */
export function envVariables(set: EnvironmentSet | null, envName: string | null): EnvVarMap {
  const out: EnvVarMap = {};
  if (!set) return out;
  const entry = (v: EnvVar, source: string, from: EnvSource | null | undefined) => {
    const dir = (v.secret ? from?.private : from?.public) ?? undefined;
    return { value: v.value, secret: v.secret, source, ...(dir !== undefined ? { dir } : {}) };
  };
  for (const v of set.shared) out[v.name] = entry(v, SHARED, set.sharedSource);
  const env = set.environments.find((e) => e.name === envName);
  for (const v of env?.variables ?? []) out[v.name] = entry(v, env!.name, env!.source);
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
  /** The request's Prompt variables (`requestPrompts`). */
  prompts?: Prompt[];
  /** Values remembered for them; a prompt without one is asked when sent. */
  answers?: Record<string, string>;
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

export function makeVarProvider({ env, fileVars, requestVars, headerVars = [], envName, prompts = [], answers = {} }: Scope): VarProvider {
  // Answered prompts are used as typed, over everything else; unanswered ones are asked when sent.
  const prompted = new Map<string, { value: string; masked: boolean } | null>();
  for (const p of prompts) prompted.set(p.name, Object.hasOwn(answers, p.name) ? { value: answers[p.name], masked: promptMasked(p.name) } : null);

  // Later wins: environment, then the file, then the request's own declarations.
  const scope = new Map<string, Entry>();
  for (const [name, e] of Object.entries(env)) {
    const source = e.source === SHARED ? "shared variables" : `environment "${e.source}"`;
    const origin = e.source === SHARED ? "shared" : "environment";
    const definition: Definition = { kind: "env", env: e.source, name, ...(e.dir !== undefined ? { dir: e.dir } : {}) };
    scope.set(name, { value: e.value, secret: e.secret, source, origin, definition });
  }
  for (const v of fileVars) {
    const definition: Definition = { kind: headerVars.includes(v) ? "file" : "request", name: v.name };
    scope.set(v.name, { value: v.value, secret: false, source: "this file", origin: "file", definition });
  }
  for (const v of requestVars) scope.set(v.name, { value: v.value, secret: false, source: "this request", origin: "file", definition: { kind: "request", name: v.name } });

  function resolve(text: string): Resolution {
    const undefinedNames = new Set<string>();
    const circular: string[][] = [];
    const asked = new Set<string>();
    let secret = false;
    const walk = (text: string, chain: string[]): string =>
      segments(text)
        .map(({ text: whole, ref: name }) => {
          if (name === undefined) return whole;
          // A `$name` is generated at send time, or (unknown to the core) undefined; never looked up.
          if (isDynamic(name)) return whole;
          if (name.startsWith("$")) {
            undefinedNames.add(name);
            return whole;
          }
          const prompt = prompted.get(name);
          if (prompt) {
            secret ||= prompt.masked;
            return prompt.value;
          }
          if (prompt === null) {
            asked.add(name);
            return whole;
          }
          if (chain.includes(name)) {
            const cycle = [...chain, name];
            if (!circular.some((c) => c.join("\0") === cycle.join("\0"))) circular.push(cycle);
            return whole;
          }
          const entry = scope.get(name);
          if (!entry) {
            undefinedNames.add(name);
            return whole;
          }
          secret ||= entry.secret;
          return walk(entry.value, [...chain, name]);
        })
        .join("");
    const value = walk(text, []);
    return { value, undefined: [...undefinedNames].sort(), circular, asked: [...asked].sort(), secret };
  }

  function info(name: string): VarInfo {
    if (isDynamic(name)) return { state: "dyn" };
    if (name.startsWith("$")) return { state: "bad" };
    const prompt = prompted.get(name);
    if (prompt === null) return { state: "prompt", source: "a prompt: asked when sent" };
    if (prompt) return { state: "ok", value: prompt.value, secret: prompt.masked, source: "a prompt, remembered in the Session" };
    const entry = scope.get(name);
    if (!entry) return { state: "bad", source: envName ? undefined : "no environment selected" };
    const r = resolve(`{{${name}}}`);
    if (r.circular.length) return { state: "circular", chain: r.circular[0], source: entry.source, definition: entry.definition };
    return { state: "ok", value: r.value, secret: r.secret, source: entry.source, definition: entry.definition };
  }

  function completions(): VarCompletion[] {
    // A Prompt variable overrides every other variable of its name, so it takes that name's entry.
    const sources = new Map<string, VarCompletion["source"]>([...scope].map(([name, entry]) => [name, entry.origin]));
    for (const name of prompted.keys()) sources.set(name, "prompt");
    const named = [...sources].map(([name, source]): VarCompletion => {
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

/**
 * What a value of environment `env` (`SHARED`: a shared variable) in the
 * Environments modal can refer to: that environment over the shared variables as
 * edited in `set`, over `inherited` (below the root, what the folder's requests get
 * from farther folders' files, ADR-0004).
 */
export function envValueProvider(set: EnvironmentSet, inherited: EnvironmentSet | null, env: string): VarProvider {
  const name = env === SHARED ? null : env;
  return makeVarProvider({ env: { ...envVariables(inherited, name), ...envVariables(set, name) }, fileVars: [], requestVars: [], envName: env });
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
 * The text split into plain runs and `{{name}}` references (as `segments` reads them,
 * like the resolver), marked the way the editor marks them, for rendering a field
 * without an editor.
 */
export function varSegments(text: string, provider: VarProvider | null): VarSegment[] {
  if (!provider) return text ? [{ text }] : [];
  return segments(text).map(({ text, ref }) => (ref === undefined ? { text } : { text, name: ref, cls: varClass(provider.info(ref)) }));
}
