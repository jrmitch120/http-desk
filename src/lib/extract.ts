// Extract to variable: turns selected text in a field into `{{name}}`, defining
// `name` as a File variable or in environments. The field replaces its own
// selection; this module decides where the definition goes and writes it.
import { variableNameError } from "./http";
import type { EnvironmentSet, HttpFile, Request } from "./types";

/** Where an extracted variable is defined. */
export type ExtractTarget = { kind: "file" } | { kind: "env"; env: string } | { kind: "all" };

/**
 * Defines `name = value` as a File variable: a standard `@name = value` line at
 * the top of the file, or, when the name is already a File variable the request
 * uses, that definition's new value.
 */
export function extractToFile(file: HttpFile, request: Request | undefined, name: string, value: string) {
  // A request's own declaration wins over the file's (GLOSSARY: File variable); the last of a repeated name is in use.
  const existing = request?.variables.filter((v) => v.name === name).at(-1) ?? file.header.variables.filter((v) => v.name === name).at(-1);
  if (existing) existing.value = value;
  else file.header.variables.push({ name, value });
}

/** Why `name` can't be extracted to, if it can't. The File variable rule, and no
 *  leading `$` (`{{$name}}` reads as a dynamic variable). Empty is no error. */
export function extractNameError(name: string): string | null {
  if (name.startsWith("$")) return "A name starting with $ is read as a dynamic variable";
  return variableNameError(name);
}

/** What the form knows about the place it would write to. */
export interface ExtractScope {
  file: HttpFile;
  request: Request | undefined;
  envSet: EnvironmentSet | null;
}

/** A warning when `target` already defines `name`: extracting replaces its value there. */
export function extractConflict(target: ExtractTarget, name: string, { file, request, envSet }: ExtractScope): string | null {
  if (!name) return null;
  if (target.kind === "file") {
    const defined = [...(request?.variables ?? []), ...file.header.variables].some((v) => v.name === name);
    return defined ? `${name} is already a File variable; its value will be replaced.` : null;
  }
  if (!envSet) return null;
  const envs = targetEnvironments(target, envSet);
  const having = envSet.environments.filter((e) => envs.includes(e.name)).flatMap((e) => {
    const v = e.variables.filter((v) => v.name === name).at(-1);
    return v ? [{ env: e.name, secret: v.secret }] : [];
  });
  if (!having.length) return null;
  if (having.length === 1) {
    const [{ env, secret }] = having;
    return `${env} already has ${name}${secret ? " (a Secret)" : ""}; its value will be replaced.`;
  }
  const names = having.map((h) => h.env);
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)} already have ${name}; their values will be replaced.`;
}

/** The environments `target` puts a variable in. */
export function targetEnvironments(target: ExtractTarget, set: EnvironmentSet): string[] {
  if (target.kind === "env") return [target.env];
  if (target.kind === "all") return set.environments.map((e) => e.name);
  return [];
}

/**
 * Defines `name = value` in each of the environments `envs` (in place). One
 * that already has the name gets the new value there (the last, which is the
 * one in use), and a Secret stays a Secret.
 */
export function extractToEnvironments(set: EnvironmentSet, envs: string[], name: string, value: string) {
  for (const env of set.environments) {
    if (!envs.includes(env.name)) continue;
    const existing = env.variables.filter((v) => v.name === name).at(-1);
    if (existing) {
      existing.value = value;
      delete existing.jsonType;
    } else env.variables.push({ name, value, secret: false });
  }
}
