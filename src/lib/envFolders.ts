// Per-directory environment files (ADR-0004). The core works out what each folder
// with env files gives its requests (`load_folder_environments`, one effective
// EnvironmentSet per folder below the root); here a request just takes the nearest
// of those at or above its own folder, or the root's own set. Each environment in
// those sets says which folders supply it (`source`), so edits can go to that
// folder's own pair of files (`load_environments` / `save_environments` with `dir`).
import type { EnvironmentSet, EnvSource, FolderEnvironments, TreeNode } from "./types";

const parts = (p: string) => p.split(/[\\/]/).filter(Boolean);

/** The folder holding the file at `path` (a request's, or an env file's), relative to
 *  workspace `root`, `/`-separated ("" at the root). */
export function folderOf(root: string, path: string): string {
  const r = parts(root);
  const p = parts(path).slice(0, -1);
  return r.every((x, i) => p[i] === x) ? p.slice(r.length).join("/") : "";
}

/** A folder as the strip and send warnings name it: `api/users/`, or "the workspace root". */
export function folderLabel(dir: string): string {
  return dir ? `${dir}/` : "the workspace root";
}

/** Whether relative folder `dir` is `folder` or inside it (everything is within the root, ""). */
export function within(dir: string, folder: string): boolean {
  return folder === "" || dir === folder || dir.startsWith(`${folder}/`);
}

/** The `folders` entry nearest at or above `dir`, if any. */
function nearest(folders: FolderEnvironments[], dir: string): FolderEnvironments | undefined {
  let best: FolderEnvironments | undefined;
  for (const f of folders) {
    if (within(dir, f.dir) && (!best || f.dir.length > best.dir.length)) best = f;
  }
  return best;
}

/** The environments a request in folder `dir` is sent with. */
export function environmentsFor(root: EnvironmentSet | null, folders: FolderEnvironments[], dir: string): EnvironmentSet | null {
  return nearest(folders, dir)?.set ?? root;
}

/** The nearest folder at or above `dir` with env files of its own ("" for the root): where the Environments modal opens for a request in `dir`. */
export function nearestEnvFolder(folders: FolderEnvironments[], dir: string): string {
  return nearest(folders, dir)?.dir ?? "";
}

/** Every folder below the root of the explorer's `tree`, in its order, relative to `root` (where env files can be added). */
export function workspaceFolders(tree: TreeNode | null, root: string): string[] {
  const out: string[] = [];
  const skip = parts(root).length;
  const walk = (n: TreeNode) => {
    for (const c of n.children ?? []) {
      if (c.kind !== "dir") continue;
      out.push(parts(c.path).slice(skip).join("/"));
      walk(c);
    }
  };
  if (tree) walk(tree);
  return out;
}

/** Every environment name in the workspace, once: the root's in file order, then each folder's new ones. */
export function environmentNames(root: EnvironmentSet | null, folders: FolderEnvironments[]): string[] {
  const names = new Set<string>();
  for (const s of [root, ...folders.map((f) => f.set)]) for (const e of s?.environments ?? []) names.add(e.name);
  return [...names];
}

/**
 * The folder whose own pair of env files a value of `name` in environment `env`
 * (`$shared` for the shared variables) goes to, for requests getting `set`: where
 * the value in use is (a Secret's in the private file's folder), or for a new one
 * the folder whose shareable file supplies the environment (else its private file's),
 * so the write never makes a nearer file hide a farther one. Undefined when `set`
 * doesn't have the environment or doesn't say where it comes from.
 */
export function writeFolder(set: EnvironmentSet | null, env: string, name: string): string | undefined {
  if (!set) return undefined;
  let source: EnvSource | null | undefined;
  let vars;
  if (env === "$shared") [source, vars] = [set.sharedSource, set.shared];
  else {
    const e = set.environments.find((e) => e.name === env);
    [source, vars] = [e?.source, e?.variables ?? []];
  }
  if (!source) return undefined;
  const existing = vars.filter((v) => v.name === name).at(-1);
  const dir = existing ? (existing.secret ? source.private : source.public) : (source.public ?? source.private);
  return dir ?? undefined;
}
