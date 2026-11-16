// The workspace tree the explorer shows (`TreeNode`, from the shell).
import type { TreeNode } from "./types";

/** The files under `node` (itself, if it's a file), in the order the explorer shows them. */
export function treeFiles(node: TreeNode): string[] {
  return node.kind === "file" ? [node.path] : (node.children ?? []).flatMap(treeFiles);
}

/** The node at `path` under `node` (itself included). */
export function findNode(node: TreeNode, path: string): TreeNode | undefined {
  if (node.path === path) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, path);
    if (found) return found;
  }
}
