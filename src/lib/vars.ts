// Builds the variable provider used for highlighting, tooltips and autocomplete.
import type { VarInfo, VarProvider } from "./codemirror/setup";
import { VAR_RE } from "./http";
import type { Variable } from "./types";

export type EnvVarMap = Record<string, { value: string; secret: boolean; source: string }>;

export function makeVarProvider(env: EnvVarMap, fileVars: Variable[], envName: string | null): VarProvider {
  const file = new Map(fileVars.map((v) => [v.name, v.value]));
  return {
    info(name) {
      if (name.startsWith("$")) return { state: "dyn" };
      if (file.has(name)) return { state: "ok", value: file.get(name), source: "this file" };
      const e = env[name];
      if (e) return { state: "ok", value: e.value, secret: e.secret, source: e.source === "$shared" ? "shared variables" : `environment "${e.source}"` };
      return { state: "bad", source: envName ? undefined : "no environment selected" };
    },
    names() {
      const out = new Map<string, string>();
      for (const [k, v] of Object.entries(env)) out.set(k, v.secret ? "secret" : v.source);
      for (const k of file.keys()) out.set(k, "file");
      return [...out].map(([name, detail]) => ({ name, detail }));
    },
  };
}

/** The classes of a `{{name}}` mark: `cm-var cm-var-<state>`, plus `cm-var-secret` for a Secret. */
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
