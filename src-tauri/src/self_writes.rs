//! Self-write suppression: remembers what HttpDesk itself just did to the
//! workspace (content writes, renames, moves, new folders, deletes) so the
//! watcher can drop the events those actions cause.
//!
//! Each expectation describes the disk state our action left behind. An event
//! is ours while the disk still matches; the first event that doesn't match is
//! someone else's change, so it is reported and the expectation is forgotten.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use httpdesk_core::workspace;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Expect {
    /// A file holding exactly this content.
    Content(u64),
    /// A folder.
    Dir,
    /// Nothing at this path, nor anywhere below it.
    Absent,
}

#[derive(Clone, Default)]
pub struct SelfWrites(Arc<Mutex<HashMap<PathBuf, Expect>>>);

impl SelfWrites {
    /// Call before writing `bytes` to `path`. A symlink's target is expected too,
    /// since that is where the watcher sees the write.
    pub fn writing(&self, path: &Path, bytes: &[u8]) {
        let hash = workspace::content_hash(bytes);
        let mut map = self.0.lock().unwrap();
        map.insert(workspace::resolve_symlinks(path), Expect::Content(hash));
        map.insert(path.to_path_buf(), Expect::Content(hash));
    }

    /// Call before creating the folder `path`.
    pub fn creating_dir(&self, path: &Path) {
        self.0.lock().unwrap().insert(path.to_path_buf(), Expect::Dir);
    }

    /// Call before moving `from` (a file or folder) to `to`.
    pub fn moving(&self, from: &Path, to: &Path) {
        let landed = if from.is_dir() {
            Some(Expect::Dir)
        } else {
            std::fs::read(from).ok().map(|b| Expect::Content(workspace::content_hash(&b)))
        };
        let mut map = self.0.lock().unwrap();
        map.insert(from.to_path_buf(), Expect::Absent);
        if let Some(e) = landed {
            map.insert(to.to_path_buf(), e);
        }
    }

    /// Call before deleting (or trashing) `path`.
    pub fn removing(&self, path: &Path) {
        self.0.lock().unwrap().insert(path.to_path_buf(), Expect::Absent);
    }

    /// Whether a watcher event for `path` was caused by our own action.
    pub fn is_own(&self, path: &Path) -> bool {
        let mut map = self.0.lock().unwrap();
        if let Some(&expect) = map.get(path) {
            let own = match expect {
                Expect::Content(hash) => std::fs::read(path).is_ok_and(|b| workspace::content_hash(&b) == hash),
                Expect::Dir => path.is_dir(),
                Expect::Absent => !exists(path),
            };
            if !own {
                map.remove(path);
            }
            return own;
        }
        // Anything below a folder we moved away or deleted, which is still gone.
        path.ancestors().skip(1).any(|a| map.get(a) == Some(&Expect::Absent)) && !exists(path)
    }
}

/// Like `Path::exists`, but a dangling symlink counts as present.
fn exists(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}
