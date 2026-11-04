// Builds the variable provider used for highlighting, tooltips and autocomplete.
import type { VarProvider } from "./codemirror/setup";
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
