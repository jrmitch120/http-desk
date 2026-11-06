//! Deleting workspace entries. `delete_path` only ever moves to the OS trash;
//! when the trash can't take an entry it reports that instead of unlinking,
//! and the UI asks before calling `delete_permanently`.

use std::path::Path;
use std::sync::{Arc, RwLock};

use serde::Serialize;

/// Moves one file or folder to the trash.
pub type TrashFn = dyn Fn(&Path) -> Result<(), String> + Send + Sync;

/// The trash `delete_path` uses. Replaceable, so tests never touch the user's
/// real Trash: test builds start with a trash that always fails.
pub struct Trash(RwLock<Arc<TrashFn>>);

impl Default for Trash {
    fn default() -> Self {
        #[cfg(not(test))]
        let os: Arc<TrashFn> = Arc::new(|path: &Path| trash::delete(path).map_err(|e| e.to_string()));
        #[cfg(test)]
        let os: Arc<TrashFn> = Arc::new(|_: &Path| Err("the OS trash is off in tests".to_string()));
        Trash(RwLock::new(os))
    }
}

impl Trash {
    #[cfg(test)]
    pub fn replace(&self, f: impl Fn(&Path) -> Result<(), String> + Send + Sync + 'static) {
        *self.0.write().unwrap() = Arc::new(f);
    }

    /// The current trash, for moving entries off the calling thread.
    pub fn get(&self) -> Arc<TrashFn> {
        self.0.read().unwrap().clone()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DeleteOutcome {
    Trashed,
    /// The trash refused the entry; it is still in place.
    TrashUnavailable,
}

/// Moves `path` to the trash. Never unlinks anything.
pub fn to_trash(trash: &TrashFn, path: &Path) -> Result<DeleteOutcome, String> {
    std::fs::symlink_metadata(path).map_err(|e| format!("Could not delete {}: {e}", path.display()))?;
    Ok(match trash(path) {
        Ok(()) => DeleteOutcome::Trashed,
        Err(_) => DeleteOutcome::TrashUnavailable,
    })
}

/// Unlinks `path` for good. A symlink is removed itself, never what it points to.
pub fn delete_permanently(path: &Path) -> Result<(), String> {
    let fail = |e: std::io::Error| format!("Could not delete {}: {e}", path.display());
    if std::fs::symlink_metadata(path).map_err(fail)?.is_dir() {
        std::fs::remove_dir_all(path).map_err(fail)
    } else {
        std::fs::remove_file(path).map_err(fail)
    }
}
