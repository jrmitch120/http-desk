// Per-directory environment files (ADR-0004). The core works out what each folder
// with env files gives its requests (`load_folder_environments`, one effective
// EnvironmentSet per folder below the root); here a request just takes the nearest
// of those at or above its own folder, or the root's own set.
import type { EnvironmentSet, FolderEnvironments } from "./types";

const parts = (p: string) => p.split(/[\\/]/).filter(Boolean);

/** The folder of the file at `path`, relative to workspace `root`, `/`-separated ("" at the root). */
export function requestFolder(root: string, path: string): string {
  const r = parts(root);
  const p = parts(path).slice(0, -1);
  return r.every((x, i) => p[i] === x) ? p.slice(r.length).join("/") : "";
}

/** A folder as the strip and send warnings name it: `api/users/`, or "the workspace root". */
export function folderLabel(dir: string): string {
  return dir ? `${dir}/` : "the workspace root";
}

/** The environments a request in folder `dir` is sent with. */
export function environmentsFor(root: EnvironmentSet | null, folders: FolderEnvironments[], dir: string): EnvironmentSet | null {
  let best: FolderEnvironments | undefined;
  for (const f of folders) {
    const inside = dir === f.dir || dir.startsWith(`${f.dir}/`);
    if (inside && (!best || f.dir.length > best.dir.length)) best = f;
  }
  return best?.set ?? root;
}

/** Every environment name in the workspace, once: the root's in file order, then each folder's new ones. */
export function environmentNames(root: EnvironmentSet | null, folders: FolderEnvironments[]): string[] {
  const names = new Set<string>();
  for (const s of [root, ...folders.map((f) => f.set)]) for (const e of s?.environments ?? []) names.add(e.name);
  return [...names];
}
