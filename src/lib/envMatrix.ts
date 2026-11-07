// The Environments matrix (#83): one row per variable name, one column for the
// shared variables and one per environment. It's a view of an EnvironmentSet;
// edits go into the set's own variable lists, so saving is the usual
// `save_environments` and Secrets stay in the private file.
import { envVarsOf, SHARED } from "./vars";
import type { EnvironmentSet, EnvVar } from "./types";

/**
 * What a cell shows:
 * - `set`: the column defines the variable (maybe with an empty value).
 * - `gap`: an environment doesn't define it and neither does Shared, so it's
 *   an Undefined variable there.
 * - `shared`: an environment doesn't define it, but the shared variables do.
 * - `unset`: the Shared column doesn't define it (Shared is optional, never a gap).
 */
export type MatrixCell = { state: "set"; variable: EnvVar } | { state: "gap" | "shared" | "unset" };

/** Shared, then each environment. */
export function matrixColumns(set: EnvironmentSet): string[] {
  return [SHARED, ...set.environments.map((e) => e.name)];
}

/**
 * Every named variable once, in the order first seen from Shared through the
 * environments (the matrix then sorts them by name). With `previous` (the rows
 * shown so far), a name in it stays even when no column defines it any more (its
 * last cell was unset), so its row doesn't vanish; the owner drops a deleted row
 * from `previous` itself.
 */
export function matrixNames(set: EnvironmentSet, previous: readonly string[] = []): string[] {
  const names = new Set(previous);
  for (const list of [set.shared, ...set.environments.map((e) => e.variables)]) {
    for (const v of list) if (v.name.trim()) names.add(v.name.trim());
  }
  return [...names];
}

/** How the rows are sorted: by name A→Z or Z→A. */
export type MatrixSort = "asc" | "desc";

const byName = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** `names` sorted by name only, so typing a value never moves a row. */
export function sortNames(names: readonly string[], sort: MatrixSort): string[] {
  const sign = sort === "asc" ? 1 : -1;
  return [...names].sort((a, b) => sign * byName.compare(a, b));
}

/** What a click on the Variable header does: A→Z ⇄ Z→A. */
export function nextSort(sort: MatrixSort): MatrixSort {
  return sort === "asc" ? "desc" : "asc";
}

/** The column's definition of `name`: the last same-named row, as sending uses. */
function find(set: EnvironmentSet, column: string, name: string): EnvVar | undefined {
  // A name typed with spaces around it is saved trimmed, so it's compared trimmed.
  return envVarsOf(set, column)?.filter((v) => v.name.trim() === name).at(-1);
}

export function matrixCell(set: EnvironmentSet, column: string, name: string): MatrixCell {
  const variable = find(set, column, name);
  if (variable) return { state: "set", variable };
  if (column === SHARED) return { state: "unset" };
  return find(set, SHARED, name) ? { state: "shared" } : { state: "gap" };
}

/**
 * Edits a cell. A column that doesn't define the variable gets it (empty,
 * shareable, then `patch`), so typing into a gap or locking it fills it.
 */
export function setCell(set: EnvironmentSet, column: string, name: string, patch: Partial<Pick<EnvVar, "value" | "secret">>) {
  const list = envVarsOf(set, column);
  if (!list) return;
  const variable = find(set, column, name);
  if (variable) Object.assign(variable, patch);
  else list.push({ name, value: "", secret: false, ...patch });
}

/** Unsets a cell: removes `name` from the column (every same-named row), so it's
 *  "Not set" there, and a gap when nothing else supplies it. Saving drops it from
 *  both of the folder's files. */
export function unsetCell(set: EnvironmentSet, column: string, name: string) {
  const list = envVarsOf(set, column);
  if (!list) return;
  const keep = list.filter((v) => v.name.trim() !== name);
  if (column === SHARED) set.shared = keep;
  else set.environments.find((e) => e.name === column)!.variables = keep;
}

/** Adds `name`, empty, to every environment that doesn't define it (not to Shared). Returns how many got it. */
export function addToAllEnvironments(set: EnvironmentSet, name: string): number {
  const trimmed = name.trim();
  let added = 0;
  for (const env of set.environments) {
    if (find(set, env.name, trimmed)) continue;
    env.variables.push({ name: trimmed, value: "", secret: false });
    added++;
  }
  return added;
}

/** Whether a row matches the filter: by name, or by a shareable value in any column (never a Secret's). */
export function rowMatches(set: EnvironmentSet, name: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q || name.toLowerCase().includes(q)) return true;
  return matrixColumns(set).some((column) => {
    const v = find(set, column, name);
    return !!v && !v.secret && v.value.toLowerCase().includes(q);
  });
}

/** Removes `name` from Shared and every environment. */
export function removeEverywhere(set: EnvironmentSet, name: string) {
  const keep = (list: EnvVar[]) => list.filter((v) => v.name.trim() !== name);
  set.shared = keep(set.shared);
  for (const env of set.environments) env.variables = keep(env.variables);
}
