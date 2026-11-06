//! Workspace confinement: the one check every command applies to a path it
//! receives before it creates, reads, writes, renames, moves or deletes
//! workspace files.

use std::path::{Component, Path, PathBuf};

use crate::{AppState, CmdResult};

/// Resolves `path` against the canonical workspace `root` and returns it if it
/// is the root or lies below it.
///
/// Every directory on the way is canonicalized (so `..` and symlinked folders
/// can't step outside), except the final component, which is kept as written:
/// a symlinked file inside the workspace counts as inside, and a case-only
/// rename target keeps the case the user typed. Components that don't exist
/// yet are resolved lexically. Relative paths are taken relative to `root`.
pub(crate) fn within(root: &Path, path: &Path) -> CmdResult<PathBuf> {
    let outside = || format!("{} is outside the workspace", path.display());
    let path = root.join(path);
    let resolved = match path.components().next_back() {
        Some(Component::Normal(name)) => resolve(path.parent().ok_or_else(outside)?)?.join(name),
        _ => resolve(&path)?,
    };
    if resolved.starts_with(root) {
        Ok(resolved)
    } else {
        Err(outside())
    }
}

/// Like [`within`], but refuses the workspace root itself (for commands that
/// act on an entry, such as rename and delete).
pub(crate) fn entry_within(root: &Path, path: &Path) -> CmdResult<PathBuf> {
    let resolved = within(root, path)?;
    if resolved == root {
        return Err("The workspace folder itself can't be changed here".into());
    }
    Ok(resolved)
}

/// Canonicalizes the longest existing prefix of `path`, then applies the
/// remaining (not yet existing) components lexically.
fn resolve(path: &Path) -> CmdResult<PathBuf> {
    let comps: Vec<Component> = path.components().collect();
    for i in (1..=comps.len()).rev() {
        let prefix: PathBuf = comps[..i].iter().collect();
        match prefix.canonicalize() {
            Ok(mut out) => {
                for c in &comps[i..] {
                    match c {
                        Component::Normal(n) => out.push(n),
                        Component::ParentDir => {
                            out.pop();
                        }
                        _ => {}
                    }
                }
                return Ok(out);
            }
            // A dangling symlink: we can't tell where it points.
            Err(_) if prefix.symlink_metadata().is_ok() => {
                return Err(format!("Cannot resolve {}", prefix.display()));
            }
            Err(_) => {}
        }
    }
    Err(format!("Cannot resolve {}", path.display()))
}

/// True when `to` names the same entry as `from`, differing only in letter
/// case, and `to` "exists" only because the filesystem ignores case
/// (macOS, Windows). Such a rename must go ahead, not fail as "already exists".
pub(crate) fn is_case_only_rename(from: &Path, to: &Path) -> bool {
    let (Some(dir), Some(a), Some(b)) = (from.parent(), from.file_name(), to.file_name()) else { return false };
    if to.parent() != Some(dir) || a == b || a.to_string_lossy().to_lowercase() != b.to_string_lossy().to_lowercase() {
        return false;
    }
    // On a case-sensitive filesystem an entry with exactly `to`'s name exists.
    std::fs::read_dir(dir).is_ok_and(|mut it| !it.any(|e| e.is_ok_and(|e| e.file_name() == b)))
}

impl AppState {
    /// [`within`] the open workspace.
    pub(crate) fn confine(&self, path: &Path) -> CmdResult<PathBuf> {
        within(&self.root()?, path)
    }

    /// [`entry_within`] the open workspace.
    pub(crate) fn confine_entry(&self, path: &Path) -> CmdResult<PathBuf> {
        entry_within(&self.root()?, path)
    }
}
