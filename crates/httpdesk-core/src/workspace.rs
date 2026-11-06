//! Workspace helpers: directory tree, request search, atomic writes.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const HTTP_EXTENSIONS: &[&str] = &["http", "rest"];
const IGNORED_DIRS: &[&str] = &["node_modules", "target", "dist", "build", "__pycache__", "venv"];
const MAX_ENTRIES: usize = 20_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Dir,
    File,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    pub path: PathBuf,
    pub kind: NodeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<TreeNode>>,
}

pub fn is_http_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| HTTP_EXTENSIONS.iter().any(|x| x.eq_ignore_ascii_case(e)))
}

/// Whether the explorer skips a folder with this name: dot-folders (`.git`,
/// `.venv`, `.cache`, …), dependencies, build output, virtualenvs and caches.
/// The watcher uses the same rule, so churn the explorer doesn't show causes no reloads.
pub fn is_ignored_dir(name: &str) -> bool {
    name.starts_with('.') || IGNORED_DIRS.contains(&name)
}

/// Whether `path` lies inside an ignored folder below `root`. The folders `root`
/// itself sits in don't count, nor does `path`'s own name.
pub fn inside_ignored_dir(root: &Path, path: &Path) -> bool {
    let Some(dirs) = path.strip_prefix(root).ok().and_then(Path::parent) else { return false };
    dirs.components().any(|c| is_ignored_dir(&c.as_os_str().to_string_lossy()))
}

/// Lists directories and `.http`/`.rest` files under `root`, directories first.
pub fn tree(root: &Path) -> std::io::Result<TreeNode> {
    let mut budget = MAX_ENTRIES;
    let children = list_dir(root, &mut budget, 0)?;
    Ok(TreeNode {
        name: root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.display().to_string()),
        path: root.to_path_buf(),
        kind: NodeKind::Dir,
        children: Some(children),
    })
}

fn list_dir(dir: &Path, budget: &mut usize, depth: usize) -> std::io::Result<Vec<TreeNode>> {
    let mut nodes = Vec::new();
    if depth > 16 {
        return Ok(nodes);
    }
    let mut entries: Vec<_> = std::fs::read_dir(dir)?.filter_map(Result::ok).collect();
    entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
    for entry in entries {
        if *budget == 0 {
            break;
        }
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            if is_ignored_dir(&name) {
                continue;
            }
            *budget -= 1;
            let children = list_dir(&path, budget, depth + 1).unwrap_or_default();
            nodes.push(TreeNode { name, path, kind: NodeKind::Dir, children: Some(children) });
        } else if is_http_file(&path) {
            *budget -= 1;
            nodes.push(TreeNode { name, path, kind: NodeKind::File, children: None });
        }
    }
    nodes.sort_by_key(|n| n.kind != NodeKind::Dir);
    Ok(nodes)
}

/// All `.http` files under `root` (same filtering as [`tree`]).
pub fn http_files(root: &Path) -> Vec<PathBuf> {
    fn walk(node: &TreeNode, out: &mut Vec<PathBuf>) {
        match node.kind {
            NodeKind::File => out.push(node.path.clone()),
            NodeKind::Dir => node.children.iter().flatten().for_each(|c| walk(c, out)),
        }
    }
    let mut out = Vec::new();
    if let Ok(t) = tree(root) {
        walk(&t, &mut out);
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: PathBuf,
    pub index: usize,
    pub name: String,
    pub method: String,
    pub url: String,
}

/// Case-insensitive search over request names, methods and URLs.
pub fn search(root: &Path, query: &str) -> Vec<SearchHit> {
    let terms: Vec<String> = query.split_whitespace().map(str::to_lowercase).collect();
    let mut hits = Vec::new();
    for path in http_files(root) {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let file_name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
        for (index, req) in crate::parse(&text).requests.iter().enumerate() {
            let name = req.display_name();
            let haystack = format!("{} {} {} {}", name, req.method, req.url, file_name).to_lowercase();
            if terms.iter().all(|t| haystack.contains(t)) {
                hits.push(SearchHit {
                    path: path.clone(),
                    index,
                    name,
                    method: req.method.clone(),
                    url: req.url.clone(),
                });
            }
            if hits.len() >= 500 {
                return hits;
            }
        }
    }
    hits
}

/// Follows a chain of symlinks to the file it ends at (which may not exist yet).
/// Paths that aren't symlinks are returned unchanged.
pub fn resolve_symlinks(path: &Path) -> PathBuf {
    let mut path = path.to_path_buf();
    for _ in 0..40 {
        let Ok(link) = std::fs::read_link(&path) else { break };
        path = match path.parent() {
            Some(parent) if link.is_relative() => parent.join(link),
            _ => link,
        };
    }
    path
}

/// Writes via a temp file + rename so watchers never observe partial content.
/// A symlink is written through to its target, and an existing file keeps its
/// permissions.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let path = &resolve_symlinks(path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_file_name(format!(
        ".{}.httpdesk-tmp",
        path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
    ));
    let permissions = std::fs::metadata(path).ok().map(|m| m.permissions());
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        // Apply the mode before any content lands, so a `chmod 600` file is never readable by others.
        if let Some(p) = permissions {
            f.set_permissions(p)?;
        }
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    };
    write().inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

/// Cheap content fingerprint used for self-write suppression.
pub fn content_hash(bytes: &[u8]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tree_and_search() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("api/users")).unwrap();
        std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
        std::fs::write(
            root.join("api/users/users.http"),
            "### List users\nGET https://x/users\n\n### Create user\nPOST https://x/users\n",
        )
        .unwrap();
        std::fs::write(root.join("node_modules/x/a.http"), "GET https://ignored\n").unwrap();
        std::fs::write(root.join("readme.md"), "").unwrap();
        write_atomic(&root.join("a.rest"), b"GET https://x/a\n").unwrap();

        let t = tree(root).unwrap();
        let names: Vec<_> = t.children.as_ref().unwrap().iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["api", "a.rest"]);
        assert_eq!(http_files(root).len(), 2);

        let hits = search(root, "post users");
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0].name.as_str(), hits[0].index), ("Create user", 1));
        assert_eq!(search(root, "users.http").len(), 2);
    }
}
