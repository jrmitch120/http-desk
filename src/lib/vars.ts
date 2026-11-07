// The frontend's variable resolver, used for highlighting, tooltips and
// autocomplete. It gives the same answers as the core's `vars::Resolver`
// (src/lib/vars.test.ts drives both through the same cases), except that dynamic
// variables are left as written: they're generated at send time.
import type { Resolution, VarInfo, VarProvider } from "./codemirror/setup";
import { promptMasked, VAR_RE } from "./http";
import type { EnvironmentSet, Prompt, Variable } from "./types";

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
  envName: string | null;
  /** The request's Prompt variables (`requestPrompts`). */
  prompts?: Prompt[];
  /** Values remembered for them; a prompt without one is asked when sent. */
  answers?: Record<string, string>;
}

interface Entry {
  value: string;
  secret: boolean;
  source: string;
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

export function makeVarProvider({ env, fileVars, requestVars, envName, prompts = [], answers = {} }: Scope): VarProvider {
  // Answered prompts are used as typed, over everything else; unanswered ones are asked when sent.
  const prompted = new Map<string, { value: string; masked: boolean } | null>();
  for (const p of prompts) prompted.set(p.name, Object.hasOwn(answers, p.name) ? { value: answers[p.name], masked: promptMasked(p.name) } : null);

  // Later wins: environment, then the file, then the request's own declarations.
  const scope = new Map<string, Entry>();
  for (const [name, e] of Object.entries(env)) {
    scope.set(name, { ...e, source: e.source === "$shared" ? "shared variables" : `environment "${e.source}"` });
  }
  for (const v of fileVars) scope.set(v.name, { value: v.value, secret: false, source: "this file" });
  for (const v of requestVars) scope.set(v.name, { value: v.value, secret: false, source: "this request" });

  function resolve(text: string): Resolution {
    const undefinedNames = new Set<string>();
    const circular: string[][] = [];
    const asked = new Set<string>();
    let secret = false;
    const walk = (text: string, chain: string[]): string =>
      segments(text)
        .map((s) => {
          if ("text" in s) return s.text;
          if (s.name.startsWith("$")) return s.whole;
          const prompt = prompted.get(s.name);
          if (prompt) {
            secret ||= prompt.masked;
            return prompt.value;
          }
          if (prompt === null) {
            asked.add(s.name);
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
    return { value, undefined: [...undefinedNames].sort(), circular, asked: [...asked].sort(), secret };
  }

  return {
    resolve,
    info(name): VarInfo {
      if (name.startsWith("$")) return { state: "dyn" };
      const prompt = prompted.get(name);
      if (prompt === null) return { state: "prompt", source: "a prompt: asked when sent" };
      if (prompt) return { state: "ok", value: prompt.value, secret: prompt.masked, source: "a prompt, remembered until the app quits" };
      const entry = scope.get(name);
      if (!entry) return { state: "bad", source: envName ? undefined : "no environment selected" };
      const r = resolve(`{{${name}}}`);
      if (r.circular.length) return { state: "circular", chain: r.circular[0], source: entry.source };
      return { state: "ok", value: r.value, secret: r.secret, source: entry.source };
    },
    names() {
      const out = new Map<string, string>();
      for (const [k, v] of Object.entries(env)) out.set(k, v.secret ? "secret" : v.source);
      for (const v of [...fileVars, ...requestVars]) out.set(v.name, "file");
      for (const p of prompts) out.set(p.name, "prompt");
      return [...out].map(([name, detail]) => ({ name, detail }));
    },
  };
}

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
